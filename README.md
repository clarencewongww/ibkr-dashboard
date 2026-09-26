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

Multiple files can be loaded together; the app merges them and de-duplicates.

---

## 3. Privacy

- **Zero network.** No CDN, no web fonts, no analytics, no external requests of any kind. The only
  "http" strings in the source are XML namespaces inside inline `data:` SVG URIs, which are never
  fetched. The app is `index.html` + `styles.css` + `app.js` and nothing else.
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

## 4. File map

| Path | Role |
| --- | --- |
| `index.html` | Markup contract: header, month/year chips, chart cards, table, `#postedToggle`, `#clearBtn`, file input. |
| `styles.css` | All styling and design tokens (CSS custom properties in `:root`); no external assets. |
| `app.js` | CSV parser (Flex + Activity Statement), month aggregation, rendering. Exposes `window.IBKR` for debugging. |
| `csv/` | Your local IBKR exports (gitignored). |
| `data/` | Scratch space for local data (gitignored). |
| `.gitignore` | Keeps `*.csv`, `csv/*`, `data/*` and env/log noise out of git. |
| `README.md` | This file. |

## 5. Verify it yourself

```bash
# No outbound references should be printed by either grep:
grep -nE "https?://|//cdn|@import|googleapis|fontawesome" index.html styles.css app.js
# → only matches inside data: URIs (xmlns), which never make a request

# Your CSV must be ignored by git:
git check-ignore -v csv/Monthly_Realised_PnL.csv

# Confirm nothing sensitive is staged before committing:
git status --short
```

Manual smoke test: open the page → choose the CSV → the newest month's total should match
`Realized P/L` for that month in the file; toggling **Posted ↔ Accrual** should change the interest
bucket only when an Interest Accruals section is present.
