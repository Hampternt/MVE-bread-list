// ═══════════════════════════════════════════════════════════════
// Bread Run — Route Checklist
// script.js
// ─────────────────────────────────────────────────────────────
// Data flow:
//   fetchSheetData() → allData[]
//   loadRoute() → renderCurrentRoute()
//   renderCurrentRoute() → renderSummary() + renderOrders()
//   checkbox change (delegated) → toggle / toggleSummaryItem → re-render
// ═══════════════════════════════════════════════════════════════

// ─── CONFIGURATION ────────────────────────────────────────────
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQtpZq0YITZ1P_7kRssEnU8JW8c-wXsq7odSN2GjcGmBsJAIrmtC0QWXjjv6tSafF_u-BJ90ZLvR5IK/pub?output=csv";
const FIREBASE_URL = "https://mve-bread-default-rtdb.europe-west1.firebasedatabase.app";

// ─── COLUMN MAPPING (0-indexed) ───────────────────────────────
// Matches: PSR-BREAD-2026-03-04 sheet exactly
const COLS = {
  orderNum      : 0,   // Order ID
  qty           : 1,   // Quantity
  // col 2 = Product ID (not used)
  ware          : 3,   // Product Name
  // col 4 = Supplier SKU (not used)
  // col 5 = Position (not used)
  supplier      : 6,   // Supplier
  customer      : 7,   // Customer
  dept          : 8,   // Department
  // col 9 = Delivery street (not used per brief)
  // col 10 = Comment (not used per brief)
  route         : 11,  // Route nickname
  routeOrdering : 12,  // Delivery order — higher = first in car = top of list
  acceptAlts    : 13,  // Accept alternatives (TRUE/FALSE)
};

// ─── STATE ────────────────────────────────────────────────────
let checked           = {};   // { route: { itemId: bool } }
let summaryChecked    = {};   // { route: { ware: bool } }
let summaryOpen       = false;
let summarySort       = 'qty-desc';  // 'qty-desc' = high→low  |  'qty-asc' = low→high
let allData           = [];   // all rows parsed from sheet
let lastKnownModified = null; // timestamp of last known Firebase write

// ─── CSV PARSER ───────────────────────────────────────────────
function parseCSV(text) {
  const rows  = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) { fields.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    fields.push(cur.trim());
    rows.push(fields);
  }
  return rows;
}

function rowToObject(fields) {
  return {
    orderNum      : String(fields[COLS.orderNum]       || '').trim(),
    qty           : parseInt(fields[COLS.qty])          || 0,
    ware          : String(fields[COLS.ware]            || '').trim(),
    supplier      : String(fields[COLS.supplier]        || '').trim(),
    customer      : String(fields[COLS.customer]        || '').trim(),
    dept          : String(fields[COLS.dept]            || '').trim(),
    route         : String(fields[COLS.route]           || '').trim(),
    routeOrdering : parseInt(fields[COLS.routeOrdering]) || 0,
    acceptAlts    : String(fields[COLS.acceptAlts]      || '').trim().toUpperCase() === 'TRUE',
  };
}

// ─── FETCH ────────────────────────────────────────────────────
const sel = document.getElementById('routeSelect');

function showMsg(icon, msg) {
  document.getElementById('content').innerHTML =
    `<div class="placeholder"><div class="big">${icon}</div><p>${msg}</p></div>`;
}

