# MVE Bread List — Route Checklist

**Live app:** http://mvebread.dblo.net/

A mobile-first web app for managing bread delivery routes. Staff pick a route, work through each customer's orders, and tick items off as they're packed. Completed items sink to the bottom so the to-do items stay at the top. State is synced in real-time across all devices via Firebase — multiple drivers see each other's ticks instantly.

---

## How it works

### 1. Load the page

The app immediately fetches today's orders from a published Google Sheet (CSV). While loading you'll see a spinner; once data is ready the **Route** dropdown is populated automatically.

### 2. Select your route

Choose your delivery route from the dropdown. The page shows:

- **Stats bar** — total orders | items completed | total units for that route
- **Sorting Stage** — a collapsible checklist of every bread type on the route with unit totals, so you can tick off types as you sort them into the van before starting the customer-by-customer pack
- **Customer order cards** — one section per customer, in reverse delivery order (last stop packed first so it ends up deepest in the van)

### 3. Work through orders

Each customer section shows their individual order cards. Tap the checkbox on a card to mark it as picked/packed:

- The card turns green and slides to the **bottom of that customer's section**, keeping unfinished items at the top.
- The stats bar updates instantly.
- When **all** items for a customer are ticked, the whole customer section slides to the **bottom of the page**, out of the way.
- When every order on the route is done, a "Route complete! ✅" banner appears.

Customers with multiple departments show a divider heading per department, with each department sorted independently.

### 4. Report missing items

If a product isn't available, tap the **missing items button** on its card. A detail sheet slides up where you can record:

- How many units are missing
- A replacement product (if the customer accepts alternatives)

Missing items are stored in Firebase and appear on the **Missing Items Report** page (`/missing-report.html`), split into "Replaced" and "Fully Missing" sections. This page can be opened on any device and refreshed independently.

### 5. Reset

Tap **↺ Reset checklist** at the bottom of the page to clear all ticks for the current route (a confirmation dialog prevents accidental resets). Route state is kept separately, so resetting one route doesn't affect others.

### 6. Refresh data

Tap **↻ Refresh** in the header to re-fetch the sheet (useful if orders were added or changed mid-day). Checked state is preserved across refreshes.

---

## Pages

| Page | URL path | Purpose |
|------|----------|---------|
| Main checklist | `/` | Route selection and order packing |
| Tutorial | `/tutorial.html` | Step-by-step usage guide |
| Missing items report | `/missing-report.html` | Read-only report of all missing/replaced items across all routes |
| Project map | `/project-map.html` | Technical architecture overview |

---

## Google Sheets setup

Orders are read from a Google Sheet published as CSV. The sheet must have at least these columns (0-indexed):

| Index | Field | Description |
|-------|-------|-------------|
| 0 | Order ID | Order number — one order can span multiple bread line items |
| 1 | Quantity | Number of units |
| 3 | Product Name | Bread type shown on the card |
| 6 | Supplier | Supplier name shown on the card |
| 7 | Customer | Customer name (used to group cards) |
| 8 | Department | Sub-group within a customer (divider shown when a customer has multiple depts) |
| 11 | Route | Route nickname shown in the dropdown |
| 12 | Route Ordering | Integer — higher = last delivery stop (packed first, top of screen) |
| 13 | Accept alternatives | `TRUE` / `FALSE` — controls whether a replacement can be recorded for missing items |

To point the app at a different sheet, update `SHEET_CSV_URL` near the top of `src/script.js`:

```js
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/YOUR_SHEET_ID/pub?output=csv";
```

The sheet must be published: **File → Share → Publish to web → CSV**.

---

## Project structure

```
MVE-bread-list/
├── index.html          # App shell (HTML structure only)
├── tutorial.html       # How-to-use guide page
├── missing-report.html # Missing items report page
├── project-map.html    # Technical architecture explainer page
├── src/
│   ├── script.js       # All app logic — data fetching, rendering, state, Firebase sync
│   └── style.css       # All styles — design tokens in :root at top
├── assets/
│   ├── bread-basket.svg    # App logo (header icon)
│   ├── logo.svg            # Bakehuset supplier icon
│   └── sandnes-bakeri.png  # Sandnes Bakeri supplier icon
├── config/
│   └── firebase-rules.json # Firebase Realtime Database security rules
├── legacy/
│   ├── Code.gs             # Google Apps Script (legacy, unused)
│   ├── appsscript.json     # Apps Script project manifest
│   └── .clasp.json         # clasp config for pushing Code.gs
├── CNAME               # Custom domain config for GitHub Pages (mvebread.dblo.net)
└── README.md           # This file
```

The app is a single self-contained HTML file with no build step, no npm, and no external dependencies. It is hosted via **GitHub Pages**.

---

## Sorting logic

Customer groups appear in **reverse delivery order** (highest `routeOrdering` value first — last delivery stop packed first into van). Customer positions are **frozen** once the route loads; only CSS state classes change so groups don't jump around as you tick. Within each customer group (or department sub-group), unchecked items always appear above checked items and update live on every tap.

---

## Deployment

Push to `main`. GitHub Pages picks it up automatically and serves `index.html` at the CNAME domain. No build step, no npm, no bundler.

---

## Customising

| What | Where |
|------|-------|
| Sheet URL | `SHEET_CSV_URL` const at top of `src/script.js` |
| Firebase URL | `FIREBASE_URL` const at top of `src/script.js` |
| Column mapping | `COLS` object at top of `src/script.js` |
| Colour theme | CSS variables in `:root` at top of `src/style.css` |
| App title / logo | `<header>` in `index.html` |
