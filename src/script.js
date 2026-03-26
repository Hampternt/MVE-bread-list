// ═══════════════════════════════════════════════════════════════
// Bread Run — Route Checklist
// script.js
// ─────────────────────────────────────────────────────────────
// Data flow:
//   fetchOrderData() → allOrderRows[]
//   loadRoute() → renderCurrentRoute()
//   renderCurrentRoute() → renderSummary() + renderOrders()
//   checkbox change (delegated) → toggle / toggleSummaryItem → re-render
// ═══════════════════════════════════════════════════════════════

// ─── PIN GATE ─────────────────────────────────────────────────
const pin = sessionStorage.getItem('app-pin');
if (!pin) { location.replace('index.html'); }

// Clears the stored PIN and sends the user back to the landing page.
// Called whenever Firebase or Firestore returns 401/403 (stale or wrong PIN).
function redirectToPin() {
  sessionStorage.removeItem('app-pin');
  location.replace('index.html');
}

// ─── CONFIGURATION ────────────────────────────────────────────
const FIREBASE_URL    = `https://mve-bread-default-rtdb.europe-west1.firebasedatabase.app/${pin}`;
const FIRESTORE_KEY   = 'AIzaSyBW9rjG7CrZDC9wGmLGze1JQdKQrA2X1oQ';
const FIRESTORE_URL   = 'https://firestore.googleapis.com/v1/projects/mve-bread/databases/(default)/documents';
const FIRESTORE_COLL  = `pins/${pin}/bread-orders`;

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

// ─── CRATE VISUALISATION ──────────────────────────────────────
const CRATE_COLORS = [
  '#e8c840','#5abf6a','#4a9ede','#e87840',
  '#c45abf','#5abfbf','#e84040','#b0bf5a','#bf8a5a','#5a6abf'
];

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

// ─── FETCH MODE STATE ─────────────────────────────────────────
let fetchModeActive        = false;
let fetchCurrentBatchIndex = 0;
let fetchBatches           = [];
// Physical space constraints
const FETCH_FLOOR_STACKS     = 3;   // floor positions for active picking
const FETCH_MAX_STACK_HEIGHT = 8;   // max crates per floor stack
const FETCH_TROLLEY_STACKS   = 2;   // trolley output stacks (default)
const FETCH_PALLET_STACKS    = 4;   // pallet output stacks
// Stacking state machine — tracks where finished customers go
let stackingState = null; // initialised per batch

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

// ─── FIRESTORE DOCUMENT → ORDER OBJECT ───────────────────────
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

// ─── FETCH ────────────────────────────────────────────────────
const routeDropdown = document.getElementById('routeSelect');

function showMsg(icon, msg) {
  document.getElementById('content').innerHTML =
    `<div class="placeholder"><div class="big">${icon}</div><p>${msg}</p></div>`;
}

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
      if (res.status === 401 || res.status === 403) { redirectToPin(); return; }
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

fetchOrderData();

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
    if (res.status === 401 || res.status === 403) { redirectToPin(); return; }
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
// Firebase RTDB keys cannot contain:  . $ # [ ] /
// Firebase REST also decodes %XX sequences in URL paths, so a key containing '/' encoded
// as '%2F' gets decoded back to '/' and treated as a path separator (causing 401s).
// Fix: double-encode all forbidden characters so Firebase stores their %-encoded form as
// a literal key character instead of the actual character.
// encodeURIComponent handles $, #, [, ] but leaves . and ' raw — we encode . manually.
// decodeURIComponent in fetchStatuses decodes the stored keys back correctly on read.
function firebaseKey(str) {
  return encodeURIComponent(str)
    .replace(/\./g,   '%252E')  // .  (not encoded by encodeURIComponent)
    .replace(/%2F/gi, '%252F')  // /
    .replace(/%24/gi, '%2524')  // $
    .replace(/%23/gi, '%2523')  // #
    .replace(/%5B/gi, '%255B')  // [
    .replace(/%5D/gi, '%255D'); // ]
}