async function fetchSheetData() {
  if (!SHEET_CSV_URL || SHEET_CSV_URL === 'YOUR_GOOGLE_SHEETS_CSV_URL_HERE') {
    showMsg('⚠️', 'No sheet URL configured');
    return;
  }

  showMsg('⏳', 'Loading…');
  console.log('[BreadRun] Fetching sheet data…');

  const isLocal  = location.protocol === 'file:';
  const PROXY    = 'https://corsproxy.io/?';
  const bustUrl  = SHEET_CSV_URL + '&_=' + Date.now();
  const finalUrl = isLocal ? PROXY + encodeURIComponent(bustUrl) : bustUrl;

  try {
    const res = await fetch(finalUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error('Sheet appears empty');

    // Skip header row; skip rows with no order ID
    // itemId is a unique per-row index — orderNum alone isn't unique because
    // multiple bread line items can share the same Order ID.
    allData = rows.slice(1)
      .map((fields, i) => {
        const o = { ...rowToObject(fields), itemId: String(i) };
        o.itemKey = o.orderNum + '|' + o.ware;  // stable cross-device identity
        return o;
      })
      .filter(r => r.orderNum);

    if (!allData.length) {
      showMsg('📭', 'No orders found in sheet');
      return;
    }

    console.log(`[BreadRun] Sheet loaded — ${allData.length} items across ${[...new Set(allData.map(r => r.route))].length} routes`);

    // Rebuild route dropdown, preserving current selection if still valid
    const currentRoute = sel.value;
    while (sel.options.length > 1) sel.remove(1);

    const routes = [...new Set(allData.map(r => r.route))].sort((a, b) => {
      // Numeric sort where possible (1, 2 … 10), then alphabetic (hau 1, hau 2)
      const na = parseInt(a), nb = parseInt(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });

    routes.forEach(r => {
      const opt       = document.createElement('option');
      opt.value       = r;
      opt.textContent = `Route ${r}`;
      sel.appendChild(opt);
    });

    if (currentRoute && routes.includes(currentRoute)) {
      sel.value = currentRoute;
      renderCurrentRoute();  // re-render without wiping checked state
    } else {
      showMsg('🚚', 'Select your route to begin');
      document.getElementById('statsBar').style.display   = 'none';
      document.getElementById('summaryBox').style.display = 'none';
    }

    fetchStatuses(); // async — re-renders once statuses arrive; no-op if URL not set

  } catch (err) {
    console.error('[BreadRun] Sheet fetch failed:', err);
    showMsg('⚠️', 'Could not load sheet — ' + err.message);
  }
}

fetchSheetData();

// Immediately sync when the user returns to this tab.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && sel.value) {
    console.log('[BreadRun] Tab focused: fetching statuses…');
    fetchStatuses();
  }
});

// ─── STATUS SYNC ──────────────────────────────────────────────
// Applies an array of status rows (from GET or POST response) into local state.
function applyStatusRows(rows) {
  const keyToItem = {};
  allData.forEach(d => { keyToItem[d.itemKey] = { route: d.route, itemId: d.itemId }; });
  rows.forEach(r => {
    if (r.orderNum.startsWith('SUMMARY|')) {
      const [, rRoute, rWare] = r.orderNum.split('|');
      if (!summaryChecked[rRoute]) summaryChecked[rRoute] = {};
      summaryChecked[rRoute][rWare] = (r.status === 'checked');
      return;
    }
    const item = keyToItem[r.orderNum]; // orderNum column stores itemKey
    if (!item) return; // stale or old-format entry — ignore
    if (!checked[item.route]) checked[item.route] = {};
    if (r.status === 'checked')   checked[item.route][item.itemId] = true;
    if (r.status === 'unchecked') checked[item.route][item.itemId] = false;
  });
}

// Fetches individual item statuses from Firebase and re-renders.
// Silently no-ops if FIREBASE_URL is not set.
async function fetchStatuses() {
  if (!FIREBASE_URL) return;
  console.log('[BreadRun] Fetching item statuses from Firebase…');
  try {
    const res  = await fetch(`${FIREBASE_URL}/statuses.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data) {
      const rows = Object.entries(data).map(([key, val]) => ({
        orderNum: decodeURIComponent(key),
        ...val,
      }));
      applyStatusRows(rows);
    }
    if (sel.value) renderCurrentRoute();
  } catch (err) {
    console.warn('[BreadRun] Could not load statuses:', err.message);
  }
}

// Writes an individual item status to Firebase via PUT.
async function postStatus({ orderNum, route, customer, status }) {
  if (!FIREBASE_URL) return;
  const key = encodeURIComponent(orderNum);
  console.log(`[BreadRun] POST status — route=${route} customer="${customer}" item=${orderNum} status=${status}`);
  try {
    await fetch(`${FIREBASE_URL}/statuses/${key}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, route, customer }),
    });
    // Stamp a lastModified timestamp so other clients can detect this change cheaply.
    const ts = Date.now();
    lastKnownModified = ts;
    fetch(`${FIREBASE_URL}/lastModified.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ts),
    });
  } catch (err) {
    console.warn('[BreadRun] Could not save status:', err.message);
  }
}

// Deletes an individual item status from Firebase.
async function deleteStatus(orderNum) {
  if (!FIREBASE_URL) return;
  const key = encodeURIComponent(orderNum);
  try {
    await fetch(`${FIREBASE_URL}/statuses/${key}.json`, { method: 'DELETE' });
    const ts = Date.now();
    lastKnownModified = ts;
    fetch(`${FIREBASE_URL}/lastModified.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ts),
    });
  } catch (err) {
    console.warn('[BreadRun] Could not delete status:', err.message);
  }
}

