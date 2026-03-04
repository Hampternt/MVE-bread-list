# MVE Bread List — Route Checklist

**Live app:** http://mvebread.dblo.net/

A mobile-first web app for managing bread delivery routes. Staff pick a route, work through each customer's orders, and tick items off as they're packed. Completed items sink to the bottom so the to-do items stay at the top.

---

## How it works

### 1. Load the page

The app immediately fetches today's orders from a published Google Sheet (CSV). While loading you'll see a spinner; once data is ready the **Route** dropdown is populated automatically.

### 2. Select your route

Choose your delivery route from the dropdown. The page shows:

- **Stats bar** — total orders | items completed | total units for that route
- **Sorting Stage** — a collapsible checklist of every bread type on the route, with unit totals, so you can tick off types as you sort them into the van
- **Customer order cards** — one section per customer, in reverse delivery order (last stop packed first so it ends up deepest in the van)

### 3. Work through orders

Each customer section shows their individual order cards. Tap the checkbox on a card to mark it as picked/packed:

- The card turns green and slides to the **bottom of that customer's section**, keeping unfinished items at the top.
- The stats bar updates instantly.
- When **all** items for a customer are ticked, the whole customer section slides to the **bottom of the page**, out of the way.
- When every order on the route is done, a "Route complete! ✅" banner appears.

### 4. Reset

Tap **↺ Reset checklist** at the bottom of the page to clear all ticks for the current route (a confirmation dialog prevents accidental resets). Route state is kept separately, so resetting one route doesn't affect others.

### 5. Refresh data

Tap **↻ Refresh** in the header to re-fetch the sheet (useful if orders were added or changed mid-day). Checked state is preserved across refreshes.

---

## Google Sheets setup

Orders are read from a Google Sheet published as CSV. The sheet must have at least these columns (0-indexed):

| Index | Field | Description |
|-------|-------|-------------|
| 0 | Order ID | Unique order number (used as the checkbox key) |
| 1 | Quantity | Number of units |
| 3 | Product Name | Bread type shown on the card |
| 6 | Supplier | Supplier name shown on the card |
| 7 | Customer | Customer name (used to group cards) |
| 11 | Route | Route nickname shown in the dropdown |
| 12 | Route Ordering | Integer — higher = last delivery stop (packed first) |

To point the app at a different sheet, update `SHEET_CSV_URL` near the top of `index.html`:

```js
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/YOUR_SHEET_ID/pub?output=csv";
```

The sheet must be published: **File → Share → Publish to web → CSV**.

---

## Project structure

```
MVE-bread-list/
├── index.html      # The entire app — HTML, CSS, and JS in one file
├── oldindex.html   # Previous version (archived, not deployed)
├── CNAME           # Custom domain config for GitHub Pages (mvebread.dblo.net)
└── README.md       # This file
```

The app is a single self-contained HTML file with no build step, no npm, and no external dependencies. It is hosted via **GitHub Pages**.

---

## Sorting logic

Customer groups appear in **reverse delivery order** by default (highest `routeOrdering` value first). When a customer's last item is ticked, the customer group moves to the bottom of the list. Within each customer group, unchecked items always appear above checked items. Both levels of sorting update live on every tap.

---

## Deployment

Push to the `master` / `main` branch. GitHub Pages picks it up automatically and serves `index.html` at the CNAME domain.

---

## Customising

| What | Where in `index.html` |
|------|-----------------------|
| Sheet URL | `const SHEET_CSV_URL` (line ~550) |
| Column mapping | `const COLS` object (lines ~555–570) |
| Colour theme | CSS variables at the top of `<style>` |
| App title / logo | `<header>` section in the HTML body |
