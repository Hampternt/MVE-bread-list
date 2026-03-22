# Freezer List Page + Landing Chooser + Firestore Data Layer — Design Spec

**Date:** 2026-03-21
**Status:** Draft

---

## Context

The app currently fetches order data from a published Google Sheets CSV on every page load, and stores checkbox state in Firebase Realtime Database (RTDB). This creates two external dependencies (Google Sheets + Firebase), involves a CORS proxy workaround for local dev, and means the full order dataset is re-downloaded on every sync cycle.

This spec covers three interconnected changes:

1. **Freezer list page** — a new `freezer.html` with blue theme, no crate visualisation, pointing at frozen-goods order data
2. **Landing chooser** — `index.html` becomes a two-button selector (Bread list / Freezer list); bread list moves to `bread.html`
3. **Firestore as order data source** — order rows migrate from Google Sheets CSV to Cloud Firestore; an upload button lets an admin push a new CSV or XLSX export to Firestore; the app queries Firestore once on load and keeps data in memory; RTDB continues to handle checkbox statuses as-is

---

## Architecture Overview

```
                    ADMIN UPLOAD
                         │
              CSV or XLSX file
                         │
                  browser parses
                  (SheetJS for xlsx,
                   parseCSV for csv)
                         │
               batch write to Firestore
                  /bread-orders/
                  /freezer-orders/
                         │
                ┌────────┴────────┐
                │                 │
          bread.html         freezer.html
                │                 │
      getDocs(bread-orders)  getDocs(freezer-orders)
      ── once on load ──    ── once on load ──
                │                 │
         allOrderRows[]    allOrderRows[]
         (in memory)       (in memory)
                │                 │
           renderCurrentRoute()   │
                │                 │
          ┌─────┴──────────────────┘
          │
   Firebase RTDB (existing)
   /statuses/           /freezer-statuses/
   /lastModified        /freezer-lastModified
   ── status ticks, polling, sync ──
```

---

## Files Changed / Created

| File | Action | Notes |
|------|--------|-------|
| `index.html` | Replace content | Landing chooser: two buttons → `bread.html` and `freezer.html` |
| `bread.html` | Create | Copy of current `index.html`; no visual changes; updated script reference |
| `freezer.html` | Create | Copy of `bread.html`; blue theme, `freezer-script.js`, updated header |
| `src/script.js` | Edit | Replace `fetchSheetData()` (Google Sheets CSV fetch) with Firestore query |
| `src/freezer-script.js` | Create | Copy of updated `script.js`; crate viz removed; queries `freezer-orders` collection; separate RTDB paths |
| `src/style.css` | Edit | Add `.theme-freezer` blue overrides; add landing page styles; add upload UI styles |
| `upload.html` | Create | Simple admin upload page; file input for CSV/XLSX; parses and batch-writes to Firestore |
| `config/firebase-rules.json` | Edit | Add `freezer-statuses` and `freezer-lastModified` RTDB nodes |
| `freezer-data.csv` | Rename | `PSR-FREEZER-2026-01-23-to-2026-01-23.csv` renamed to stable name for initial seed upload |
| `PSR-FREEZER-2026-01-23-to-2026-01-23.xlsx` | Delete | No longer needed once CSV is the canonical seed file |
| `tutorial.html` | Edit | Back-link updated from `index.html` → `bread.html` |
| `project-map.html` | Out of scope | References `index.html` — outdated but not updated in this task |

---

## Data Model (Firestore)

### Collections

| Collection | Contents |
|---|---|
| `bread-orders` | All bread delivery order rows |
| `freezer-orders` | All frozen-goods order rows |

### Document structure

Document ID: Firestore auto-generated ID (avoids all encoding ambiguity).

Fields per document:

| Field | Type | Notes |
|---|---|---|
| `itemKey` | string | `orderNum + '\|' + ware` — the stable RTDB key, stored explicitly as a field |
| `orderNum` | string | |
| `qty` | number | |
| `ware` | string | |
| `supplier` | string | |
| `customer` | string | |
| `dept` | string | |
| `route` | string | |
| `routeOrdering` | number | |
| `acceptAlts` | boolean | |

`itemKey` is stored as a plain field (not derived from the document ID) to avoid any encoding/decoding ambiguity and to be consistent with the existing RTDB key format. When the app reads a Firestore document, `order.itemKey = doc.fields.itemKey.stringValue` — no transformation needed.