// Polls /lastModified — a single tiny number — every 15 s.
// Only fetches full statuses when the timestamp has actually changed.
async function pollForChanges() {
  if (!FIREBASE_URL || !sel.value) return;
  try {
    const res = await fetch(`${FIREBASE_URL}/lastModified.json`);
    if (!res.ok) return;
    const ts = await res.json();
    if (!ts) return;
    if (lastKnownModified === null) {
      lastKnownModified = ts; // first poll — just initialise, no redundant fetch
      return;
    }
    if (ts !== lastKnownModified) {
      lastKnownModified = ts;
      console.log('[BreadRun] Remote change detected — fetching statuses…');
      fetchStatuses();
    }
  } catch (err) {
    console.warn('[BreadRun] Poll failed:', err.message);
  }
}

setInterval(pollForChanges, 15_000);

// ─── ROUTE LOADING ────────────────────────────────────────────
function loadRoute() {
  const route = sel.value;
  if (!route) {
    document.getElementById('summaryBox').style.display = 'none';
    document.getElementById('statsBar').style.display   = 'none';
    showMsg('🚚', 'Select your route to begin');
    return;
  }
  renderCurrentRoute();
}

function renderCurrentRoute() {
  const route  = sel.value;
  const orders = getRouteOrders(route);

  if (!orders.length) {
    showMsg('📭', 'No orders for this route');
    return;
  }

  document.getElementById('statsBar').style.display = 'flex';
  updateStats(orders);
  renderSummary(orders);
  renderOrders(orders);
}

// Returns all orders for a given route
function getRouteOrders(route) {
  return allData.filter(r => r.route === route);
}

// Returns customers grouped and sorted by highest routeOrdering first.
// Position never changes once the route is loaded — completion is
// shown via cg-done styling only, no jumping.
function sortedCustomers(orders) {
  const customerMap = {};
  orders.forEach(o => {
    if (!customerMap[o.customer]) {
      customerMap[o.customer] = { orders: [], maxOrdering: 0 };
    }
    customerMap[o.customer].orders.push(o);
    if (o.routeOrdering > customerMap[o.customer].maxOrdering) {
      customerMap[o.customer].maxOrdering = o.routeOrdering;
    }
  });
  return Object.entries(customerMap).sort((a, b) => b[1].maxOrdering - a[1].maxOrdering);
}

// ─── SUMMARY (SORTING STAGE) ──────────────────────────────────
function toggleSummary() {
  summaryOpen = !summaryOpen;
  document.getElementById('summaryItems').classList.toggle('open', summaryOpen);
  document.getElementById('summaryChevron').classList.toggle('open', summaryOpen);
}

function renderSummary(orders) {
  const route        = orders[0].route;
  const routeSummary = summaryChecked[route] || {};

  // Total quantity per product type across all orders on this route
  const totals = {};
  orders.forEach(o => { totals[o.ware] = (totals[o.ware] || 0) + o.qty; });

  // Unchecked types first (by qty), then checked types (by qty)
  const all = Object.entries(totals).sort((a, b) => {
    const byQty = summarySort === 'qty-desc' ? b[1] - a[1] : a[1] - b[1];
    return byQty !== 0 ? byQty : a[0].localeCompare(b[0]);
  });
  document.getElementById('summarySortBtn').textContent =
    summarySort === 'qty-desc' ? 'QTY ↓' : 'QTY ↑';
  const unchecked = all.filter(([w]) => !routeSummary[w]);
  const doneItems = all.filter(([w]) =>  routeSummary[w]);
  const entries   = [...unchecked, ...doneItems];

  document.getElementById('summarySubtitle').textContent =
    `${doneItems.length}/${entries.length} types sorted`;

  const box = document.getElementById('summaryItems');

  // Ware name is stored in data-ware (HTML-encoded) — no inline JS quoting needed.
  // The label wraps the checkbox so the entire row is a valid tap target.
  box.innerHTML = entries.map(([ware, qty]) => {
    const isCk     = !!routeSummary[ware];
    const safeId   = 'sum-' + ware.replace(/[^a-zA-Z0-9]/g, '-');
    const safeWare = ware.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `
      <div class="summary-row ${isCk ? 's-checked' : ''}" id="${safeId}" data-ware="${safeWare}">
        <label>
          <div class="summary-checkbox-area">
            <input type="checkbox" name="${safeId}" ${isCk ? 'checked' : ''}>
          </div>
          <div class="summary-label-content">
            <span class="summary-ware">${ware}</span>
            <span class="summary-qty">${qty} stk</span>
          </div>
        </label>
      </div>`;
  }).join('');

  box.classList.toggle('open', summaryOpen);
  document.getElementById('summaryChevron').classList.toggle('open', summaryOpen);
  document.getElementById('summaryBox').style.display = 'block';
}

