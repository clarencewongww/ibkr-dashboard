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

### Option A — one-click launcher (kills the old server first)

Double-click **`Start-Dashboard.app`**, or run `./Start-Dashboard.sh` from Terminal. The launcher
kills whatever is listening on port 8000, starts `python3 -m http.server` bound to **127.0.0.1**,
waits for `http://127.0.0.1:8000/index.html` to answer, then opens it. The server is detached, so
nothing has to stay open after the page appears.

- **First launch only (Gatekeeper):** right-click `Start-Dashboard.app` → **Open** → **Open**. The
  bundle is signed locally (ad-hoc), so plain double-click works from then on.
- **Stop it manually:** `lsof -ti:8000 -sTCP:LISTEN | xargs kill`.

### Option B — double-click (no server)

Open `index.html` directly from Finder (works over `file://`) and pick your CSV with **Choose file**.
All parsing is done with the browser's `FileReader`; no server, no upload.

### Option C — local HTTP server (recommended for a stable origin)

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

## 3. Breakdown, interest, filters & currency

### Monthly chart

The **Monthly realised P&L** card is dual-axis: the green/red bars scale to the monthly totals
(**left** axis) and the teal running-total line — dots carry a `Running $…` tip — scales to the
cumulative series (**right** axis). A month far larger than the rest can no longer flatten the
other series. The legend marks the sides: **Net P&L (left)** and **Running total (right)**.

### Breakdown

The **Income breakdown** card stacks each month into three colored segments:

| Segment | Color | Contents |
| --- | --- | --- |
| **Options** | green | Option and future-option trades. |
| **Stock** | indigo | Stock/ETF trades, including assignment and exercise legs. |
| **Income** | gold | Interest + dividends + withholding + fees, combined (the legend calls it **Interest + Div**). |

The full split stays **Total = options + assignment + interest + dividends + withholding + fees**,
so the stack height matches the month's total whenever the segments share a sign. Positive and
negative segments are drawn on opposite sides of the zero line independently. Hover or focus a
segment for its exact value and share of the month's net; the gold **Income** segment instead
spells out `Income $X = Interest $a + Div $b` (withholding/fees stay netted inside `X`).

The legend's **Interest + Div** row carries a round **i** button (`#incomeInfo` → `#incomeHelp`).
Hover or focus it for the definition — *Income = Interest + Dividends (plus Withholding + Fees
netted)*. The **Net P&L** KPI delta carries the same `Income $X = Interest $a + Div $b` breakdown
as a title. Both views convert at render time with the active USD/AUD switch.

### Interest tab

The **Overview / Interest** tabs above the content (deep-linkable as `#overview` / `#interest`)
switch views; the Interest tab renders four KPIs, a bar chart and a per-month table:

| KPI | Maths |
| --- | --- |
| **Interest total** | Interest across the visible months. |
| **Avg / day** | Total ÷ days — calendar days of the visible months on the posted basis, or the summed `IACC` `from`→`to` window on the accrual basis. |
| **Best month** | Highest monthly interest; the winning month's name sits under the value. |
| **Share of income** | **Total interest ÷ net P&L** — the label says "income", but the maths divides by the net P&L summed across the visible months, not by the income segment, and reads `0.0%` when net is zero. |

- **Chart.** Bars are green when the month's interest is positive, red when negative; a teal line
  with dots tracks the cumulative interest across the visible months. Hover or focus a bar or dot
  for the unified monthly tip (`Net … · Interest …`).
