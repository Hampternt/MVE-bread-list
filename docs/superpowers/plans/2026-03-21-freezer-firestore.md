# Freezer List + Firestore Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a freezer-goods packing list page, migrate order data from Google Sheets to Firestore, and add a CSV/XLSX upload page — all without a build step.

**Architecture:** `index.html` becomes a landing chooser; bread list moves to `bread.html`; `freezer.html` is a blue-themed copy without crate viz; order data is queried once from Firestore on load and kept in memory; RTDB continues to store checkbox statuses as-is; `upload.html` parses CSV/XLSX and batch-writes to Firestore.

**Tech Stack:** Vanilla JS, Firebase Realtime Database (REST), Cloud Firestore (REST), SheetJS v0.18.5 (CDN, XLSX parsing), GitHub Pages (static hosting)

**Firebase project:** `mve-bread` | API key: `AIzaSyDGGpoqD-GlAF98dYxly7X7dQRWeUwpXY4`
**RTDB URL:** `https://mve-bread-default-rtdb.europe-west1.firebasedatabase.app`
**Firestore base:** `https://firestore.googleapis.com/v1/projects/mve-bread/databases/(default)/documents`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `bread.html` | **Create** | Bread list page (copy of current `index.html`) |
| `index.html` | **Replace** | Landing chooser — two buttons, no JS |
| `freezer.html` | **Create** | Freezer list page — blue theme, no crate viz |
| `src/script.js` | **Modify** | Replace `fetchSheetData` with Firestore `fetchOrderData` |
| `src/freezer-script.js` | **Create** | Copy of updated `script.js`: crate viz removed, freezer Firestore collection + RTDB paths |
| `src/upload-script.js` | **Create** | Upload page logic: parse CSV/XLSX, batch-write to Firestore |
| `upload.html` | **Create** | Admin upload page shell |
| `src/style.css` | **Modify** | Add `.theme-freezer` variables + landing page styles + upload page styles |
| `config/firebase-rules.json` | **Modify** | Add `freezer-statuses` + `freezer-lastModified` RTDB nodes |
| `tutorial.html` | **Modify** | Update back-link `index.html` → `bread.html` |
| `freezer-data.csv` | **Rename** | `PSR-FREEZER-2026-01-23-to-2026-01-23.csv` → stable name for initial seed |
| `PSR-FREEZER-2026-01-23-to-2026-01-23.xlsx` | **Delete** | No longer needed |

---

## Task 1: Firestore Security Rules (Manual — Firebase Console)

**Files:** None (configured in Firebase Console)

