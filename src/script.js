// ═══════════════════════════════════════════════════════════════
// Bread Run — Route Checklist
// script.js
// ─────────────────────────────────────────────────────────────
// Data flow:
//   fetchSheetData() → allOrderRows[]
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
// itemChecked      — { route: { itemId: bool } } — which order cards are ticked
// itemId is a session-local row index, not stored in Firebase; see itemKey below.
let itemChecked          = {};
// summaryTypeChecked — { route: { ware: bool } } — which Sorting Stage bread types are ticked
let summaryTypeChecked   = {};
// isSummaryOpen    — whether the Sorting Stage collapsible is expanded
let isSummaryOpen        = false;
// summaryProductSort — sort direction for the summary list: 'qty-desc' | 'qty-asc'
let summaryProductSort   = 'qty-desc';
// allOrderRows     — every data row from the Google Sheet (header stripped, filtered to rows with an orderNum)
let allOrderRows         = [];
// lastFirebaseWriteTime — Unix ms timestamp of the last write we know about at /lastModified
//                          Used by the 15 s poller to detect remote changes without a full fetch.
let lastFirebaseWriteTime = null;
// itemMissingData — { route: { itemId: { qtyMissing, replacementWare } } }
//                   Entry present = item is missing; values may be null if detail not yet filled.
let itemMissingData    = {};
// missingDetailTarget — { route, itemId, acceptAlts } | null — which card's detail sheet is open
let missingDetailTarget = null;

// ─── CSV PARSER ───────────────────────────────────────────────
function parseCSV(text) {
  const rows  = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = [];
    let fieldBuffer = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') { fieldBuffer += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) { fields.push(fieldBuffer.trim()); fieldBuffer = ''; }
      else fieldBuffer += char;
    }
    fields.push(fieldBuffer.trim());
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
const routeDropdown = document.getElementById('routeSelect');

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

  const isLocalFileProtocol = location.protocol === 'file:';
  const PROXY               = 'https://corsproxy.io/?';
  // Google Sheets CDN caches aggressively — append a timestamp to bypass it.
  const cacheBustedUrl = SHEET_CSV_URL + '&_=' + Date.now();
  // When opened via file:// the browser blocks cross-origin fetches, so we route
  // through a CORS proxy. On a real server the sheet URL is fetched directly.
  const fetchUrl = isLocalFileProtocol ? PROXY + encodeURIComponent(cacheBustedUrl) : cacheBustedUrl;

  try {
    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error('Sheet appears empty');

    // Skip header row; skip rows with no order ID.
    // itemId uses the row index (not orderNum) because a single Order ID can
    // span multiple bread line items (one per product type).
    allOrderRows = rows.slice(1)
      .map((fields, i) => {
        const order = { ...rowToObject(fields), itemId: String(i) };
        // itemKey = "orderNum|ware" — stable cross-device identity stored in Firebase.
        // Unlike itemId (session-local index), itemKey survives page reloads.
        order.itemKey = order.orderNum + '|' + order.ware;
        return order;
      })
      .filter(order => order.orderNum);

    if (!allOrderRows.length) {
      showMsg('📭', 'No orders found in sheet');
      return;
    }

    console.log(`[BreadRun] Sheet loaded — ${allOrderRows.length} items across ${[...new Set(allOrderRows.map(order => order.route))].length} routes`);

    // Rebuild route dropdown, preserving current selection if still valid
    const currentRoute = routeDropdown.value;
    while (routeDropdown.options.length > 1) routeDropdown.remove(1);

    const routes = [...new Set(allOrderRows.map(order => order.route))].sort((a, b) => {
      // Numeric sort where possible (1, 2 … 10), then alphabetic (hau 1, hau 2)
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
      renderCurrentRoute();  // re-render without wiping checked state
    } else {
      showMsg('🚚', 'Select your route to begin');
      document.getElementById('statsBar').style.display   = 'none';
      document.getElementById('summaryBox').style.display = 'none';
    }

    fetchStatuses(); // async — re-renders once statuses arrive; no-op if URL not set

    const el = document.getElementById('lastRefreshed');
    if (el) el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  } catch (err) {
    console.error('[BreadRun] Sheet fetch failed:', err);
    showMsg('⚠️', 'Could not load sheet — ' + err.message);
  }
}