- **Table.** One row per visible month: month, interest, trade count, and **share of net** — that
  month's interest ÷ that month's net P&L (same divisor as the KPI, month by month). The static
  header row labels the four columns; hover **Trades** for *trade executions that month, not
  interest rows* and **Share** for the monthly rule (`—` when the month's net is 0).
- **Posted vs accrual.** `Posted` (the default) uses posted cash interest. `Accrual` replaces the
  interest bucket with the **Interest Accruals (`IACC`)** amounts spread day-by-day across each
  accrual window, so mid-month accruals land on both months. The toggle is global — it changes the
  interest bucket in every view, not just this tab. A file with no Interest Accruals section falls
  back to posted interest and the toggle's tooltip explains why; the card's basis note reads
  `Posted basis` / `Accrual basis`.
- **Currency.** The USD/AUD switch applies here like everywhere else: KPIs, bars, tooltips and the
  table are converted at render time from the raw USD amounts (see *Currency* below).

### Exclude

**Exclude** removes instruments from every aggregate — KPIs, both charts, the month table and the
drill-down. Exclusions are set from the **Tickers** modal only:

- Open **Tickers (n)** in the toolbar, tick a symbol's **Ex** checkbox and press **Apply** to commit
  and persist the list; **Clear** drops it again.
- Matching is case-insensitive and uses the **root symbol**: OCC-style padded option symbols are
  trimmed at the first space, so excluding `AMD` also hides `AMD   260220P00185000`.
- **Scope.** Each row also carries a **Scope** select — *All* (the default), *Options only* or
  *Stock only*. A scoped exclude drops only that leg kind — `AMD` + *Stock only* hides AMD's
  stock trades while its option legs keep counting, and vice versa. Scopes persist under
  **`ibkr-exclude-scope-v1`** and are dropped whenever their symbol leaves the exclude list.
- The list persists in `localStorage` under **`ibkr-exclude-v1`** and survives refreshes.
- The toolbar note (`#filterNote`) summarises the active filters — `Including only AMD
  (Options only), B · Excluding C (Stock only) · Stock only` — and stays hidden while
  everything is default.
- Ticker-less cash rows (e.g. broker interest) are never excluded.
- Excluding only hides instruments from the display; **concatenated files still double-count** if
  you load overlapping periods — excluded or not, load each month once.

### Include

**Include tickers** is the allow-list mirror of Exclude, using the same case-insensitive root-symbol
matching and persisted in `localStorage` under **`ibkr-include-v1`**:

- **Allow-list first.** While the include list is non-empty, only listed roots aggregate into the
  KPIs, both charts, the month table and the drill-down; an empty list includes everything.
- **Exclude wins, per kind.** When a ticker is caught by both filters, each leg kind survives only
  if the include scope allows it **and** no exclude covers it. An unscoped exclude drops every leg
  of its symbol; a scoped one drops only its kind — include `AMD` *Options only* together with
  exclude `AMD` *Stock only* keeps AMD's options, while a plain exclude of `AMD` beats any scope.
- **Scope.** *Include* + *Options only* keeps only that symbol's option legs (its stock legs and
  every other symbol are dropped). Scopes persist under **`ibkr-include-scope-v1`**, are pruned
  when their symbol leaves the include list, and show up on the chip (`AMD (Options only)`) and
  in `#filterNote`.
- **Global asset filter.** The modal's **All / Options only / Stock only** radios
  (`#assetToggle`) hide the other leg kind dashboard-wide and apply **live** — no Apply needed.
  The choice is **session-only** (never written to `localStorage`); **Clear** resets it to *All*.
- **Tickers modal.** The **Tickers (n)** button opens a `<dialog>` listing every traded root
  (largest |P&L| first, plus any manual pick) with symbol, P&L, a **Scope** select and
  **In / Ex** checkboxes that are mutually exclusive per row — checking one unchecks its twin.
  **Apply** commits and persists the lists *and* their scopes, **Clear** drops both filters,
  both scope maps and the global asset choice and empties the search box without closing the
  modal, and **Close** / Esc / backdrop discards unapplied changes (state is the source of truth).
- **Search.** The modal's filter box is a case-insensitive substring match over the rendered
  symbols; the count reads `shown / total` while a query is active, and the **×** button
  (`#tickerSearchClear`) clears the query.
- **Chips.** Every included root appears as a pressed chip next to the button, labelled with its
  scope while scoped (`AMD (Options only)`); click a chip to drop that ticker from the allow-list.
- **Jump back.** The Monthly summary header carries a **Tickers ↑** shortcut (`#toTopTickers`) that
  scrolls the toolbar into view and focuses the modal button.
- **Ticker-less cash rows** (e.g. broker interest) have no root symbol, so **include never filters
  them** — interest and other cash buckets stay in the totals while an allow-list is active.