- [ ] **Step 1: Open Firestore rules**

  Go to [Firebase Console](https://console.firebase.google.com) → select project `mve-bread` → Firestore Database → **Rules** tab.

- [ ] **Step 2: Set Phase 1 rules (temporarily open for upload)**

  Replace the rules with:
  ```
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /bread-orders/{doc} {
        allow read: if true;
        allow write: if true;  // TEMPORARY — Phase 1 only
      }
      match /freezer-orders/{doc} {
        allow read: if true;
        allow write: if true;  // TEMPORARY — Phase 1 only
      }
    }
  }
  ```

- [ ] **Step 3: Publish the rules**

  Click **Publish**. Rules take effect within ~60 seconds.

- [ ] **Step 4: Verify Firestore is reachable**

  Open this URL in your browser — you should get a JSON response (empty or `{}`, not a permissions error):
  ```
  https://firestore.googleapis.com/v1/projects/mve-bread/databases/(default)/documents/bread-orders?key=AIzaSyDGGpoqD-GlAF98dYxly7X7dQRWeUwpXY4
  ```

---

## Task 2: Update RTDB Rules for Freezer

**Files:**
- Modify: `config/firebase-rules.json`

- [ ] **Step 1: Update the rules file**

  Replace the entire contents of `config/firebase-rules.json` with:
  ```json
  {
    "rules": {
      "statuses": {
        ".read": true,
        "$key": {
          ".write": true,
          ".validate": "!newData.exists() || (\n  newData.hasChildren(['status', 'route', 'customer'])\n  && newData.child('status').isString()\n  && (newData.child('status').val() === 'checked' || newData.child('status').val() === 'unchecked' || newData.child('status').val() === 'missing')\n  && newData.child('route').isString()\n  && newData.child('customer').isString()\n  && (!newData.hasChild('qtyMissing') || newData.child('qtyMissing').isNumber())\n  && (!newData.hasChild('replacementWare') || newData.child('replacementWare').isString())\n)"
        }
      },
      "lastModified": {
        ".read": true,
        ".write": true,
        ".validate": "newData.isNumber()"
      },
      "freezer-statuses": {
        ".read": true,
        "$key": {
          ".write": true,
          ".validate": "!newData.exists() || (\n  newData.hasChildren(['status', 'route', 'customer'])\n  && newData.child('status').isString()\n  && (newData.child('status').val() === 'checked' || newData.child('status').val() === 'unchecked' || newData.child('status').val() === 'missing')\n  && newData.child('route').isString()\n  && newData.child('customer').isString()\n  && (!newData.hasChild('qtyMissing') || newData.child('qtyMissing').isNumber())\n  && (!newData.hasChild('replacementWare') || newData.child('replacementWare').isString())\n)"
        }
      },
      "freezer-lastModified": {
        ".read": true,
        ".write": true,
        ".validate": "newData.isNumber()"
      }
    }
  }
  ```

- [ ] **Step 2: Deploy rules to Firebase**

  Go to Firebase Console → Realtime Database → Rules tab → paste the same rules → **Publish**.

  *(The `config/firebase-rules.json` file is the source of truth in the repo; the Console is where they actually take effect.)*

- [ ] **Step 3: Commit**

  ```bash
  git add config/firebase-rules.json
  git commit -m "feat: add freezer-statuses and freezer-lastModified RTDB rules"
  ```

---

## Task 3: CSS — Blue Theme + Landing + Upload Styles

**Files:**
- Modify: `src/style.css` (append to end of file)

- [ ] **Step 1: Append new styles to `src/style.css`**

  Add at the very end of the file:
  ```css
  /* ─── FREEZER THEME ──────────────────────────────────────── */
  body.theme-freezer {
    --accent:     #4a9edd;
    --accent-dim: #2d6fa3;
    --done-bg:    #0d2535;
    --check:      #5ab8f5;
  }

  /* ─── LANDING PAGE ───────────────────────────────────────── */
  .landing-main {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: calc(100vh - 60px);
    padding: 2rem 1rem;
    gap: 1rem;
  }

  .landing-subtitle {
    color: var(--muted);
    font-size: 0.9rem;
    margin-bottom: 0.5rem;
    text-align: center;
  }

  .landing-btn {
    display: block;
    width: 100%;
    max-width: 400px;
    min-height: 80px;
    padding: 1.25rem 1.5rem;
    border: none;
    border-radius: 12px;
    font-size: 1.2rem;
    font-weight: 700;
    cursor: pointer;
    text-decoration: none;
    text-align: center;
    line-height: 1.3;
    transition: opacity 0.15s;
  }
  .landing-btn:active { opacity: 0.8; }

  .landing-btn-bread {
    background: var(--accent);
    color: #1a1a18;
  }

  .landing-btn-freezer {
    background: #4a9edd;
    color: #fff;
  }

  .landing-admin {
    margin-top: 2rem;
    color: var(--muted);
    font-size: 0.8rem;
    text-decoration: none;
  }
  .landing-admin:hover { color: var(--text); }

  /* ─── UPLOAD PAGE ────────────────────────────────────────── */
  .upload-main {
    padding: 1.5rem 1rem;
    max-width: 500px;
    margin: 0 auto;
  }

  .upload-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .upload-card h2 {
    font-size: 1rem;
    color: var(--muted);
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .upload-radio-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .upload-radio-group label {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-size: 1rem;
    cursor: pointer;
  }

  .upload-file-input {
    padding: 0.75rem;
    background: var(--bg);
    border: 1px dashed var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 0.95rem;
    width: 100%;
    box-sizing: border-box;
  }

  .upload-preview {
    font-size: 0.9rem;
    color: var(--muted);
    padding: 0.5rem 0;
  }
  .upload-preview.hidden { display: none; }

  .upload-btn {
    background: var(--accent);
    color: #1a1a18;
    border: none;
    border-radius: 8px;
    padding: 0.9rem 1.5rem;
    font-size: 1rem;
    font-weight: 700;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .upload-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .upload-btn:not(:disabled):active { opacity: 0.8; }

  .upload-status {
    font-size: 0.9rem;
    min-height: 1.4em;
    color: var(--muted);
  }
  .upload-status.error { color: #e84040; }
  .upload-status.success { color: var(--check); }
  ```

- [ ] **Step 2: Verify no existing styles broken**

  Open `index.html` in a browser via a local static server — existing styles should be unaffected (new classes are unused by the old page).

- [ ] **Step 3: Commit**

  ```bash
  git add src/style.css
  git commit -m "feat: add theme-freezer, landing page, and upload page CSS"
  ```

---

## Task 4: Create `bread.html` + New Landing `index.html`

**Files:**
- Create: `bread.html`
- Replace: `index.html`

- [ ] **Step 1: Copy current `index.html` to `bread.html`**

  ```bash
  cp "index.html" "bread.html"
  ```

- [ ] **Step 2: Verify `bread.html` works**

  Serve locally (`python3 -m http.server 8080` or VS Code Live Server). Open `http://localhost:8080/bread.html` — should look and work identical to the current app.

- [ ] **Step 3: Replace `index.html` with the landing chooser**

  Overwrite `index.html` entirely with:
  ```html
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
    <title>MVE Delivery — Choose List</title>
    <link rel="icon" href="assets/bread-basket.svg" type="image/svg+xml">
    <link rel="stylesheet" href="src/style.css">
  </head>
  <body>
    <header class="header">
      <img src="assets/bread-basket.svg" alt="" class="header-logo">
      <span class="header-title">MVE Delivery</span>
    </header>

    <main class="landing-main">
      <p class="landing-subtitle">Select a list to begin packing</p>
      <a href="bread.html" class="landing-btn landing-btn-bread">🍞 Bread list</a>
      <a href="freezer.html" class="landing-btn landing-btn-freezer">❄️ Freezer wares list</a>
      <a href="upload.html" class="landing-admin">Upload order data</a>
    </main>
  </body>
  </html>
  ```

- [ ] **Step 4: Verify landing page**

  Open `http://localhost:8080/` — two large buttons should appear with correct colours. Clicking "Bread list" should open `bread.html`.

- [ ] **Step 5: Commit**

  ```bash
  git add bread.html index.html
  git commit -m "feat: add landing chooser page; move bread list to bread.html"
  ```

---

## Task 5: Fix `tutorial.html` Back-Link

**Files:**
- Modify: `tutorial.html`

- [ ] **Step 1: Find and update the back-link**

  In `tutorial.html`, find the line containing `href="index.html"` (the Back button, around line 216) and change it to `href="bread.html"`.

- [ ] **Step 2: Verify**

  Open `http://localhost:8080/tutorial.html` → click Back → should land on `bread.html`, not the landing chooser.

- [ ] **Step 3: Commit**

  ```bash
  git add tutorial.html
  git commit -m "fix: update tutorial.html back-link to bread.html"
  ```

---

## Task 6: Migrate `script.js` to Firestore

**Files:**
- Modify: `src/script.js`

This task replaces the Google Sheets CSV fetch with a Firestore REST query. Everything downstream (rendering, RTDB sync, missing items) is untouched.

- [ ] **Step 1: Replace configuration block (lines 12–14)**

  Replace:
  ```js
  const SHEET_CSV_URL = "https://docs.google.com/...";
  const FIREBASE_URL = "https://mve-bread-default-rtdb.europe-west1.firebasedatabase.app";
  ```

  With:
  ```js
  const FIREBASE_URL    = 'https://mve-bread-default-rtdb.europe-west1.firebasedatabase.app';
  const FIRESTORE_KEY   = 'AIzaSyDGGpoqD-GlAF98dYxly7X7dQRWeUwpXY4';
  const FIRESTORE_URL   = 'https://firestore.googleapis.com/v1/projects/mve-bread/databases/(default)/documents';
  const FIRESTORE_COLL  = 'bread-orders';
  ```

- [ ] **Step 2: Add `firestoreDocToOrder()` helper after `rowToObject()` (after line 96)**

  Insert this new function:
  ```js
  // ─── FIRESTORE DOCUMENT → ORDER OBJECT ───────────────────
  // Maps a raw Firestore REST document to the same shape as rowToObject().
  function firestoreDocToOrder(doc, itemId) {
    const f = doc.fields;
    const num = key => parseInt(f[key]?.integerValue ?? f[key]?.doubleValue) || 0;
    return {
      itemKey      : f.itemKey.stringValue,
      orderNum     : f.orderNum.stringValue,
      qty          : num('qty'),
      ware         : f.ware.stringValue,
      supplier     : f.supplier?.stringValue || '',
      customer     : f.customer.stringValue,
      dept         : f.dept?.stringValue || '',
      route        : f.route.stringValue,
      routeOrdering: num('routeOrdering'),
      acceptAlts   : f.acceptAlts?.booleanValue === true,
      itemId       : String(itemId),
    };
  }
  ```

- [ ] **Step 3: Replace `fetchSheetData()` (lines 106–187) with `fetchOrderData()`**

  Delete the entire `fetchSheetData` function and replace with:
  ```js
  // ─── FETCH ORDER DATA FROM FIRESTORE ─────────────────────
  async function fetchOrderData() {
    showMsg('⏳', 'Loading…');
    console.log('[BreadRun] Fetching orders from Firestore…');

    const docs = [];
    let pageToken = null;

    try {
      do {
        const url = `${FIRESTORE_URL}/${FIRESTORE_COLL}?key=${FIRESTORE_KEY}&pageSize=300` +
                    (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '') +
                    `&_=${Date.now()}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.documents) docs.push(...data.documents);
        pageToken = data.nextPageToken || null;
      } while (pageToken);

      if (!docs.length) {
        showMsg('📭', 'No orders found — upload data first');
        return;
      }

      allOrderRows = docs
        .map((doc, i) => firestoreDocToOrder(doc, i))
        .filter(order => order.orderNum);

      if (!allOrderRows.length) {
        showMsg('📭', 'No valid orders in Firestore');
        return;
      }

      console.log(`[BreadRun] Loaded ${allOrderRows.length} items across ${[...new Set(allOrderRows.map(o => o.route))].length} routes`);

      // Rebuild route dropdown, preserving current selection if still valid
      const currentRoute = routeDropdown.value;
      while (routeDropdown.options.length > 1) routeDropdown.remove(1);

      const routes = [...new Set(allOrderRows.map(o => o.route))].sort((a, b) => {
        const na = parseInt(a), nb = parseInt(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      });

      routes.forEach(route => {
        const opt       = document.createElement('option');
        opt.value       = route;
        opt.textContent = `Route ${route}`;
        routeDropdown.appendChild(opt);
      });

      if (currentRoute && routes.includes(currentRoute)) {
        routeDropdown.value = currentRoute;
        renderCurrentRoute();
      } else {
        showMsg('🚚', 'Select your route to begin');
        document.getElementById('statsBar').style.display   = 'none';
        document.getElementById('summaryBox').style.display = 'none';
      }

      fetchStatuses();

      const el = document.getElementById('lastRefreshed');
      if (el) el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    } catch (err) {
      console.error('[BreadRun] Firestore fetch failed:', err);
      showMsg('⚠️', 'Could not load orders — ' + err.message);
    }
  }
  ```

- [ ] **Step 4: Update the call site and refresh listener (line ~189 and ~943)**

  Change:
  ```js
  fetchSheetData();
  ```
  to:
  ```js
  fetchOrderData();
  ```

  Change:
  ```js
  document.querySelector('.refresh-btn').addEventListener('click', fetchSheetData);
  ```
  to:
  ```js
  document.querySelector('.refresh-btn').addEventListener('click', fetchOrderData);
  ```

- [ ] **Step 5: Verify (requires bread-orders data in Firestore — skip if Task 10 not done yet, come back)**

  Open `http://localhost:8080/bread.html`. If `bread-orders` is empty you'll see "No orders found — upload data first". That's correct — seeding happens in Task 10.