async function postStatus({ orderNum, route, customer, status, qtyMissing = null, replacementWare = null }) {
  if (!FIREBASE_URL) return;
  const key = firebaseKey(orderNum);
  console.log(`[BreadRun] POST status — route=${route} customer="${customer}" item=${orderNum} status=${status}`);
  const body = { status, route, customer };
  if (qtyMissing      !== null) body.qtyMissing      = qtyMissing;
  if (replacementWare !== null) body.replacementWare = replacementWare;
  try {
    const res = await fetch(`${FIREBASE_URL}/statuses/${key}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[BreadRun] Firebase PUT denied — ${res.status} — key=${orderNum} body=${JSON.stringify(body)} — ${errText}`);
    }
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
  const key = firebaseKey(orderNum);
  try {
    const res = await fetch(`${FIREBASE_URL}/statuses/${key}.json`, { method: 'DELETE' });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[BreadRun] Firebase DELETE denied — ${res.status} — key=${orderNum} — ${errText}`);
    }
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
      // fetchOrderData() already called fetchStatuses(), so no second fetch needed.
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
    document.getElementById('fetchBar').style.display   = 'none';
    document.getElementById('fetchModeBtn').style.display = 'none';
    showMsg('🚚', 'Select your route to begin');
    return;
  }
  document.getElementById('fetchModeBtn').style.display = 'flex';
  // Reset fetch batches when route changes
  fetchBatches = [];
  fetchCurrentBatchIndex = 0;
  stackingState = null;
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

  if (fetchModeActive) {
    document.getElementById('summaryBox').style.display = 'none';
    document.getElementById('fetchBar').style.display   = 'flex';
    if (!fetchBatches.length) rebuildFetchBatches(orders);
    renderFetchMode(orders);
  } else {
    document.getElementById('fetchBar').style.display   = 'none';
    renderSummary(orders);
    renderOrders(orders);
  }
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

// ─── CRATE VISUALISATION HELPERS ──────────────────────────────
function getWareColors(orders) {
  const wares = [...new Set(orders.map(o => o.ware))].sort();
  const map = {};
  wares.forEach((ware, i) => { map[ware] = CRATE_COLORS[i % CRATE_COLORS.length]; });
  return map;
}

const CRATE_COMPACT_THRESHOLD = 50;

// Returns structured crate assignments with rich item data.
// Each crate: { size: 10|5, items: [{ ware, qty, color }] }
// Algorithm: minimise crate count first, then maximise pure (single-type) crates.
function buildCrateDataStructured(custOrders, wareColors) {
  const qtyByWare = {};
  custOrders.forEach(o => { qtyByWare[o.ware] = (qtyByWare[o.ware] || 0) + o.qty; });
  const total = Object.values(qtyByWare).reduce((s, q) => s + q, 0);
  if (!total) return null;

  // Step 1: Determine minimum crate count and sizes
  const crates = [];
  let bigCount = Math.floor(total / 10);
  const rem = total % 10;
  let smallCount = 0;
  if (rem > 5)      bigCount++;
  else if (rem > 0) smallCount = 1;
  for (let i = 0; i < bigCount; i++)   crates.push({ size: 10, items: [] });
  for (let i = 0; i < smallCount; i++) crates.push({ size:  5, items: [] });

  // Track remaining qty per ware and used capacity per crate
  const wares = Object.entries(qtyByWare).sort((a, b) => b[1] - a[1]);
  const remaining = {};
  wares.forEach(([ware, qty]) => { remaining[ware] = qty; });
  const used = crates.map(() => 0);

  // Step 2a: Fill whole crates purely (ware qty >= crate size)
  for (const [ware] of wares) {
    if (remaining[ware] <= 0) continue;
    for (let ci = 0; ci < crates.length; ci++) {
      if (used[ci] > 0) continue;
      if (remaining[ware] >= crates[ci].size) {
        const color = wareColors[ware] || '#888';
        crates[ci].items.push({ ware, qty: crates[ci].size, color });
        used[ci] = crates[ci].size;
        remaining[ware] -= crates[ci].size;
        if (remaining[ware] <= 0) break;
      }
    }
  }

  // Step 2b: Check if any remaining ware qty exactly matches a crate's remaining capacity
  for (const [ware] of wares) {
    if (remaining[ware] <= 0) continue;
    for (let ci = 0; ci < crates.length; ci++) {
      const space = crates[ci].size - used[ci];
      if (space > 0 && remaining[ware] === space) {
        crates[ci].items.push({ ware, qty: space, color: wareColors[ware] || '#888' });
        used[ci] += space;
        remaining[ware] = 0;
        break;
      }
    }
  }

  // Step 2c: Pack remaining wares — prefer crates that can hold the full amount (tightest fit),
  // otherwise use the largest available space to avoid splitting across many crates.
  const leftover = wares.filter(([w]) => remaining[w] > 0).sort((a, b) => remaining[b[0]] - remaining[a[0]]);
  for (const [ware] of leftover) {
    while (remaining[ware] > 0) {
      let bestCi = -1, bestWaste = Infinity, fallbackCi = -1, fallbackSpace = 0;
      for (let ci = 0; ci < crates.length; ci++) {
        const space = crates[ci].size - used[ci];
        if (space <= 0) continue;
        if (space >= remaining[ware]) {
          const waste = space - remaining[ware];
          if (waste < bestWaste) { bestCi = ci; bestWaste = waste; }
        } else if (space > fallbackSpace) {
          fallbackCi = ci; fallbackSpace = space;
        }
      }
      const ci = bestCi !== -1 ? bestCi : fallbackCi;
      if (ci === -1) break;
      const space = crates[ci].size - used[ci];
      const toPlace = Math.min(remaining[ware], space);
      crates[ci].items.push({ ware, qty: toPlace, color: wareColors[ware] || '#888' });
      used[ci] += toPlace;
      remaining[ware] -= toPlace;
    }
  }

  return { crates, total };
}

// Wrapper: converts structured crate data to the slot-based format used by renderOneCrate().
function buildCrateData(custOrders, wareColors) {
  const structured = buildCrateDataStructured(custOrders, wareColors);
  if (!structured) return null;
  const { crates, total } = structured;

  // Convert a structured crate to the flat { size, slots } format
  function toSlotCrate(crate) {
    const slots = [];
    crate.items.forEach(({ color, qty }) => { for (let i = 0; i < qty; i++) slots.push(color); });
    while (slots.length < crate.size) slots.push(null);
    return { size: crate.size, slots };
  }

  if (total > CRATE_COMPACT_THRESHOLD) {
    const fullBig = Math.floor(total / 10);
    const rem = total % 10;
    // For the compact badge we just need the count of full large crates and a partial crate
    const lastCrate = rem > 0 ? toSlotCrate(crates[crates.length - 1]) : null;
    return { compact: true, total, fullBig, partialCrate: lastCrate };
  }

  return { compact: false, total, crates: crates.map(toSlotCrate) };
}

function renderOneCrate(crate) {
  const rows = crate.size === 10 ? 2 : 1;
  const cols = 5;
  let h = '<div class="crate">';
  for (let r = 0; r < rows; r++) {
    h += '<div class="crate-row">';
    for (let c = 0; c < cols; c++) {
      const color = crate.slots[r * cols + c];
      h += color ? `<div class="crate-slot" style="background:${color}"></div>`
                 : '<div class="crate-slot empty"></div>';
    }
    h += '</div>';
  }
  return h + '</div>';
}

function crateVizHTML(data) {
  if (!data) return '';
  let html = '<div class="crate-bg">';
  if (data.compact) {
    if (data.fullBig > 0)   html += `<div class="crate-compact">\u25A0\u00D7${data.fullBig}</div>`;
    if (data.partialCrate)  html += renderOneCrate(data.partialCrate);
  } else {
    data.crates.forEach(crate => { html += renderOneCrate(crate); });
  }
  return html + '</div>';
}

// Progress-aware crate rendering for fetch mode.
// Each slot can be 'filled' (checked), 'pending' (outlined), or 'empty' (no bread assigned).
function renderOneCrateProgress(crate, label) {
  const rows = crate.size === 10 ? 2 : 1;
  const cols = 5;
  let h = `<div class="crate-progress">`;
  if (label) h += `<div class="crate-label">${label}</div>`;
  h += '<div class="crate">';
  for (let r = 0; r < rows; r++) {
    h += '<div class="crate-row">';
    for (let c = 0; c < cols; c++) {
      const slot = crate.slots[r * cols + c];
      if (!slot) {
        h += '<div class="crate-slot empty"></div>';
      } else if (slot.filled) {
        h += `<div class="crate-slot" style="background:${slot.color}"></div>`;
      } else {
        h += `<div class="crate-slot crate-slot-pending" style="border-color:${slot.color};color:${slot.color}"></div>`;
      }
    }
    h += '</div>';
  }
  h += '</div></div>';
  return h;
}

// Build progress slot data for a customer's crates based on check state.
// Returns array of { size, slots: [{color, filled}|null], label } — one per crate.
function buildProgressCrates(custData, route, globalStartNum) {
  if (!custData.structured) return [];
  const crates = custData.structured.crates;
  const result = [];
  let crateNum = globalStartNum;

  for (const crate of crates) {
    const slots = [];
    for (const item of crate.items) {
      // How many of this ware's orders are checked for this customer?
      const wareOrders = custData.orders.filter(o => o.ware === item.ware);
      const totalWareQty = wareOrders.reduce((s, o) => s + o.qty, 0);
      const checkedQty = wareOrders
        .filter(o => isItemResolved(route, o.itemId))
        .reduce((s, o) => s + o.qty, 0);

      // Proportion checked for this ware across all orders
      const ratio = totalWareQty > 0 ? checkedQty / totalWareQty : 0;
      const filledCount = Math.round(item.qty * ratio);

      for (let i = 0; i < item.qty; i++) {
        slots.push({ color: item.color, filled: i < filledCount });
      }
    }
    // Pad to crate size
    while (slots.length < crate.size) slots.push(null);
    result.push({ size: crate.size, slots, label: `#${crateNum}` });
    crateNum++;
  }
  return result;
}

