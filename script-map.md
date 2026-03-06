# BREAD RUN — script.js internals

## 1. WHAT THIS FILE IS

`script.js` is the entire brain of the Bread Run app — ~630 lines with no build step,
no framework, no imports. It fetches a Google Sheet CSV, renders an interactive
route checklist, and syncs checkbox state to Firebase Realtime Database in real time
across multiple drivers' phones.

---

## 2. DATA FLOW

```
Google Sheet (CSV, published)
          │
          ▼  fetchSheetData()
    parseCSV() + rowToObject()
          │
          ▼
    allOrderRows[]          ← in-memory array of all order objects (every route)
          │
          ▼  loadRoute() → renderCurrentRoute()
    getRouteOrders(route)   ← filters allOrderRows to the selected route
          │
          ├──► renderSummary(orders)   ← Sorting Stage collapsible
          │
          └──► renderOrders(orders)    ← customer group cards
                    │
                    ▼  checkbox change (delegated)
              toggle itemChecked[route][itemId]
                    │
                    ├──► postStatus(itemKey)  ─────► Firebase PUT  /statuses/{key}
                    │    deleteStatus(itemKey) ────► Firebase DELETE /statuses/{key}
                    │         │
                    │         └──► Firebase PUT  /lastModified  (timestamp)
                    │
                    └──► updateStats() + renderOrders()


  On load / tab focus / polling:
    fetchStatuses()  ─────────► Firebase GET  /statuses.json
          │
          ▼  applyStatusRows()
    itemChecked + summaryTypeChecked updated
          │
          ▼
    renderCurrentRoute()


  Polling (every 15 s):
    pollForChanges() ─────────► Firebase GET  /lastModified.json
          │  timestamp changed?
          └──yes──► fetchStatuses()
```

---

## 3. STATE (what lives in memory)

| Variable | Type | Shape | Description |
|---|---|---|---|
| `allOrderRows` | `Array` | `[{ orderNum, qty, ware, supplier, customer, dept, route, routeOrdering, acceptAlts, itemId, itemKey }]` | Every data row from the sheet; header stripped, blank orderNums filtered |
| `itemChecked` | `Object` | `{ route: { itemId: bool } }` | Which order cards are ticked; keyed by session-local `itemId` |
| `summaryTypeChecked` | `Object` | `{ route: { ware: bool } }` | Which Sorting Stage bread types are ticked |
| `isSummaryOpen` | `boolean` | `true \| false` | Whether the Sorting Stage collapsible is expanded |
| `summaryProductSort` | `string` | `'qty-desc' \| 'qty-asc'` | Current sort direction of the summary list |
| `lastFirebaseWriteTime` | `number \| null` | Unix ms timestamp | Last `/lastModified` value we know about; `null` until first poll |

### itemId vs itemKey

| | `itemId` | `itemKey` |
|---|---|---|
| Format | `"0"`, `"1"`, `"42"` (row index as string) | `"orderNum\|ware"` e.g. `"1234\|Rugbrød"` |
| Scope | Session-local (changes if sheet row order changes) | Stable across devices and reloads |
| Used in | `itemChecked` local state, HTML `data-item` | Firebase `/statuses/{key}` |
| Why not use orderNum as ID? | One Order ID can cover multiple bread line items | `orderNum\|ware` is always unique per line |

---

## 4. FUNCTION CATALOGUE

### Data / Network

| Function | Purpose |
|---|---|
| `parseCSV(text)` | RFC-4180-compatible CSV parser — handles quoted fields and escaped quotes |
| `rowToObject(fields)` | Maps a CSV row array to a typed order object using the `COLS` mapping |
| `fetchSheetData()` | Fetches the Sheet CSV, parses it into `allOrderRows`, populates the route dropdown |
| `applyStatusRows(rows)` | Merges an array of Firebase status rows into `itemChecked` / `summaryTypeChecked` |
| `fetchStatuses()` | GET `/statuses.json` → `applyStatusRows()` → re-render |
| `postStatus({...})` | PUT a single item's status to Firebase + stamp `/lastModified` |
| `deleteStatus(orderNum)` | DELETE a single item's status from Firebase + stamp `/lastModified` |
| `pollForChanges()` | GET `/lastModified` — only triggers `fetchStatuses()` if timestamp changed |
| `resetFirebaseRoute(route, orders)` | PATCH all route entries to `null` (atomic delete) |