- [ ] **Step 6: Commit**

  ```bash
  git add src/script.js
  git commit -m "feat: replace Google Sheets CSV fetch with Firestore REST query in script.js"
  ```

---

## Task 7: Create `src/freezer-script.js`

**Files:**
- Create: `src/freezer-script.js`

Start from the updated `script.js` and make the following changes.

- [ ] **Step 1: Copy `script.js` to `freezer-script.js`**

  ```bash
  cp src/script.js src/freezer-script.js
  ```

- [ ] **Step 2: Update the configuration block**

  Change the four constants at the top:
  ```js
  const FIREBASE_URL    = 'https://mve-bread-default-rtdb.europe-west1.firebasedatabase.app';
  const FIRESTORE_KEY   = 'AIzaSyDGGpoqD-GlAF98dYxly7X7dQRWeUwpXY4';
  const FIRESTORE_URL   = 'https://firestore.googleapis.com/v1/projects/mve-bread/databases/(default)/documents';
  const FIRESTORE_COLL  = 'freezer-orders';   // ← only this line differs
  ```

- [ ] **Step 3: Remove crate visualisation constants and functions**

  Delete the following from `freezer-script.js`:
  - The `CRATE_COLORS` array (lines ~36–39)
  - `CRATE_COMPACT_THRESHOLD` constant (line ~490)
  - `getWareColors()` function
  - `buildCrateData()` function
  - `renderOneCrate()` function
  - `crateVizHTML()` function