// Delegated listener on the container — survives innerHTML replacement in renderSummary
document.getElementById('summaryItems').addEventListener('change', e => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  const row   = e.target.closest('.summary-row');
  const ware  = row.dataset.ware;
  const route = sel.value;
  if (!summaryChecked[route]) summaryChecked[route] = {};
  summaryChecked[route][ware] = !summaryChecked[route][ware];
  if (summaryChecked[route][ware]) {
    postStatus({ orderNum: 'SUMMARY|' + route + '|' + ware, route, customer: '', status: 'checked' });
  } else {
    deleteStatus('SUMMARY|' + route + '|' + ware);
  }
  renderSummary(getRouteOrders(route));
});

// ─── ORDER LIST ───────────────────────────────────────────────
function renderOrders(orders) {
  // Preserve scroll position — don't jump to top on every checkbox tap
  const content      = document.getElementById('content');
  const scrollY      = window.scrollY;
  const route        = orders[0].route;
  const routeChecked = checked[route] || {};
  const customers    = sortedCustomers(orders);
  const allDone      = orders.every(o => routeChecked[o.itemId]);

  let html = '';

  if (allDone && orders.length > 0) {
    html += `<div class="all-done"><div class="icon">✅</div><p>Route complete!</p></div>`;
  }

  // ─── CUSTOMER GROUP ──────────────────────────────────────────
  customers.forEach(([customer, { orders: custOrders }]) => {
    const custDone    = custOrders.filter(o => routeChecked[o.itemId]).length;
    const allCustDone = custDone === custOrders.length;
    const effectiveDone = allCustDone;
    const inProgress    = !effectiveDone && custDone > 0;

    html += `
      <div class="customer-group ${effectiveDone ? 'cg-done' : inProgress ? 'cg-in-progress' : ''}">
        <div class="customer-header">
          <span class="customer-name">${customer}</span>
          ${inProgress ? '<span class="status-pip"></span>' : ''}
          <span class="customer-tally ${effectiveDone ? 'tally-done' : ''}">${custDone}/${custOrders.length}</span>
        </div>
        <div class="customer-orders">`;

    // Pending items first, checked items sink to bottom — dept-aware sub-grouping
    const depts = [...new Set(custOrders.map(o => o.dept))];
    if (depts.length <= 1) {
      const pending = custOrders.filter(o => !routeChecked[o.itemId]);
      const done    = custOrders.filter(o =>  routeChecked[o.itemId]);
      [...pending, ...done].forEach(o => { html += cardHTML(o, routeChecked); });
    } else {
      depts.forEach(dept => {
        const deptOrders = custOrders.filter(o => o.dept === dept);
        const pending    = deptOrders.filter(o => !routeChecked[o.itemId]);
        const done       = deptOrders.filter(o =>  routeChecked[o.itemId]);
        html += `<div class="dept-divider">${dept || '—'}</div>`;
        [...pending, ...done].forEach(o => { html += cardHTML(o, routeChecked); });
      });
    }

    html += `</div></div>`;
  });

  html += `<button class="reset-btn">↺ Reset checklist</button>`;
  content.innerHTML = html;

  window.scrollTo({ top: scrollY, behavior: 'instant' });
}

// ─── ORDER CARD ───────────────────────────────────────────────
// orderNum is stored in data-order (HTML-encoded) — no inline JS quoting needed.
function cardHTML(o, routeChecked) {
  const isCk = !!routeChecked[o.itemId];
  return `
    <div class="order-card ${isCk ? 'checked' : ''}" data-item="${o.itemId}">
      <label>
        <div class="checkbox-area">
          <input type="checkbox" name="ord-${o.itemId}" ${isCk ? 'checked' : ''}>
        </div>
        <div class="order-info">
          <div class="order-top">
            <span class="ware-name">${o.ware}</span>
            <span class="qty-badge">QTY: ${o.qty}</span>
          </div>
          <div class="order-meta">
            <span class="meta-item">
              <span class="meta-label">Order</span>&nbsp;
              <span class="meta-value">${o.orderNum}</span>
            </span>
            <span class="meta-item">
              <span class="meta-label">Supplier</span>&nbsp;
              <span class="meta-value">${o.supplier}</span>
            </span>
          </div>
          ${o.acceptAlts ? '<div class="alts-badge">&#x21C6; Accepts alternatives</div>' : ''}
        </div>
      </label>
    </div>`;
}

