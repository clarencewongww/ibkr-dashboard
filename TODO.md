# TODO — IBKR Dashboard

All four Daily P&L items from the previous batch are **done** — shipped in commit
`feat: daily p&l detail picker monday` on `main`.

## Daily P&L batch — done ✅

- [x] **1. Week starts Monday.** The `#dailyGrid` calendar is Monday-first:
      weekday row `M T W T F S S`, and the grid maths use the JS offset
      `col = (getUTCDay() + 6) % 7` (Mon=1 → column 0, Sun=0 → column 6), so
      every month's first cell is a Monday and the grid stays 4–6 rows / 42
      cells max. Verified for all 36 months of 2025–2027 plus the browser DOM.
- [x] **2. Day click → day detail.** Selecting a cell (click / Enter) opens
      `#dailyDetail` below the calendar: header `Wed 14 Jan 2026` + day net
      pill, a **Trades** group (Symbol · Asset class · Trades · Net P&L, one row
      per symbol+asset with summed net/count, full name in each row's
      `title`/`aria-label`) and an **Income** group (type · description · signed
      amount). Rows come from `aggregateByDay().rows`, collected in the same
      pass and with the same filters as the day buckets, so the day total ties
      to the clicked cell; clicking the same day again toggles the detail off,
      Enter/Esc and arrow-key focus behaviour are unchanged. Empty day →
      *No activity this day.*; cash-only day → income rows plus the trades
      group's *No trades this day.* line.
- [x] **3. Calendar icon picker.** `#dailyPickerBtn` (calendar glyph, beside
      `‹ ›`) opens the `#dailyPicker` dialog (Year + Month selects, Go / Close).
      Year options come from the loaded data, plus *All years* while the global
      year filter is *All years* (jumps to the latest year on record holding the
      month); with a year filter active the select pins to it and the jump goes
      through the same `clampDailyYm()` path as `‹`/`›`. Esc, backdrop and
      outside clicks close it; focus returns to `#dailyPickerBtn`.
- [x] **4. Income is not trades.** Trade counts on cells and in the detail stay
      trade-only; cell totals and the day total include interest / dividends /
      withholding / fees (and the accrual day-splits on the Accrual basis). A
      cash-only day shows the amount with no trade count, and its detail lists
      the income rows only.

## Resume notes
- Branch `main`, static zero-build app: `index.html`, `styles.css`,
  `app.js`, `sw.js`. Data stays local (`data/*.csv`, gitignored).
- Re-verify with `node --check app.js`, the node invariants (Monday-first
  offsets, day sums == monthly rows for posted+accrual × include/exclude ×
  asset × USD/AUD) and a browser pass at 375 / 768 / 1440 in both themes.