- [ ] **Step 4: Remove crate viz calls from `renderOrders()`**

  In `renderOrders()`, make these changes:

  Remove:
  ```js
  const wareColors = getWareColors(orders);
  ```

  Change single-dept customer header (remove `crateVizHTML` call):
  ```js
  // FROM:
  ${multiDept ? '' : crateVizHTML(buildCrateData(custOrders, wareColors))}
  // TO:
  ${''}
  ```
  (or simply remove that template literal line entirely)

  Change dept-divider (remove `crateVizHTML` call):
  ```js
  // FROM:
  html += `<div class="dept-divider">${dept || '—'}${crateVizHTML(buildCrateData(deptOrders, wareColors))}</div>`;
  // TO:
  html += `<div class="dept-divider">${dept || '—'}</div>`;
  ```

- [ ] **Step 5: Update ALL RTDB paths throughout `freezer-script.js`**

  Do a find-and-replace for these two patterns (they appear in `postStatus`, `deleteStatus`, `fetchStatuses`, `pollForChanges`, and `resetFirebaseRoute`):

  | Find | Replace with |
  |------|-------------|
  | `/statuses/` | `/freezer-statuses/` |
  | `/statuses.json` | `/freezer-statuses.json` |
  | `/lastModified` | `/freezer-lastModified` |

  After replacing, verify with a search that no bare `/statuses` remains in the file (there should be zero hits).