The `itemId` (session-local array index) is NOT stored — it is assigned at query time, exactly as today.

---

## Firestore Integration (no SDK — REST API)

To keep the no-build-step, no-module-script architecture, Firestore is accessed via its REST API, the same pattern as the existing RTDB REST calls.

**Read (on load) — with pagination loop:**
```
GET https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/{collection}?key={API_KEY}&pageSize=300
```
The response may include a `nextPageToken` field. `fetchOrderData()` loops until no `nextPageToken` is returned, accumulating all pages into a single array before proceeding. If any page request fails, the entire load is aborted and a visible error message is shown (same behaviour as the existing `fetchSheetData` failure path) — no partial dataset is used.

**Write (upload) — write-then-delete to avoid empty-collection window:**
Upload flow:
1. Parse file → array of new row objects (each with a generated `itemKey`)
2. Write all new documents to Firestore via chunked `batchWrite` (500 ops per call)
3. Only after all writes succeed: fetch existing document IDs from the collection
4. Delete any document whose `itemKey` is NOT in the newly uploaded set (via chunked `batchWrite` deletes)

This ensures the collection is never empty during an upload. If the write phase fails mid-way, stale documents remain but no data is lost. If the delete phase fails, duplicate/stale rows may exist but a reload and re-upload corrects it. **Operational note:** uploads should happen before a shift starts, not while drivers are actively using the app.

**API key exposure:** The Firestore API key is restricted in the Google Cloud Console to the app's domain (and `localhost` for dev). Note: HTTP referrer restrictions on API keys can be bypassed by server-side requests (curl, Postman) that spoof the `Referer` header, so the key alone is not a meaningful write guard — the Firestore security rules (see Security section) are the actual protection. Write operations will require auth when the security layer is added.

---

## `fetchSheetData()` replacement in `script.js`

The function is renamed `fetchOrderData()` and changed to:
1. `GET` all documents from `bread-orders` with pagination loop (see Firestore REST API section)
2. Map each Firestore document's fields to the existing order object shape (same as `rowToObject()` today); `order.itemKey` comes directly from the stored `itemKey` field
3. Assign `itemId` as array index (same as today)
4. Populate route dropdown
5. Call `fetchStatuses()` (RTDB, unchanged)

The refresh button's event listener (`fetchSheetData` → `fetchOrderData`) is updated in the same change.

Everything downstream (rendering, RTDB sync, missing items, reset) is unchanged.

---

## Upload Page (`upload.html`)

A minimal admin-only page (linked from the landing chooser with an unobtrusive "Admin" link, or accessible directly at `/upload.html`).

**UI:**
- Select target list: "Bread orders" / "Freezer orders" (radio buttons)
- File input: accepts `.csv`, `.xlsx`
- Upload button
- Progress/status feedback (row count, success/error)

