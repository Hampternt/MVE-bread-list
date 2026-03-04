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
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwc9gXaLxB2eRZF3cV_cJwwn2HRhq4aVd0-YRaPl7kuUSQUqWbJzy9GFQgfEtWgriM_XQ/exec"; // paste deployed Web App URL here to enable status sync

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
  // col 8 = Department (not used for now)
  // col 9 = Delivery street (not used per brief)
  // col 10 = Comment (not used per brief)
  route         : 11,  // Route nickname
  routeOrdering : 12,  // Delivery order — higher = first in car = top of list
  // col 13 = Accept alternatives (not used)
};

// ─── STATE ────────────────────────────────────────────────────
let checked        = {};   // { route: { itemId: bool } }
let summaryChecked = {};   // { route: { ware: bool } }
let customerStatus = {};   // { route: { orderNum: 'in_progress'|'done' } } — from Google Sheets
let summaryOpen    = true;
let summarySort    = 'qty-desc';  // 'qty-desc' = high→low  |  'qty-asc' = low→high
let allData        = [];   // all rows parsed from sheet

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
    route         : String(fields[COLS.route]           || '').trim(),
    routeOrdering : parseInt(fields[COLS.routeOrdering]) || 0,
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
      .map((fields, i) => ({ ...rowToObject(fields), itemId: String(i) }))
      .filter(r => r.orderNum);

    if (!allData.length) {
      showMsg('📭', 'No orders found in sheet');
      return;
    }

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
    console.error(err);
    showMsg('⚠️', 'Could not load sheet — ' + err.message);
  }
}

fetchSheetData();

// ─── STATUS SYNC ──────────────────────────────────────────────
// Fetches customer statuses from the Apps Script Web App and re-renders.
// Silently no-ops if APPS_SCRIPT_URL is not set.
async function fetchStatuses() {
  if (!APPS_SCRIPT_URL) return;
  try {
    const res = await fetch(APPS_SCRIPT_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();

    // Only keep statuses for order numbers that exist in the current sheet data
    const validOrderNums = new Set(allData.map(r => r.orderNum));
    customerStatus = {};
    rows.forEach(r => {
      if (!validOrderNums.has(r.orderNum)) return; // stale entry — new run, ignore
      if (!customerStatus[r.route]) customerStatus[r.route] = {};
      customerStatus[r.route][r.orderNum] = r.status;
    });

    if (sel.value) renderCurrentRoute();
  } catch (err) {
    console.warn('Could not load statuses:', err.message);
  }
}

// Posts a customer status update to the Apps Script Web App.
async function postStatus({ orderNum, route, customer, status }) {
  if (!APPS_SCRIPT_URL) return;
  try {
    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNum, route, customer, status }),
    });
  } catch (err) {
    console.warn('Could not save status:', err.message);
  }
}

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
    const custDone     = custOrders.filter(o => routeChecked[o.itemId]).length;
    const allCustDone  = custDone === custOrders.length;
    const orderNum     = custOrders[0].orderNum;
    const remoteStatus = (customerStatus[route] || {})[orderNum];
    const effectiveDone = allCustDone || remoteStatus === 'done';
    const inProgress    = !effectiveDone && (custDone > 0 || remoteStatus === 'in_progress');

    html += `
      <div class="customer-group ${effectiveDone ? 'cg-done' : inProgress ? 'cg-in-progress' : ''}">
        <div class="customer-header">
          <span class="customer-name">${customer}</span>
          ${inProgress ? '<span class="status-pip"></span>' : ''}
          <span class="customer-tally ${effectiveDone ? 'tally-done' : ''}">${custDone}/${custOrders.length}</span>
        </div>
        <div class="customer-orders">`;

    // Pending items first, checked items sink to bottom
    const pending = custOrders.filter(o => !routeChecked[o.itemId]);
    const done    = custOrders.filter(o =>  routeChecked[o.itemId]);
    [...pending, ...done].forEach(o => { html += cardHTML(o, routeChecked); });

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
        </div>
      </label>
    </div>`;
}

// Delegated listener on content — survives innerHTML replacement in renderOrders.
// Handles both order-card checkboxes and the reset button.
document.getElementById('content').addEventListener('change', e => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  const card   = e.target.closest('.order-card');
  if (!card) return;
  const itemId = card.dataset.item;
  const route  = sel.value;
  if (!checked[route]) checked[route] = {};
  checked[route][itemId] = !checked[route][itemId];

  const orders       = getRouteOrders(route);
  const routeChecked = checked[route];

  // Determine new customer status and POST it
  const changedItem = orders.find(o => o.itemId === itemId);
  if (changedItem && APPS_SCRIPT_URL) {
    const custOrders   = orders.filter(o => o.customer === changedItem.customer);
    const checkedCount = custOrders.filter(o => routeChecked[o.itemId]).length;
    const newStatus    = checkedCount === custOrders.length ? 'done'
                       : checkedCount > 0                  ? 'in_progress'
                       : null;
    if (newStatus) {
      const orderNum = custOrders[0].orderNum;
      if (!customerStatus[route]) customerStatus[route] = {};
      customerStatus[route][orderNum] = newStatus;
      postStatus({ orderNum, route, customer: changedItem.customer, status: newStatus });
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
