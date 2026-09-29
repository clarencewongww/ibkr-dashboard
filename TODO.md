# TODO — IBKR Dashboard

Working notes for future features. Nothing here is started yet.

## Daily P&L tab (next batch)

Current state: `renderDaily()` in `app.js`, `#tabDaily` panel in `index.html`,
calendar CSS in `styles.css`. Calendar is Sun-first, cells show day number,
day P&L and a trade count; day-level cash income is already included in the
daily totals (same aggregation as the monthly rows).

### 1. Week starts Monday
- Change the calendar grid to Mon-first (`M T W T F S S`).
- Weekday header row and cell offset math must both shift by one
  (currently `dow === index % 7` with Sunday = 0).

### 2. Click a day → show that day's trades and individual profits
- Clicking a cell (or pressing Enter on it) opens a day detail view —
  panel below the calendar or a modal, whichever fits better.
- List each instrument with its realised P&L for that day, e.g.
  `AMZN options  +$120.40`, plus day total.
- Reuse the existing drill-down row style (`#drillTable` patterns:
  Symbol | Asset class | Trades | Net P&L) and the same include/exclude
  filters as the calendar.

### 3. Calendar icon → month/year picker
- Add a calendar glyph next to the `‹ ›` controls that opens a small
  picker (two selects: Year, Month) to jump directly to a month/year.
- Must respect the global Year select clamping behaviour (year filter
  limits the jumpable range when not "All years").
- `Today` button stays as-is.

### 4. Interest / dividends in the day detail
- Interest and dividend income must be reflected in the daily P&L totals
  (already the case) but must NOT be counted as trades
  (trade count stays trade-only — already the case).
- When a day is clicked, the detail view must also list income rows,
  e.g. `USD Broker Interest Received  +$232.10`,
  `AAPL Cash Dividend  +$1.61`, clearly separated from trades
  (e.g. an "Income" group with no trade-count contribution).
- Cash-only days should show the day detail with income rows and
  no trade rows.

## Resume notes
- Branch `main`, static zero-build app: `index.html`, `styles.css`,
  `app.js`, `sw.js`. Data stays local (`data/*.csv`, gitignored).
- Verify each change with `node --check app.js` plus a browser pass at
  375 / 768 / 1440 in both themes, and confirm
  daily sums still equal the Monthly summary rows.