**Parse logic:**
- `.csv` files: reuse `parseCSV()` from the main app (copied inline — no module system)
- `.xlsx` files: parsed using [SheetJS](https://sheetjs.com/) `v0.18.5`, loaded via CDN `<script>` tag with a pinned version URL and an `integrity` SRI hash to prevent supply-chain tampering. SheetJS exposes a global `XLSX`; `XLSX.read()` + `XLSX.utils.sheet_to_array_of_arrays()` produces a 2D array identical in shape to parsed CSV rows. The same `rowToObject()` mapping is applied to both formats.

**Upload flow:**
1. Parse file → array of row objects
2. Show preview: "Found N rows across R routes"
3. Admin confirms
4. Delete all existing documents in the target collection (chunked batchWrite deletes)
5. Write new documents (chunked batchWrite, 500 per batch)
6. Show completion: "Uploaded N rows"

**Security (current):** No authentication. The Firestore write rules are temporarily `allow write: if true`. The API key is domain-restricted but that restriction can be bypassed by server-side requests — the collection is effectively publicly writable in Phase 1. This is an acceptable interim state for an internal tool used before shifts, but Phase 2 auth should be added before the app is used in any environment where data integrity matters. Phase 2 is the deployment trigger: add Firebase Auth before go-live on the production domain.

---

## Security Layer (designed now, implemented later)

The Firestore rules are written from day one to support auth:

```javascript
// Firestore security rules (firestore.rules)
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Order data: public read, admin-only write
    match /bread-orders/{doc} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.token.admin == true;
    }
    match /freezer-orders/{doc} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.token.admin == true;
    }
  }
}
```

**In Phase 1 (now):** The `allow write` check will be `if true` temporarily, making upload work without auth. The rule structure is already in place.

**In Phase 2 (later):** One Firebase Auth admin account is created (email/password). A `customClaims: { admin: true }` flag is set on it. The upload page adds a login form (email + password → `signInWithEmailAndPassword`). The `allow write: if true` line is replaced with the `request.auth.token.admin == true` check above. No other code changes needed — the rule structure is already correct.

RTDB rules are unchanged (drivers write status ticks without logging in).

---

## Colour Theme (freezer)

Add `.theme-freezer` to `<body>` in `freezer.html`. In `src/style.css`:

```css
body.theme-freezer {
  --accent:     #4a9edd;   /* cool blue */
  --accent-dim: #2d6fa3;   /* darker blue */
  --done-bg:    #0d2535;   /* dark blue-tinted done cards */
  --check:      #5ab8f5;   /* light blue checkmarks */
}
```

---

## Landing Page (`index.html`)

Full-screen dark-themed chooser. Two large tap targets (min 80px height, full-width on mobile):
- **"Bread list"** — gold accent (`--accent`)
- **"Freezer wares list"** — blue accent (`#4a9edd`)

App logo above the buttons. Unobtrusive "Upload data" link in footer → `upload.html`. No JavaScript required.

---

## Firebase RTDB Rules (`config/firebase-rules.json`)

Add `freezer-statuses` and `freezer-lastModified` as siblings to existing nodes (copy exact structure):

```json
"freezer-statuses": {
  ".read": true,
  "$key": {
    ".write": true,
    ".validate": "!newData.exists() || (
      newData.hasChildren(['status', 'route', 'customer'])
      && newData.child('status').isString()
      && (newData.child('status').val() === 'checked' || newData.child('status').val() === 'unchecked' || newData.child('status').val() === 'missing')
      && newData.child('route').isString()
      && newData.child('customer').isString()
      && (!newData.hasChild('qtyMissing') || newData.child('qtyMissing').isNumber())
      && (!newData.hasChild('replacementWare') || newData.child('replacementWare').isString())
    )"
  }
},
"freezer-lastModified": {
  ".read": true,
  ".write": true,
  ".validate": "newData.isNumber()"
}
```

---

## `missing-report.html`

Reads from bread `/statuses/` only. Unchanged. Freezer equivalent is out of scope for this task.

---

## Verification

1. Open `http://localhost/` — landing page shows gold "Bread list" and blue "Freezer wares list" buttons, plus footer "Upload data" link
2. Tap "Bread list" → `bread.html` loads; route dropdown populates from Firestore `bread-orders`
3. Bread list ticks write to RTDB `/statuses/`; no writes to Firestore; no writes to `/freezer-statuses/`
4. Tap "Freezer wares list" → `freezer.html` loads with blue theme; route dropdown populates from Firestore `freezer-orders`
5. Freezer list ticks write to RTDB `/freezer-statuses/` only
6. Open `upload.html`; upload `freezer-data.csv` with "Freezer orders" selected → success message with correct row count
7. Reload `freezer.html` → updated data appears; removed rows are gone; no stale rows remain
8. Upload an `.xlsx` file → same result as CSV upload (SheetJS converts, same row count)
9. Upload to "Bread orders" → `freezer-orders` collection is untouched and vice versa
10. Sorting Stage summary renders correctly on both list pages; ticking a summary item persists to RTDB with correct `SUMMARY|{route}|{ware}` key
11. Long-press missing-item flow works on both pages; saves to correct RTDB path
12. Reset on freezer page clears `/freezer-statuses/` only; bread `/statuses/` is untouched
13. Polling: mutate RTDB status directly → page updates within 15s
14. No crate diagrams anywhere on freezer page
15. `tutorial.html` → Back navigates to `bread.html`
16. Simulate upload failure mid-write (disconnect network after first batch): reload list page → existing data still present (not empty); re-upload recovers cleanly
17. Firestore collection > 300 rows: all rows appear in the app (pagination loop working)