// ─── FETCH MODE ──────────────────────────────────────────────

// How many output stacks the selected transport allows
function getTransportStacks() {
  const mode = document.getElementById('fetchTransport').value;
  if (mode === 'pallet') return FETCH_PALLET_STACKS;
  if (mode === 'single') return 1;
  return FETCH_TROLLEY_STACKS;
}

// Build batches of customers based on floor space constraints.
// Each customer uses 1 floor stack (or 0 if single-crate → goes straight to trolley).
// Customers with > FETCH_MAX_STACK_HEIGHT crates get a dedicated floor stack.
function rebuildFetchBatches(orders) {
  const wareColors = getWareColors(orders);
  const customers = sortedCustomers(orders); // LIFO: last delivery = first in list
  fetchBatches = [];
  let batch = null;
  let floorUsed = 0;
  let trolleyUsed = 0;
  const trolleySlots = getTransportStacks();

  function flushBatch() {
    if (batch && batch.customers.length > 0) {
      batch.pickSequence = buildPickSequence(batch, wareColors);
      fetchBatches.push(batch);
    }
    batch = { customers: [], pickSequence: [] };
    floorUsed = 0;
    trolleyUsed = 0;
  }

  flushBatch();

  for (const [customer, { orders: custOrders }] of customers) {
    const structured = buildCrateDataStructured(custOrders, wareColors);
    const crateCount = structured ? structured.crates.length : 0;
    const isSingleCrate = crateCount <= 1;

    // Determine how many floor stacks this customer needs
    let floorNeeded = isSingleCrate ? 0 : 1;

    // Check if this customer fits in the current batch
    const wouldExceedFloor = floorUsed + floorNeeded > FETCH_FLOOR_STACKS;
    const wouldExceedTrolley = isSingleCrate && trolleyUsed + 1 > trolleySlots;

    if (batch.customers.length > 0 && (wouldExceedFloor || (isSingleCrate && wouldExceedTrolley))) {
      flushBatch();
    }

    batch.customers.push({
      customer,
      orders: custOrders,
      crateCount,
      isSingleCrate,
      structured,
    });

    if (isSingleCrate) trolleyUsed++;
    else floorUsed += floorNeeded;
  }

  flushBatch();
  if (fetchCurrentBatchIndex >= fetchBatches.length) fetchCurrentBatchIndex = 0;
}