### Rendering

| Function | Purpose |
|---|---|
| `loadRoute()` | Called on dropdown change; delegates to `renderCurrentRoute()` |
| `renderCurrentRoute()` | Orchestrates a full re-render: stats + summary + orders |
| `getRouteOrders(route)` | Filters `allOrderRows` to a single route |
| `sortedCustomers(orders)` | Groups orders by customer, sorts by `maxOrdering` descending |
| `renderSummary(orders)` | Renders the Sorting Stage collapsible (bread type totals) |
| `renderOrders(orders)` | Renders all customer group cards with pending/done ordering |
| `cardHTML(order, checkedForRoute)` | Returns HTML string for one order card |
| `supplierIconHTML(supplier)` | Returns an `<img>` tag for known suppliers, or `''` |
| `updateStats(orders)` | Updates the stats bar (total items, done count, total units) |
| `showMsg(icon, msg)` | Replaces content area with a centred placeholder message |

### UI / Event

| Function | Purpose |
|---|---|
| `toggleSummary()` | Toggles `isSummaryOpen` and the `open` CSS class |
| `askReset()` | Shows the confirm overlay |
| `closeConfirm()` | Hides the confirm overlay |
| `doReset()` | Clears local state for the route, re-renders, fires `resetFirebaseRoute()` |

---

## 5. FIREBASE KEY FORMAT

All state lives under `{FIREBASE_URL}/statuses/` as URL-encoded keys.

| Key format | Example | Stored value |
|---|---|---|
| `encodeURIComponent(orderNum + "\|" + ware)` | `1234%7CRugbr%C3%B8d` | `{ status: "checked"\|"unchecked", route, customer }` |
| `encodeURIComponent("SUMMARY\|" + route + "\|" + ware)` | `SUMMARY%7C2%7CRugbr%C3%B8d` | `{ status: "checked", route, customer: "" }` |

The timestamp lives separately at `{FIREBASE_URL}/lastModified` as a plain Unix ms number.

---

## 6. SORT ORDER LOGIC

### Customer groups — LIFO packing order

Higher `routeOrdering` = last delivery stop = packed first into van = top of screen.

```
routeOrdering:  10     7      3      1
Screen order:  [A]   [B]   [C]   [D]      ← A is last delivery, packed first
Van order:     [ A | B | C | D ]→ door    ← D is first delivery, loaded last
```

Customer positions are **frozen for the session**. Only the CSS class changes
(`cg-done`, `cg-in-progress`) — the DOM order never changes, so checked-off
customers don't jump around on screen.

### Within a customer — pending-first sink

```
Before any ticks:   [Rugbrød] [Ciabatta] [Baguette]
After ticking Rugbrød: [Ciabatta] [Baguette] [Rugbrød ✓]
```

Checked items sink to the bottom of their customer (or dept sub-group).
The customer's position in the page does not change.

### Dept sub-grouping

When a customer has items across multiple departments, each dept gets a divider
and its own pending/done sort. If a customer has only one dept (the common case),
the divider is skipped entirely (`depts.length <= 1` fast path).

### Summary (Sorting Stage) sort

Default: `qty-desc` (highest quantity first). Toggle button cycles to `qty-asc`.
Within each direction, unchecked types appear before checked types.

---

## 7. SYNC TRIGGER TABLE

| Trigger | Action |
|---|---|
| Page load | `fetchSheetData()` → `fetchStatuses()` |
| Tab regains focus | `fetchStatuses()` |
| Route dropdown changes | `loadRoute()` → `renderCurrentRoute()` (local state only) |
| Checkbox tapped (mid-customer) | `postStatus()` or `deleteStatus()` fire-and-forget, then local re-render |
| Checkbox tapped (completes customer) | Show overlay → `await postStatus/deleteStatus` → `await fetchStatuses()` → hide overlay |
| Reset button confirmed | Local clear → `renderCurrentRoute()` → `resetFirebaseRoute()` fire-and-forget |
| Poll (every 15 s) | GET `/lastModified` — only triggers full sync if timestamp differs |
