# Missing Items Report Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create `missing-report.html` — a standalone read-only page that fetches all missing-status items from Firebase and displays them in two visual sections (replaced vs fully missing).

**Architecture:** Single self-contained HTML file with an inline `<style>` block and inline `<script>`. Fetches `GET {FIREBASE_URL}/statuses.json` once on load, filters for `status === 'missing'`, skips `SUMMARY|` keys, decodes ware name + order number from the itemKey (`orderNum|ware`), and renders two sections. Manual refresh button re-runs the fetch.

**Tech Stack:** Vanilla HTML/CSS/JS, Firebase Realtime Database REST API (same URL as `script.js`).

---

### Task 1: Create `missing-report.html` — shell + styles

**Files:**
- Create: `missing-report.html`

**Step 1: Create the file with HTML shell, `<style>` block, and static header**

The `<style>` block must define the same design tokens as `style.css` (copy the `:root` block verbatim). Add rules for:
- `body`, `header` — matching main app
- `.report-section` — grouping wrapper with a heading
- `.report-card` — one row per missing item; `border-left: 4px solid` coloured by state
  - `.report-card.replaced` → `border-left-color: #e8c840` (amber), `background: #26230e`
  - `.report-card.fully-missing` → `border-left-color: #bf4040`, `background: #281818`
- `.card-ware` — product name, large, Barlow Condensed 700
- `.card-meta` — DM Mono 12px row of pills: Route · Customer · Order · Qty · Replacement
- `.meta-pill` — small label+value pair, same `.meta-item` pattern from main app
- `.empty-state` — centred placeholder (same `.placeholder` style)
- `.refresh-btn` — reuse exact styles from main app's `.refresh-btn`
- `.status-badge` — small pill: "REPLACED" (amber) or "MISSING" (red), DM Mono 11px uppercase
- `#loadingMsg`, `#errorMsg` — simple centred DM Mono feedback text

HTML body structure:
```html
<header> <!-- logo + title "Missing Items Report" + refresh button --> </header>
<div id="loadingMsg">…</div>
<div id="errorMsg" style="display:none">…</div>
<div id="report" style="display:none">
  <section class="report-section" id="sectionReplaced">
    <h2 class="section-heading">Replaced</h2>
    <div id="listReplaced"></div>
  </section>
  <section class="report-section" id="sectionMissing">
    <h2 class="section-heading">Fully Missing</h2>
    <div id="listMissing"></div>
  </section>
</div>
```

Add `.section-heading` style: DM Mono 11px, uppercase, letter-spacing, `color: var(--muted)`, padding `12px 16px 6px`, border-bottom.

**Step 2: Verify the file renders the static shell correctly**

Open `missing-report.html` in a browser (or via the live site after push). You should see the dark header and nothing else (no data yet — script not added).

---

### Task 2: Add fetch + render logic in `<script>`

**Files:**
- Modify: `missing-report.html` — add `<script>` before `</body>`

**Step 1: Add the Firebase URL constant and `fetchMissing()` function**

```js
const FIREBASE_URL = 'https://mve-bread-default-rtdb.europe-west1.firebasedatabase.app';

async function fetchMissing() {
  document.getElementById('loadingMsg').style.display = 'block';
  document.getElementById('errorMsg').style.display  = 'none';
  document.getElementById('report').style.display    = 'none';

  try {
    const res  = await fetch(`${FIREBASE_URL}/statuses.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    render(data);
  } catch (err) {
    document.getElementById('loadingMsg').style.display = 'none';
    document.getElementById('errorMsg').style.display  = 'block';
    document.getElementById('errorMsg').textContent    = `Could not load data — ${err.message}`;
  }
}
```

**Step 2: Add the `render(data)` function**

```js
function render(data) {
  const replaced = [];
  const missing  = [];

  if (data) {
    Object.entries(data).forEach(([encodedKey, val]) => {
      if (val.status !== 'missing') return;
      const key = decodeURIComponent(encodedKey);
      if (key.startsWith('SUMMARY|')) return;

      const pipeIdx  = key.indexOf('|');
      const orderNum = pipeIdx >= 0 ? key.slice(0, pipeIdx) : key;
      const ware     = pipeIdx >= 0 ? key.slice(pipeIdx + 1) : key;

      const item = { orderNum, ware, route: val.route || '—', customer: val.customer || '—',
                     qtyMissing: val.qtyMissing ?? null, replacementWare: val.replacementWare ?? null };

      if (item.replacementWare) replaced.push(item);
      else                       missing.push(item);
    });
  }

  document.getElementById('listReplaced').innerHTML =
    replaced.length ? replaced.map(cardHTML).join('') : emptyHTML('No replaced items');

  document.getElementById('listMissing').innerHTML =
    missing.length  ? missing.map(cardHTML).join('')  : emptyHTML('No fully missing items');

  // Hide sections with no items and no counterpart — but always show both headings so layout is clear
  document.getElementById('sectionReplaced').style.display = replaced.length || missing.length ? '' : 'none';

  document.getElementById('loadingMsg').style.display = 'none';
  document.getElementById('report').style.display     = 'block';
}
```

**Step 3: Add `cardHTML(item)` and `emptyHTML(msg)` helpers**

```js
function cardHTML(item) {
  const cardClass = item.replacementWare ? 'replaced' : 'fully-missing';
  const badgeClass = item.replacementWare ? 'badge-replaced' : 'badge-missing';
  const badgeText  = item.replacementWare ? 'REPLACED'       : 'MISSING';
  const replHTML   = item.replacementWare
    ? `<span class="meta-pill"><span class="meta-label">Replacement</span>&nbsp;<span class="meta-value">${item.replacementWare}</span></span>`
    : '';
  const qtyHTML = item.qtyMissing != null
    ? `<span class="meta-pill"><span class="meta-label">Qty missing</span>&nbsp;<span class="meta-value">${item.qtyMissing}</span></span>`
    : '';

  return `
    <div class="report-card ${cardClass}">
      <div class="card-top">
        <span class="card-ware">${item.ware}</span>
        <span class="status-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="card-meta">
        <span class="meta-pill"><span class="meta-label">Route</span>&nbsp;<span class="meta-value">${item.route}</span></span>
        <span class="meta-pill"><span class="meta-label">Customer</span>&nbsp;<span class="meta-value">${item.customer}</span></span>
        <span class="meta-pill"><span class="meta-label">Order</span>&nbsp;<span class="meta-value">${item.orderNum}</span></span>
        ${qtyHTML}${replHTML}
      </div>
    </div>`;
}

function emptyHTML(msg) {
  return `<div class="empty-state"><p>${msg}</p></div>`;
}
```

**Step 4: Wire up fetch on load and refresh button**

```js
document.querySelector('.refresh-btn').addEventListener('click', fetchMissing);
fetchMissing();
```

**Step 5: Manual verify**

Open the page in a browser. With no missing items in Firebase you should see the two section headings and "No replaced items" / "No fully missing items" empty states. Mark an item missing in the main app, refresh this page — the card should appear in the correct section with correct data.

**Step 6: Commit**

```bash
git add missing-report.html
git commit -m "Add missing items report page"
```