// Build the pick sequence for a batch: one entry per bread type, shared types first.
function buildPickSequence(batch, wareColors) {
  // Assign crate labels per customer
  let globalCrate = 1;
  const crateAssignments = []; // parallel to batch.customers

  for (const cust of batch.customers) {
    const custCrates = [];
    if (cust.structured) {
      for (const crate of cust.structured.crates) {
        custCrates.push({ crateLabel: `#${globalCrate}`, globalNum: globalCrate, crate });
        globalCrate++;
      }
    }
    crateAssignments.push(custCrates);
  }

  // Group by ware across all customers in the batch
  const wareMap = {}; // ware → { supplier, color, picks: [...] }

  batch.customers.forEach((cust, ci) => {
    const custCrates = crateAssignments[ci];
    // For each crate, for each item in that crate
    custCrates.forEach(({ crateLabel, globalNum, crate }) => {
      crate.items.forEach(item => {
        if (!wareMap[item.ware]) {
          // Find a representative order for supplier info
          const sampleOrder = cust.orders.find(o => o.ware === item.ware) || {};
          wareMap[item.ware] = {
            supplier: sampleOrder.supplier || '',
            color: item.color,
            picks: [],
          };
        }
        // Find which orderItemIds map to this ware+customer combo
        const orderItemIds = cust.orders
          .filter(o => o.ware === item.ware)
          .map(o => o.itemId);

        wareMap[item.ware].picks.push({
          customer: cust.customer,
          crateLabel,
          globalNum,
          qty: item.qty,
          orderItemIds,
        });
      });
    });
  });

  // Sort pick sequence: follow customer order from the crate overview.
  // Walk customers top-to-bottom; for each customer, emit their bread types in crate order.
  // If a bread type was already emitted by a previous customer (shared type), skip it —
  // it's already in the list at the earlier position. This lets the driver work top-down
  // without jumping back to the crate overview to see what the next customer needs.
  const sequence = Object.entries(wareMap).map(([ware, data]) => {
    const uniqueCustomers = new Set(data.picks.map(p => p.customer)).size;
    const totalQty = data.picks.reduce((s, p) => s + p.qty, 0);
    // Track the first customer index and first crate number where this ware appears
    const firstPick = data.picks[0];
    const firstCustomerIdx = batch.customers.findIndex(c => c.customer === firstPick.customer);
    const firstCrateNum = firstPick.globalNum;
    return { ware, ...data, uniqueCustomers, totalQty, firstCustomerIdx, firstCrateNum };
  });

  // Primary: order of first customer that needs the bread (matches crate overview top-to-bottom)
  // Secondary: crate number within that customer (crate #1 before #2)
  // Tertiary: shared types slightly before single-customer types at the same customer position
  sequence.sort((a, b) => {
    if (a.firstCustomerIdx !== b.firstCustomerIdx) return a.firstCustomerIdx - b.firstCustomerIdx;
    if (a.firstCrateNum !== b.firstCrateNum) return a.firstCrateNum - b.firstCrateNum;
    return b.uniqueCustomers - a.uniqueCustomers;
  });

  return sequence;
}

