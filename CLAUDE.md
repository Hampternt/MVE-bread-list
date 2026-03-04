# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A zero-dependency vanilla JavaScript single-page app for MVE Bread delivery staff. Used on mobile to track and check off orders per delivery route. Data comes from a Google Sheet published as CSV. Hosted on GitHub Pages at `mvebread.dblo.net`.

## Development

No build step. No package manager. To run locally, open `index.html` in a browser. The app auto-detects `file://` protocol and routes data fetches through `corsproxy.io` to handle CORS.

To deploy: push to `main` branch — GitHub Pages serves it automatically.

## Architecture

Everything lives in `index.html` — all HTML, CSS (in `<style>`), and JavaScript (in `<script>`). There are no separate files except `CNAME`.

**Data flow:**
1. `fetchSheetData()` — fetches CSV from Google Sheets, parses it with a custom hand-rolled parser
2. Populates `allData[]` — all order rows
3. `renderCurrentRoute()` calls `renderSummary()` and `renderOrders()` to build the UI
4. User checks off items → state updated in memory → `updateStats()` + re-render

**Key state:**
- `allData[]` — all parsed rows
- `checked[route][itemId]` — which order line items are ticked, per route
- `summaryChecked[route][ware]` — which bread types are marked sorted, per route
- `COLS` object — maps CSV column indices to semantic field names

**Sorting logic:**
- Customer groups sorted by highest `routeOrdering` first (LIFO — last stop packed first)
- Within a customer: unchecked items first, checked items sink to bottom
- Completed customers slide to the bottom of the page

**Event handling:** All listeners attached to static container elements (`#summaryItems`, `#content`) using delegated events via `event.target.matches()` — survives `innerHTML` replacement without reattaching.

## Customization Points (in `script.js` section of `index.html`)

- `SHEET_CSV_URL` — change to point at a different Google Sheet
- `COLS` object — remap if the sheet column structure changes
- CSS variables at the top of `<style>` — controls the dark olive + yellow-gold + green theme