- [ ] **Step 7: Update the log prefix**

  Change `[BreadRun]` → `[FreezerRun]` throughout `freezer-script.js` for easier console debugging.

- [ ] **Step 8: Commit**

  ```bash
  git add src/freezer-script.js
  git commit -m "feat: add freezer-script.js with Firestore query and no crate viz"
  ```

---

## Task 8: Create `freezer.html`

**Files:**
- Create: `freezer.html`

- [ ] **Step 1: Copy `bread.html` to `freezer.html`**

  ```bash
  cp bread.html freezer.html
  ```

- [ ] **Step 2: Make freezer-specific edits to `freezer.html`**

  1. Change `<title>` from `Bread Run` → `Freezer Run`
  2. Add `class="theme-freezer"` to `<body>`
  3. Change the `<script src="src/script.js">` → `<script src="src/freezer-script.js">`
  4. Change the header title text to `Freezer Wares`
  5. In the header nav, change the existing "Missing items" link if it exists — or add a "← Bread list" back-link to `bread.html`

- [ ] **Step 3: Verify**

  Open `http://localhost:8080/freezer.html` — should show blue accent colour on the header and checkboxes. Shows "No orders found — upload data first" (correct, data not seeded yet).

- [ ] **Step 4: Commit**

  ```bash
  git add freezer.html
  git commit -m "feat: add freezer.html with blue theme"
  ```

---

## Task 9: Create Upload Page

**Files:**
- Create: `upload.html`
- Create: `src/upload-script.js`

### 9a — `upload.html`