// Initialise stacking state for a batch
function initStackingState(batch) {
  // Delivery queue: customers in delivery order (lowest routeOrdering first = delivered first = bottom of stack)
  const deliveryQueue = [...batch.customers].sort((a, b) => {
    const aOrd = Math.max(...a.orders.map(o => o.routeOrdering));
    const bOrd = Math.max(...b.orders.map(o => o.routeOrdering));
    return aOrd - bOrd;
  }).map(c => c.customer);

  stackingState = {
    transportMode: document.getElementById('fetchTransport').value,
    maxStacks: getTransportStacks(),
    stacks: [],         // [{ customers: [name,...], topCustomer: name }]
    deliveryQueue,      // lowest ordering first (bottom of stack → top)
    nextToStack: 0,     // index into deliveryQueue for ideal next
    completedCustomers: new Set(),
    stackedCustomers: new Set(),
  };
}

// Check if a customer in the current batch is fully picked
function isBatchCustomerComplete(route, custOrders) {
  return custOrders.every(order => isItemResolved(route, order.itemId));
}

// Process stacking: determine prompts for completed customers
function getStackingPrompts(batch, route) {
  if (!stackingState) initStackingState(batch);
  const st = stackingState;
  const prompts = [];

  // Update completed set
  for (const cust of batch.customers) {
    if (isBatchCustomerComplete(route, cust.orders)) {
      st.completedCustomers.add(cust.customer);
    } else {
      st.completedCustomers.delete(cust.customer);
    }
  }

  // Try to stack customers in delivery order
  while (st.nextToStack < st.deliveryQueue.length) {
    const nextCust = st.deliveryQueue[st.nextToStack];
    if (!st.completedCustomers.has(nextCust) || st.stackedCustomers.has(nextCust)) break;

    // Find a stack to put this customer on
    // Prefer existing stack with most customers (they're in order)
    let targetStack = null;
    for (const stack of st.stacks) {
      // Can stack on top if stack height allows
      if (stack.customers.length < FETCH_MAX_STACK_HEIGHT) {
        targetStack = stack;
        break;
      }
    }
    if (!targetStack && st.stacks.length < st.maxStacks) {
      targetStack = { customers: [], topCustomer: null };
      st.stacks.push(targetStack);
    }
    if (!targetStack) break; // no space

    targetStack.customers.push(nextCust);
    targetStack.topCustomer = nextCust;
    st.stackedCustomers.add(nextCust);
    st.nextToStack++;

    const pos = st.stacks.indexOf(targetStack) + 1;
    const isBottom = targetStack.customers.length === 1;
    prompts.push({
      customer: nextCust,
      message: `${nextCust} done! Stack on Position ${pos}${isBottom ? ' (bottom)' : ` (on top of ${targetStack.customers[targetStack.customers.length - 2]})`}`,
      type: 'ready',
    });
  }

  // Check for out-of-order completed customers that aren't stacked yet
  for (const cust of batch.customers) {
    if (st.completedCustomers.has(cust.customer) &&
        !st.stackedCustomers.has(cust.customer) &&
        cust.customer !== st.deliveryQueue[st.nextToStack]) {
      // Can we start a new stack for this out-of-order customer?
      if (st.stacks.length < st.maxStacks) {
        const newStack = { customers: [cust.customer], topCustomer: cust.customer };
        st.stacks.push(newStack);
        st.stackedCustomers.add(cust.customer);
        const pos = st.stacks.length;
        prompts.push({
          customer: cust.customer,
          message: `${cust.customer} done! Start new stack (Position ${pos})`,
          type: 'ready',
        });
      } else {
        prompts.push({
          customer: cust.customer,
          message: `${cust.customer} done — waiting for ${st.deliveryQueue[st.nextToStack]} to finish before stacking`,
          type: 'wait',
        });
      }
    }
  }

  return prompts;
}