- As with Exclude, hiding is display-only: **overlapping concatenated files still double-count**.

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
- **Never committed.** `data/` and `*.csv` / `*.CSV` are gitignored. `data/Monthly_Realised_PnL.csv`
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
| `index.html` | Markup contract: header, month/year chips, chart cards, table, `#postedToggle`, `#tickerBtn` / `#tickerSearchClear` / `#tickerCount` / `#filterNote` / `#toTopTickers`, `#assetToggle` asset radios, `#fxInput` / `#fxReset` / `#fxBadge`, legend income popover `#incomeInfo` / `#incomeHelp`, `#clearBtn`, file input. |
| `styles.css` | All styling and design tokens (CSS custom properties in `:root`); no external assets. |
| `app.js` | CSV parser (Flex + Activity Statement), month aggregation, root-symbol include/exclude filter with per-kind scopes, session-only asset filter, USD/AUD rate chain, rendering. Exposes `window.IBKR` for debugging. |
| `Start-Dashboard.sh` | Kill-then-start launcher: frees port 8000, serves this folder on **127.0.0.1** and opens the page. |
| `Start-Dashboard.app` | Double-click wrapper around `Start-Dashboard.sh`; no Terminal window (right-click **Open** on first launch only). |
| `data/` | Your local IBKR exports and scratch space (gitignored). |
| `.gitignore` | Keeps `*.csv`, `data/*` and env/log noise out of git. |
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
git check-ignore -v data/Monthly_Realised_PnL.csv

# Confirm nothing sensitive is staged before committing:
git status --short
```

Manual smoke test: open the page → choose the CSV → the newest month's total should match
`Realized P/L` for that month in the file; toggling **Posted ↔ Accrual** should change the interest
bucket only when an Interest Accruals section is present.

---

## 7. Install as an app (PWA) & launcher modes

The dashboard is a PWA. Served from the canonical origin **http://127.0.0.1:8000** (the launcher),
Chromium browsers can install it as a chromeless app window. `file://` cannot install — service
workers need http/https, so always install from the launcher's URL, not from a Finder double-click.

### Install (Brave)

1. Start the dashboard with **`Start-Dashboard.app`** (or `./Start-Dashboard.sh`) so the page is open
   at `http://127.0.0.1:8000/index.html`.
2. Brave menu → **Cast, save, and share** → **Install page as app…** (older builds: *Save and share →
   Install…*, or the install icon in the omnibox). Name it **IBKR P&L** and confirm.
3. Manage or remove installed apps from **`brave://apps`**; their bundles also live under
   `~/Applications/Brave Browser Apps.localized/`.
4. Launch it from Launchpad/Applications as usual — it opens standalone, without browser chrome, and
   still opens when the local server is down (next section).

### Offline behaviour (service worker)

`sw.js` registers when the page is served over http(s) and caches **only the static shell** —
`index.html`, `styles.css`, `app.js`, `manifest.webmanifest` and the icons — in cache
**`ibkr-shell-v1`**. It is network-first: fresh files win while the server is up; if the server is
down, the cached shell is served instead, so the installed app still opens and renders (statement
data still comes from the in-page state / `localStorage` as before). **CSV files, `/data/*` and the
cross-origin FX lookups are never intercepted and never cached** — statement data stays out of
CacheStorage exactly as it stays out of the network, and old shell caches are purged on activate.

### Launcher modes

`Start-Dashboard.sh` / `Start-Dashboard.app` open the page in this order and log the mode they used
(both to stdout and to the server log):

| Mode | What opens |
| --- | --- |
| **Installed app window** | The first `*.app` under `~/Applications/Brave Browser Apps.localized/` whose `CrAppModeShortcutURL` starts with `http://127.0.0.1:8000` — i.e. the installed PWA. |
| **Brave app window** | `Brave Browser --app=http://127.0.0.1:8000/index.html` on the default profile (chromeless), backgrounded by the launcher. |
| **Brave via `open -a`** | `open -a "Brave Browser" --args --app=…` when the binary isn't at `/Applications` but LaunchServices knows the app. |
| **Default browser** | Plain `open http://127.0.0.1:8000/index.html` when no Brave install is found. |

Install the PWA once and every later launch goes straight to the app window.