- [ ] **Step 1: Create `upload.html`**

  ```html
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
    <title>Upload Orders — MVE Delivery</title>
    <link rel="icon" href="assets/bread-basket.svg" type="image/svg+xml">
    <link rel="stylesheet" href="src/style.css">
    <!--
      SheetJS v0.18.5 — for XLSX parsing.
      Get the SRI integrity hash from:
      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
      (Click the hash icon next to the file on cdnjs.cloudflare.com)
    -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
            integrity="REPLACE_WITH_SRI_HASH"
            crossorigin="anonymous"></script>
  </head>
  <body>
    <header class="header">
      <a href="index.html" class="info-btn" style="margin-right:auto">← Back</a>
      <span class="header-title">Upload Orders</span>
    </header>

    <main class="upload-main">
      <div class="upload-card">
        <h2>Choose list</h2>
        <div class="upload-radio-group">
          <label><input type="radio" name="collection" value="bread-orders" checked> 🍞 Bread orders</label>
          <label><input type="radio" name="collection" value="freezer-orders"> ❄️ Freezer orders</label>
        </div>

        <h2>Choose file</h2>
        <input type="file" id="fileInput" class="upload-file-input" accept=".csv,.xlsx">

        <div id="preview" class="upload-preview hidden"></div>

        <button id="uploadBtn" class="upload-btn" disabled>Upload to Firestore</button>

        <div id="status" class="upload-status"></div>
      </div>
    </main>

    <script src="src/upload-script.js"></script>
  </body>
  </html>
  ```

  > **Getting the SRI hash:** Go to https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js — on the cdnjs.com library page for xlsx, click the copy icon next to the `<script>` tag for v0.18.5; the copied tag includes the correct `integrity` attribute. Paste that hash in place of `REPLACE_WITH_SRI_HASH`. The page will fail silently (no SheetJS) if the hash is wrong or missing.

### 9b — `src/upload-script.js`