// Delegated listener on content — survives innerHTML replacement in renderOrders.
// Handles both order-card checkboxes and the reset button.
document.getElementById('content').addEventListener('change', async e => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  const card   = e.target.closest('.order-card');
  if (!card) return;
  const itemId = card.dataset.item;
  const route  = sel.value;
  if (!checked[route]) checked[route] = {};
  checked[route][itemId] = !checked[route][itemId];

  const orders       = getRouteOrders(route);
  const routeChecked = checked[route];

  // POST individual item state
  const changedItem = orders.find(o => o.itemId === itemId);
  if (changedItem && FIREBASE_URL) {
    const isNowChecked = !!checked[route][itemId];
    console.log(`[BreadRun] Checkbox toggled — route=${route} customer="${changedItem.customer}" ware="${changedItem.ware}" → ${isNowChecked ? 'checked' : 'unchecked'}`);

    // After a customer is fully done, show overlay, PUT then GET to pick up
    // any other drivers' changes before re-rendering.
    const custOrders  = orders.filter(o => o.customer === changedItem.customer);
    const allCustDone = custOrders.every(o => checked[route][o.itemId]);
    if (allCustDone) {
      const syncOverlay = document.getElementById('syncOverlay');
      syncOverlay.classList.add('open');
      if (isNowChecked) {
        await postStatus({ orderNum: changedItem.itemKey, route, customer: changedItem.customer, status: 'checked' });
      } else {
        await deleteStatus(changedItem.itemKey);
      }
      await fetchStatuses(); // GET after PUT/DELETE — no race, picks up other drivers' changes
      syncOverlay.classList.remove('open');
      return; // fetchStatuses() → renderCurrentRoute() handles the re-render
    } else {
      if (isNowChecked) {
        postStatus({ orderNum: changedItem.itemKey, route, customer: changedItem.customer, status: 'checked' });
      } else {
        deleteStatus(changedItem.itemKey);
      }
    }
  }

  updateStats(orders);
  renderOrders(orders);
});

document.getElementById('content').addEventListener('click', e => {
  if (e.target.closest('.reset-btn')) askReset();
});

// ─── STATS BAR ────────────────────────────────────────────────
function updateStats(orders) {
  const route        = orders[0].route;
  const routeChecked = checked[route] || {};
  const doneCount    = orders.filter(o => routeChecked[o.orderNum]).length;
  const totalQty     = orders.reduce((s, o) => s + o.qty, 0);
  document.getElementById('statTotal').textContent = orders.length;
  document.getElementById('statDone').textContent  = doneCount;
  document.getElementById('statQty').textContent   = totalQty;
}

// ─── RESET WITH CONFIRMATION ──────────────────────────────────
function askReset() {
  document.getElementById('confirmOverlay').classList.add('open');
}

function closeConfirm() {
  document.getElementById('confirmOverlay').classList.remove('open');
}

function doReset() {
  closeConfirm();
  const route  = sel.value;
  const orders = getRouteOrders(route);
  checked[route]        = {};
  summaryChecked[route] = {};
  updateStats(orders);
  renderSummary(orders);
  renderOrders(orders);
  resetFirebaseRoute(route, orders); // async, fire-and-forget
}

// Clears all Firebase entries for a route via a single PATCH with null values.
async function resetFirebaseRoute(route, orders) {
  if (!FIREBASE_URL) return;
  const patch = {};
  orders.forEach(o => { patch[encodeURIComponent(o.itemKey)] = null; });
  const wares = [...new Set(orders.map(o => o.ware))];
  wares.forEach(w => { patch[encodeURIComponent('SUMMARY|' + route + '|' + w)] = null; });
  try {
    await fetch(`${FIREBASE_URL}/statuses.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const ts = Date.now();
    lastKnownModified = ts;
    fetch(`${FIREBASE_URL}/lastModified.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ts),
    });
  } catch (err) {
    console.warn('[BreadRun] Could not reset Firebase route:', err.message);
  }
}

// ─── STATIC UI WIRING ────────────────────────────────────────
// Attach handlers to elements that exist on page load
document.querySelector('.refresh-btn').addEventListener('click', fetchSheetData);
document.getElementById('routeSelect').addEventListener('change', loadRoute);
document.querySelector('.summary-toggle').addEventListener('click', toggleSummary);
document.getElementById('summarySortBtn').addEventListener('click', e => {
  e.stopPropagation();  // prevent triggering expand/collapse on the parent
  summarySort = summarySort === 'qty-desc' ? 'qty-asc' : 'qty-desc';
  renderSummary(getRouteOrders(sel.value));
});
document.querySelector('.confirm-cancel').addEventListener('click', closeConfirm);
document.querySelector('.confirm-ok').addEventListener('click', doReset);
document.getElementById('confirmOverlay').addEventListener('click', function (e) {
  if (e.target === this) closeConfirm();
});