fetchSheetData();

// Immediately sync when the user returns to this tab.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && routeDropdown.value) {
    console.log('[BreadRun] Tab focused: fetching statuses…');
    fetchStatuses();
  }
});

// ─── STATUS SYNC ──────────────────────────────────────────────
// Applies an array of status rows (from GET or POST response) into local state.
function applyStatusRows(rows) {
  // Build a lookup from itemKey → { route, itemId } so we can map Firebase keys back to local state.
  const itemKeyLookup = {};
  allOrderRows.forEach(d => { itemKeyLookup[d.itemKey] = { route: d.route, itemId: d.itemId }; });

  rows.forEach(statusRow => {
    // Summary items share the /statuses path but are distinguished by a "SUMMARY|" prefix
    // on the key, e.g. "SUMMARY|2|Rugbrød". This avoids a separate Firebase endpoint.
    if (statusRow.orderNum.startsWith('SUMMARY|')) {
      const [, rRoute, rWare] = statusRow.orderNum.split('|');
      if (!summaryTypeChecked[rRoute]) summaryTypeChecked[rRoute] = {};
      summaryTypeChecked[rRoute][rWare] = (statusRow.status === 'checked');
      return;
    }
    const item = itemKeyLookup[statusRow.orderNum]; // orderNum column stores itemKey
    if (!item) return; // stale or old-format entry — ignore
    if (!itemChecked[item.route])     itemChecked[item.route]     = {};
    if (!itemMissingData[item.route]) itemMissingData[item.route] = {};
    if (statusRow.status === 'checked') {
      itemChecked[item.route][item.itemId] = true;
      delete itemMissingData[item.route][item.itemId];
    } else if (statusRow.status === 'unchecked') {
      itemChecked[item.route][item.itemId] = false;
      delete itemMissingData[item.route][item.itemId];
    } else if (statusRow.status === 'missing') {
      itemMissingData[item.route][item.itemId] = {
        qtyMissing:      statusRow.qtyMissing      ?? null,
        replacementWare: statusRow.replacementWare ?? null,
      };
    }
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
    if (routeDropdown.value) renderCurrentRoute();
  } catch (err) {
    console.warn('[BreadRun] Could not load statuses:', err.message);
  }
}

// Writes an individual item status to Firebase via PUT.
async function postStatus({ orderNum, route, customer, status, qtyMissing = null, replacementWare = null }) {
  if (!FIREBASE_URL) return;
  const key = encodeURIComponent(orderNum);
  console.log(`[BreadRun] POST status — route=${route} customer="${customer}" item=${orderNum} status=${status}`);
  const body = { status, route, customer };
  if (qtyMissing      !== null) body.qtyMissing      = qtyMissing;
  if (replacementWare !== null) body.replacementWare = replacementWare;
  try {
    await fetch(`${FIREBASE_URL}/statuses/${key}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Stamp a lastModified timestamp so other clients can detect this change cheaply.
    const serverTimestamp = Date.now();
    lastFirebaseWriteTime = serverTimestamp;
    fetch(`${FIREBASE_URL}/lastModified.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serverTimestamp),
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
    const serverTimestamp = Date.now();
    lastFirebaseWriteTime = serverTimestamp;
    fetch(`${FIREBASE_URL}/lastModified.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serverTimestamp),
    });
  } catch (err) {
    console.warn('[BreadRun] Could not delete status:', err.message);
  }
}

// Polls /lastModified — a single tiny number — every 15 s.
// Only fetches full statuses when the timestamp has actually changed.
async function pollForChanges() {
  if (!FIREBASE_URL || !routeDropdown.value) return;
  try {
    const res = await fetch(`${FIREBASE_URL}/lastModified.json`);
    if (!res.ok) return;
    const serverTimestamp = await res.json();
    if (!serverTimestamp) return;
    if (lastFirebaseWriteTime === null) {
      // First poll after page load — just record the current timestamp.
      // fetchSheetData() already called fetchStatuses(), so no second fetch needed.
      lastFirebaseWriteTime = serverTimestamp;
      return;
    }
    if (serverTimestamp !== lastFirebaseWriteTime) {
      lastFirebaseWriteTime = serverTimestamp;
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
  const route = routeDropdown.value;
  if (!route) {
    document.getElementById('summaryBox').style.display = 'none';
    document.getElementById('statsBar').style.display   = 'none';
    showMsg('🚚', 'Select your route to begin');
    return;
  }
  renderCurrentRoute();
}

function renderCurrentRoute() {
  const route  = routeDropdown.value;
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
  return allOrderRows.filter(order => order.route === route);
}

// Returns true if an item is resolved (checked OR marked missing)
function isItemResolved(route, itemId) {
  return !!(itemChecked[route]?.[itemId] || itemMissingData[route]?.[itemId]);
}

// Returns customers grouped and sorted by highest routeOrdering first (LIFO packing order):
// higher routeOrdering = last delivery stop = loaded first into the van = top of the list.
// Customer positions are fixed for the entire session — only styling changes when a customer
// is complete, preventing disorienting jumps as items get ticked off.
function sortedCustomers(orders) {
  const customerIndex = {};
  orders.forEach(order => {
    if (!customerIndex[order.customer]) {
      customerIndex[order.customer] = { orders: [], maxOrdering: 0 };
    }
    customerIndex[order.customer].orders.push(order);
    if (order.routeOrdering > customerIndex[order.customer].maxOrdering) {
      customerIndex[order.customer].maxOrdering = order.routeOrdering;
    }
  });
  return Object.entries(customerIndex).sort((a, b) => b[1].maxOrdering - a[1].maxOrdering);
}

// ─── SUMMARY (SORTING STAGE) ──────────────────────────────────
function toggleSummary() {
  isSummaryOpen = !isSummaryOpen;
  document.getElementById('summaryItems').classList.toggle('open', isSummaryOpen);
  document.getElementById('summaryChevron').classList.toggle('open', isSummaryOpen);
}

function renderSummary(orders) {
  const route        = orders[0].route;
  const routeSummary = summaryTypeChecked[route] || {};

  // Total quantity per product type across all orders on this route
  const productTotals = {};
  orders.forEach(order => { productTotals[order.ware] = (productTotals[order.ware] || 0) + order.qty; });

  // Unchecked types first (by qty), then checked types (by qty)
  const allProducts = Object.entries(productTotals).sort((a, b) => {
    const byQty = summaryProductSort === 'qty-desc' ? b[1] - a[1] : a[1] - b[1];
    return byQty !== 0 ? byQty : a[0].localeCompare(b[0]);
  });
  document.getElementById('summarySortBtn').textContent =
    summaryProductSort === 'qty-desc' ? 'QTY ↓' : 'QTY ↑';
  const pendingProducts   = allProducts.filter(([w]) => !routeSummary[w]);
  const completedProducts = allProducts.filter(([w]) =>  routeSummary[w]);
  const sortedProducts    = [...pendingProducts, ...completedProducts];

  document.getElementById('summarySubtitle').textContent =
    `${completedProducts.length}/${sortedProducts.length} types sorted`;

  const summaryItemsEl = document.getElementById('summaryItems');

  // Ware name is stored in data-ware (HTML-encoded) — no inline JS quoting needed.
  // The label wraps the checkbox so the entire row is a valid tap target.
  summaryItemsEl.innerHTML = sortedProducts.map(([ware, qty]) => {
    const isChecked      = !!routeSummary[ware];
    const safeElementId  = 'sum-' + ware.replace(/[^a-zA-Z0-9]/g, '-');
    const htmlSafeWareName = ware.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `
      <div class="summary-row ${isChecked ? 's-checked' : ''}" id="${safeElementId}" data-ware="${htmlSafeWareName}">
        <label>
          <div class="summary-checkbox-area">
            <input type="checkbox" name="${safeElementId}" ${isChecked ? 'checked' : ''}>
          </div>
          <div class="summary-label-content">
            <span class="summary-ware">${ware}</span>
            <span class="summary-qty">${qty} stk</span>
          </div>
        </label>
      </div>`;
  }).join('');

  summaryItemsEl.classList.toggle('open', isSummaryOpen);
  document.getElementById('summaryChevron').classList.toggle('open', isSummaryOpen);
  document.getElementById('summaryBox').style.display = 'block';
}

// Delegated listener on the container — survives innerHTML replacement in renderSummary
document.getElementById('summaryItems').addEventListener('change', e => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  const row   = e.target.closest('.summary-row');
  const ware  = row.dataset.ware;
  const route = routeDropdown.value;
  if (!summaryTypeChecked[route]) summaryTypeChecked[route] = {};
  summaryTypeChecked[route][ware] = !summaryTypeChecked[route][ware];
  // Summary items are stored in Firebase under "SUMMARY|{route}|{ware}" to share
  // the /statuses endpoint with order items. The prefix lets applyStatusRows tell them apart.
  if (summaryTypeChecked[route][ware]) {
    postStatus({ orderNum: 'SUMMARY|' + route + '|' + ware, route, customer: '', status: 'checked' });
  } else {
    deleteStatus('SUMMARY|' + route + '|' + ware);
  }
  renderSummary(getRouteOrders(route));
});

// ─── ORDER LIST ───────────────────────────────────────────────
function renderOrders(orders) {
  // Preserve scroll position — don't jump to top on every checkbox tap
  const contentEl       = document.getElementById('content');
  const scrollPosition  = window.scrollY;
  const route           = orders[0].route;
  const checkedForRoute = itemChecked[route] || {};
  const missingForRoute = itemMissingData[route] || {};
  const customerGroups  = sortedCustomers(orders);
  const isRouteComplete = orders.every(order => isItemResolved(route, order.itemId));

  let html = '';

  if (isRouteComplete && orders.length > 0) {
    html += `<div class="all-done"><div class="icon">✅</div><p>Route complete!</p></div>`;
  }

  // ─── CUSTOMER GROUP ──────────────────────────────────────────
  customerGroups.forEach(([customer, { orders: custOrders }]) => {
    const completedCount     = custOrders.filter(order => isItemResolved(route, order.itemId)).length;
    const isCustomerComplete = completedCount === custOrders.length;
    const isInProgress       = !isCustomerComplete && completedCount > 0;

    html += `
      <div class="customer-group ${isCustomerComplete ? 'cg-done' : isInProgress ? 'cg-in-progress' : ''}">
        <div class="customer-header">
          <span class="customer-name">${customer}</span>
          ${isInProgress ? '<span class="status-pip"></span>' : ''}
          <span class="customer-tally ${isCustomerComplete ? 'tally-done' : ''}">${completedCount}/${custOrders.length}</span>
        </div>
        <div class="customer-orders">`;

    // Pending items first, resolved items sink to bottom — dept-aware sub-grouping.
    // depts.length <= 1 is a fast path: skip the dept divider overhead for most customers.
    const depts = [...new Set(custOrders.map(order => order.dept))];
    if (depts.length <= 1) {
      const pending = custOrders.filter(order => !isItemResolved(route, order.itemId));
      const done    = custOrders.filter(order =>  isItemResolved(route, order.itemId));
      [...pending, ...done].forEach(order => { html += cardHTML(order, checkedForRoute, missingForRoute); });
    } else {
      depts.forEach(dept => {
        const deptOrders = custOrders.filter(order => order.dept === dept);
        const pending    = deptOrders.filter(order => !isItemResolved(route, order.itemId));
        const done       = deptOrders.filter(order =>  isItemResolved(route, order.itemId));
        html += `<div class="dept-divider">${dept || '—'}</div>`;
        [...pending, ...done].forEach(order => { html += cardHTML(order, checkedForRoute, missingForRoute); });
      });
    }

    html += `</div></div>`;
  });

  html += `<button class="reset-btn">↺ Reset checklist</button>`;
  contentEl.innerHTML = html;

  window.scrollTo({ top: scrollPosition, behavior: 'instant' });
}

// ─── ORDER CARD ───────────────────────────────────────────────
function supplierIconHTML(supplier) {
  const supplierLower = supplier.toLowerCase();
  if (supplierLower.includes('bakehuset')) return `<img class="supplier-icon" src="assets/logo.svg" alt="Bakehuset">`;
  if (supplierLower.includes('sandnes'))   return `<img class="supplier-icon" src="assets/sandnes-bakeri.png" alt="Sandnes Bakeri">`;
  return '';
}

// orderNum is stored in data-order (HTML-encoded) — no inline JS quoting needed.
function cardHTML(order, checkedForRoute, missingForRoute = {}) {
  const isChecked   = !!checkedForRoute[order.itemId];
  const missingData = missingForRoute[order.itemId]; // undefined if not missing
  const isMissing   = !!missingData;
  const isResolved  = isMissing && order.acceptAlts && missingData.replacementWare;

  let cardClass = '';
  if (isChecked)        cardClass = 'checked';
  else if (isResolved)  cardClass = 'missing-resolved';
  else if (isMissing)   cardClass = 'missing';

  // Missing row rendered below the label
  let missingRowHTML = '';
  if (isMissing) {
    const { qtyMissing, replacementWare } = missingData;
    const itemDataAttr = `data-item="${order.itemId}"`;
    if (!order.acceptAlts) {
      // No alternatives — show info + qty-only button
      const infoText = qtyMissing ? `No alternatives &middot; ${qtyMissing} missing` : 'No alternatives';
      missingRowHTML = `
      <div class="missing-row">
        <span class="missing-info">${infoText}</span>
        <button class="missing-detail-btn" ${itemDataAttr}>Note qty</button>
      </div>`;
    } else if (!replacementWare) {
      // Alts allowed, no replacement noted yet
      missingRowHTML = `
      <div class="missing-row">
        <button class="missing-detail-btn" ${itemDataAttr}>+ Note replacement</button>
      </div>`;
    } else {
      // Replacement entered
      const qtySummary = qtyMissing ? `Missing ${qtyMissing} ` : 'Missing ';
      missingRowHTML = `
      <div class="missing-row">
        <span class="missing-info">${qtySummary}&rarr; ${replacementWare}</span>
        <button class="missing-detail-btn missing-edit-btn" ${itemDataAttr}>&#9998;</button>
      </div>`;
    }
  }

  return `
    <div class="order-card ${cardClass}" data-item="${order.itemId}">
      <label>
        <div class="checkbox-area">
          <input type="checkbox" name="ord-${order.itemId}" ${isChecked ? 'checked' : ''}>
        </div>
        <div class="order-info">
          <div class="order-top">
            <span class="ware-name">${order.ware}</span>
            <span class="qty-badge">QTY: ${order.qty}</span>
            ${supplierIconHTML(order.supplier)}
          </div>
          <div class="order-meta">
            <span class="meta-item">
              <span class="meta-label">Order</span>&nbsp;
              <span class="meta-value">${order.orderNum}</span>
            </span>
            <span class="meta-item">
              <span class="meta-label">Supplier</span>&nbsp;
              <span class="meta-value">${order.supplier}</span>
            </span>
          </div>
          ${order.acceptAlts ? '<div class="alts-badge">&#x21C6; Accepts alternatives</div>' : ''}
        </div>
      </label>${missingRowHTML}
    </div>`;
}

// Delegated listener on content — survives innerHTML replacement in renderOrders.
// Handles order-card checkboxes. On a missing card: tap clears missing → unchecked.
document.getElementById('content').addEventListener('change', async e => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  const orderCard = e.target.closest('.order-card');
  if (!orderCard) return;
  const itemId = orderCard.dataset.item;
  const route  = routeDropdown.value;

  if (!itemChecked[route])     itemChecked[route]     = {};
  if (!itemMissingData[route]) itemMissingData[route] = {};

  const routeOrders = getRouteOrders(route);
  const tappedOrder = routeOrders.find(order => order.itemId === itemId);

  // If the card is in a missing state, a tap clears missing → unchecked (not checked)
  if (itemMissingData[route][itemId]) {
    delete itemMissingData[route][itemId];
    itemChecked[route][itemId] = false;
    if (tappedOrder && FIREBASE_URL) {
      console.log(`[BreadRun] Missing cleared by tap — route=${route} ware="${tappedOrder.ware}"`);
      deleteStatus(tappedOrder.itemKey);
    }
    updateStats(routeOrders);
    renderOrders(routeOrders);
    return;
  }

  itemChecked[route][itemId] = !itemChecked[route][itemId];

  // POST individual item state
  if (tappedOrder && FIREBASE_URL) {
    const isNowChecked = !!itemChecked[route][itemId];
    console.log(`[BreadRun] Checkbox toggled — route=${route} customer="${tappedOrder.customer}" ware="${tappedOrder.ware}" → ${isNowChecked ? 'checked' : 'unchecked'}`);

    // When a customer is fully done: show overlay, await the PUT, then GET fresh state
    // before re-rendering. This picks up any changes made by other drivers in the interim
    // and prevents a flash of stale state if two drivers are ticking the same route.
    const customerOrders    = routeOrders.filter(order => order.customer === tappedOrder.customer);
    const isCustomerComplete = customerOrders.every(order => isItemResolved(route, order.itemId));
    if (isCustomerComplete) {
      const syncOverlayEl = document.getElementById('syncOverlay');
      syncOverlayEl.classList.add('open');
      if (isNowChecked) {
        await postStatus({ orderNum: tappedOrder.itemKey, route, customer: tappedOrder.customer, status: 'checked' });
      } else {
        await deleteStatus(tappedOrder.itemKey);
      }
      await fetchStatuses(); // GET after PUT/DELETE — no race, picks up other drivers' changes
      syncOverlayEl.classList.remove('open');
      return; // fetchStatuses() → renderCurrentRoute() handles the re-render
    } else {
      if (isNowChecked) {
        postStatus({ orderNum: tappedOrder.itemKey, route, customer: tappedOrder.customer, status: 'checked' });
      } else {
        deleteStatus(tappedOrder.itemKey);
      }
    }
  }

  updateStats(routeOrders);
  renderOrders(routeOrders);
});

// Delegated click handler — reset button + missing detail button
document.getElementById('content').addEventListener('click', e => {
  if (e.target.closest('.reset-btn')) { askReset(); return; }
  const btn = e.target.closest('.missing-detail-btn');
  if (btn) { e.stopPropagation(); openMissingDetail(btn.dataset.item); }
});

// ─── LONG PRESS — toggle missing state ────────────────────────
document.getElementById('content').addEventListener('pointerdown', e => {
  if (e.target.closest('.missing-detail-btn') || e.target.closest('.reset-btn')) return;
  const orderCard = e.target.closest('.order-card');
  if (!orderCard) return;

  const startX = e.clientX, startY = e.clientY;

  const timer = setTimeout(() => {
    navigator.vibrate?.(30);

    const itemId = orderCard.dataset.item;
    const route  = routeDropdown.value;
    if (!itemMissingData[route]) itemMissingData[route] = {};
    if (!itemChecked[route])     itemChecked[route]     = {};

    const routeOrders = getRouteOrders(route);
    const order = routeOrders.find(o => o.itemId === itemId);
    if (!order) return;

    if (itemMissingData[route][itemId]) {
      // Already missing — long press clears it
      delete itemMissingData[route][itemId];
      itemChecked[route][itemId] = false;
      if (FIREBASE_URL) deleteStatus(order.itemKey);
      console.log(`[BreadRun] Long press: missing cleared — route=${route} ware="${order.ware}"`);
    } else {
      // Not missing — mark as missing
      itemChecked[route][itemId] = false;
      itemMissingData[route][itemId] = { qtyMissing: null, replacementWare: null };
      if (FIREBASE_URL) {
        postStatus({ orderNum: order.itemKey, route, customer: order.customer, status: 'missing' });
      }
      console.log(`[BreadRun] Long press: marked missing — route=${route} ware="${order.ware}"`);
    }

    renderOrders(routeOrders);
  }, 500);

  const cancel = () => clearTimeout(timer);
  const onMove = ev => {
    if (Math.abs(ev.clientX - startX) > 10 || Math.abs(ev.clientY - startY) > 10) {
      clearTimeout(timer);
    }
  };
  document.addEventListener('pointermove', onMove, { once: false });
  document.addEventListener('pointerup',     cancel, { once: true });
  document.addEventListener('pointercancel', cancel, { once: true });
  // Clean up move listener once pointer is released
  const cleanup = () => document.removeEventListener('pointermove', onMove);
  document.addEventListener('pointerup',     cleanup, { once: true });
  document.addEventListener('pointercancel', cleanup, { once: true });
});

// ─── MISSING DETAIL SHEET ─────────────────────────────────────
function openMissingDetail(itemId) {
  const route = routeDropdown.value;
  const order = getRouteOrders(route).find(o => o.itemId === itemId);
  if (!order) return;

  missingDetailTarget = { route, itemId, acceptAlts: order.acceptAlts };

  document.getElementById('detailWareName').textContent = order.ware;

  const existingData = (itemMissingData[route] || {})[itemId] || {};
  const qtyInput = document.getElementById('detailQtyMissing');
  const replInput = document.getElementById('detailReplacementWare');
  qtyInput.value  = existingData.qtyMissing      || '';
  replInput.value = existingData.replacementWare || '';

  const replRow = document.getElementById('detailReplacementRow');
  replRow.style.display = order.acceptAlts ? '' : 'none';

  document.getElementById('missingDetailOverlay').classList.add('open');
  qtyInput.focus();
}

function closeMissingDetail() {
  document.getElementById('missingDetailOverlay').classList.remove('open');
  missingDetailTarget = null;
}

function saveMissingDetail() {
  if (!missingDetailTarget) return;
  const { route, itemId, acceptAlts } = missingDetailTarget;

  const qtyRaw  = document.getElementById('detailQtyMissing').value.trim();
  const replRaw = document.getElementById('detailReplacementWare').value.trim();

  const qtyMissing      = qtyRaw  ? parseInt(qtyRaw, 10) : null;
  const replacementWare = (acceptAlts && replRaw) ? replRaw : null;

  if (!itemMissingData[route]) itemMissingData[route] = {};
  itemMissingData[route][itemId] = { qtyMissing, replacementWare };

  const order = getRouteOrders(route).find(o => o.itemId === itemId);
  if (order && FIREBASE_URL) {
    postStatus({
      orderNum: order.itemKey,
      route,
      customer: order.customer,
      status: 'missing',
      qtyMissing,
      replacementWare,
    });
  }

  closeMissingDetail();
  renderCurrentRoute();
}

// ─── STATS BAR ────────────────────────────────────────────────
function updateStats(orders) {
  const route          = orders[0].route;
  const completedCount = orders.filter(order => isItemResolved(route, order.itemId)).length;
  const totalUnits      = orders.reduce((s, order) => s + order.qty, 0);
  document.getElementById('statTotal').textContent = orders.length;
  document.getElementById('statDone').textContent  = completedCount;
  document.getElementById('statQty').textContent   = totalUnits;
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
  const route  = routeDropdown.value;
  const orders = getRouteOrders(route);
  itemChecked[route]        = {};
  itemMissingData[route]    = {};
  summaryTypeChecked[route] = {};
  updateStats(orders);
  renderSummary(orders);
  renderOrders(orders);
  resetFirebaseRoute(route, orders); // async, fire-and-forget
}

// Clears all Firebase entries for a route via a single PATCH with null values.
async function resetFirebaseRoute(route, orders) {
  if (!FIREBASE_URL) return;
  const nullPatch = {};
  orders.forEach(order => { nullPatch[encodeURIComponent(order.itemKey)] = null; });
  const wares = [...new Set(orders.map(order => order.ware))];
  wares.forEach(w => { nullPatch[encodeURIComponent('SUMMARY|' + route + '|' + w)] = null; });
  try {
    await fetch(`${FIREBASE_URL}/statuses.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nullPatch),
    });
    const serverTimestamp = Date.now();
    lastFirebaseWriteTime = serverTimestamp;
    fetch(`${FIREBASE_URL}/lastModified.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serverTimestamp),
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
  summaryProductSort = summaryProductSort === 'qty-desc' ? 'qty-asc' : 'qty-desc';
  renderSummary(getRouteOrders(routeDropdown.value));
});
document.querySelector('.confirm-cancel').addEventListener('click', closeConfirm);
document.querySelector('.confirm-ok').addEventListener('click', doReset);
document.getElementById('confirmOverlay').addEventListener('click', function (e) {
  if (e.target === this) closeConfirm();
});
document.querySelector('.missing-detail-cancel').addEventListener('click', closeMissingDetail);
document.querySelector('.missing-detail-save').addEventListener('click', saveMissingDetail);
document.getElementById('missingDetailOverlay').addEventListener('click', function (e) {
  if (e.target === this) closeMissingDetail();
});
