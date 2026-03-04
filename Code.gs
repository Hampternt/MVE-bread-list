// ═══════════════════════════════════════════════════════════════
// MVE Bread — CustomerStatus Web App
// Code.gs
// ─────────────────────────────────────────────────────────────
// Bound to spreadsheet: 1fHSxyKIDYyBRqiDmUm2BEe2GmDGObVrDW7pzJEwVSKE
//
// Deploy as Web App:
//   Script Editor → Deploy → New deployment → Web App
//   Execute as: Me
//   Access: Anyone
//
// After deploying, paste the generated URL into APPS_SCRIPT_URL in script.js
// ═══════════════════════════════════════════════════════════════

var SHEET_NAME = 'CustomerStatus';
var HEADERS    = ['orderNum', 'route', 'customer', 'status', 'timestamp'];

// ─── doGet ─────────────────────────────────────────────────────
// Returns all rows from CustomerStatus tab as a JSON array:
//   [{ orderNum, route, customer, status }, ...]
function doGet(e) {
  var sheet = getOrCreateSheet();
  var data  = sheet.getDataRange().getValues();

  // If only header row (or empty), return empty array
  if (data.length < 2) {
    console.log('[doGet] Sheet empty — returning []');
    return jsonResponse([]);
  }

  var rows = data.slice(1)
    .map(function(row) {
      return {
        orderNum  : String(row[0]),
        route     : String(row[1]),
        customer  : String(row[2]),
        status    : String(row[3]),
        timestamp : String(row[4])
      };
    })
    .filter(function(r) { return r.orderNum && r.status; });

  console.log('[doGet] Returning ' + rows.length + ' item statuses');
  return jsonResponse(rows);
}

// ─── doPost ────────────────────────────────────────────────────
// Receives: { orderNum, route, customer, status } JSON body
// Finds existing row by orderNum and updates it, or appends new row.
function doPost(e) {
  var payload  = JSON.parse(e.postData.contents);
  var orderNum = String(payload.orderNum);
  var route    = String(payload.route    || '');
  var customer = String(payload.customer || '');
  var status   = String(payload.status   || '');

  if (!orderNum || !status) {
    console.warn('[doPost] Rejected — missing orderNum or status. Payload: ' + JSON.stringify(payload));
    return jsonResponse({ ok: false, error: 'Missing orderNum or status' });
  }

  var sheet   = getOrCreateSheet();
  var allRows = sheet.getDataRange().getValues();

  // Search for existing row matching orderNum (rows start at index 1 = row 2 in sheet)
  var action = 'inserted';
  for (var i = 1; i < allRows.length; i++) {
    if (String(allRows[i][0]) === orderNum) {
      sheet.getRange(i + 1, 4).setValue(status);
      sheet.getRange(i + 1, 5).setValue(new Date().toISOString());
      console.log('[doPost] Updated — route=' + route + ' customer="' + customer + '" item=' + orderNum + ' status=' + status);
      action = 'updated';
      break;
    }
  }

  if (action === 'inserted') {
    // No existing row — append new
    sheet.appendRow([orderNum, route, customer, status, new Date().toISOString()]);
    console.log('[doPost] Inserted — route=' + route + ' customer="' + customer + '" item=' + orderNum + ' status=' + status);
  }

  // Return all rows so the client can apply fresh state without a separate GET
  var freshData = sheet.getDataRange().getValues();
  var rows = freshData.slice(1).map(function(row) {
    return {
      orderNum : String(row[0]),
      route    : String(row[1]),
      customer : String(row[2]),
      status   : String(row[3])
    };
  }).filter(function(r) { return r.orderNum && r.status; });
  return jsonResponse({ ok: true, action: action, rows: rows });
}

// ─── Helpers ───────────────────────────────────────────────────
function getOrCreateSheet() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    console.log('[getOrCreateSheet] Sheet not found — creating ' + SHEET_NAME);
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
  }
  return sheet;
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
