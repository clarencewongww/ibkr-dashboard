# IBKR Realised P&L — Local Dashboard

A single-page, zero-dependency dashboard that turns your IBKR **Monthly Realised P&L** export into
monthly buckets (options, assignment, interest, dividends, withholding, fees) with instrument-level
drill-down. Everything runs in the browser: your file never leaves your machine.

---

## 1. Get the CSV from IBKR

### Preferred: Flex Query

1. Log in to Client Portal → **Performance & Reports** → **Flex Queries**.
2. Open (or create) an **Activity Flex Query** named `Monthly_Realised_PnL`.
3. Include these sections:
   - **Trades** (Executions)
   - **Cash Transactions**
   - **Interest Accruals**
   - **Cash Report**
   - **Realized/Unrealized P&L** → set the currency to **Base** (not per-currency, not "Base Summary")
4. Set **Format: CSV**, **Period: Last Month**, then **Run** / **Download** the file.
5. Save the `.csv` anywhere on your machine — this app only reads it locally.

> **Freshness limits, by design:**
> - IBKR typically needs up to **5 business days** after month-end before the full previous month is final.
> - Flex Queries generally cannot include the **current trading day** — the most recent complete day is
>   the previous day. A same-day re-run for "last month" is fine once the month has actually closed.

### Fallback: Activity Statement

Statements → **Run** → select the monthly period → **CSV**. Choose the *Monthly* statement and include
`Trades`, `Cash Transactions`, `Interest Accruals` and `Cash Report` sections. The parser also
understands this Activity-Statement layout (it keys off the `Trades` / cash section headers).

---

## 2. Run it

### Option A — double-click (no server)

Open `index.html` directly from Finder (works over `file://`) and pick your CSV with **Choose file**.
All parsing is done with the browser's `FileReader`; no server, no upload.

### Option B — local HTTP server (recommended for a stable origin)

```bash
python3 -m http.server 8000 --bind 127.0.0.1
# then open http://127.0.0.1:8000
```

Bind to **127.0.0.1 only** — never `0.0.0.0`. Binding to all interfaces would expose your statement
to anyone on the same network. There is nothing to install and no build step.

### What the buckets mean

| Bucket | Rule |
| --- | --- |
| **Options** | Trades whose asset class is an option/future-option (`OPT`, `FOP`, `WAR`, `IOPT`, …). |
| **Assignment** | Stock/ETF trades whose `Code` contains **`A`** (assignment) or **`Ex`** (exercise), plus GEA-flagged legs. Plain stock trades (no `A`/`Ex`) are folded into this total and shown as **Stock (other)** in the drill-down. |
| **Interest** | Posted cash interest by default (`Broker Interest Received/Paid`, `Bond Interest`, …). Switch the **Posted / Accrual** toggle to replace posted interest with the **Interest Accruals** (`IACC`) split, spread day-by-day across each accrual period. If the file has no Interest Accruals section, the toggle falls back to posted interest. |
| **Dividends / Withholding / Fees** | From cash rows: dividends & payment-in-lieu; withholding tax; other/advisor fees and commission adjustments. |
| **Total** | `options + assignment + interest + dividends + withholding + fees`. |

Commissions are **already netted** into the realized P&L figure IBKR reports — the app does not
subtract them a second time. The CSV's commission column is read for context only.

Multiple files are concatenated; do not load overlapping periods twice or totals will double-count. Load each month once.

---

## 3. Breakdown, exclude & currency

### Breakdown

The **Income breakdown** card stacks each month into three colored segments:

| Segment | Color | Contents |
| --- | --- | --- |
| **Options** | green | Option and future-option trades. |
| **Stock** | indigo | Stock/ETF trades, including assignment and exercise legs. |
| **Income** | gold | Interest + dividends + withholding + fees, combined. |

The full split stays **Total = options + assignment + interest + dividends + withholding + fees**,
so the stack height matches the month's total whenever the segments share a sign. Positive and
negative segments are drawn on opposite sides of the zero line independently. Hover or focus a
segment for its exact value and share of the month's net.

### Exclude

**Exclude tickers** removes instruments from every aggregate — KPIs, both charts, the month table
and the drill-down:

- Type a ticker (or several, comma-separated: `AMD, NVDA`) and press Enter, or click a chip.
- The chips row shows the **12 largest instruments by absolute P&L**, plus any excluded ticker
  that isn't already listed, so an exclusion can always be undone. `aria-pressed` mirrors the state.
- Matching is case-insensitive and uses the **root symbol**: OCC-style padded option symbols are
  trimmed at the first space, so excluding `AMD` also hides `AMD   260220P00185000`.
- The list persists in `localStorage` under **`ibkr-exclude-v1`** and survives refreshes.
- Ticker-less cash rows (e.g. broker interest) are never excluded.
- Excluding only hides instruments from the display; **concatenated files still double-count** if
  you load overlapping periods — excluded or not, load each month once.