// Render a visual workspace diagram showing floor stacks (active) and trolley stacks (completed).
// Each customer occupies a floor position with their crates shown as vertical blocks.
// Completed customers move to the trolley/pallet side.
function renderWorkspaceDiagram(batch, route, wareColors) {
  if (!stackingState) return '';
  const st = stackingState;

  // Build progress crate data for each customer, keyed by customer name
  const custCrateMap = {};
  let crateNum = 1;
  for (const cust of batch.customers) {
    const pcs = buildProgressCrates(cust, route, crateNum);
    custCrateMap[cust.customer] = pcs;
    crateNum += pcs.length;
  }

  // Split customers: floor (active) vs trolley (stacked/completed)
  const floorCustomers = batch.customers.filter(c => !st.stackedCustomers.has(c.customer));
  const transportLabel = st.transportMode === 'pallet' ? 'Pallet' : st.transportMode === 'single' ? 'Stack' : 'Trolley';

  let html = '<div class="workspace-diagram">';

  // ── Floor side ──
  html += '<div class="ws-section">';
  html += '<div class="ws-section-label">Floor</div>';
  html += '<div class="ws-stacks">';

  // Show floor stack positions (always show FETCH_FLOOR_STACKS slots)
  for (let fi = 0; fi < FETCH_FLOOR_STACKS; fi++) {
    const cust = floorCustomers[fi];
    html += '<div class="ws-stack">';
    if (cust) {
      const pcs = custCrateMap[cust.customer] || [];
      const done = isBatchCustomerComplete(route, cust.orders);
      // Render crates bottom-to-top (first crate at bottom)
      html += '<div class="ws-crate-column">';
      for (let ci = pcs.length - 1; ci >= 0; ci--) {
        const pc = pcs[ci];
        const filledCount = pc.slots.filter(s => s && s.filled).length;
        const totalSlots = pc.slots.filter(s => s).length;
        const isCrateFull = filledCount === totalSlots && totalSlots > 0;
        html += `<div class="ws-crate-block${isCrateFull ? ' ws-crate-full' : ''}" title="${pc.label}: ${filledCount}/${totalSlots}">`;
        // Mini color bar inside the block
        const uniqueColors = [...new Set(pc.slots.filter(s => s).map(s => s.color))];
        for (const color of uniqueColors) {
          const colorSlots = pc.slots.filter(s => s && s.color === color);
          const colorFilled = colorSlots.filter(s => s.filled).length;
          const pct = (colorFilled / colorSlots.length) * 100;
          html += `<div class="ws-crate-fill" style="background:${color};opacity:${colorFilled > 0 ? 1 : 0.25};width:${Math.max(pct, 10)}%"></div>`;
        }
        html += `<span class="ws-crate-num">${pc.label}</span>`;
        html += '</div>';
      }
      html += '</div>';
      html += `<div class="ws-stack-label${done ? ' ws-label-done' : ''}">${cust.customer}</div>`;
    } else {
      html += '<div class="ws-crate-column ws-empty-slot"></div>';
      html += '<div class="ws-stack-label ws-label-empty">---</div>';
    }
    html += '</div>';
  }
  html += '</div></div>';

  // ── Trolley/Pallet side ──
  html += '<div class="ws-section ws-section-transport">';
  html += `<div class="ws-section-label">${transportLabel}</div>`;
  html += '<div class="ws-stacks">';

  for (let si = 0; si < st.maxStacks; si++) {
    const stack = st.stacks[si];
    html += '<div class="ws-stack">';
    if (stack && stack.customers.length > 0) {
      html += '<div class="ws-crate-column">';
      // Show each customer's crates in the stack (bottom to top)
      for (let ci = stack.customers.length - 1; ci >= 0; ci--) {
        const custName = stack.customers[ci];
        const pcs = custCrateMap[custName] || [];
        for (let cri = pcs.length - 1; cri >= 0; cri--) {
          const pc = pcs[cri];
          html += `<div class="ws-crate-block ws-crate-full ws-crate-stacked" title="${custName} ${pc.label}">`;
          const uniqueColors = [...new Set(pc.slots.filter(s => s).map(s => s.color))];
          for (const color of uniqueColors) {
            html += `<div class="ws-crate-fill" style="background:${color}"></div>`;
          }
          html += `<span class="ws-crate-num">${pc.label}</span>`;
          html += '</div>';
        }
      }
      html += '</div>';
      html += `<div class="ws-stack-label ws-label-done">${stack.topCustomer}</div>`;
    } else {
      html += '<div class="ws-crate-column ws-empty-slot"></div>';
      html += '<div class="ws-stack-label ws-label-empty">---</div>';
    }
    html += '</div>';
  }

  html += '</div></div>';
  html += '</div>';
  return html;
}