- [ ] **Step 2: Create `src/upload-script.js`**

  ```js
  // ═══════════════════════════════════════════════════════════
  // Upload Script — parses CSV or XLSX and writes to Firestore
  // ═══════════════════════════════════════════════════════════

  const FIRESTORE_KEY  = 'AIzaSyDGGpoqD-GlAF98dYxly7X7dQRWeUwpXY4';
  const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/mve-bread/databases/(default)/documents';

  // ─── COLUMN MAPPING (matches script.js COLS) ─────────────
  const COLS = {
    orderNum      : 0,
    qty           : 1,
    ware          : 3,
    supplier      : 6,
    customer      : 7,
    dept          : 8,
    route         : 11,
    routeOrdering : 12,
    acceptAlts    : 13,
  };

  // ─── CSV PARSER (copy of script.js parseCSV) ─────────────
  function parseCSV(text) {
    const rows  = [];
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const fields = [];
      let buf = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (inQ && line[i + 1] === '"') { buf += '"'; i++; }
          else inQ = !inQ;
        } else if (c === ',' && !inQ) { fields.push(buf.trim()); buf = ''; }
        else buf += c;
      }
      fields.push(buf.trim());
      rows.push(fields);
    }
    return rows;
  }

  function rowToOrder(fields) {
    const orderNum = String(fields[COLS.orderNum] || '').trim();
    const ware     = String(fields[COLS.ware]     || '').trim();
    if (!orderNum || !ware) return null;
    return {
      itemKey      : orderNum + '|' + ware,
      orderNum,
      qty          : parseInt(fields[COLS.qty])           || 0,
      ware,
      supplier     : String(fields[COLS.supplier]     || '').trim(),
      customer     : String(fields[COLS.customer]     || '').trim(),
      dept         : String(fields[COLS.dept]         || '').trim(),
      route        : String(fields[COLS.route]        || '').trim(),
      routeOrdering: parseInt(fields[COLS.routeOrdering]) || 0,
      acceptAlts   : String(fields[COLS.acceptAlts]   || '').trim().toUpperCase() === 'TRUE',
    };
  }

  // ─── PARSE FILE ───────────────────────────────────────────
  async function parseFile(file) {
    if (file.name.endsWith('.csv')) {
      const text = await file.text();
      const rows = parseCSV(text);
      return rows.slice(1).map(rowToOrder).filter(Boolean);
    }

    // XLSX: use SheetJS global XLSX
    const buf   = await file.arrayBuffer();
    const wb    = XLSX.read(buf, { type: 'array' });
    const ws    = wb.Sheets[wb.SheetNames[0]];
    const rows  = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    return rows.slice(1).map(rowToOrder).filter(Boolean);
  }

  // ─── FIRESTORE HELPERS ────────────────────────────────────
  function toFirestoreDoc(collection, docId, order) {
    return {
      fields: {
        itemKey      : { stringValue : order.itemKey },
        orderNum     : { stringValue : order.orderNum },
        qty          : { integerValue: String(order.qty) },
        ware         : { stringValue : order.ware },
        supplier     : { stringValue : order.supplier },
        customer     : { stringValue : order.customer },
        dept         : { stringValue : order.dept },
        route        : { stringValue : order.route },
        routeOrdering: { integerValue: String(order.routeOrdering) },
        acceptAlts   : { booleanValue: order.acceptAlts },
      },
    };
  }

  // Document ID: encodeURIComponent(itemKey) — deterministic, no encoding ambiguity
  function docId(order) {
    return encodeURIComponent(order.itemKey);
  }

  async function batchWrite(writes) {
    const url  = `https://firestore.googleapis.com/v1/projects/mve-bread/databases/(default):batchWrite?key=${FIRESTORE_KEY}`;
    const res  = await fetch(url, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ writes }),
    });
    if (!res.ok) throw new Error(`batchWrite HTTP ${res.status}`);
    return res.json();
  }

  async function listAllDocIds(collection) {
    const ids = [];
    let pageToken = null;
    do {
      const url = `${FIRESTORE_BASE}/${collection}?key=${FIRESTORE_KEY}&pageSize=300&mask.fieldPaths=itemKey` +
                  (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const res  = await fetch(url);
      if (!res.ok) throw new Error(`list HTTP ${res.status}`);
      const data = await res.json();
      if (data.documents) {
        data.documents.forEach(doc => {
          // Extract just the doc ID from the full resource name
          ids.push(doc.name.split('/').pop());
        });
      }
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    return ids;
  }

  async function deleteDocIds(collection, ids) {
    // Build delete writes
    const writes = ids.map(id => ({
      delete: `projects/mve-bread/databases/(default)/documents/${collection}/${id}`,
    }));
    // Chunk into 500
    for (let i = 0; i < writes.length; i += 500) {
      await batchWrite(writes.slice(i, i + 500));
    }
  }

  // ─── UPLOAD FLOW ─────────────────────────────────────────
  async function uploadOrders(orders, collection) {
    setStatus('', `Writing ${orders.length} rows…`);

    // Step 1: write all new documents (write-then-delete pattern)
    const newDocIds = new Set(orders.map(docId));
    const writeOps  = orders.map(order => ({
      update: {
        name  : `projects/mve-bread/databases/(default)/documents/${collection}/${docId(order)}`,
        fields: toFirestoreDoc(collection, docId(order), order).fields,
      },
    }));

    for (let i = 0; i < writeOps.length; i += 500) {
      setStatus('', `Writing rows ${i + 1}–${Math.min(i + 500, writeOps.length)} of ${writeOps.length}…`);
      await batchWrite(writeOps.slice(i, i + 500));
    }

    // Step 2: fetch existing doc IDs and delete those not in new set
    setStatus('', 'Removing stale rows…');
    const existingIds = await listAllDocIds(collection);
    const toDelete    = existingIds.filter(id => !newDocIds.has(id));
    if (toDelete.length) {
      await deleteDocIds(collection, toDelete);
    }

    setStatus('success', `✓ Uploaded ${orders.length} rows to ${collection}. ${toDelete.length} stale rows removed.`);
  }

  // ─── UI ───────────────────────────────────────────────────
  const fileInput  = document.getElementById('fileInput');
  const uploadBtn  = document.getElementById('uploadBtn');
  const previewEl  = document.getElementById('preview');
  const statusEl   = document.getElementById('status');

  let parsedOrders = [];

  function setStatus(type, msg) {
    statusEl.textContent  = msg;
    statusEl.className    = 'upload-status' + (type ? ' ' + type : '');
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    uploadBtn.disabled = true;
    parsedOrders = [];
    previewEl.classList.add('hidden');
    setStatus('', '');
    if (!file) return;

    setStatus('', 'Parsing file…');
    try {
      parsedOrders = await parseFile(file);
      const routes = [...new Set(parsedOrders.map(o => o.route))];
      previewEl.textContent = `Found ${parsedOrders.length} rows across ${routes.length} route(s): ${routes.join(', ')}`;
      previewEl.classList.remove('hidden');
      setStatus('', '');
      uploadBtn.disabled = parsedOrders.length === 0;
    } catch (err) {
      setStatus('error', 'Parse error: ' + err.message);
    }
  });

  uploadBtn.addEventListener('click', async () => {
    const collection = document.querySelector('input[name="collection"]:checked').value;
    uploadBtn.disabled = true;
    try {
      await uploadOrders(parsedOrders, collection);
    } catch (err) {
      setStatus('error', 'Upload failed: ' + err.message);
      uploadBtn.disabled = false;
    }
  });
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add upload.html src/upload-script.js
  git commit -m "feat: add upload page for CSV/XLSX to Firestore"
  ```

---

## Task 10: Seed Initial Data

**Files:**
- Rename: `PSR-FREEZER-2026-01-23-to-2026-01-23.csv` → `freezer-data.csv`
- Delete: `PSR-FREEZER-2026-01-23-to-2026-01-23.xlsx`

- [ ] **Step 1: Rename the freezer CSV and delete the XLSX**

  ```bash
  git mv "PSR-FREEZER-2026-01-23-to-2026-01-23.csv" "freezer-data.csv"
  git rm "PSR-FREEZER-2026-01-23-to-2026-01-23.xlsx"
  git commit -m "chore: rename freezer CSV to stable name, delete source xlsx"
  ```

- [ ] **Step 2: Upload freezer orders via the upload page**

  Open `http://localhost:8080/upload.html`:
  1. Select **Freezer orders**
  2. Choose `freezer-data.csv`
  3. Verify preview shows the correct row count and routes
  4. Click **Upload to Firestore**
  5. Wait for success message

- [ ] **Step 3: Export and upload bread orders**

  The bread list needs data in `bread-orders` before Task 11 verification will work. Export from the Google Sheet:
  1. Open the Google Sheet that backs the bread list
  2. File → Download → Comma Separated Values (.csv)
  3. Open `http://localhost:8080/upload.html`
  4. Select **Bread orders**, choose the exported CSV, click **Upload to Firestore**
  5. Wait for the success message

  Until this step is done, `bread.html` shows "No orders found — upload data first" — that is correct and expected.

- [ ] **Step 4: Verify freezer data in Firebase Console**

  Firebase Console → Firestore → `freezer-orders` collection → should contain documents with all the order fields.

- [ ] **Step 5: Verify `freezer.html` loads data**

  Open `http://localhost:8080/freezer.html` — route dropdown should populate. Select a route — orders should appear.

---

## Task 11: End-to-End Verification

- [ ] **Landing page:** `http://localhost:8080/` shows two buttons; both links work
- [ ] **Bread list:** `bread.html` loads orders from Firestore `bread-orders`; ticking writes to RTDB `/statuses/`
- [ ] **Freezer list:** `freezer.html` loads with blue accent; ticking writes to RTDB `/freezer-statuses/`
- [ ] **Isolation:** Tick an item on freezer — nothing changes in `/statuses/` (check Firebase Console)
- [ ] **Sorting Stage:** Summary box on both pages renders and saves correctly
- [ ] **Missing items:** Long-press on a freezer card — detail sheet opens; saves to `/freezer-statuses/`
- [ ] **Reset:** Freezer reset clears `/freezer-statuses/` only
- [ ] **Polling:** Mutate a `/freezer-statuses/` entry directly in Firebase Console → freezer page updates within 15s
- [ ] **No crate diagrams** anywhere on `freezer.html`
- [ ] **Upload page:** Re-upload `freezer-data.csv` → row count same, no duplicates on reload
- [ ] **Tutorial back-link:** `tutorial.html` → Back → lands on `bread.html`

- [ ] **Final commit and push to main**

  ```bash
  git push origin DevNewFeatureBranch
  # Then open a PR to merge into main
  ```

---

## Security Phase 2 Checklist (do before production go-live)

When ready to lock down Firestore writes:

- [ ] Create a Firebase Auth user (Console → Authentication → Add user) with email/password
- [ ] Set custom claim `admin: true` on that user (requires Firebase Admin SDK or Cloud Functions — Firebase Console does not support custom claims directly; use the [Admin SDK quickstart](https://firebase.google.com/docs/auth/admin/custom-claims))
- [ ] Add login form to `upload.html` (email + password → `signInWithEmailAndPassword` via Firebase Auth REST API)
- [ ] Update Firestore rules: change `allow write: if true` → `allow write: if request.auth != null && request.auth.token.admin == true`
- [ ] Publish updated rules