### Currency

The **USD / AUD** switch converts every money figure at render time. Amounts stay raw USD in
memory; nothing is rewritten.

- **Automatic rate.** Loading a CSV kicks off a background rate lookup (a fresh override or cache
  short-circuits it), and selecting AUD retries when no rate has resolved yet. Providers are tried
  in order:
  1. **frankfurter** — `frankfurter.dev` v2 rate endpoint (primary; `GET /v2/rate/USD/AUD`)
  2. **er-api** — `open.er-api.com` v6 latest rates (fallback)
  3. **currency-api** — `@fawazahmed0/currency-api` via `cdn.jsdelivr.net` (second fallback)
- **Cache.** A successful rate is cached in `localStorage` under **`fx-audusd-v1`** for **12 hours**.
  After that it is refreshed; if every provider fails, the newest cached rate is used as `(stale)`.
- **Network hygiene.** Each lookup is a plain `GET` of the provider's fixed URL — **only currency
  codes are sent; your file, totals and statement data never leave the page and never appear in a
  URL**. The page is marked `Referrer: no-referrer`, requests use `cache: 'no-store'`, and an
  **`AbortController` 5-second timeout** caps each provider attempt.
- **Manual override.** Entering a rate in **Rate USD/AUD** beats the automatic chain, is stored as
  **`fx_override`**, and suppresses provider lookups entirely — **manual mode is zero-network**.
  **Auto** clears the override and returns to the automatic chain.
- **Offline.** With no override, no cache and no reachable provider, the app falls back to a baked
  approximation of **1.423** USD→AUD (badge reads `FX: approximate`).
- **Badge.** The footer always shows the applied source, the provider's rate date and the exact
  rate (`FX: <source> · <date> · 1 USD=<rate> AUD`).
- **Attribution.** The footer keeps the required rates attribution link to **Exchange Rate API**;
  no statement data is requested by or sent to it.

---

## 4. Privacy

- **No CDN, no fonts, no analytics.** The app is `index.html` + `styles.css` + `app.js` and nothing
  else; every asset is inline or local, and `file://` use makes zero requests. The **only** optional
  outbound calls are the fixed-URL USD→AUD rate lookups described in *Currency* above — nothing else
  is ever requested, and your file is never uploaded. (The remaining `http` strings inside inline
  `data:` SVG URIs are XML namespaces, which are never fetched.)
- **Data stays in the browser.** Parsed results are cached in `localStorage` under the key **`ibkr-v1`**
  (only for files ≤ 2 MB) so a refresh doesn't lose your session. `Clear` in the header wipes the
  cache, the file input and all state.
- **Never committed.** `csv/`, `data/`, and `*.csv` / `*.CSV` are gitignored. `csv/Monthly_Realised_PnL.csv`
  is a local working copy and is **not** in version control.
- **Never deploy with real data.** If this is hosted anywhere (GitHub Pages, etc.), ship the code only —
  no statements, no cached exports, no screenshots of real P&L.
- Design tokens (palette, spacing, gradient) are based on the MIT-licensed
  [Creative Tim `purity-ui-dashboard`](https://github.com/creativetimofficial/purity-ui-dashboard)
  (Purity UI Dashboard). Attribution retained here as required by the MIT license.

---

## 5. File map

| Path | Role |
| --- | --- |
| `index.html` | Markup contract: header, month/year chips, chart cards, table, `#postedToggle`, `#excludeInput` / `#excludeChips`, `#fxInput` / `#fxReset` / `#fxBadge`, `#clearBtn`, file input. |
| `styles.css` | All styling and design tokens (CSS custom properties in `:root`); no external assets. |
| `app.js` | CSV parser (Flex + Activity Statement), month aggregation, root-symbol exclude filter, USD/AUD rate chain, rendering. Exposes `window.IBKR` for debugging. |
| `csv/` | Your local IBKR exports (gitignored). |
| `data/` | Scratch space for local data (gitignored). |
| `.gitignore` | Keeps `*.csv`, `csv/*`, `data/*` and env/log noise out of git. |
| `README.md` | This file. |

## 6. Verify it yourself

```bash
# Expected outbound URLs only: the footer attribution link (index.html) and the three
# fixed FX provider endpoints (app.js). No data, no query strings, no CSV content:
grep -rn "https://" README.md index.html
grep -nE "https?://" app.js
# → attribution + provider URLs only; every URL is a literal constant, and no user data
#   is ever interpolated into one

# Your CSV must be ignored by git:
git check-ignore -v csv/Monthly_Realised_PnL.csv

# Confirm nothing sensitive is staged before committing:
git status --short
```

Manual smoke test: open the page → choose the CSV → the newest month's total should match
`Realized P/L` for that month in the file; toggling **Posted ↔ Accrual** should change the interest
bucket only when an Interest Accruals section is present.