// Render the fetch mode view
function renderFetchMode(orders) {
  const contentEl = document.getElementById('content');
  const scrollPosition = window.scrollY;
  const route = orders[0].route;

  if (!fetchBatches.length) { contentEl.innerHTML = ''; return; }
  const batch = fetchBatches[fetchCurrentBatchIndex];
  if (!batch) { contentEl.innerHTML = ''; return; }

  // Ensure stacking state exists for this batch
  if (!stackingState) initStackingState(batch);

  const wareColors = getWareColors(orders);
  let html = '';

  // ── Customer crate overview at the top — shows progress as slots fill up ──
  let globalCrateNum = 1;
  html += `<div class="fetch-batch-header"><div class="fetch-batch-title">Batch ${fetchCurrentBatchIndex + 1} of ${fetchBatches.length}</div></div>`;

  for (const cust of batch.customers) {
    const done = isBatchCustomerComplete(route, cust.orders);
    const completedCount = cust.orders.filter(o => isItemResolved(route, o.itemId)).length;
    const progressCrates = buildProgressCrates(cust, route, globalCrateNum);
    globalCrateNum += progressCrates.length;

    html += `<div class="fetch-cust-crates${done ? ' cust-done' : ''}">`;
    html += '<div class="fetch-cust-header-row">';
    html += `<span class="fetch-cust-name">${cust.customer}</span>`;
    html += `<span class="fetch-cust-tally${done ? ' tally-done' : ''}">${completedCount}/${cust.orders.length}</span>`;
    html += '</div>';
    if (progressCrates.length) {
      html += '<div class="fetch-crate-row">';
      for (const pc of progressCrates) {
        html += renderOneCrateProgress(pc, pc.label);
      }
      html += '</div>';
    }
    html += '</div>';
  }

  // ── Workspace diagram: floor stacks + trolley stacks ──
  const prompts = getStackingPrompts(batch, route);
  html += renderWorkspaceDiagram(batch, route, wareColors);

  // Stacking prompts (text instructions)
  for (const p of prompts) {
    html += `<div class="fetch-stack-prompt${p.type === 'wait' ? ' prompt-wait' : ''}">${p.message}</div>`;
  }

  // Batch complete banner
  const batchComplete = batch.customers.every(c => isBatchCustomerComplete(route, c.orders));
  if (batchComplete) {
    html += '<div class="fetch-batch-done">Batch complete!</div>';
  }

  // ── Pick sequence cards ──
  for (const pick of batch.pickSequence) {
    const allChecked = pick.picks.every(p =>
      p.orderItemIds.every(id => isItemResolved(route, id))
    );

    html += `<div class="fetch-pick-card${allChecked ? ' pick-done' : ''}">`;
    html += '<div class="fetch-pick-header">';
    html += `<div class="fetch-color-swatch" style="background:${pick.color}"></div>`;
    html += `<span class="fetch-ware-name">${pick.ware}</span>`;
    if (pick.uniqueCustomers > 1) {
      html += `<span class="fetch-shared-badge">x${pick.uniqueCustomers}</span>`;
    }
    html += `<span class="fetch-ware-total">${pick.totalQty} stk</span>`;
    html += supplierIconHTML(pick.supplier);
    html += '</div>';

    // Sub-rows: pending first, checked last
    const pending = pick.picks.filter(p => !p.orderItemIds.every(id => isItemResolved(route, id)));
    const done = pick.picks.filter(p => p.orderItemIds.every(id => isItemResolved(route, id)));
    const sortedPicks = [...pending, ...done];

    for (const p of sortedPicks) {
      const isChecked = p.orderItemIds.every(id => isItemResolved(route, id));
      html += `<label class="fetch-pick-row${isChecked ? ' row-checked' : ''}" data-order-ids="${p.orderItemIds.join(',')}">`;
      html += `<input type="checkbox" ${isChecked ? 'checked' : ''}>`;
      html += `<span class="fetch-crate-ref">Crate ${p.crateLabel} (${p.customer})</span>`;
      html += `<span class="fetch-pick-qty">${p.qty} stk</span>`;
      html += '</label>';
    }

    html += '</div>';
  }

  html += '<button class="reset-btn">↺ Reset checklist</button>';
  contentEl.innerHTML = html;
  window.scrollTo({ top: scrollPosition, behavior: 'instant' });

  // Update nav buttons
  document.getElementById('fetchPrevBtn').disabled = fetchCurrentBatchIndex <= 0;
  document.getElementById('fetchNextBtn').disabled = fetchCurrentBatchIndex >= fetchBatches.length - 1;
  document.getElementById('fetchBatchLabel').textContent = `Batch ${fetchCurrentBatchIndex + 1} / ${fetchBatches.length}`;
}

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
  const wareColors      = getWareColors(orders);

  let html = '';

  if (isRouteComplete && orders.length > 0) {
    html += `<div class="all-done"><div class="icon">✅</div><p>Route complete!</p></div>`;
  }

  // ─── CUSTOMER GROUP ──────────────────────────────────────────
  customerGroups.forEach(([customer, { orders: custOrders }]) => {
    const completedCount     = custOrders.filter(order => isItemResolved(route, order.itemId)).length;
    const isCustomerComplete = completedCount === custOrders.length;
    const isInProgress       = !isCustomerComplete && completedCount > 0;

    // Compute depts early — needed to decide where to place crate viz (header vs divider).
    const depts = [...new Set(custOrders.map(order => order.dept))];
    const multiDept = depts.length > 1;

    html += `
      <div class="customer-group ${isCustomerComplete ? 'cg-done' : isInProgress ? 'cg-in-progress' : ''}">
        <div class="customer-header">
          <span class="customer-name">${customer}</span>
          ${isInProgress ? '<span class="status-pip"></span>' : ''}
          <span class="customer-tally ${isCustomerComplete ? 'tally-done' : ''}">${completedCount}/${custOrders.length}</span>
          ${multiDept ? '' : crateVizHTML(buildCrateData(custOrders, wareColors))}
        </div>
        <div class="customer-orders">`;

    // Pending items first, resolved items sink to bottom — dept-aware sub-grouping.
    if (!multiDept) {
      const pending = custOrders.filter(order => !isItemResolved(route, order.itemId));
      const done    = custOrders.filter(order =>  isItemResolved(route, order.itemId));
      [...pending, ...done].forEach(order => { html += cardHTML(order, checkedForRoute, missingForRoute); });
    } else {
      depts.forEach(dept => {
        const deptOrders = custOrders.filter(order => order.dept === dept);
        const pending    = deptOrders.filter(order => !isItemResolved(route, order.itemId));
        const done       = deptOrders.filter(order =>  isItemResolved(route, order.itemId));
        html += `<div class="dept-divider">${dept || '—'}${crateVizHTML(buildCrateData(deptOrders, wareColors))}</div>`;
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
// Handles order-card checkboxes AND fetch-mode pick-row checkboxes.
document.getElementById('content').addEventListener('change', async e => {
  if (!e.target.matches('input[type="checkbox"]')) return;

  // ── FETCH MODE pick-row checkbox ──
  const pickRow = e.target.closest('.fetch-pick-row');
  if (pickRow) {
    const route = routeDropdown.value;
    if (!itemChecked[route]) itemChecked[route] = {};
    const orderIds = pickRow.dataset.orderIds.split(',');
    const routeOrders = getRouteOrders(route);
    const isNowChecked = e.target.checked;

    for (const id of orderIds) {
      itemChecked[route][id] = isNowChecked;
      const order = routeOrders.find(o => o.itemId === id);
      if (order && FIREBASE_URL) {
        if (isNowChecked) {
          postStatus({ orderNum: order.itemKey, route, customer: order.customer, status: 'checked' });
        } else {
          deleteStatus(order.itemKey);
        }
      }
    }
    updateStats(routeOrders);
    renderFetchMode(routeOrders);
    return;
  }

  // ── Normal mode order-card checkbox ──
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
      updateStats(routeOrders);
      renderOrders(routeOrders);
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
  // Reset fetch mode state too
  fetchBatches = [];
  fetchCurrentBatchIndex = 0;
  stackingState = null;
  updateStats(orders);
  renderCurrentRoute();
  resetFirebaseRoute(route, orders); // async, fire-and-forget
}

// Clears all Firebase entries for a route via a single PATCH with null values.
async function resetFirebaseRoute(route, orders) {
  if (!FIREBASE_URL) return;
  const nullPatch = {};
  orders.forEach(order => { nullPatch[order.itemKey] = null; });
  const wares = [...new Set(orders.map(order => order.ware))];
  wares.forEach(w => { nullPatch['SUMMARY|' + route + '|' + w] = null; });
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
document.querySelector('.refresh-btn').addEventListener('click', fetchOrderData);
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

// ─── FETCH MODE WIRING ──────────────────────────────────────
document.getElementById('fetchModeBtn').addEventListener('click', () => {
  fetchModeActive = !fetchModeActive;
  document.getElementById('fetchModeBtn').classList.toggle('active', fetchModeActive);
  document.getElementById('fetchModeBtn').textContent = fetchModeActive ? 'Exit Fetch' : 'Fetch Mode';
  // Rebuild batches when entering fetch mode
  if (fetchModeActive) {
    fetchBatches = [];
    fetchCurrentBatchIndex = 0;
    stackingState = null;
  }
  renderCurrentRoute();
});
document.getElementById('fetchPrevBtn').addEventListener('click', () => {
  if (fetchCurrentBatchIndex > 0) {
    fetchCurrentBatchIndex--;
    stackingState = null;
    renderCurrentRoute();
  }
});
document.getElementById('fetchNextBtn').addEventListener('click', () => {
  if (fetchCurrentBatchIndex < fetchBatches.length - 1) {
    fetchCurrentBatchIndex++;
    stackingState = null;
    renderCurrentRoute();
  }
});
document.getElementById('fetchTransport').addEventListener('change', () => {
  // Rebuild batches with new transport setting (affects trolley slot count)
  fetchBatches = [];
  fetchCurrentBatchIndex = 0;
  stackingState = null;
  if (fetchModeActive) renderCurrentRoute();
});
