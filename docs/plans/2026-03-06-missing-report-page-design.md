# Missing Items Report Page — Design

**Date:** 2026-03-06

## Purpose

A standalone read-only HTML page for office staff and management to check which items have been flagged as missing during a delivery run. Audience is mixed: real-time checking during a run and post-run review.

## Data Source

`GET {FIREBASE_URL}/statuses.json` — same endpoint used by the main app. Filter for entries where `status === 'missing'`. Skip keys with `SUMMARY|` prefix (sorting-stage entries).

Ware name and order number are decoded from the itemKey (`orderNum|ware` format). Route, customer, `qtyMissing`, and `replacementWare` are stored directly on the Firebase entry.

## Refresh Strategy

Fetch once on page load. Manual **Refresh** button for on-demand re-checks. No polling — users open the page when they want to check, so automatic background polling adds complexity with no benefit.

## Layout

Single flat list — no grouping by route or customer. Two visual sections:

| Section | Border colour | Condition |
|---|---|---|
| Replaced | Amber (`--accent`) | `replacementWare` is set |
| Fully missing | Red (`#bf4040`) | No `replacementWare` |

Each row shows: **ware name · order # · route · customer · qty missing · replacement** (or "—").

Empty state: friendly message when no missing items are found.

## Style

Matches the main app — same Google Fonts (Barlow Condensed, DM Mono), same CSS custom properties inline in a `<style>` block. No external stylesheet dependency. Self-contained single file.

## File

`missing-report.html` in the repo root, served by GitHub Pages at the same domain.
