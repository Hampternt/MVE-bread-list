// ═══════════════════════════════════════════════════════════
// Upload Script — parses CSV or XLSX and writes to Firestore
// ═══════════════════════════════════════════════════════════

// ─── PIN GATE ─────────────────────────────────────────────
const pin = sessionStorage.getItem('app-pin');
if (!pin) { location.replace('index.html'); }

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
    qty          : parseInt(fields[COLS.qty])            || 0,
    ware,
    supplier     : String(fields[COLS.supplier]      || '').trim(),
    customer     : String(fields[COLS.customer]      || '').trim(),
    dept         : String(fields[COLS.dept]          || '').trim(),
    route        : String(fields[COLS.route]         || '').trim(),
    routeOrdering: parseInt(fields[COLS.routeOrdering]) || 0,
    acceptAlts   : String(fields[COLS.acceptAlts]    || '').trim().toUpperCase() === 'TRUE',
  };
}

// ─── PARSE FILE ───────────────────────────────────────────
async function parseFile(file) {
  if (file.name.toLowerCase().endsWith('.csv')) {
    const text = await file.text();
    const rows = parseCSV(text);
    return rows.slice(1).map(rowToOrder).filter(Boolean);
  }

  // XLSX: use SheetJS global XLSX (loaded via CDN in upload.html)
  const buf  = await file.arrayBuffer();
  const wb   = XLSX.read(buf, { type: 'array' });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  return rows.slice(1).map(rowToOrder).filter(Boolean);
}

// ─── FIREBASE AUTH (anonymous) ────────────────────────────
// Firestore REST writes require a Firebase Auth ID token.
// We sign in anonymously and cache the token for the session.
let _authToken = null;

async function getAuthToken() {
  if (_authToken) return _authToken;
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIRESTORE_KEY}`;
  const res  = await fetch(url, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`Auth failed HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  _authToken = data.idToken;
  return _authToken;
}

// ─── FIRESTORE HELPERS ────────────────────────────────────
// Returns the raw Firestore document ID (not URL-encoded).
// '/' is replaced because Firestore REST treats %2F as a path separator.
// URL-encoding happens in writeDoc/deleteDoc when building the fetch URL.
function docId(order) {
  return order.itemKey.replace(/\//g, '_');
}

function orderToFirestoreFields(order) {
  return {
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
  };
}

async function writeDoc(collection, id, fields) {
  const token = await getAuthToken();
  const url   = `${FIRESTORE_BASE}/${collection}/${encodeURIComponent(id)}?key=${FIRESTORE_KEY}`;
  const res   = await fetch(url, {
    method : 'PATCH',
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`write HTTP ${res.status}: ${await res.text()}`);
}

async function deleteDoc(collection, id) {
  const token = await getAuthToken();
  const url   = `${FIRESTORE_BASE}/${collection}/${encodeURIComponent(id)}?key=${FIRESTORE_KEY}`;
  const res   = await fetch(url, {
    method : 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`delete HTTP ${res.status}: ${await res.text()}`);
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
      data.documents.forEach(doc => ids.push(doc.name.split('/').pop()));
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return ids;
}

// ─── UPLOAD FLOW (write-then-delete) ─────────────────────
// Writes new docs first, then removes stale ones.
// The collection is never empty during upload.
async function uploadOrders(orders, collection) {
  setStatus('', `Writing ${orders.length} rows…`);
  const newDocIds = new Set(orders.map(docId));
  const BATCH = 20;

  // Step 1: write/upsert all documents in parallel batches
  for (let i = 0; i < orders.length; i += BATCH) {
    const chunk = orders.slice(i, i + BATCH);
    setStatus('', `Writing rows ${i + 1}–${Math.min(i + BATCH, orders.length)} of ${orders.length}…`);
    await Promise.all(chunk.map(order => writeDoc(collection, docId(order), orderToFirestoreFields(order))));
  }

  // Step 2: delete stale documents (those not in the new upload)
  setStatus('', 'Removing stale rows…');
  const existingIds = await listAllDocIds(collection);
  const toDelete    = existingIds.filter(id => !newDocIds.has(id));

  for (let i = 0; i < toDelete.length; i += BATCH) {
    await Promise.all(toDelete.slice(i, i + BATCH).map(id => deleteDoc(collection, id)));
  }

  setStatus('success', `✓ Uploaded ${orders.length} rows to ${collection}. ${toDelete.length} stale row(s) removed.`);
}

// ─── UI ───────────────────────────────────────────────────
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const previewEl = document.getElementById('preview');
const statusEl  = document.getElementById('status');

let parsedOrders = [];

function setStatus(type, msg) {
  statusEl.textContent = msg;
  statusEl.className   = 'upload-status' + (type ? ' ' + type : '');
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
    const routes = [...new Set(parsedOrders.map(o => o.route))].filter(Boolean);
    previewEl.textContent = `Found ${parsedOrders.length} rows across ${routes.length} route(s): ${routes.join(', ')}`;
    previewEl.classList.remove('hidden');
    setStatus('', '');
    uploadBtn.disabled = parsedOrders.length === 0;
  } catch (err) {
    setStatus('error', 'Parse error: ' + err.message);
  }
});

uploadBtn.addEventListener('click', async () => {
  const collection = `pins/${pin}/${document.querySelector('input[name="collection"]:checked').value}`;
  uploadBtn.disabled = true;
  try {
    await uploadOrders(parsedOrders, collection);
  } catch (err) {
    setStatus('error', 'Upload failed: ' + err.message);
    uploadBtn.disabled = false;
  }
});
