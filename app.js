'use strict';

/*
 * app.js — IBKR dashboard: CSV parser, aggregator and UI wiring.
 *
 * Supports both export shapes:
 *   - Flex Query CSV  — HEADER/DATA rows with section codes (TRNT, CTRN, IACC, ...)
 *   - Activity Statement CSV — Section,Kind,... rows (Trades / Dividends / ...)
 *
 * Zero dependencies; works from file:// via FileReader + localStorage. The only network
 * calls are the optional USD rate-map lookups (cached; baked rates cover offline use).
 * Every DOM lookup is optional, so the script survives if the shell HTML is missing.
 *
 * DOM contract (see index.html): fileInput dropZone yearSelect currencySelect monthChips
 * kpiNet kpiMonth kpiAvg kpiBest chartSvg chartTip breakdownSvg breakdownTip monthlyBody
 * drillBody drillTitle emptyState errorBox clearBtn postedToggle fileLabel,
 * includeChips tickerBtn toTopTickers tickersToTop filterNote tickerSearchClear
 * includeMore (the "+n" chip for chips the fixed cluster cannot show)
 * toolbarToggle (mobile Controls fold — class/aria/persisted state only)
 * themeCycle (icon button: [data-mode] picks the sun/moon/monitor glyph; a click cycles
 * light → dark → system and persists ibkr-theme-v1, the inline head script paints it first)
 * fxRate (read-only toolbar rate) fxBadge fxDetail csvHelpBtn csvHelpModal csvHelpClose
 * heroCsvInfo heroCsvHelp (the hero subtitle "i" opens the same help dialog), plus
 * the interest card
 * (interestSvg interestTip kpiIntTotal kpiIntAvgDay kpiIntBest kpiIntShare
 * interestBody), incomeInfo incomeHelp (the breakdown legend .info/.info-tip pair),
 * the ticker picker (tickerModal assetToggle tickerSearch tickerCount tickerList
 * tickerApply tickerClear — per-symbol scope selects plus the global asset toggle)
 * and the [data-tab]-driven Overview/Interest tabs. All of those are optional:
 * every lookup is null-safe so the script survives an older shell.
 *
 * X labels: xLabelPlan() measures the widest label each chart will actually draw
 * (probe <text class="label"> inside the live svg, so the card's container-query
 * font is what gets measured) on all three charts — chartSvg, interestSvg,
 * breakdownSvg. Horizontal, middle-anchored labels every Nth month, one label per
 * ceil(64 / band) months (coarser only when the measured glyph needs more), with
 * the last month always labelled and no ticks in the thinned slots. Never rotated,
 * never a hardcoded 9/21.
 *
 * Hosting: the shell is sub-path safe for the GitHub Pages copy (relative refs,
 * manifest ./ scope, sw.js resolves its allowlist from its own URL), and
 * .github/workflows/pages.yml gates the deploy with a privacy guard that fails
 * if any CSV / data export / screengrab is ever tracked.
 *
 * Browser: window.IBKR = { state, aggregateByMonth, renderAll, ... }.
 * Node (tests): module.exports.
 */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* Full names for the Daily P&L calendar title / aria labels — same indexes as MONTH_NAMES. */
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/* Three-letter forms for the day-detail header / labels — same indexes as WEEKDAY_NAMES. */
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CACHE_KEY = 'ibkr-v1';
const CACHE_MAX_BYTES = 2 * 1024 * 1024; // bigger raw files are parsed but not cached
const EXCLUDE_KEY = 'ibkr-exclude-v1';   // persisted root-symbol exclude list
const INCLUDE_KEY = 'ibkr-include-v1';   // persisted root-symbol include ("only these") list
const INCLUDE_SCOPE_KEY = 'ibkr-include-scope-v1'; // { SYM: 'options'|'stock' } — include only that leg kind
const EXCLUDE_SCOPE_KEY = 'ibkr-exclude-scope-v1'; // { SYM: 'options'|'stock' } — exclude only that leg kind
const TOOLBAR_KEY = 'ibkr-toolbar-collapsed-v1';   // '1' while the mobile toolbar fold is collapsed
const THEME_KEY = 'ibkr-theme-v1';                 // 'light' | 'dark' | 'system' (absent = system)
const FX_KEYS = { cache: 'fx-usd-rates-v1' }; // one USD rate map for AUD/CNY/SGD (no manual override)
const FX_TTL_MS = 12 * 60 * 60 * 1000;   // fresh-cache window for the FX rate map
const FX_TIMEOUT_MS = 5000;              // per-provider request timeout
/* Display currencies, all quoted from USD (USD itself is the 1:1 base). */
const FX_CURRENCIES = ['AUD', 'CNY', 'SGD'];
const CURRENCY_META = {
  usd: { sym: '$', label: 'USD' },
  aud: { sym: 'A$', label: 'AUD' },
  cny: { sym: 'CN¥', label: 'CNY' },
  sgd: { sym: 'S$', label: 'SGD' }
};
/* Offline approximations, labelled 'approximate' in the footer badge. */
const FX_BAKED_RATES = { aud: 1.423, cny: 7.1, sgd: 1.28 };
const FLEX_SECTIONS = ['TRNT', 'CTRN', 'CRTT', 'FIFO', 'CDIV', 'ACCT', 'IACC'];
const FLEX_ROW_KINDS = ['HEADER', 'DATA'];
const OPTION_ASSETS = new Set(['OPT', 'FOP', 'EQUITY AND INDEX OPTIONS', 'EQUITY_AND_INDEX_OPTIONS', 'INDEX OPTIONS', 'FUTURE OPTIONS', 'FUTURES OPTIONS', 'WAR', 'IOPT']);
const STOCK_ASSETS = new Set(['STK', 'STOCKS', 'EQUITY']);
const ACTIVITY_SECTIONS = new Set([
  'TRADES', 'INTEREST', 'BROKER INTEREST RECEIVED', 'BROKER INTEREST PAID',
  'BOND INTEREST RECEIVED', 'BOND INTEREST PAID', 'DIVIDENDS', 'PAYMENT IN LIEU',
  'WITHHOLDING TAX', 'OTHER FEES', 'ADVISOR FEES', 'COMMISSION ADJUSTMENTS',
  'COMMISSIONS', 'DEPOSITS/WITHDRAWALS'
]);
const ACTIVITY_CASH_SECTIONS = new Set([
  'INTEREST', 'BROKER INTEREST RECEIVED', 'BROKER INTEREST PAID', 'BOND INTEREST RECEIVED',
  'BOND INTEREST PAID', 'DIVIDENDS', 'PAYMENT IN LIEU', 'WITHHOLDING TAX',
  'OTHER FEES', 'ADVISOR FEES', 'COMMISSION ADJUSTMENTS', 'DEPOSITS/WITHDRAWALS'
]);
// Column order used when a Flex export carries bare section codes instead of HEADER rows.
const FLEX_FALLBACK_HEADER = {
  TRNT: ['FXRATETOBASE', 'ASSETCLASS', 'SYMBOL', 'TRADEDATE', 'QUANTITY', 'TRADEPRICE', 'PROCEEDS', 'IBCOMMISSION', 'NOTES/CODES', 'COSTBASIS', 'FIFOPNLREALIZED'],
  CTRN: ['DESCRIPTION', 'DATE/TIME', 'AMOUNT', 'TYPE']
};
// Column order used when an Activity Statement section is missing its HEADER row.
const ACTIVITY_FALLBACK_HEADER = {
  TRADES: ['DATADISCRIMINATOR', 'ASSET CATEGORY', 'CURRENCY', 'SYMBOL', 'DATE/TIME', 'QUANTITY', 'T. PRICE', 'C. PRICE', 'PROCEEDS', 'COMM/FEE', 'BASIS', 'REALIZED P/L', 'MTM P/L', 'CODE'],
  CASH: ['CURRENCY', 'DATE', 'DESCRIPTION', 'AMOUNT']
};

const IBKR = (function () {

  // ---------------------------------------------------------------- helpers

  const up = s => String(s == null ? '' : s).trim().toUpperCase();
  const num = s => {
    const v = typeof s === 'number' ? s : parseFloat(String(s == null ? '' : s).replace(/[,\s$]/g, ''));
    return isFinite(v) ? v : 0;
  };
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const titleCase = s => String(s == null ? '' : s).toLowerCase().replace(/\b[a-z]/g, m => m.toUpperCase());

  function monthKey(value) {
    const m = /^(\d{4})[-/.](\d{2})/.exec(String(value == null ? '' : value).trim());
    return m ? m[1] + '-' + m[2] : null;
  }
  /**
   * dayKey('2026-01-05 09:30:00') -> '2026-01-05' (also accepts / and . separators).
   * Mirrors monthKey's normalization: same leading-date regex, but the day part is
   * required — a bare 'yyyy-MM' is unsupported and returns null.
   */
  function dayKey(value) {
    const m = /^(\d{4})[-/.](\d{2})[-/.](\d{2})/.exec(String(value == null ? '' : value).trim());
    return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
  }
  function ymd(value) {
    const m = /^(\d{4})[-/.](\d{2})[-/.](\d{2})/.exec(String(value == null ? '' : value).trim());
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function monthLabel(key) {
    const n = +String(key).slice(5, 7);
    return MONTH_NAMES[n - 1] ? MONTH_NAMES[n - 1] + ' ' + String(key).slice(0, 4) : String(key);
  }
  /** Lowercased display currency code ('usd'|'aud'|'cny'|'sgd'), or the active mode. */
  function normalizeCurrency(currency) {
    const v = String(currency == null ? '' : currency).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(CURRENCY_META, v) ? v : null;
  }
  /** Symbol prefix for a display currency ("$", "A$", "CN¥", "S$"). */
  function currencySymbol(currency) {
    const cur = normalizeCurrency(currency) || 'usd';
    return CURRENCY_META[cur].sym;
  }
  /**
   * USD -> display-currency factor. USD is 1; AUD/CNY/SGD come from the fetched
   * state.fx.rates map, with the baked approximation covering the window before a
   * lookup resolves (and every offline case). Rates map from USD, so one factor
   * converts any raw amount.
   */
  function fxRateFor(currency) {
    const cur = normalizeCurrency(currency) || 'usd';
    if (cur === 'usd') return 1;
    const fetched = Number(state.fx && state.fx.rates && state.fx.rates[cur]);
    if (isFinite(fetched) && fetched > 0) return fetched;
    const baked = Number(FX_BAKED_RATES[cur]);
    return isFinite(baked) && baked > 0 ? baked : 1;
  }
  /** Raw USD amount -> amount in the active display currency. */
  function disp(value) {
    return (Number(value) || 0) * fxRateFor(currencyMode());
  }
  /** fmtMoney(value[, 'usd'|'aud'|'cny'|'sgd']) — value is always raw USD; currency defaults to the active mode. */
  function fmtMoney(value, currency) {
    const cur = normalizeCurrency(currency) || currencyMode();
    const v = (Number(value) || 0) * fxRateFor(cur);
    return (v < 0 ? '-' : '') + currencySymbol(cur) +
      Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtCompact(value, currency) {
    const cur = normalizeCurrency(currency) || currencyMode();
    const n = (Number(value) || 0) * fxRateFor(cur);
    const a = Math.abs(n), sym = currencySymbol(cur);
    if (a >= 1000) return (n < 0 ? '-' : '') + sym + (a / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k';
    if (a === 0) return sym + '0';
    return (n < 0 ? '-' : '') + sym + Math.round(a);
  }
  /**
   * Compact money for the narrow daily-calendar cells. Cents are always dropped and
   * the k scale keeps its tenth only when non-zero ("$2k", not "$2.0k"), because a
   * 375px cell's content box fits roughly four glyphs at 11px/700 (~30px). Anything
   * still longer than four glyphs sheds the currency symbol — the sign, colour and the
   * full fmtMoney value in the cell's title/aria-label keep the meaning:
   * "$420" / "$2k" / "1.7k" / "-617" / "-$8k".
   */
  function fmtCellMoney(value, currency) {
    const cur = normalizeCurrency(currency) || currencyMode();
    const n = (Number(value) || 0) * fxRateFor(cur);
    const a = Math.abs(n), sym = currencySymbol(cur);
    const sign = n < 0 ? '-' : '';
    let text;
    if (a >= 999.5) {
      const k = a < 10000 ? (a / 1000).toFixed(1).replace(/\.0$/, '') : String(Math.round(a / 1000));
      text = sign + sym + k + 'k';
      // The sign costs a glyph, so a signed value that still carries a k decimal
      // falls back to whole thousands ("-$8.4k" → "-$8k") — the exact figure stays
      // in the cell's title/aria-label.
      if (sign && text.length > 4) text = sign + sym + Math.round(a / 1000) + 'k';
    } else {
      const whole = Math.round(a);
      text = (whole === 0 ? sym : sign + sym) + whole;
    }
    return text.length > 4 ? text.replace(sym, '') : text;
  }

  // ------------------------------------------------------------------ CSV

  /** RFC-ish splitter: quoted fields, embedded newlines, doubled "" escapes. */
  function parseCsv(text) {
    const rows = [];
    const src = String(text == null ? '' : text);
    let row = [], field = '', quoted = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += ch;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else if (ch === '\r') {
        if (src[i + 1] !== '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.length > 1 || (r[0] || '').trim() !== '');
  }

  /** Flex wraps rows as HEADER/DATA,<SECTION>,...; Activity Statements use Trades,Header,... */
  function detectFormat(rows) {
    const limit = Math.min(rows.length, 200);
    for (let i = 0; i < limit; i++) {
      const r = rows[i] || [];
      const c0 = up(r[0]), c1 = up(r[1]);
      if (FLEX_SECTIONS.indexOf(c0) >= 0) return 'flex';
      if (FLEX_ROW_KINDS.indexOf(c0) >= 0 && FLEX_SECTIONS.indexOf(c1) >= 0) return 'flex';
      if (c0 === 'TRADES' && c1 === 'HEADER') return 'activity';
    }
    return 'activity';
  }

  // --------------------------------------------------------------- parsing

  function parseFlex(rows) {
    const trades = [], cash = [], accruals = [];
    let section = '', header = [];

    const read = (row, start, names) => {
      for (const name of names) {
        const i = header.indexOf(name);
        if (i >= 0) return row[start + i] == null ? '' : String(row[start + i]);
      }
      return '';
    };

    for (const row of rows) {
      if (!row || !row.length) continue;
      const c0 = up(row[0]), c1 = up(row[1]);
      let kind = '', code = '', start = 2;

      if (c0 === 'HEADER' || c0 === 'DATA') {
        kind = c0; code = c1;
      } else if (FLEX_SECTIONS.indexOf(c0) >= 0) {
        code = c0; start = 1;
        if (c1 === 'HEADER') { kind = 'HEADER'; start = 2; } else kind = 'DATA';
      }
      if (!code) continue;

      if (kind === 'HEADER') {
        section = code;
        header = row.slice(start).map(up);
        if (!header.length && FLEX_FALLBACK_HEADER[code]) header = FLEX_FALLBACK_HEADER[code].slice();
        continue;
      }
      if (kind !== 'DATA') continue;
      if (code !== section) { // data rows without their own header row
        section = code;
        header = FLEX_FALLBACK_HEADER[code] ? FLEX_FALLBACK_HEADER[code].slice() : [];
      }

      if (code === 'TRNT') {
        const lod = up(read(row, start, ['LEVELOFDETAIL', 'LEVEL OF DETAIL']));
        if (lod === 'CLOSED_LOT' || lod === 'CLOSEDLOT' || lod === 'ORDER') continue; // executions only
        const pnl = num(read(row, start, ['FIFOPNLREALIZED', 'FIFO PNL REALIZED']));
        const fx = num(read(row, start, ['FXRATETOBASE', 'FX RATE TO BASE']));
        const rate = fx > 0 ? fx : 1;
        trades.push({
          date: read(row, start, ['TRADEDATE', 'DATE/TIME', 'DATETIME']),
          asset: up(read(row, start, ['ASSETCLASS', 'ASSET CLASS'])),
          symbol: read(row, start, ['SYMBOL']) || read(row, start, ['DESCRIPTION']),
          currency: up(read(row, start, ['CURRENCYPRIMARY', 'CURRENCY'])),
          code: up(read(row, start, ['NOTES/CODES', 'NOTES / CODES', 'CODE'])),
          qty: num(read(row, start, ['QUANTITY'])),
          proceeds: num(read(row, start, ['PROCEEDS'])) * rate,
          comm: num(read(row, start, ['IBCOMMISSION', 'COMM/FEE', 'COMMISSION'])),
          pnl: pnl * rate
        });
      } else if (code === 'CTRN') {
        cash.push({
          date: read(row, start, ['DATE/TIME', 'DATE']),
          type: up(read(row, start, ['TYPE'])),
          description: read(row, start, ['DESCRIPTION']) || read(row, start, ['SYMBOL']),
          amount: num(read(row, start, ['AMOUNT'])),
          currency: up(read(row, start, ['CURRENCYPRIMARY', 'CURRENCY']))
        });
      } else if (code === 'CDIV') {
        cash.push({
          date: read(row, start, ['PAYDATE', 'PAY DATE', 'EXDATE', 'EX DATE']),
          type: up(read(row, start, ['TYPE'])) || 'DIVIDENDS',
          description: read(row, start, ['DESCRIPTION']) || read(row, start, ['SYMBOL']),
          amount: num(read(row, start, ['AMOUNT', 'NETAMOUNT'])),
          currency: up(read(row, start, ['CURRENCYPRIMARY', 'CURRENCY']))
        });
      } else if (code === 'IACC') {
        const amount = num(read(row, start, ['INTERESTACCRUED', 'INTEREST ACCRUED']));
        const from = read(row, start, ['FROMDATE', 'FROM DATE']);
        const to = read(row, start, ['TODATE', 'TO DATE']);
        if (amount && from && to) accruals.push({ currency: up(read(row, start, ['CURRENCYPRIMARY'])), from, to, amount });
      }
    }

    // Per-currency IACC rows are more precise than BASE_SUMMARY; never mix both.
    if (accruals.some(a => a.currency && a.currency !== 'BASE_SUMMARY')) {
      for (let i = accruals.length - 1; i >= 0; i--) if (accruals[i].currency === 'BASE_SUMMARY') accruals.splice(i, 1);
    }
    return { format: 'flex', trades, cash, accruals };
  }

  /**
   * Activity Statement shape — every row repeats its section name:
   *   Trades,Header,DataDiscriminator,Asset Category,...
   *   Trades,Data,Trade,Stocks,USD,AAPL,2026-01-05, ...
   * SubTotal/Total rows and non-Trade discriminators (Order, ClosedLot) are skipped.
   */
  function parseActivityStatement(rows) {
    const trades = [], cash = [];
    let section = '', header = null;

    const value = (row, base, names) => {
      if (!header) return '';
      for (const name of names) {
        const i = header.indexOf(name);
        if (i >= 0) return row[base + i] == null ? '' : String(row[base + i]);
      }
      return '';
    };

    for (const row of rows) {
      if (!row || !row.length) continue;
      const c0 = up(row[0]), c1 = up(row[1]);
      let base = 2, kind = '';

      if (ACTIVITY_SECTIONS.has(c0)) {
        section = c0;
        if (c1 === 'HEADER') { header = row.slice(2).map(up); continue; }
        kind = c1;
        if (kind !== 'DATA') continue; // SubTotal / Total summary rows
      } else if ((c0 === 'HEADER' || c0 === 'DATA') && section) {
        base = 1; // header/data-only variant
        if (c0 === 'HEADER') { header = row.slice(1).map(up); continue; }
        kind = 'DATA';
      } else {
        continue;
      }
      if (!header) header = (section === 'TRADES' ? ACTIVITY_FALLBACK_HEADER.TRADES : ACTIVITY_FALLBACK_HEADER.CASH).slice();
      const disc = up(value(row, base, ['DATADISCRIMINATOR', 'DATA DISCRIMINATOR']));

      if (section === 'TRADES') {
        if (disc !== 'TRADE') continue; // trades only: skip Order / ClosedLot
        trades.push({
          date: value(row, base, ['DATE/TIME', 'TRADE DATE']),
          asset: up(value(row, base, ['ASSET CATEGORY', 'ASSETCLASS'])),
          symbol: value(row, base, ['SYMBOL']) || value(row, base, ['DESCRIPTION']),
          currency: up(value(row, base, ['CURRENCY'])),
          code: up(value(row, base, ['CODE'])),
          qty: num(value(row, base, ['QUANTITY'])),
          proceeds: num(value(row, base, ['PROCEEDS'])),
          comm: num(value(row, base, ['COMM/FEE', 'COMMISSION'])),
          pnl: num(value(row, base, ['REALIZED P/L', 'REALIZEDPL', 'FIFOPNLREALIZED']))
        });
      } else if (ACTIVITY_CASH_SECTIONS.has(section)) {
        cash.push({
          date: value(row, base, ['DATE', 'DATE/TIME']),
          type: up(value(row, base, ['TYPE'])) || section,
          description: value(row, base, ['DESCRIPTION']) || value(row, base, ['SYMBOL']),
          amount: num(value(row, base, ['AMOUNT'])),
          currency: up(value(row, base, ['CURRENCY']))
        });
      }
    }
    return { format: 'activity', trades, cash, accruals: [] };
  }

  function parseCsvText(text) {
    const rows = parseCsv(text);
    const format = detectFormat(rows);
    const parsed = format === 'flex' ? parseFlex(rows) : parseActivityStatement(rows);
    return { format, trades: parsed.trades, cash: parsed.cash, accruals: parsed.accruals || [] };
  }

  // ----------------------------------------------------------- aggregation

  function isAssignmentCode(code) {
    const c = up(code);
    if (!c) return false;
    const tokens = c.split(/[;,]/).map(s => s.trim());
    return tokens.some(t => t === 'A' || t === 'EX') || tokens.some(t => t.indexOf('GEA') >= 0);
  }

  /** options | assign | otherStock (otherStock folds into the assignment total). */
  function classify(trade) {
    const asset = up(trade.asset);
    if (OPTION_ASSETS.has(asset) || asset.indexOf('OPTION') >= 0 || asset.indexOf('OPT') >= 0) return 'options';
    if (STOCK_ASSETS.has(asset)) return isAssignmentCode(trade.code) ? 'assign' : 'otherStock';
    return 'otherStock';
  }

  /** Root symbol: "AMD   260220P00185000" -> "AMD", " amzn " -> "AMZN". */
  function rootOf(symbol) {
    const s = up(symbol);
    return s ? s.split(/\s+/)[0] : '';
  }

  function cashCategory(type) {
    const t = up(type);
    if (!t) return null;
    if (t.indexOf('BROKER INTEREST') >= 0 || t === 'INTEREST' || t.indexOf('BOND INTEREST') >= 0) return 'interest';
    if (t.indexOf('DIVIDEND') >= 0 || t.indexOf('PAYMENT IN LIEU') >= 0) return 'dividends';
    if (t.indexOf('WITHHOLDING') >= 0) return 'withholding';
    if (t.indexOf('OTHER FEE') >= 0 || t.indexOf('ADVISOR') >= 0 || t.indexOf('COMMISSION ADJUSTMENT') >= 0) return 'fees';
    return null;
  }

  /** Human labels for the day-detail Income rows and the month drill-down cash rows. */
  const CASH_LABELS = { interest: 'Interest', dividends: 'Dividends', withholding: 'Withholding', fees: 'Fees' };

  /** "USD Broker Interest Received" — currency + description (title-cased type as fallback). */
  function cashDesc(c) {
    const row = c || {};
    const cur = up(row.currency);
    const text = row.description ? String(row.description) : (row.type ? titleCase(row.type) : 'Cash');
    return (cur && cur !== 'BASE_SUMMARY' ? cur + ' ' : '') + text;
  }

  /** "Interest Accruals 2026-01-01 – 2026-01-31" (single day when the window is degenerate). */
  function accrualDesc(a) {
    const from = dayKey(a && a.from), to = dayKey(a && a.to);
    if (!to || (from && to < from)) return 'Interest Accruals ' + (from || String((a && a.from) || ''));
    return 'Interest Accruals ' + from + ' – ' + to;
  }

  function emptyMonth() {
    return { options: 0, assign: 0, otherStock: 0, otherStockCount: 0, interest: 0, dividends: 0, withholding: 0, fees: 0, count: 0, wins: 0, flat: 0, total: 0 };
  }

  /**
   * Trade-level filter shared by aggregateByMonth() and the drill-down loop.
   *   kind      — coarse asset class: 'options' for options/futures options, else 'stock'
   *   include / exclude — root symbols (array or Set): exclude wins, include empty = all
   *   includeScope / excludeScope — { SYM: 'options'|'stock' } object or Map; 'all'/missing
   *               allows every kind, otherwise the entry only matches that leg kind for SYM
   *   globalAsset — dashboard-wide 'all' | 'options' | 'stock' gate applied to every trade
   * Trades whose root has no scope entry are unaffected by scopes.
   */
  function tradePasses(trade, opts) {
    const o = opts || {};
    const kind = classify(trade) === 'options' ? 'options' : 'stock';
    const allows = (scope, k) => !scope || scope === 'all' || scope === k;
    const exclude = toSymbolSet(o.exclude);
    const include = toSymbolSet(o.include);
    const excludeScope = toScopeMap(o.excludeScope);
    const includeScope = toScopeMap(o.includeScope);
    const globalAsset = normalizeScope(o.globalAsset == null ? o.asset : o.globalAsset);
    const sym = rootOf(trade.symbol);
    if (exclude.has(sym) && allows(excludeScope.get(sym), kind)) return false;
    if (include.size > 0 && !(include.has(sym) && allows(includeScope.get(sym), kind))) return false;
    return globalAsset === 'all' || kind === globalAsset;
  }

  /** Arrays/Set of root symbols -> Set (Sets pass straight through). */
  const toSymbolSet = value => (value instanceof Set ? value : new Set(normalizeSymbols(value)));

  /** { SYM: scope }/Map -> Map, dropping 'all' entries (Maps pass straight through). */
  function toScopeMap(value) {
    if (value instanceof Map) return value;
    const map = new Map();
    const normalized = normalizeScopeMap(value);
    for (const sym of Object.keys(normalized)) map.set(sym, normalized[sym]);
    return map;
  }

  /** Set/Map normalization of an aggregate/drill options object, computed once per render. */
  function prepareTradeFilter(options) {
    const o = options || {};
    return {
      include: toSymbolSet(o.include),
      exclude: toSymbolSet(o.exclude),
      includeScope: toScopeMap(o.includeScope),
      excludeScope: toScopeMap(o.excludeScope),
      globalAsset: normalizeScope(o.globalAsset == null ? o.asset : o.globalAsset)
    };
  }

  /**
   * Aggregate trades + cash into { 'yyyy-MM': buckets }. Amounts stay raw USD (display converts).
   * interestMode 'accrual' replaces posted cash interest with the Interest Accruals (IACC) split.
   * opts.include / opts.exclude (root symbols, default []) keep/hide matching trades; a non-empty
   * include means "only these". opts.includeScope / opts.excludeScope ({ SYM: 'options'|'stock' })
   * narrow a symbol's entry to one leg kind, and opts.globalAsset ('all'|'options'|'stock') hides
   * the other kind for every ticker. Excludes win over includes, per kind: an unscoped exclude
   * drops every leg of its symbol, a scoped one only that kind, so include AMD (Options only) +
   * exclude AMD (Stock only) keeps AMD's options while its stock legs are dropped.
   * Ticker-less cash rows are never filtered by any of these (they have no root symbol to match).
   */
  function aggregateByMonth(trades, cash, options) {
    const months = {};
    const bucket = key => months[key] || (months[key] = emptyMonth());
    const opts = options || {};
    const useAccrual = opts.interestMode === 'accrual' && opts.accruals && opts.accruals.length > 0;
    const filter = prepareTradeFilter(opts);

    for (const t of trades || []) {
      if (!tradePasses(t, filter)) continue;
      const key = monthKey(t.date);
      if (!key) continue;
      const b = bucket(key);
      const pnl = Number(t.pnl) || 0;
      const where = classify(t);
      if (where === 'otherStock') { b.assign += pnl; b.otherStock += pnl; b.otherStockCount++; }
      else b[where] += pnl;
      b.count++;
      if (pnl > 0) b.wins++;
      else if (pnl === 0) b.flat++;
    }

    for (const c of cash || []) {
      const sym = rootOf(c && c.symbol); // cash rows are ticker-less: never filtered by scopes
      if (sym && filter.exclude.has(sym)) continue;
      const cat = cashCategory(c.type);
      if (!cat || (cat === 'interest' && useAccrual)) continue;
      const key = monthKey(c.date);
      if (key) bucket(key)[cat] += Number(c.amount) || 0;
    }

    if (useAccrual) {
      for (const a of opts.accruals) {
        const from = ymd(a.from), to = ymd(a.to);
        const amount = Number(a.amount) || 0;
        if (!from || !amount) continue;
        if (!to || to < from) { bucket(monthKey(a.from)).interest += amount; continue; }
        const days = Math.round((to - from) / 86400000) + 1;
        const perDay = amount / days;
        for (let i = 0; i < days; i++) {
          bucket(monthKey(new Date(from + i * 86400000).toISOString().slice(0, 10))).interest += perDay;
        }
      }
    }

    for (const key of Object.keys(months)) {
      const b = months[key];
      b.total = b.options + b.assign + b.interest + b.dividends + b.withholding + b.fees;
    }
    return months;
  }

  /**
   * Day-grain sibling of aggregateByMonth(): same trade filter, same cash categories and the
   * same accrual walk, but every amount lands on its 'yyyy-MM-dd' bucket. Day buckets carry the
   * month bucket shape (so count/wins/categories stay inspectable) and total the identical mix.
   * Returns { byDay, maxAbs, monthTotals, rows }:
   *   byDay       — { 'yyyy-MM-dd': bucket }, buckets without a parseable day are dropped
   *   monthTotals — { 'yyyy-MM': sum of that month's day totals } (the calendar's pill maths)
   *   maxAbs      — largest |day total| across the whole file (the calendar now paints
   *                 one flat tint per sign, so it no longer scales by this; kept for callers
   *                 that want a single scale across months)
   *   rows        — { 'yyyy-MM-dd': { trades: [{symbol, asset, net, count}], income: [{label,
   *                 desc, amount}] } } — the day-detail itemisation, collected in the very same
   *                 pass as the buckets (same predicate, same accrual split), so the day total
   *                 always equals trades net + income net. Income rows never touch bucket.count:
   *                 interest/dividends/withholding/fees and accrual splits are cash, not trades.
   */
  function aggregateByDay(trades, cash, options) {
    const byDay = {};
    const bucket = key => byDay[key] || (byDay[key] = emptyMonth());
    const rows = {};
    const dayRows = key => rows[key] || (rows[key] = { trades: [], income: [] });
    const tradeRowIndex = new Map(); // day + '\u0000' + symbol + '|' + asset -> row object
    const opts = options || {};
    const useAccrual = opts.interestMode === 'accrual' && opts.accruals && opts.accruals.length > 0;
    const filter = prepareTradeFilter(opts);

    for (const t of trades || []) {
      if (!tradePasses(t, filter)) continue;
      const key = dayKey(t.date);
      if (!key) continue;
      const b = bucket(key);
      const pnl = Number(t.pnl) || 0;
      const where = classify(t);
      if (where === 'otherStock') { b.assign += pnl; b.otherStock += pnl; b.otherStockCount++; }
      else b[where] += pnl;
      b.count++;
      if (pnl > 0) b.wins++;
      else if (pnl === 0) b.flat++;
      // Itemisation: one row per full symbol + asset-class label, mirroring the drill-down.
      const asset = where === 'options' ? 'Options' : where === 'assign' ? 'Assignment' : 'Stock (other)';
      const symbol = t.symbol || '—';
      const rowKey = key + '\u0000' + symbol + '|' + asset;
      let row = tradeRowIndex.get(rowKey);
      if (!row) {
        row = { symbol, asset, net: 0, count: 0 };
        tradeRowIndex.set(rowKey, row);
        dayRows(key).trades.push(row);
      }
      row.net += pnl;
      row.count++;
    }

    for (const c of cash || []) {
      const sym = rootOf(c && c.symbol); // cash rows are ticker-less: never filtered by scopes
      if (sym && filter.exclude.has(sym)) continue;
      const cat = cashCategory(c.type);
      if (!cat || (cat === 'interest' && useAccrual)) continue;
      const key = dayKey(c.date);
      if (!key) continue;
      const amount = Number(c.amount) || 0;
      bucket(key)[cat] += amount;
      if (amount !== 0) dayRows(key).income.push({ label: CASH_LABELS[cat], desc: cashDesc(c), amount });
    }

    if (useAccrual) {
      for (const a of opts.accruals) {
        const from = ymd(a.from), to = ymd(a.to);
        const amount = Number(a.amount) || 0;
        if (!from || !amount) continue;
        const spread = (key, value) => {
          if (!key) return;
          bucket(key).interest += value;
          if (value !== 0) dayRows(key).income.push({ label: CASH_LABELS.interest, desc: accrualDesc(a), amount: value });
        };
        if (!to || to < from) { spread(dayKey(a.from), amount); continue; }
        const days = Math.round((to - from) / 86400000) + 1;
        const perDay = amount / days;
        for (let i = 0; i < days; i++) {
          spread(new Date(from + i * 86400000).toISOString().slice(0, 10), perDay);
        }
      }
    }

    const monthTotals = {};
    let maxAbs = 0;
    for (const key of Object.keys(byDay)) {
      const b = byDay[key];
      b.total = b.options + b.assign + b.interest + b.dividends + b.withholding + b.fees;
      const month = key.slice(0, 7);
      monthTotals[month] = (monthTotals[month] || 0) + b.total;
      const abs = Math.abs(b.total);
      if (abs > maxAbs) maxAbs = abs;
    }
    return { byDay, maxAbs, monthTotals, rows };
  }

  // ------------------------------------------------------------- UI state

  const state = {
    trades: [], cash: [], accruals: [], months: {}, year: 'all', month: 'all', name: '', format: '',
    names: [],                    // file names in use; state.name is their comma-joined form (persisted)
    daily: { ym: null, sel: null }, // Daily P&L tab: shown 'yyyy-MM' + selected 'yyyy-MM-dd'
    exclude: [],                 // root symbols skipped during aggregation (persisted)
    include: [],                 // when non-empty, only these roots aggregate (persisted)
    excludeScope: {},            // { SYM: 'options'|'stock' } — skip only that leg kind (persisted)
    includeScope: {},            // { SYM: 'options'|'stock' } — keep only that leg kind (persisted)
    asset: 'all',                // global asset-class view filter all|options|stock (session only)
    currency: 'usd',             // fallback when #currencySelect is absent; {@see currencyMode}
    fx: { rates: {}, fetchedAt: 0, source: '', date: '' } // USD -> {aud,cny,sgd} rate map
  };
  const boundEvents = new WeakMap();
  let restoreTried = false;

  const byId = id => (typeof document === 'undefined' ? null : document.getElementById(id));
  /** First present element among the candidate ids a shell may use for the same slot. */
  function pickById(ids) {
    for (const id of ids) { const el = byId(id); if (el) return el; }
    return null;
  }
  const hasData = () => state.trades.length > 0 || state.cash.length > 0;
  /**
   * Touch-first device: coarse pointer or any touch points. Dialogs skip their
   * auto-focus for it (no soft keyboard / select wheel without a user gesture).
   */
  function isCoarsePointer() {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      try { if (window.matchMedia('(pointer: coarse)').matches) return true; } catch (err) { /* unsupported query */ }
    }
    return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  }
  /** Media-query match, guarded for engines (and tests) without matchMedia. */
  function matchesMedia(query) {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches === true;
  }
  /**
   * scrollIntoView with the shared reduced-motion guard (same rule as onToTopTickers):
   * smooth by default, auto when the OS asks for reduced motion. The sticky toolbar's
   * live height becomes scroll-margin-top, so the target always lands clear of the band
   * even when the mobile toolbar is expanded (the styles.css 76px base matches its
   * folded height only).
   */
  function scrollIntoViewSoft(el, block) {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    if (typeof document !== 'undefined' && el.style) {
      const toolbar = document.querySelector ? document.querySelector('.toolbar') : null;
      if (toolbar && typeof toolbar.getBoundingClientRect === 'function') {
        const band = Math.round(toolbar.getBoundingClientRect().height);
        if (band > 0) el.style.scrollMarginTop = (band + 8) + 'px';
      }
    }
    el.scrollIntoView({ behavior: matchesMedia('(prefers-reduced-motion: reduce)') ? 'auto' : 'smooth', block: block || 'start' });
  }
  function setText(id, text) { const el = byId(id); if (el) el.textContent = text; }
  /** setTitle("#id", text) — independent of setDelta/setText so a tooltip survives text rewrites. */
  function setTitle(id, text) { const el = byId(id); if (el) el.title = text || ''; }
  function setPickText(ids, text) { const el = pickById(ids); if (el) el.textContent = text; }
  function setDelta(id, text, dir) {
    const el = byId(id);
    if (!el) return;
    el.className = 'delta delta--' + (dir || 'flat');
    el.textContent = text;
  }
  function showError(message) {
    const box = byId('errorBox');
    if (!box) return;
    const text = box.querySelector ? box.querySelector('.js-error-text') : null;
    if (text) text.textContent = message || '';
    else box.textContent = message || '';
    box.hidden = !message;
  }
  /** "a.csv, b.csv" → ['a.csv', 'b.csv'] (legacy state.name strings; [] when empty). */
  function splitFileNames(name) {
    const text = String(name == null ? '' : name).trim();
    return text ? text.split(/\s*,\s*/).filter(Boolean) : [];
  }
  /** File-name list from a string | array | null (loadParsed/loadText accept either shape). */
  function fileNamesOf(name) {
    return (Array.isArray(name) ? name : [name]).map(n => String(n == null ? '' : n).trim()).filter(Boolean);
  }
  /**
   * #fileLabel: one compact line — "Name.csv (cached)" for a single file,
   * "3 files · First.csv +2" for several (styles.css ellipsises it in place, so it
   * stays one line). title/aria-label always carry the full comma-separated list of
   * names in use, so the clipped summary stays recoverable on hover / for AT. An
   * empty list is the "No files selected" placeholder (fresh boot / clearAll).
   */
  function setFileLabel(names, cached) {
    const el = byId('fileLabel');
    const list = fileNamesOf(names);
    if (el) {
      el.textContent = !list.length ? 'No files selected'
        : list.length === 1 ? list[0] + (cached === true ? ' (cached)' : '')
        : list.length + ' files · ' + list[0] + ' +' + (list.length - 1) + (cached === true ? ' (cached)' : '');
      el.title = list.join(', ');
      if (typeof el.setAttribute === 'function') el.setAttribute('aria-label', list.length ? list.join(', ') : 'No files selected');
    }
    return list;
  }
  /**
   * Idempotent listener binding: wire() may run twice (init + the late-shell load
   * fallback), so the dedupe key is event + handler name. Handlers must therefore be
   * named top-level functions — an anonymous handler would key as "handler" and
   * silently collide with the next one on the same element.
   */
  function listen(el, ev, fn) {
    if (!el) return;
    let set = boundEvents.get(el);
    if (!set) { set = new Set(); boundEvents.set(el, set); }
    const key = ev + ':' + (fn.name || 'handler');
    if (set.has(key)) return;
    set.add(key);
    el.addEventListener(ev, fn);
  }
  function interestMode() {
    if (typeof document === 'undefined') return 'posted';
    const checked = document.querySelector ? document.querySelector('input[name="postedToggle"]:checked') : null;
    if (checked) return String(checked.value || '').trim().toLowerCase() === 'accrual' ? 'accrual' : 'posted';
    return 'posted';
  }
  /** The active display currency: #currencySelect's value, else state.currency ('usd' default). */
  function currencyMode() {
    if (typeof document !== 'undefined' && document.querySelector) {
      const sel = document.querySelector('#currencySelect');
      if (sel) {
        const v = normalizeCurrency(sel.value);
        if (v) state.currency = v;
      }
    }
    return normalizeCurrency(state.currency) || 'usd';
  }
  function visibleKeys() {
    return Object.keys(state.months)
      .filter(k => state.year === 'all' || !state.year || k.slice(0, 4) === state.year)
      .sort();
  }

  // ------------------------------------------------------- exclude/currency

  /** Uppercased, trimmed, de-duplicated root symbols (input order preserved). */
  function normalizeSymbols(list) {
    const parts = Array.isArray(list) ? list : String(list == null ? '' : list).split(/[,;]+/);
    const seen = new Set(), out = [];
    for (const part of parts) {
      const sym = up(part);
      if (!sym || seen.has(sym)) continue;
      seen.add(sym); out.push(sym);
    }
    return out;
  }

  /** 'all' | 'options' | 'stock' — tolerant of aliases and blank input. */
  function normalizeScope(value) {
    const v = up(value);
    if (v === 'OPTIONS' || v === 'OPTION' || v === 'OPT' || v === 'OPTS') return 'options';
    if (v === 'STOCK' || v === 'STOCKS' || v === 'EQUITY' || v === 'EQUITIES' || v === 'STK') return 'stock';
    return 'all';
  }

  /** Human label for a scope value ("All" / "Options only" / "Stock only"). */
  function scopeLabel(scope) {
    const s = normalizeScope(scope);
    return s === 'options' ? 'Options only' : s === 'stock' ? 'Stock only' : 'All';
  }

  /** { SYM: scope } (or a Map) -> plain object with uppercased keys, 'all' entries dropped. */
  function normalizeScopeMap(value) {
    const out = {};
    const entries = value instanceof Map ? Array.from(value.entries())
      : (value && typeof value === 'object' ? Object.keys(value).map(k => [k, value[k]]) : []);
    for (const entry of entries) {
      const sym = up(entry[0]), scope = normalizeScope(entry[1]);
      if (sym && scope !== 'all') out[sym] = scope;
    }
    return out;
  }

  /** Scope map reduced to the symbols that are actually in `list` — orphans never survive a restore. */
  function pruneScope(scope, list) {
    const keep = new Set(normalizeSymbols(list));
    const out = {};
    for (const sym of Object.keys(scope || {})) if (keep.has(sym)) out[sym] = scope[sym];
    return out;
  }

  /** Persist both symbol lists and both scope maps (the whole ticker filter). */
  function saveFilterState() {
    lsSet(INCLUDE_KEY, JSON.stringify(state.include));
    lsSet(EXCLUDE_KEY, JSON.stringify(state.exclude));
    lsSet(INCLUDE_SCOPE_KEY, JSON.stringify(state.includeScope));
    lsSet(EXCLUDE_SCOPE_KEY, JSON.stringify(state.excludeScope));
  }

  function getExclude() { return state.exclude.slice(); }
  /** setExclude(['AMD', ...]) / setExclude('AMD,MSFT') — normalizes, persists, re-renders. */
  function setExclude(list) {
    state.exclude = normalizeSymbols(list);
    // A scope only means something next to its list entry: prune on every removal path
    // (chips, API), not just on restore, or a stale scope resurrects the ticker row.
    state.excludeScope = pruneScope(state.excludeScope, state.exclude);
    saveFilterState();
    renderAll();
    renderTickerList(); // keep an open picker's checkboxes in sync
    return state.exclude.slice();
  }
  function getInclude() { return state.include.slice(); }
  /** setInclude(['IWM', ...]) / setInclude('IWM,AMD') — non-empty means "only these roots". */
  function setInclude(list) {
    state.include = normalizeSymbols(list);
    state.includeScope = pruneScope(state.includeScope, state.include);
    saveFilterState();
    renderAll();
    renderTickerList();
    return state.include.slice();
  }

  /** getIncludeScope() — copy of { SYM: 'options'|'stock' } for scoped includes. */
  function getIncludeScope() { return Object.assign({}, state.includeScope); }
  /** setIncludeScope({ AMD: 'options' }) — persists; entries for symbols outside the include list are pruned on restore. */
  function setIncludeScope(map) {
    state.includeScope = normalizeScopeMap(map);
    saveFilterState();
    renderAll();
    renderTickerList();
    return getIncludeScope();
  }
  /** getExcludeScope() — copy of { SYM: 'options'|'stock' } for scoped excludes. */
  function getExcludeScope() { return Object.assign({}, state.excludeScope); }
  /** setExcludeScope({ AMD: 'stock' }) — excludes only that leg kind of AMD. */
  function setExcludeScope(map) {
    state.excludeScope = normalizeScopeMap(map);
    saveFilterState();
    renderAll();
    renderTickerList();
    return getExcludeScope();
  }

  // ------------------------------------------ global asset filter (#assetToggle)

  /** Current global asset filter: 'all' | 'options' | 'stock' (session-only, not persisted). */
  function getAssetFilter() { return state.asset === 'options' || state.asset === 'stock' ? state.asset : 'all'; }

  /** setAssetFilter('stock') — hides every non-stock leg dashboard-wide; radios follow via syncAssetToggle(). */
  function setAssetFilter(value, options) {
    state.asset = normalizeScope(value);
    syncAssetToggle();
    if (!(options && options.silent)) renderAll();
    return state.asset;
  }

  /** Reflect state.asset on input[name="assetToggle"] without firing events. */
  function syncAssetToggle() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    const radios = document.querySelectorAll('input[name="assetToggle"]');
    for (let i = 0; i < radios.length; i++) radios[i].checked = normalizeScope(radios[i].value) === getAssetFilter();
  }

  /** #assetToggle radio change — applied live (the modal's global filter needs no Apply). */
  function onAssetToggleChange() {
    if (typeof document === 'undefined' || !document.querySelector) return;
    const checked = document.querySelector('input[name="assetToggle"]:checked');
    setAssetFilter(checked ? checked.value : 'all');
  }

  // ------------------------------------------------------------------- FX

  function lsGet(key) {
    try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch (err) { return null; }
  }
  function lsSet(key, value) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); } catch (err) { /* storage disabled/full */ }
  }
  function lsRemove(key) {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(key); } catch (err) { /* ignore */ }
  }

  /**
   * USD rate-map chain: fresh cache > providers > stale cache > baked rates.
   * Providers are all keyless fixed-URL GETs, tried in order; (a) and (b) return a
   * whole map, (c) fills any still-missing code one pair at a time. No override and
   * no query strings, so no statement data can ever ride along.
   */
  const FX_PROVIDERS = [
    {
      source: 'er-api', url: 'https://open.er-api.com/v6/latest/USD',
      pick: j => (j && j.result === 'success' && j.rates)
        ? { rates: pickFxRates(j.rates), date: j.time_last_update_utc || '' }
        : null
    },
    {
      source: 'currency-api', url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json',
      pick: j => (j && j.usd) ? { rates: pickFxRates(j.usd), date: j.date || '' } : null
    }
  ];

  /** Pull the AUD/CNY/SGD entries out of a provider map (either key case) as a lowercased {aud,cny,sgd}. */
  function pickFxRates(obj) {
    const out = {};
    if (!obj) return out;
    for (const code of FX_CURRENCIES) {
      const raw = obj[code] != null ? obj[code] : obj[code.toLowerCase()];
      const rate = Number(raw);
      if (isFinite(rate) && rate > 0) out[code.toLowerCase()] = rate;
    }
    return out;
  }

  function readFxCache() {
    const raw = lsGet(FX_KEYS.cache);
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) || {};
      const rates = pickFxRates(o.rates);
      if (!Object.keys(rates).length) return null;
      return {
        rates, fetchedAt: Number(o.fetchedAt) || 0,
        source: String(o.source || 'cache'), date: String(o.date || '')
      };
    } catch (err) { return null; }
  }
  function fxFresh(fx) { return !!fx && fx.fetchedAt > 0 && Date.now() - fx.fetchedAt < FX_TTL_MS; }

  function applyFx(fx) {
    state.fx = {
      rates: fx.rates && typeof fx.rates === 'object' ? fx.rates : {},
      fetchedAt: fx.fetchedAt || Date.now(),
      source: fx.source || 'cache',
      date: fx.date || ''
    };
    return state.fx;
  }
  function writeFxCache(fx) {
    lsSet(FX_KEYS.cache, JSON.stringify({ rates: fx.rates, fetchedAt: fx.fetchedAt, source: fx.source, date: fx.date || '' }));
  }

  /** fetch() JSON with an AbortController timeout. */
  function fetchJson(url, timeoutMs) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('fetch unavailable'));
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (err) { /* ignore */ } }, timeoutMs || FX_TIMEOUT_MS) : null;
    const stop = () => { if (timer) clearTimeout(timer); };
    const init = { cache: 'no-store' };
    if (ctl) init.signal = ctl.signal;
    return fetch(url, init).then(res => {
      if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
      return res.json();
    }).then(json => { stop(); return json; }, err => { stop(); throw err; });
  }

  /**
   * Resolve the USD -> {aud,cny,sgd} rate map through the fallback chain and apply it
   * to state.fx. A partial map is fine: every missing code stays on its baked
   * approximation, and the badge says where the rest came from.
   */
  async function fetchFx(force) {
    const cached = readFxCache();
    if (cached && !force && fxFresh(cached)) return applyFx(cached);
    const rates = {}, sources = [];
    let date = '';
    for (const p of FX_PROVIDERS) {
      if (Object.keys(rates).length >= FX_CURRENCIES.length) break;
      try {
        const picked = p.pick(await fetchJson(p.url, FX_TIMEOUT_MS));
        if (!picked) continue;
        let added = false;
        for (const code of Object.keys(picked.rates)) {
          if (rates[code] == null) { rates[code] = picked.rates[code]; added = true; }
        }
        if (added) {
          if (sources.indexOf(p.source) < 0) sources.push(p.source);
          if (!date && picked.date) date = picked.date;
        }
      } catch (err) { /* try the next provider */ }
    }
    for (const code of FX_CURRENCIES) { // (c) per-currency frankfurter for whatever is still missing
      const key = code.toLowerCase();
      if (rates[key] != null) continue;
      try {
        const j = await fetchJson('https://api.frankfurter.dev/v2/rate/USD/' + code, FX_TIMEOUT_MS);
        const raw = j && (j.rate != null ? j.rate : j.rates && j.rates[code]);
        const rate = Number(raw);
        if (isFinite(rate) && rate > 0) {
          rates[key] = rate;
          if (sources.indexOf('frankfurter') < 0) sources.push('frankfurter');
          if (!date && j && j.date) date = j.date;
        }
      } catch (err) { /* fall through to the baked rate */ }
    }
    if (Object.keys(rates).length) {
      const fresh = { rates, fetchedAt: Date.now(), source: sources.join('+') || 'provider', date };
      writeFxCache(fresh);
      return applyFx(fresh);
    }
    if (cached) {
      return applyFx({ rates: cached.rates, fetchedAt: cached.fetchedAt, source: (cached.source || 'cache') + ' (stale)', date: cached.date });
    }
    return applyFx({ rates: Object.assign({}, FX_BAKED_RATES), fetchedAt: Date.now(), source: 'approximate', date: '' });
  }

  let fxInFlight = null;
  /**
   * Non-blocking FX kickoff: a cache is applied synchronously so the next paint can
   * convert, then renderAll() runs again once the network (or a fallback) resolves.
   */
  function resolveFxOnLoad(force) {
    if (fxInFlight) return fxInFlight;
    const quick = readFxCache();
    if (quick) applyFx(quick);
    fxInFlight = fetchFx(!!force)
      .then(fx => { renderAll(); return fx; })
      .catch(() => state.fx)
      .then(fx => { fxInFlight = null; return fx; });
    return fxInFlight;
  }

  // ------------------------------------------------------------- rendering

  function renderYears(months) {
    const years = Array.from(new Set(Object.keys(months).map(k => k.slice(0, 4)))).sort();
    const sel = byId('yearSelect');
    if (!years.length) { state.year = 'all'; if (sel) sel.innerHTML = '<option value="all">All years</option>'; return; }
    if (state.year !== 'all' && years.indexOf(state.year) < 0) state.year = 'all';
    if (sel) {
      sel.innerHTML = '<option value="all">All years</option>' +
        years.map(y => `<option value="${y}">${y}</option>`).join('');
      sel.value = state.year;
    }
  }

  function renderChips() {
    const el = byId('monthChips');
    if (!el) return;
    const values = ['all'].concat(MONTH_NAMES.map((_, i) => String(i + 1).padStart(2, '0')));
    el.innerHTML = values.map(v => {
      const active = v === state.month;
      return `<button type="button" class="chip${active ? ' is-active' : ''}" data-month="${v}" aria-pressed="${active}">` +
        `${v === 'all' ? 'All' : MONTH_NAMES[+v - 1]}</button>`;
    }).join('');
  }

  function renderKpis(months) {
    const keys = visibleKeys();
    if (!keys.length) {
      setText('kpiNet', '—'); setText('kpiMonth', '—'); setText('kpiBest', '—'); setText('kpiAvg', '—');
      setDelta('kpiNetDelta', 'Awaiting CSV'); setDelta('kpiMonthDelta', 'Awaiting CSV');
      setDelta('kpiBestDelta', 'Awaiting CSV'); setDelta('kpiAvgDelta', 'Awaiting CSV');
      setTitle('kpiNetDelta', '');
      setText('kpiMonthSub', ''); setText('kpiBestSub', '');
      return;
    }
    let net = 0, best = keys[0], positive = 0;
    const sums = { options: 0, assign: 0, interest: 0, dividends: 0, withholding: 0, fees: 0 };
    for (const k of keys) {
      const b = months[k];
      net += b.total;
      if (b.total > months[best].total) best = k;
      if (b.total > 0) positive++;
      for (const f of Object.keys(sums)) sums[f] += b[f];
    }
    const last = keys[keys.length - 1], prev = keys.length > 1 ? keys[keys.length - 2] : null;
    const mom = prev && months[prev].total !== 0 ? (months[last].total - months[prev].total) / Math.abs(months[prev].total) : null;
    const income = incomeOf(sums);
    setText('kpiNet', fmtMoney(net));
    setDelta('kpiNetDelta', `Options ${fmtMoney(sums.options)} · Stock ${fmtMoney(sums.assign)} · Income ${fmtMoney(income)}`);
    // Interest + Div breakdown of the Income figure; setDelta above only rewrites text/class.
    setTitle('kpiNetDelta', incomeTipText(sums));
    setText('kpiMonth', fmtMoney(months[last].total));
    setDelta('kpiMonthDelta', mom == null ? 'MoM n/a' : `MoM ${mom >= 0 ? '+' : ''}${(mom * 100).toFixed(1)}%`, mom == null ? 'flat' : mom >= 0 ? 'up' : 'down');
    setText('kpiMonthSub', monthLabel(last));
    setText('kpiBest', fmtMoney(months[best].total));
    setDelta('kpiBestDelta', `${months[best].count} trades`);
    setText('kpiBestSub', monthLabel(best));
    setText('kpiAvg', fmtMoney(net / keys.length));
    setDelta('kpiAvgDelta', `${positive}/${keys.length} months up`, positive * 2 >= keys.length ? 'up' : 'down');
  }

  // income-breakdown series — keep these fills in sync with the .bar--opt/.bar--stock/
  // .bar--int fallbacks and the #breakdownCard legend dots in styles.css.
  const BREAKDOWN_SERIES = [
    { key: 'options', name: 'Options', cls: 'bar--opt', fill: '#48BB78' },
    { key: 'assign', name: 'Stock', cls: 'bar--stock', fill: '#667EEA' },
    { key: 'income', name: 'Income', cls: 'bar--int', fill: '#ECC94B' }
  ];

  /** interest + dividends + withholding + fees — the breakdown's gold top segment. */
  function incomeOf(b) {
    return (Number(b.interest) || 0) + (Number(b.dividends) || 0) +
      (Number(b.withholding) || 0) + (Number(b.fees) || 0);
  }

  /**
   * "Income $X = Interest $a + Div $b" — the #kpiNetDelta title and the gold segment's
   * data-tip/<title>. X is incomeOf, so withholding + fees stay netted inside it while
   * their component lines stay hidden by choice. Raw USD in; fmtMoney converts.
   */
  function incomeTipText(b) {
    const m = b || {};
    return `Income ${fmtMoney(incomeOf(m))} = Interest ${fmtMoney(m.interest)} + Div ${fmtMoney(m.dividends)}`;
  }

  /**
   * Full month tip — the income-breakdown segments' data-tip:
   *   "May 2026 · Net $14,069.38 · Options $… (37%) · Stock $… (30%) · Interest $… (7%) · Div $… (2%)"
   * Withhold/Fees appear only when non-zero; each percentage is the line's share of the month's
   * net total and is omitted when that total is 0. `running` appends the chart cumulative.
   * The two bar charts (monthly, interest) use the short barTipText instead.
   */
  function monthTipText(k, b, running) {
    const m = b || {};
    const total = Number(m.total) || 0;
    const pct = v => total ? ` (${Math.round((Number(v) || 0) / total * 100)}%)` : '';
    let text = `${monthLabel(k)} · Net ${fmtMoney(total)}` +
      ` · Options ${fmtMoney(m.options)}${pct(m.options)}` +
      ` · Stock ${fmtMoney(m.assign)}${pct(m.assign)}` +
      ` · Interest ${fmtMoney(m.interest)}${pct(m.interest)}` +
      ` · Div ${fmtMoney(m.dividends)}${pct(m.dividends)}`;
    if (Number(m.withholding)) text += ` · Withhold ${fmtMoney(m.withholding)}${pct(m.withholding)}`;
    if (Number(m.fees)) text += ` · Fees ${fmtMoney(m.fees)}${pct(m.fees)}`;
    if (running != null) text += ` · Running ${fmtMoney(running)}`;
    return text;
  }

  /**
   * Short bar tip shared by the two bar charts (the breakdown keeps monthTipText's
   * full split):
   *   "May 2026 · Net $14,069.38 · Running $52,301.10"
   *   "May 2026 · Interest $812.44 · Running $4,201.19"
   * `head` labels the bar's own series, `value` and `running` are raw USD and
   * fmtMoney converts them to the active display currency (AUD included).
   */
  function barTipText(k, head, value, running) {
    let text = `${monthLabel(k)} · ${head} ${fmtMoney(value)}`;
    if (running != null) text += ` · Running ${fmtMoney(running)}`;
    return text;
  }

  /** 10%-padded [hi, lo] domain over a series — the shared dual-axis scale. */
  function paddedDomain(values) {
    const hi = Math.max(0, ...values);
    const lo = Math.min(0, ...values);
    const pad = (hi - lo) * 0.1 || 1;
    return [hi + pad, lo - pad];
  }

  /**
   * Shared-zero dual axes. paddedDomain scales each series independently, which
   * puts the two axes' $0 gridlines at different heights. Take the higher zero
   * (smaller fraction from the top) as the shared line and re-expand the lower
   * one — lo only — until both hi:(-lo) ratios match, so yL(0) === yR(0) and
   * the zero gridline can be drawn once, neutral. The hi ends and the higher
   * zero stay put, so any dead space lands at the bottom of the chart.
   * Returns the possibly-expanded [loL, loR]; the two his never change.
   */
  function sharedZeroLo(hiL, loL, hiR, loR) {
    const fL = hiL / (hiL - loL);
    const fR = hiR / (hiR - loR);
    const f = Math.min(fL, fR);
    const toShared = (hi, lo, own) => own <= f ? lo : -hi * (1 - f) / f;
    return [toShared(hiL, loL, fL), toShared(hiR, loR, fR)];
  }

  /**
   * X-label budget in viewBox units, used only when nothing can be measured (no DOM
   * in Node tests, or a hidden card like the Interest tab before its first show):
   * "Sep" fills ~42 at the biggest .label size styles.css switches in (24px) and
   * "Sep '25" ~81, so 56/100 keep their air. Real renders measure instead — see
   * xLabelWidth() — because the drawn width depends on the card's container-query
   * font, which no static number can track. Nothing is ever rotated.
   */
  const X_LABEL_BUDGET = 56;
  const X_LABEL_BUDGET_YEAR = 100;
  /** ViewBox units of air kept between two drawn labels. */
  const X_LABEL_AIR = 12;
  /** Conventional label spacing: one label per ceil(X_LABEL_SPACING / band) months. */
  const X_LABEL_SPACING = 64;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** Month name for a 'yyyy-MM' key ("Sep"), falling back to the raw key for odd input. */
  function xLabelName(key) {
    return MONTH_NAMES[+key.slice(5, 7) - 1] || key;
  }

  /** The x label one month key draws: "Sep", or "Sep '25" when the range spans years. */
  function xLabelText(key, multiYear) {
    return `${xLabelName(key)}${multiYear ? " '" + key.slice(2, 4) : ''}`;
  }

  /**
   * Width of the widest x label this chart will draw, in viewBox units, measured with a
   * throwaway <text class="label"> inside the live svg: styles.css sizes .label per card
   * (container query 11 -> 24px), so a probe inherits exactly the font that will be drawn
   * and getComputedTextLength() already answers in user units — no card-width maths and
   * no hardcoded breakpoints. Returns 0 when there is nothing to measure (no DOM, or a
   * display:none card), and the caller keeps the static budget.
   */
  function xLabelWidth(svg, keys, multiYear) {
    if (!svg || !svg.appendChild || typeof document === 'undefined' || !document.createElementNS) return 0;
    const probe = document.createElementNS(SVG_NS, 'text');
    probe.setAttribute('class', 'label');
    probe.setAttribute('x', '-9999');
    probe.setAttribute('y', '-9999');
    probe.setAttribute('aria-hidden', 'true');
    let width = 0;
    svg.appendChild(probe);
    try {
      if (typeof probe.getComputedTextLength === 'function') {
        const names = new Set();
        for (const key of keys) names.add(xLabelName(key));
        let widest = '';
        for (const name of names) {
          probe.textContent = name;
          const w = probe.getComputedTextLength();
          if (w > width) { width = w; widest = name; }
        }
        // "Sep '25" only ever adds the year suffix, so measuring that suffix on the
        // widest month name bounds every drawn label without one probe per key.
        if (multiYear) {
          for (const yy of new Set(keys.map(k => k.slice(2, 4)))) {
            probe.textContent = `${widest} '${yy}`;
            const w = probe.getComputedTextLength();
            if (w > width) width = w;
          }
        }
      }
    } catch (err) {
      width = 0; // a shell that never laid the svg out simply keeps the static budget
    }
    if (probe.parentNode) probe.parentNode.removeChild(probe);
    return width;
  }

  /**
   * One x row's geometry: the widest label this chart will draw (measured live, the
   * static budget when the card is hidden), the conventional stride — one label every
   * ceil(64 / band) months, coarser only when the measured glyph + air needs more —
   * and the index of the last month, which always carries a label so the row closes
   * on the right. Live from keys.length (any 1 to 60+, never a hardcoded 9/21).
   */
  function xLabelPlan(svg, keys, band, multiYear) {
    const measured = xLabelWidth(svg, keys, multiYear);
    const width = measured || (multiYear ? X_LABEL_BUDGET_YEAR : X_LABEL_BUDGET);
    return {
      band: band,
      width: width,
      skip: Math.max(1, Math.ceil(Math.max(width + X_LABEL_AIR, X_LABEL_SPACING) / band)),
      last: keys.length - 1
    };
  }

  /**
   * One x-axis month slot: a horizontal, middle-anchored text on every skip-th month's
   * centre, plus the last month, which is always labelled so the row closes on the
   * right. Thinned slots draw nothing — no tick, no rotate() branch; every drawn label
   * reads left to right. A stride label is dropped when the forced last label would sit
   * closer to it than X_LABEL_AIR + the measured width, so the closing pair can never
   * collide.
   */
  function xLabelMarkup(label, x, y, i, plan) {
    const isLast = i === plan.last;
    if (!isLast) {
      if (i % plan.skip !== 0) return '';
      if ((plan.last - i) * plan.band < plan.width + X_LABEL_AIR) return '';
    }
    return `<text class="label" x="${x.toFixed(1)}" y="${y}" text-anchor="middle">${label}</text>`;
  }

  // chart hooks: .bar / .bar--neg / .line / .dot / .tick / .label are styled by styles.css
  /**
   * Position the hovered chart's tip (`.chart-tip`) at the element's top-centre. The tip is
   * resolved from the target's own `.chart-wrap`, so renderChart and renderBreakdown share
   * this maths and each SVG keeps its own tip (#chartTip / #breakdownTip).
   */
  function showTipFor(target) {
    if (!target || !target.getAttribute || !target.getBoundingClientRect) return;
    const wrap = target.closest ? target.closest('.chart-wrap') : null;
    const tip = (wrap && wrap.querySelector ? wrap.querySelector('.chart-tip') : null) || byId('chartTip');
    if (!tip) return;
    const text = target.getAttribute('data-tip');
    if (!text) return;
    // Unhide before measuring: offsetParent is null while an element is hidden,
    // which would fall back to the viewport origin and misplace the first hover.
    // The tips keep their layout (styles.css: display:block + opacity/visibility),
    // so only the hidden attribute flips them between visible and invisible.
    tip.textContent = text;
    tip.hidden = false;
    const docW = typeof document !== 'undefined' && document.documentElement
      ? document.documentElement.clientWidth : 0;
    // Long unified tips wrap inside the viewport instead of widening the page.
    if (docW) tip.style.maxWidth = Math.max(160, docW - 8) + 'px';
    const host = tip.offsetParent && tip.offsetParent.getBoundingClientRect ? tip.offsetParent : null;
    const base = host ? host.getBoundingClientRect() : { left: 0, top: 0 };
    const r = target.getBoundingClientRect();
    const left = r.left - base.left + r.width / 2;
    const top = r.top - base.top;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    // Keep the tip fully on screen: only bars near the edges shift, and only as far as
    // needed, so a tooltip can never extend the page's scrollWidth (the 375px smoke test).
    if (docW && tip.getBoundingClientRect) {
      const box = tip.getBoundingClientRect();
      const dx = box.left < 4 ? 4 - box.left : box.right > docW - 4 ? docW - 4 - box.right : 0;
      const dy = box.top < 4 ? 4 - box.top : 0;
      if (dx) tip.style.left = left + dx + 'px';
      if (dy) tip.style.top = top + dy + 'px';
    }
  }
  function hideTipFor(tip) { if (tip) tip.hidden = true; } // stays laid out, styles.css fades it out
  function hideTip() { hideTipFor(byId('chartTip')); }
  function hideBreakdownTip() { hideTipFor(byId('breakdownTip')); }
  function hideInterestTip() { hideTipFor(byId('interestTip')); }
  function tipTarget(e) {
    const t = e.target;
    return t && t.getAttribute && t.getAttribute('data-tip') ? t : null;
  }
  /**
   * Keep an absolutely positioned popover (right-anchored by CSS) inside the
   * viewport. Called on the anchor's reveal events, so it only ever nudges the
   * popover's own offsets: horizontally `right` (negative moves it right,
   * positive moves it left) and vertically `top` when the box would poke above
   * the viewport. The upward-opening tips (#heroCsvHelp above the hero's 10px
   * padding, #fxDetail in the pinned footer strip) otherwise start at a negative
   * viewport y and lose their first lines. Flipping below is deliberately not an
   * option: the toolbar is sticky at z-index 15, above the hero's stacking
   * context, so a flipped hero tip would be half-buried under it. Clamp into view.
   * Used by #basisHelp (.info-tip), #heroCsvHelp (.info-tip) and #fxDetail (.fx-detail).
   */
  function clampPopover(anchor, popover) {
    if (!anchor || !popover || !popover.getBoundingClientRect) return;
    if (typeof document === 'undefined' || !document.documentElement) return;
    // Drop the previous reveal's clamp first so the box is measured at its CSS
    // anchor position (and repeat calls cannot accumulate).
    popover.style.right = '0';
    popover.style.top = '';
    popover.style.bottom = '';
    const docW = document.documentElement.clientWidth;
    let box = popover.getBoundingClientRect();
    const overLeft = 4 - box.left;
    const overRight = box.right - (docW - 4);
    if (overLeft > 0 && box.width <= docW - 8) popover.style.right = (-Math.ceil(overLeft)) + 'px';
    else if (overRight > 0) popover.style.right = Math.ceil(overRight) + 'px';
    // Vertical clamp: pin the box 4px below the viewport top when it overflows.
    // Shift via `top` (the offset whose containing block is the positioned
    // ancestor's padding box) so the CSS `bottom` anchor is replaced by an
    // explicit position. The ancestor's own viewport top is re-read here; the
    // popover's offsetTop would drop to its static position the moment `bottom`
    // is cleared, so it cannot be used for the arithmetic.
    box = popover.getBoundingClientRect();
    const parent = popover.offsetParent;
    if (box.top < 4 && parent) {
      const parentStyle = getComputedStyle(parent);
      const parentTop = parent.getBoundingClientRect().top + (parseFloat(parentStyle.borderTopWidth) || 0);
      popover.style.bottom = 'auto';
      popover.style.top = (4 - parentTop) + 'px';
    }
  }
  function placeBasisTip() { clampPopover(byId('basisInfo'), byId('basisHelp')); }
  function placeIncomeTip() { clampPopover(byId('incomeInfo'), byId('incomeHelp')); }
  function placeFxDetail() { clampPopover(byId('fxBadge'), byId('fxDetail')); }
  function placeHeroCsvTip() { clampPopover(byId('heroCsvInfo'), byId('heroCsvHelp')); }
  /* A clamp is only valid for the viewport it was measured in — the hero tip
     hangs off the hero's own height — so a resize/zoom under a revealed tip
     must be remeasured (place* is idempotent: it re-anchors, then clamps).
     Hidden popovers just get their CSS anchor back; the next reveal remeasures. */
  function replacePopovers() {
    placeBasisTip();
    placeIncomeTip();
    placeFxDetail();
    placeHeroCsvTip();
  }

  function renderChart(months) {
    const svg = byId('chartSvg');
    if (!svg) return;
    const keys = visibleKeys();
    const W = 720, H = 300, pl = 72, pr = 64, pt = 28, pb = 46;
    const iw = W - pl - pr, ih = H - pt - pb;
    if (!keys.length) {
      hideTip();
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML = '<g id="chartPlaceholder">' +
        '<line class="grid" x1="0" y1="40" x2="720" y2="40"></line>' +
        '<line class="grid" x1="0" y1="110" x2="720" y2="110"></line>' +
        '<line class="grid" x1="0" y1="180" x2="720" y2="180"></line>' +
        '<line class="axis" x1="0" y1="250" x2="720" y2="250"></line>' +
        '<text class="chart__hint" x="360" y="150" text-anchor="middle">Load a CSV to plot monthly totals</text></g>';
      return;
    }
    const totals = keys.map(k => months[k].total);
    const cumulative = [];
    let run = 0;
    for (const t of totals) { run += t; cumulative.push(run); }
    // Dual axes: bars scale to the monthly totals (left), the running line to the cumulative
    // series (right), so neither series can flatten the other. sharedZeroLo then re-expands
    // the lower zero's domain so both axes pivot on one $0 (drawn once, neutral, below).
    let [hiL, loL] = paddedDomain(totals);
    let [hiR, loR] = paddedDomain(cumulative);
    [loL, loR] = sharedZeroLo(hiL, loL, hiR, loR);
    const scale = (hi, lo) => v => pt + ih * (hi - v) / (hi - lo);
    const yL = scale(hiL, loL);
    const yR = scale(hiR, loR);
    const band = iw / keys.length;
    const cx = i => pl + band * (i + 0.5);
    const barW = Math.max(6, Math.min(12, band - 6));
    const zeroY = yL(0); // === yR(0) after sharedZeroLo
    const multiYear = state.year === 'all' && new Set(keys.map(k => k.slice(0, 4))).size > 1;
    // x row measured from this card's live .label font: narrow cards space the
    // labels out further (last month always labelled); thinned slots stay empty
    const xPlan = xLabelPlan(svg, keys, band, multiYear);
    let out = '';
    // Grid + labels track each axis: left (bars) in green, right (running total)
    // in --chart-line blue; the shared $0 line is neutral and drawn once.
    // styles.css colours .grid--left/right and .label--left/right.
    const zeroYs = zeroY.toFixed(1);
    out += `<line class="grid" x1="${pl}" y1="${zeroYs}" x2="${W - pr}" y2="${zeroYs}" stroke="currentColor" stroke-opacity="0.5" />`;
    out += `<text class="label label--left" x="${pl - 8}" y="${(+zeroYs + 3).toFixed(1)}" text-anchor="end">${fmtCompact(0)}</text>`;
    out += `<text class="label label--right" x="${W - pr + 8}" y="${(+zeroYs + 3).toFixed(1)}" text-anchor="start">${fmtCompact(0)}</text>`;
    for (const v of [hiL, loL]) {
      const yy = yL(v).toFixed(1);
      out += `<line class="grid grid--left" x1="${pl}" y1="${yy}" x2="${W - pr}" y2="${yy}" stroke="currentColor" stroke-opacity="0.5" />`;
      out += `<text class="label label--left" x="${pl - 8}" y="${(+yy + 3).toFixed(1)}" text-anchor="end">${fmtCompact(v)}</text>`;
    }
    for (const v of [hiR, loR]) {
      const yy = yR(v).toFixed(1);
      out += `<line class="grid grid--right" x1="${pl}" y1="${yy}" x2="${W - pr}" y2="${yy}" stroke="currentColor" stroke-opacity="0.5" />`;
      out += `<text class="label label--right" x="${W - pr + 8}" y="${(+yy + 3).toFixed(1)}" text-anchor="start">${fmtCompact(v)}</text>`;
    }
    keys.forEach((k, i) => {
      const total = totals[i];
      const top = total >= 0 ? yL(total) : zeroY;
      const height = Math.max(1, Math.abs(yL(total) - zeroY));
      const tip = barTipText(k, 'Net', total, cumulative[i]);
      if (state.month !== 'all' && k === `${state.year}-${state.month}`) {
        out += `<rect x="${(pl + band * i + 2).toFixed(1)}" y="${pt}" width="${(band - 4).toFixed(1)}" height="${ih}" rx="4" fill="currentColor" fill-opacity="0.05" />`;
      }
      out += `<rect class="bar${total < 0 ? ' bar--neg' : ''}" x="${(cx(i) - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW}" height="${height.toFixed(1)}" rx="2" fill="${total >= 0 ? '#48BB78' : '#F56565'}" tabindex="0" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
      out += xLabelMarkup(xLabelText(k, multiYear), cx(i), H - 16, i, xPlan);
    });
    out += `<polyline class="line" points="${keys.map((k, i) => `${cx(i).toFixed(1)},${yR(cumulative[i]).toFixed(1)}`).join(' ')}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
    for (let i = 0; i < keys.length; i++) {
      const runTip = `${monthLabel(keys[i])} · Running ${fmtMoney(cumulative[i])}`;
      out += `<circle class="dot" cx="${cx(i).toFixed(1)}" cy="${yR(cumulative[i]).toFixed(1)}" r="2.5" tabindex="0" data-tip="${esc(runTip)}"><title>${esc(runTip)}</title></circle>`;
    }
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = out;
  }

  /**
   * Stacked income-mix bars: Options (green, bottom), Stock (indigo, middle) and
   * Income — interest + dividends + withholding + fees (gold, top). Values stay raw USD;
   * fmtMoney/fmtCompact convert them for the active display currency. Positive and negative
   * segments stack away from the zero line independently, so the stack height equals the
   * month total whenever the segments share a sign.
   */
  function renderBreakdown(months) {
    const svg = byId('breakdownSvg');
    if (!svg) return;
    const keys = visibleKeys();
    const W = 720, H = 300, pl = 72, pr = 20, pt = 28, pb = 46;
    const iw = W - pl - pr, ih = H - pt - pb;
    if (!keys.length) {
      hideBreakdownTip();
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML = '<g id="breakdownPlaceholder"><text class="chart__hint" x="360" y="150" text-anchor="middle">Load a CSV to see the income mix</text></g>';
      return;
    }
    const stacks = keys.map(k => {
      const b = months[k] || {};
      return {
        key: k,
        total: Number(b.total) || 0,
        segs: BREAKDOWN_SERIES.map(s => ({
          key: s.key, name: s.name, cls: s.cls, fill: s.fill,
          value: s.key === 'income' ? incomeOf(b) : (Number(b[s.key]) || 0)
        }))
      };
    });
    let hi = 0, lo = 0;
    for (const st of stacks) {
      let pos = 0, neg = 0;
      for (const s of st.segs) { if (s.value > 0) pos += s.value; else neg += s.value; }
      if (pos > hi) hi = pos;
      if (neg < lo) lo = neg;
    }
    const pad = (hi - lo) * 0.1 || 1;
    hi += pad; lo -= pad;
    const y = v => pt + ih * (hi - v) / (hi - lo);
    const band = iw / keys.length;
    const cx = i => pl + band * (i + 0.5);
    const barW = Math.max(6, Math.min(12, band - 6));
    const multiYear = state.year === 'all' && new Set(keys.map(k => k.slice(0, 4))).size > 1;
    // x row measured from this card's live .label font: narrow cards space the
    // labels out further (last month always labelled); thinned slots stay empty
    const xPlan = xLabelPlan(svg, keys, band, multiYear);
    let out = '';
    for (const v of [hi, 0, lo]) {
      const yy = y(v).toFixed(1);
      out += `<line class="grid" x1="${pl}" y1="${yy}" x2="${W - pr}" y2="${yy}" stroke="currentColor" stroke-opacity="0.5" />`;
      out += `<text class="label" x="${pl - 8}" y="${(+yy + 3).toFixed(1)}" text-anchor="end">${fmtCompact(v)}</text>`;
    }
    stacks.forEach((st, i) => {
      if (state.month !== 'all' && st.key === `${state.year}-${state.month}`) {
        out += `<rect x="${(pl + band * i + 2).toFixed(1)}" y="${pt}" width="${(band - 4).toFixed(1)}" height="${ih}" rx="4" fill="currentColor" fill-opacity="0.05" />`;
      }
      let pos = 0, neg = 0;
      for (const s of st.segs) {
        if (!s.value) continue;
        const from = s.value > 0 ? pos : neg;
        if (s.value > 0) pos += s.value; else neg += s.value;
        const top = Math.min(y(from), y(from + s.value));
        const h = Math.max(1, Math.abs(y(from + s.value) - y(from)));
        // Options/Stock keep the unified month tip; the gold segment spells out its split.
        const tip = s.key === 'income'
          ? incomeTipText(months[st.key])
          : `${s.name} · ${monthTipText(st.key, months[st.key])}`;
        out += `<rect class="bar ${s.cls}" x="${(cx(i) - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" rx="2" fill="${s.fill}" tabindex="0" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
      }
      out += xLabelMarkup(xLabelText(st.key, multiYear), cx(i), H - 16, i, xPlan);
    });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = out;
  }

  // The interest card and ticker modal live in the shell; the second id in each list is a
  // tolerated alias, so either naming convention binds. Missing ids are simply skipped.
  const INTEREST_KPI = {
    total: ['kpiIntTotal', 'interestTotal', 'kpiInterestTotal'],
    avgDay: ['kpiIntAvgDay', 'interestAvgDay', 'kpiInterestAvgDay'],
    best: ['kpiIntBest', 'interestBest', 'kpiInterestBest'],
    share: ['kpiIntShare', 'interestShare', 'kpiInterestShare']
  };
  const TICKER_IDS = {
    dialog: ['tickerModal', 'tickerDialog'],
    asset: ['assetToggle', 'tickerAssetToggle'],
    search: ['tickerSearch', 'tickerFilter'],
    searchClear: ['tickerSearchClear', 'tickerClearSearch'],
    count: ['tickerCount', 'tickerListCount'],
    note: ['filterNote', 'tickerFilterNote'],
    toTop: ['toTopTickers', 'tickersToTop'],
    body: ['tickerList', 'tickerListBody', 'tickerRows', 'tickerBody'],
    apply: ['tickerApply', 'tickerApplyBtn'],
    clear: ['tickerClear', 'tickerClearBtn'],
    close: ['tickerClose', 'tickerCloseBtn'],
    openers: ['tickerBtn', 'tickerOpen', 'openTickers', 'openTickerList', 'manageTickers', 'tickerListBtn']
  };

  /** Days in a 'yyyy-MM' month (UTC maths keeps it DST-proof). */
  function daysInMonth(key) {
    const y = +String(key).slice(0, 4), m = +String(key).slice(5, 7);
    return m >= 1 && m <= 12 ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 0;
  }
  /** Exact accrual window: sum of the IACC from→to periods, inclusive days. */
  function accrualDays() {
    let days = 0;
    for (const a of state.accruals || []) {
      const from = ymd(a.from), to = ymd(a.to);
      if (!from) continue;
      days += (!to || to < from) ? 1 : Math.round((to - from) / 86400000) + 1;
    }
    return days;
  }

  /**
   * Interest analysis card — KPIs (total, avg/day, best month, share of net), a dual-axis bar
   * chart whose cumulative blue running line scales to its own right-hand domain
   * (#interestSvg/#interestTip, same 720x300 geometry as #chartSvg) and a per-month table
   * (Month | Interest | Trades | Share of net). Every lookup is null-safe: shells without the
   * card skip it entirely.
   */
  function renderInterest(months) {
    const svg = byId('interestSvg');
    const keys = visibleKeys();
    const accrual = interestMode() === 'accrual' && state.accruals.length > 0;
    const rows = keys.map(k => {
      const b = months[k] || {};
      return { key: k, b, amount: Number(b.interest) || 0, total: Number(b.total) || 0, count: Number(b.count) || 0 };
    });
    const total = rows.reduce((a, r) => a + r.amount, 0);
    const net = rows.reduce((a, r) => a + r.total, 0);
    const days = accrual ? accrualDays() : rows.reduce((a, r) => a + daysInMonth(r.key), 0);
    let best = null;
    for (const r of rows) if (!best || r.amount > best.amount) best = r;

    setPickText(INTEREST_KPI.total, rows.length ? fmtMoney(total) : '—');
    setPickText(INTEREST_KPI.avgDay, rows.length && days > 0 ? fmtMoney(total / days) + ' /day' : '—');
    setPickText(INTEREST_KPI.best, rows.length && best ? fmtMoney(best.amount) : '—');
    setPickText(INTEREST_KPI.share, !rows.length ? '—' : net ? (total / net * 100).toFixed(1) + '%' : '0.0%');
    const bestSub = pickById(['kpiIntBestSub', 'interestBestSub', 'kpiInterestBestSub']);
    if (bestSub) bestSub.textContent = rows.length && best ? monthLabel(best.key) : '';
    const basis = pickById(['interestBasis', 'interestBasisNote']);
    if (basis) basis.textContent = accrual ? 'Accrual basis' : 'Posted basis';

    const body = pickById(['interestBody', 'interestTableBody']);
    if (body) {
      body.innerHTML = keys.length ? rows.map(r => {
        const share = r.total ? Math.round(r.amount / r.total * 100) + '%' : '—';
        const cls = r.amount > 0 ? 'pos' : r.amount < 0 ? 'neg' : '';
        return `<tr data-month="${r.key}"><td>${monthLabel(r.key)}</td>` +
          `<td class="num ${cls}">${fmtMoney(r.amount)}</td>` +
          `<td class="num">${r.count}</td>` +
          `<td class="num">${share}</td></tr>`;
      }).join('') : '';
    }

    if (!svg) return;
    const W = 720, H = 300, pl = 72, pr = 64, pt = 28, pb = 46;
    const iw = W - pl - pr, ih = H - pt - pb;
    if (!keys.length) {
      hideTipFor(byId('interestTip'));
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML = ''; // the shell's :has(#interestSvg:empty) hint covers the empty state
      return;
    }
    const values = rows.map(r => r.amount);
    const cumulative = [];
    let run = 0;
    for (const v of values) { run += v; cumulative.push(run); }
    // Dual axes, same maths as renderChart: bars scale to the monthly interest (left),
    // the running line to the cumulative series (right), so a large cumulative total can
    // no longer squash the bars; sharedZeroLo then gives both axes one $0.
    let [hiL, loL] = paddedDomain(values);
    let [hiR, loR] = paddedDomain(cumulative);
    [loL, loR] = sharedZeroLo(hiL, loL, hiR, loR);
    const scale = (hi, lo) => v => pt + ih * (hi - v) / (hi - lo);
    const yL = scale(hiL, loL);
    const yR = scale(hiR, loR);
    const band = iw / keys.length;
    const cx = i => pl + band * (i + 0.5);
    const barW = Math.max(6, Math.min(12, band - 6));
    const zeroY = yL(0); // === yR(0) after sharedZeroLo
    const multiYear = state.year === 'all' && new Set(keys.map(k => k.slice(0, 4))).size > 1;
    // x row measured from this card's live .label font: narrow cards space the
    // labels out further (last month always labelled); thinned slots stay empty
    const xPlan = xLabelPlan(svg, keys, band, multiYear);
    let out = '';
    // left grid/labels follow the interest bars (green), right follow the running line;
    // the shared $0 line is neutral and drawn once.
    const zeroYs = zeroY.toFixed(1);
    out += `<line class="grid" x1="${pl}" y1="${zeroYs}" x2="${W - pr}" y2="${zeroYs}" stroke="currentColor" stroke-opacity="0.5" />`;
    out += `<text class="label label--left" x="${pl - 8}" y="${(+zeroYs + 3).toFixed(1)}" text-anchor="end">${fmtCompact(0)}</text>`;
    out += `<text class="label label--right" x="${W - pr + 8}" y="${(+zeroYs + 3).toFixed(1)}" text-anchor="start">${fmtCompact(0)}</text>`;
    for (const v of [hiL, loL]) {
      const yy = yL(v).toFixed(1);
      out += `<line class="grid grid--left" x1="${pl}" y1="${yy}" x2="${W - pr}" y2="${yy}" stroke="currentColor" stroke-opacity="0.5" />`;
      out += `<text class="label label--left" x="${pl - 8}" y="${(+yy + 3).toFixed(1)}" text-anchor="end">${fmtCompact(v)}</text>`;
    }
    for (const v of [hiR, loR]) {
      const yy = yR(v).toFixed(1);
      out += `<line class="grid grid--right" x1="${pl}" y1="${yy}" x2="${W - pr}" y2="${yy}" stroke="currentColor" stroke-opacity="0.5" />`;
      out += `<text class="label label--right" x="${W - pr + 8}" y="${(+yy + 3).toFixed(1)}" text-anchor="start">${fmtCompact(v)}</text>`;
    }
    keys.forEach((k, i) => {
      const amount = values[i];
      const top = amount >= 0 ? yL(amount) : zeroY;
      const height = Math.max(1, Math.abs(yL(amount) - zeroY));
      const tip = barTipText(k, 'Interest', amount, cumulative[i]);
      if (state.month !== 'all' && k === `${state.year}-${state.month}`) {
        out += `<rect x="${(pl + band * i + 2).toFixed(1)}" y="${pt}" width="${(band - 4).toFixed(1)}" height="${ih}" rx="4" fill="currentColor" fill-opacity="0.05" />`;
      }
      // green = interest received that month, red = interest paid/fees dragging the month negative
      out += `<rect class="bar${amount < 0 ? ' bar--neg' : ''}" x="${(cx(i) - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW}" height="${height.toFixed(1)}" rx="2" fill="${amount >= 0 ? '#48BB78' : '#F56565'}" tabindex="0" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
      out += xLabelMarkup(xLabelText(k, multiYear), cx(i), H - 16, i, xPlan);
    });
    out += `<polyline class="line" points="${keys.map((k, i) => `${cx(i).toFixed(1)},${yR(cumulative[i]).toFixed(1)}`).join(' ')}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
    for (let i = 0; i < keys.length; i++) {
      const runTip = `${monthLabel(keys[i])} · Interest running ${fmtMoney(cumulative[i])}`;
      out += `<circle class="dot" cx="${cx(i).toFixed(1)}" cy="${yR(cumulative[i]).toFixed(1)}" r="2.5" tabindex="0" data-tip="${esc(runTip)}"><title>${esc(runTip)}</title></circle>`;
    }
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = out;
  }

  // ------------------------------------------------------------ daily P&L

  /** 'yyyy-MM' — the UTC "today" month, matching the calendar's UTC grid maths. */
  function currentYm() { return new Date().toISOString().slice(0, 7); }

  /** Full month label for a 'yyyy-MM' key: "January 2026" (falls back to the key). */
  function fullMonthLabel(key) {
    const n = +String(key).slice(5, 7);
    return MONTH_FULL[n - 1] ? MONTH_FULL[n - 1] + ' ' + String(key).slice(0, 4) : String(key);
  }

  /** Shift a 'yyyy-MM' key by whole months, crossing the year boundary. */
  function shiftMonth(ym, delta) {
    const d = new Date(Date.UTC(+String(ym).slice(0, 4), +String(ym).slice(5, 7) - 1 + (Number(delta) || 0), 1));
    return d.toISOString().slice(0, 7);
  }

  /**
   * Daily P&L calendar (#dailyGrid): a Monday-first month grid of button.cal-cell rows —
   * day number · fmtMoney(day total) · "N trades" · an income tag ("Interest" /
   * "Dividend" / "Interest + Div") when the day has cash rows. One flat green tint for
   * any positive day and one flat red tint for any negative day — no magnitude scaling
   * — painted on in-month days only; Sat/Sun cells carry .cal-cell--weekend (grey
   * surface, muted day number) and keep the tint when the day has P&L or income.
   * Month title + Monthly P&L pill come from the same day buckets, so the pill always
   * equals the month row's total.
   * States: .cal-cell--dim (adjacent month), .cal-cell--today (teal ring on the day
   * number), .cal-cell--sel (selected, white ring). Keyboard: arrows move focus, Enter
   * clicks (selects/toggles), Escape clears the selection. Nav ‹ › walk whole months,
   * bounded by the toolbar year filter (the shown ym is clamped into that year); the
   * calendar-glyph picker (#dailyPickerBtn) jumps straight to a month. A selected day
   * also renders its detail panel below the grid (#dailyDetail); the click scrolls it
   * under the sticky toolbar on every viewport and #dailyDetailTop leads back to the
   * grid. Every lookup is null-safe: shells without the card skip it entirely.
   */
  function renderDaily(months) {
    const grid = byId('dailyGrid');
    const title = byId('dailyTitle');
    const pill = byId('dailyPill');
    const detail = byId('dailyDetail');
    if (!grid && !title && !pill && !detail) return;

    const useAccrual = interestMode() === 'accrual' && state.accruals.length > 0;
    const agg = aggregateByDay(state.trades, state.cash, {
      interestMode: useAccrual ? 'accrual' : 'posted', accruals: state.accruals,
      include: state.include, exclude: state.exclude,
      includeScope: state.includeScope, excludeScope: state.excludeScope,
      globalAsset: state.asset
    });

    const available = (months && Object.keys(months).length ? Object.keys(months) : Object.keys(agg.monthTotals)).sort();
    // Year filter: the calendar is clamped inside the selected year, so a stale ym,
    // ‹ / › or Today can never leave it (bounds come from the months the file has).
    const yearActive = !!state.year && state.year !== 'all';
    const yearMonths = yearActive ? available.filter(k => k.slice(0, 4) === state.year) : available;
    const pool = yearActive && yearMonths.length ? yearMonths : available;
    if (!state.daily.ym || !/^\d{4}-\d{2}$/.test(state.daily.ym)) {
      state.daily.ym = pool.length ? pool[pool.length - 1] : currentYm();
    } else if (yearActive && yearMonths.length && state.daily.ym.slice(0, 4) !== state.year) {
      state.daily.ym = yearMonths[yearMonths.length - 1]; // jump to the year's latest month
      state.daily.sel = null;                            // the old selection lives in another year
    }
    // A selection outside the active year goes the same way as the ym clamp above.
    if (yearActive && state.daily.sel && state.daily.sel.slice(0, 4) !== state.year) state.daily.sel = null;

    if (!available.length) { // no rows at all: the shell's :has placeholder covers the grid
      if (title) title.textContent = 'Daily P&L';
      if (pill) { pill.textContent = '—'; pill.className = 'num'; pill.removeAttribute('title'); }
      if (grid) grid.innerHTML = '';
      renderDailyDetail(agg);
      return;
    }

    const ym = state.daily.ym;
    const first = Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1);
    // Monday-first: JS dows are Sun=0..Sat=6, so Mon=1 -> column 0 and Sun=0 -> column 6.
    const lead = (new Date(first).getUTCDay() + 6) % 7;
    const weeks = Math.ceil((lead + daysInMonth(ym)) / 7); // 4..6 rows, 42 cells max
    const start = first - lead * 86400000;
    const today = new Date().toISOString().slice(0, 10);

    if (title) title.textContent = fullMonthLabel(ym);
    const monthDays = Object.keys(agg.byDay).filter(k => k.slice(0, 7) === ym);
    const monthTotal = monthDays.reduce((a, k) => a + agg.byDay[k].total, 0);
    const monthTrades = monthDays.reduce((a, k) => a + agg.byDay[k].count, 0);
    if (pill) {
      pill.textContent = (monthTotal > 0 ? '+' : '') + fmtMoney(monthTotal);
      pill.className = ('num ' + (monthTotal > 0 ? 'pos' : monthTotal < 0 ? 'neg' : '')).trim();
      pill.title = `${fullMonthLabel(ym)} net P&L: ${fmtMoney(monthTotal)} across ${monthTrades} trade${monthTrades === 1 ? '' : 's'}`;
    }
    if (!grid) { renderDailyDetail(agg); return; }

    const cells = [];
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(start + i * 86400000);
      const key = d.toISOString().slice(0, 10);
      cells.push({ key, day: d.getUTCDate(), dow: d.getUTCDay(), inMonth: key.slice(0, 7) === ym });
    }
    // Roving tabindex: the selected day, else today, else the 1st of the month.
    const roving = state.daily.sel && cells.some(c => c.key === state.daily.sel) ? state.daily.sel
      : cells.some(c => c.key === today) ? today
        : (cells.find(c => c.inMonth) || cells[0]).key;
    grid.innerHTML = cells.map(c => {
      const b = agg.byDay[c.key];
      const total = b ? b.total : 0;
      const count = b ? b.count : 0;
      const incomeRows = (agg.rows[c.key] && agg.rows[c.key].income) || null;
      const incomeSum = incomeRows ? incomeRows.reduce((a, r) => a + r.amount, 0) : 0;
      const tag = dayIncomeTag(b, incomeRows);
      const classes = ['cal-cell'];
      if (!c.inMonth) classes.push('cal-cell--dim');
      if (c.dow === 0 || c.dow === 6) classes.push('cal-cell--weekend');
      if (c.key === today) classes.push('cal-cell--today');
      if (c.key === state.daily.sel) classes.push('cal-cell--sel');
      // Flat tint: one green alpha for any positive day, one red for any negative —
      // no scaling by magnitude. Adjacent-month cells are context only and never
      // tinted; a weekend day with P&L or income keeps the tint (it wins over the
      // grey .cal-cell--weekend background, the class stays for the muted day number).
      const tintBase = total !== 0 ? total : incomeSum;
      const tinted = c.inMonth && tintBase !== 0;
      const tint = tinted
        ? ` style="background:rgba(${tintBase > 0 ? '72,187,120' : '245,101,101'},.18)"`
        : '';
      const money = fmtMoney(total);
      const short = fmtCellMoney(total);
      const tradeText = count === 1 ? '1 trade' : count + ' trades';
      // aria-label/title carry the full value: money always, trades and the income
      // tag only when the day has them.
      const label = `${WEEKDAY_NAMES[c.dow]}, ${MONTH_FULL[+c.key.slice(5, 7) - 1]} ${c.day}, ${c.key.slice(0, 4)} · ${money}` +
        (count ? ` · ${tradeText}` : '') +
        (tag ? ` · ${tag}` : '');
      const pnlCls = total > 0 ? 'pos' : total < 0 ? 'neg' : '';
      // Two money spans: the full fmtMoney value everywhere, swapped for the
      // compact fmtCellMoney on narrow screens (styles.css), where a
      // "$1,739.94" or "$1.7k" string would ellipsise to "$…".
      return `<button class="${classes.join(' ')}" type="button" role="gridcell" data-day="${c.key}"` +
        ` tabindex="${c.key === roving ? '0' : '-1'}" aria-label="${esc(label)}" title="${esc(label)}"${tint}>` +
        `<span class="cal-day">${c.day}</span>` +
        (total !== 0 || count ? `<span class="cal-pnl cal-pnl--full ${pnlCls}">${money}</span>` +
          `<span class="cal-pnl cal-pnl--short ${pnlCls}" aria-hidden="true">${short}</span>` : '') +
        (count ? `<span class="cal-meta">${tradeText}</span>` : '') +
        (tag ? `<span class="cal-tag" aria-hidden="true">${esc(tag)}</span>` : '') +
        `</button>`;
    }).join('');
    renderDailyDetail(agg);
  }

  /**
   * Income tag for a calendar cell — "Interest" (interest rows / accrual splits),
   * "Dividend" (dividends + payment in lieu), "Interest + Div" for both, or "Income"
   * when only withholding/fees land that day. '' without income rows.
   */
  function dayIncomeTag(bucket, incomeRows) {
    if (!bucket || !incomeRows || !incomeRows.length) return '';
    const interest = Number(bucket.interest) !== 0;
    const dividends = Number(bucket.dividends) !== 0;
    if (interest && dividends) return 'Interest + Div';
    if (interest) return 'Interest';
    if (dividends) return 'Dividend';
    return 'Income';
  }

  /** "Wed 14 Jan 2026" — the day-detail header for a 'yyyy-MM-dd' key. */
  function dayLabel(key) {
    const stamp = ymd(key);
    if (stamp == null) return String(key);
    const dow = new Date(stamp).getUTCDay();
    return `${WEEKDAY_SHORT[dow]} ${+String(key).slice(8, 10)} ${MONTH_NAMES[+String(key).slice(5, 7) - 1]} ${String(key).slice(0, 4)}`;
  }

  /**
   * Day detail (#dailyDetail): the selected day's trades and cash income, itemised from
   * aggregateByDay().rows — the same pass that built the calendar cells, so the day total
   * here is exactly the cell's total. Trades group mirrors the drill-down columns
   * (Symbol | Asset class | Trades | Net P&L); the Income group lists the day's cash rows
   * (and accrual day-splits on the accrual basis) as type · description · signed amount.
   * Income never contributes to the trade count. No selection (or no shell markup) keeps
   * the panel hidden; a day with neither trades nor income shows its empty state.
   */
  function renderDailyDetail(agg) {
    const panel = byId('dailyDetail');
    if (!panel) return;
    const sel = state.daily && state.daily.sel;
    if (!sel || !/^\d{4}-\d{2}-\d{2}$/.test(sel)) { panel.hidden = true; return; }
    const a = agg || {};
    const dayRows = (a.rows && a.rows[sel]) || { trades: [], income: [] };
    const trades = dayRows.trades.slice()
      .sort((x, y) => Math.abs(y.net) - Math.abs(x.net) || (x.symbol < y.symbol ? -1 : x.symbol > y.symbol ? 1 : 0));
    const income = dayRows.income.slice()
      .sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount) || (x.desc < y.desc ? -1 : x.desc > y.desc ? 1 : 0));
    const bucket = a.byDay ? a.byDay[sel] : null;
    const tradesNet = trades.reduce((t, r) => t + r.net, 0);
    const incomeNet = income.reduce((t, r) => t + r.amount, 0);
    // The bucket is the calendar's own number: showing it keeps cell and detail identical.
    const total = bucket ? bucket.total : tradesNet + incomeNet;
    const count = bucket ? bucket.count : trades.reduce((t, r) => t + r.count, 0);
    const hasTrades = trades.length > 0, hasIncome = income.length > 0;
    const moneyCls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';

    panel.hidden = false;
    const dateEl = byId('dailyDetailDate');
    if (dateEl) dateEl.textContent = dayLabel(sel);
    const pill = byId('dailyDetailPill');
    if (pill) {
      pill.textContent = (total > 0 ? '+' : '') + fmtMoney(total);
      pill.className = ('num ' + moneyCls(total)).trim();
      pill.title = `${dayLabel(sel)} net P&L: ${fmtMoney(total)} (trades ${fmtMoney(tradesNet)} + income ${fmtMoney(incomeNet)})` +
        (count ? ` · ${count} trade${count === 1 ? '' : 's'}` : '');
    }

    // Empty day: one message, both groups retired. Cash-only day: the trades group stays
    // with its own empty line next to the income rows (and vice versa).
    const emptyAll = byId('dailyDetailEmpty');
    const tradesGroup = byId('dailyTradesGroup');
    const incomeGroup = byId('dailyIncomeGroup');
    const none = !hasTrades && !hasIncome;
    if (emptyAll) emptyAll.hidden = !none;
    if (tradesGroup) tradesGroup.hidden = none;
    if (incomeGroup) incomeGroup.hidden = none;

    const tradesSum = byId('dailyTradesSum');
    if (tradesSum) { tradesSum.textContent = fmtMoney(tradesNet); tradesSum.className = ('cal-detail__sum num ' + moneyCls(tradesNet)).trim(); }
    const incomeSum = byId('dailyIncomeSum');
    if (incomeSum) { incomeSum.textContent = fmtMoney(incomeNet); incomeSum.className = ('cal-detail__sum num ' + moneyCls(incomeNet)).trim(); }

    const tradesTable = byId('dailyTradesTable');
    if (tradesTable) tradesTable.hidden = !hasTrades;
    const tradesEmpty = byId('dailyTradesEmpty');
    if (tradesEmpty) tradesEmpty.hidden = hasTrades;
    const tradesBody = byId('dailyTradesBody');
    if (tradesBody) tradesBody.innerHTML = trades.map(r => {
      const info = `${r.symbol} · ${r.asset} · ${r.count} trade${r.count === 1 ? '' : 's'} · ${fmtMoney(r.net)}`;
      return `<tr title="${esc(info)}" aria-label="${esc(info)}">` +
        `<td>${esc(r.symbol)}</td><td>${esc(r.asset)}</td>` +
        `<td class="num">${r.count}</td><td class="num ${moneyCls(r.net)}">${fmtMoney(r.net)}</td></tr>`;
    }).join('');

    const incomeTable = byId('dailyIncomeTable');
    if (incomeTable) incomeTable.hidden = !hasIncome;
    const incomeEmpty = byId('dailyIncomeEmpty');
    if (incomeEmpty) incomeEmpty.hidden = hasIncome;
    const incomeBody = byId('dailyIncomeBody');
    if (incomeBody) incomeBody.innerHTML = income.map(r => {
      const money = (r.amount > 0 ? '+' : '') + fmtMoney(r.amount);
      const info = `${r.label} · ${r.desc} · ${money}`;
      return `<tr title="${esc(info)}" aria-label="${esc(info)}">` +
        `<td>${esc(r.label)}</td><td>${esc(r.desc)}</td>` +
        `<td class="num ${moneyCls(r.amount)}">${money}</td></tr>`;
    }).join('');
  }

  function renderTables(months) {
    // The summary always lists every visible month — the year filter only. state.month
    // is deliberately ignored here (the drill-down below is the month-filtered view),
    // so picking a chip never shrinks the table it was picked from.
    const keys = visibleKeys();
    const summary = byId('monthlyBody');
    if (summary) {
      summary.innerHTML = keys.map(k => {
        const b = months[k];
        const cls = b.total > 0 ? 'pos' : b.total < 0 ? 'neg' : '';
        const avg = b.count ? b.total / b.count : null;
        const info = `Options ${fmtMoney(b.options)} · Assignment ${fmtMoney(b.assign)}${b.otherStockCount ? ` (incl. other stock ${fmtMoney(b.otherStock)})` : ''} · Interest ${fmtMoney(b.interest)} · Dividends ${fmtMoney(b.dividends)} · Withholding ${fmtMoney(b.withholding)} · Fees ${fmtMoney(b.fees)}`;
        return `<tr class="is-clickable" data-month="${k}" title="${esc(info)}">` +
          `<td>${monthLabel(k)}</td>` +
          `<td class="num ${cls}">${fmtMoney(b.total)}</td>` +
          `<td class="num">${b.count}</td>` +
          `<td class="num">${avg == null ? '—' : fmtMoney(avg)}</td></tr>`;
      }).join('');
    }

    const title = byId('drillTitle');
    const body = byId('drillBody');
    if (!body) return;
    const key = state.month === 'all' ? null : `${state.year}-${state.month}`;
    if (!key || !months[key]) { // shell placeholder shows while #drillBody is empty
      body.innerHTML = '';
      if (title) title.textContent = 'Instrument drill-down';
      return;
    }
    if (title) title.textContent = `Instrument drill-down — ${monthLabel(key)}`;
    const groups = new Map();
    const add = (name, asset, amount) => {
      const k = name + '|' + asset;
      const g = groups.get(k) || { name, asset, count: 0, pnl: 0 };
      g.count++; g.pnl += amount; groups.set(k, g);
    };
    // Same predicate as aggregateByMonth so the drill total always matches the month row.
    const filter = prepareTradeFilter({
      include: state.include, exclude: state.exclude,
      includeScope: state.includeScope, excludeScope: state.excludeScope,
      globalAsset: state.asset
    });
    for (const t of state.trades) {
      if (monthKey(t.date) !== key) continue;
      if (!tradePasses(t, filter)) continue;
      const where = classify(t);
      add(t.symbol || '—', where === 'options' ? 'Options' : where === 'assign' ? 'Assignment' : 'Stock (other)', Number(t.pnl) || 0);
    }
    const CAT = CASH_LABELS;
    for (const c of state.cash) {
      if (monthKey(c.date) !== key) continue;
      const cat = cashCategory(c.type);
      add(cat ? CAT[cat] : (c.type ? titleCase(c.type) : 'Cash'), 'Cash', Number(c.amount) || 0);
    }
    const rows = Array.from(groups.values())
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    body.innerHTML = rows.map(g => {
      const cls = g.pnl > 0 ? 'pos' : g.pnl < 0 ? 'neg' : '';
      return `<tr><td>${esc(g.name)}</td><td>${esc(g.asset)}</td>` +
        `<td class="num">${g.count}</td><td class="num ${cls}">${fmtMoney(g.pnl)}</td></tr>`;
    }).join('');
  }

  /**
   * Root symbols ranked by |total P&L| (desc, name tiebreak) — feeds the ticker picker
   * in the include/exclude dialog. Each entry carries the leg split
   * ({ sym, pnl, stock, options }) so mixed symbols can show a subline.
   */
  function rankedRoots() {
    const totals = new Map();
    for (const t of state.trades) {
      const sym = rootOf(t.symbol);
      if (!sym) continue;
      const g = totals.get(sym) || { pnl: 0, stock: 0, options: 0 };
      const pnl = Number(t.pnl) || 0;
      g.pnl += pnl;
      if (classify(t) === 'options') g.options += pnl; else g.stock += pnl;
      totals.set(sym, g);
    }
    return Array.from(totals.keys())
      .sort((a, b) => Math.abs(totals.get(b).pnl) - Math.abs(totals.get(a).pnl) || (a < b ? -1 : a > b ? 1 : 0))
      .map(sym => ({ sym, pnl: totals.get(sym).pnl, stock: totals.get(sym).stock, options: totals.get(sym).options }));
  }

  /** "AMD" or "AMD (Options only)" — a symbol annotated with its non-default scope. */
  function scopedSymbol(sym, scope) {
    const s = normalizeScope(scope);
    return s === 'all' ? sym : sym + ' (' + scopeLabel(s) + ')';
  }

  /** #includeChips — every included root as a pressed chip; the label carries its scope. */
  function renderIncludeChips() {
    const el = byId('includeChips');
    if (!el) return;
    el.innerHTML = state.include.map(sym => {
      const label = scopedSymbol(sym, state.includeScope[sym]);
      const title = `Including ${label} in every total — click to remove`;
      return `<button type="button" class="chip" data-ticker="${esc(sym)}" aria-pressed="true" title="${esc(title)}">${esc(label)}</button>`;
    }).join('');
    measureIncludeOverflow();
  }

  /**
   * #includeMore — the "+n" chip that stands in for the included tickers the fixed
   * 320px cluster cannot show. #includeChips (flex: 0 1 auto + overflow: hidden in
   * styles.css) is the clip box, so this pass hides the tail chips that fall outside
   * it and writes the count into the chip; its title/aria-label carry the full list
   * and data-open-tickers opens the picker (#tickerModal). It is a real <button>, so
   * Tab reaches it and Enter/Space activate the same click path; the dialog wiring
   * hands focus back to it on close. The first snapshot is taken from the bare row
   * (label cleared) and the label's own width is only reserved from the second pass
   * on — a stale "+n" must never invent room against the chips. It no-ops while the
   * cluster is empty or unlaid-out (zero width), and re-runs on window resize, since
   * the toolbar's wrapped width decides how many chips fit. renderAll() renders
   * #filterNote (the inline note that shares this row) before this pass, so the
   * note's width is already spent when the clip is measured. Hiding the tail lets
   * the note flex wider though, so a final settle pass re-checks the survivors
   * against the clip's settled edge and folds any it now cuts off into the count
   * (visible chips + "+n" must always add up to the include list). Every hide path
   * also clears title/aria-label, so a stale symbol list never lingers on the
   * hidden chip.
   */
  function measureIncludeOverflow() {
    const el = byId('includeChips');
    const more = byId('includeMore');
    if (!el || !more) return;
    const hideMore = () => {
      more.hidden = true;
      more.textContent = '';
      more.title = '';
      more.removeAttribute('aria-label');
    };
    const chips = Array.prototype.slice.call(el.querySelectorAll('button[data-ticker]'));
    if (!chips.length) { hideMore(); return; }
    let count = 0;
    hideMore(); // measure from the bare row; the label's width is reserved from pass 1
    for (let pass = 0; pass < 3; pass++) {
      for (const chip of chips) chip.hidden = false;
      if (pass) more.hidden = false;
      const right = el.getBoundingClientRect().right;
      if (!right) { // not laid out — never clip blind
        for (const chip of chips) chip.hidden = false;
        hideMore();
        return;
      }
      let clipped = 0;
      for (let i = chips.length - 1; i >= 0; i--) {
        if (chips[i].getBoundingClientRect().right <= right + 0.5) break;
        chips[i].hidden = true;
        clipped++;
      }
      if (clipped === count) break; // the row is stable at this label width
      count = clipped;
      if (count) more.textContent = '+' + count; // reserve the real width for the next pass
    }
    // The inline note keeps flexing once the tail chips hide — its width feeds the
    // row's overflow — so a chip that fit the measured clip can sit under the
    // settled one. Re-check the survivors and count the ones the clip now cuts off.
    for (let pass = 0; pass < 8; pass++) {
      const right = el.getBoundingClientRect().right;
      if (!right) break;
      let moved = 0;
      for (let i = chips.length - 1; i >= 0; i--) {
        const chip = chips[i];
        if (chip.hidden) continue;
        if (chip.getBoundingClientRect().right <= right + 0.5) break;
        chip.hidden = true;
        moved++;
      }
      if (!moved) break;
      count += moved;
      more.textContent = '+' + count;
    }
    if (!count) { hideMore(); return; }
    const label = `${count} more included ticker${count === 1 ? '' : 's'}`;
    more.textContent = '+' + count;
    more.title = `${label} — ${state.include.map(sym => scopedSymbol(sym, state.includeScope[sym])).join(', ')} · click for the full list`;
    more.setAttribute('aria-label', `${label} — open the ticker list`);
  }

  /** Selector covering every #filterNote id a shell may use (base + tickerFilterNote alias). */
  function filterNoteSelector() { return TICKER_IDS.note.map(id => '#' + id).join(', '); }

  /**
   * #filterNote tap-to-expand. The shell gives the <p> role="button" tabindex="0"
   * aria-expanded="false" and styles.css un-clips `.filter-note.is-open`; this state
   * pair is all app.js owns. Every helper is null-safe and idempotent: a shell without
   * the note simply skips it.
   */
  function filterNoteEl() { return pickById(TICKER_IDS.note); }
  function filterNoteOpen() {
    const el = filterNoteEl();
    return !!(el && el.classList && el.classList.contains('is-open'));
  }
  function setFilterNoteOpen(open) {
    const el = filterNoteEl();
    if (!el) return;
    const next = open === true;
    if (el.classList) el.classList.toggle('is-open', next);
    if (typeof el.setAttribute === 'function') el.setAttribute('aria-expanded', next ? 'true' : 'false');
  }
  function toggleFilterNote() { setFilterNoteOpen(!filterNoteOpen()); }

  /** #filterNote click — flip the expansion (clicks elsewhere collapse it in onDocumentClick). */
  function onFilterNoteClick() { toggleFilterNote(); }

  /**
   * Enter/Space on the focused note. A <p role="button"> gets no synthetic click, so
   * both keys are handled here — Space's default scroll is cancelled first.
   */
  function onFilterNoteKeydown(e) {
    const key = e.key;
    if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    toggleFilterNote();
  }

  /**
   * #filterNote — one-line summary of the active ticker filters, hidden while everything is
   * default: "Including only A (Options only), B · Excluding C (Stock only) · Stock only"
   * (the trailing clause is the global #assetToggle filter; empty clauses are omitted).
   * .filter-note ellipsises, so title= carries the full string for hover/AT; tapping the
   * note expands it in place (.is-open). A note that stays visible keeps its expanded
   * state across re-renders; a hidden one is collapsed, since it can no longer be tapped.
   */
  function renderFilterNote() {
    const el = pickById(TICKER_IDS.note);
    if (!el) return;
    const parts = [];
    if (state.include.length) parts.push('Including only ' + state.include.map(sym => scopedSymbol(sym, state.includeScope[sym])).join(', '));
    if (state.exclude.length) parts.push('Excluding ' + state.exclude.map(sym => scopedSymbol(sym, state.excludeScope[sym])).join(', '));
    if (getAssetFilter() !== 'all') parts.push(scopeLabel(getAssetFilter()));
    const text = parts.join(' · ');
    el.textContent = text;
    el.title = text;
    el.hidden = parts.length === 0;
    if (!parts.length) setFilterNoteOpen(false);
  }

  const FX_CHAIN = 'er-api→currency-api→frankfurter';

  /** "fetched 2026-09-26 04:12 UTC" for a provenance line (or a dash placeholder). */
  function fxFetchedText(ts) {
    const n = Number(ts) || 0;
    const d = new Date(n);
    return n && isFinite(d.getTime())
      ? 'fetched ' + d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
      : 'fetched —';
  }
  /** 4dp (2dp for big quotes) rate text, e.g. "1.4250" / "7.1000" / "104.25". */
  function fxFmtRate(rate) {
    const n = Number(rate);
    if (!isFinite(n) || n <= 0) return '—';
    return n >= 100 ? n.toFixed(2) : n.toFixed(4);
  }
  /** Lowercased codes with a fetched (not baked) rate, e.g. "AUD 1.4254, SGD 1.28". */
  function fxKnownRatesText(fx) {
    const rates = (fx && fx.rates) || {};
    return FX_CURRENCIES
      .map(code => code.toLowerCase())
      .filter(key => Number(rates[key]) > 0)
      .map(key => key.toUpperCase() + ' ' + fxFmtRate(rates[key]))
      .join(', ');
  }
  /** Human-readable provenance for the applied rate — #fxBadge title + #fxDetail text. */
  function fxProvenance(fx) {
    const source = String(fx.source || '');
    const cur = currencyMode();
    const label = CURRENCY_META[cur].label;
    const applied = `applied 1 USD=${fxFmtRate(fxRateFor(cur))} ${label}`;
    const payload = 'payload ' + (fx.date || '—');
    const fetched = fxFetchedText(fx.fetchedAt);
    const known = fxKnownRatesText(fx);
    if (source === 'approximate') return `approximate · ${payload} · ${fetched} · baked ${applied.replace('applied ', '')} (no provider reachable) · chain ${FX_CHAIN}`;
    if (/stale/i.test(source)) return `${source} · ${payload} · ${fetched} · cached rates re-used (providers unreachable)${known ? ' · ' + known : ''}`;
    if (source === 'cache' || source === 'cached') return `cached · ${payload} · ${fetched} · chain ${FX_CHAIN} (≤ ${Math.round(FX_TTL_MS / 3600000)} h old)${known ? ' · ' + known : ''}`;
    return `${source} · ${payload} · ${fetched} · chain ${FX_CHAIN} · ${applied}${known ? ' · ' + known : ''}`;
  }

  /** Toolbar read-only rate: "1 USD = 1.4254 AUD" for the selected currency. */
  function renderFxRate() {
    const el = byId('fxRate');
    if (!el) return;
    const cur = currencyMode();
    const label = CURRENCY_META[cur].label;
    el.textContent = '1 USD = ' + (cur === 'usd' ? '1' : fxFmtRate(fxRateFor(cur))) + ' ' + label;
    const resolved = cur === 'usd' || Number(state.fx && state.fx.rates && state.fx.rates[cur]) > 0;
    el.classList.toggle('fx-rate--approx', !resolved);
    el.title = resolved
      ? `Applied conversion rate for ${label} (from ${state.fx && state.fx.source ? state.fx.source : 'the rate cache'})`
      : `Approximate baked rate for ${label} — automatic lookup still pending or offline`;
  }

  /** Footer FX badge: source label + payload date + rate; title/#fxDetail explain the fallback. */
  function renderFxBadge() {
    const fx = state.fx || {};
    const badge = byId('fxBadge');
    const detail = byId('fxDetail');
    const cur = currencyMode();
    const label = CURRENCY_META[cur].label;
    if (!fx.source) { // no resolution yet
      setText('fxBadge', hasData() ? 'FX: loading' : 'FX: waiting for a CSV');
      if (badge) badge.title = 'USD rates not resolved yet — the automatic lookup starts with the next CSV load.';
      if (detail) detail.textContent = `${FX_CHAIN} — keyless fixed-URL GETs, no data sent`;
      return;
    }
    let sourceLabel = String(fx.source);
    if (sourceLabel === 'cache' || sourceLabel === 'cached') sourceLabel = 'cached';
    const date = fx.date ? ' · ' + fx.date : '';
    setText('fxBadge', `FX: ${sourceLabel}${date} · 1 USD=${fxFmtRate(fxRateFor(cur))} ${label}`);
    const provenance = fxProvenance(fx);
    if (badge) badge.title = provenance;
    if (detail) detail.textContent = provenance;
  }

  let postedTitleBase = null;
  /**
   * #postedToggle carries a static title from the shell — keep it and append (or drop) the
   * dynamic "no accruals in this file" warning instead of wiping the attribute.
   */
  function renderPostedToggleTitle() {
    const toggle = byId('postedToggle');
    if (!toggle) return;
    if (postedTitleBase == null) postedTitleBase = String(toggle.getAttribute('title') || toggle.title || '');
    const warn = (interestMode() === 'accrual' && !state.accruals.length)
      ? 'No Interest Accruals section in this file — showing posted interest' : '';
    toggle.title = warn ? (postedTitleBase ? postedTitleBase + ' — ' + warn : warn) : postedTitleBase;
  }

  function renderAll() {
    const useAccrual = interestMode() === 'accrual' && state.accruals.length > 0;
    const months = aggregateByMonth(state.trades, state.cash, {
      interestMode: useAccrual ? 'accrual' : 'posted', accruals: state.accruals,
      include: state.include, exclude: state.exclude,
      includeScope: state.includeScope, excludeScope: state.excludeScope,
      globalAsset: state.asset
    });
    state.months = months;
    renderYears(months);
    renderChips();
    renderKpis(months);
    renderChart(months);
    renderBreakdown(months);
    renderInterest(months);
    renderTables(months);
    renderDaily(months);
    renderFilterNote(); // first: the inline note's width is part of the row the '+n' clip measures
    renderIncludeChips();
    renderTickerCount();
    renderFxRate();
    renderFxBadge();
    const empty = byId('emptyState');
    if (empty) {
      const has = hasData();
      empty.hidden = has;
      empty.classList.toggle('is-hidden', has);
    }
    renderPostedToggleTitle();
  }

  // ------------------------------------------------------------------ data

  function loadParsed(parsed, name, bytes) {
    state.trades = parsed.trades;
    state.cash = parsed.cash;
    state.accruals = parsed.accruals || [];
    state.format = parsed.format || '';
    state.names = fileNamesOf(name);
    state.name = state.names.join(', ');
    setFileLabel(state.names); // the compact one-line summary; readFiles already set it (idempotent)
    state.year = 'all';
    state.month = 'all';
    state.daily = { ym: null, sel: null };
    try {
      if (!bytes || bytes <= CACHE_MAX_BYTES) {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 1, name: state.name, names: state.names, savedAt: new Date().toISOString(), parsed }));
      } else {
        localStorage.removeItem(CACHE_KEY);
      }
    } catch (err) { /* storage disabled or full — parsed result still renders */ }
    showError('');
    renderAll();
    resolveFxOnLoad(); // render first, then patch in the resolved USD rate map
  }

  function parseMaybeThrow(text, fileName) {
    const parsed = parseCsvText(text);
    if (!parsed.trades.length && !parsed.cash.length) {
      throw new Error((fileName ? fileName + ': ' : '') + 'no trades or cash rows found — is this an IBKR Activity Statement or Flex Query CSV?');
    }
    return parsed;
  }

  /** Public helper for tests / console use: parse and render a CSV string. */
  function loadText(text, name, bytes) {
    const parsed = parseMaybeThrow(text, name || '');
    loadParsed(parsed, name || '', typeof bytes === 'number' ? bytes : String(text).length);
  }

  function readOne(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read ' + file.name));
      reader.onload = () => {
        try {
          const text = String(reader.result || '');
          resolve({ parsed: parseMaybeThrow(text, file.name), bytes: file.size || text.length });
        } catch (err) { reject(err); }
      };
      reader.readAsText(file);
    });
  }

  function readFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []).filter(Boolean);
    if (!files.length) return;
    const names = files.map(f => f.name);
    setFileLabel(names); // compact summary straight away; loadParsed keeps state in step
    Promise.all(files.map(readOne)).then(parts => {
      const merged = {
        format: parts.every(p => p.parsed.format === parts[0].parsed.format) ? parts[0].parsed.format : 'mixed',
        trades: [], cash: [], accruals: []
      };
      let bytes = 0;
      parts.forEach(p => {
        merged.trades = merged.trades.concat(p.parsed.trades);
        merged.cash = merged.cash.concat(p.parsed.cash);
        merged.accruals = merged.accruals.concat(p.parsed.accruals);
        bytes += p.bytes;
      });
      loadParsed(merged, names, bytes);
    }).catch(err => showError(err && err.message ? err.message : 'Could not read those files.'));
  }

  function restore() {
    if (restoreTried) return;
    restoreTried = true;
    try {
      const rawExclude = lsGet(EXCLUDE_KEY);
      if (rawExclude) {
        const list = JSON.parse(rawExclude);
        if (Array.isArray(list)) state.exclude = list.map(up).filter(Boolean);
      }
    } catch (err) { /* corrupt exclude list — start unfiltered */ }
    try {
      const rawInclude = lsGet(INCLUDE_KEY);
      if (rawInclude) {
        const list = JSON.parse(rawInclude);
        if (Array.isArray(list)) state.include = list.map(up).filter(Boolean);
      }
    } catch (err) { /* corrupt include list — keep every ticker */ }
    try {
      const rawIncludeScope = lsGet(INCLUDE_SCOPE_KEY);
      if (rawIncludeScope) state.includeScope = normalizeScopeMap(JSON.parse(rawIncludeScope));
    } catch (err) { /* corrupt scope map — treat every include as unscoped */ }
    try {
      const rawExcludeScope = lsGet(EXCLUDE_SCOPE_KEY);
      if (rawExcludeScope) state.excludeScope = normalizeScopeMap(JSON.parse(rawExcludeScope));
    } catch (err) { /* corrupt scope map — treat every exclude as unscoped */ }
    // Orphans: scopes whose symbol has left its list are dropped.
    state.includeScope = pruneScope(state.includeScope, state.include);
    state.excludeScope = pruneScope(state.excludeScope, state.exclude);
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      const parsed = saved && saved.parsed;
      if (!parsed || !Array.isArray(parsed.trades) || !Array.isArray(parsed.cash)) return;
      state.trades = parsed.trades;
      state.cash = parsed.cash;
      state.accruals = Array.isArray(parsed.accruals) ? parsed.accruals : [];
      state.format = parsed.format || '';
      state.name = saved.name || 'cached';
      // Cache entries record the name list; v1 entries predate it, so recover the names by
      // splitting the comma-joined name. Everything restored is, by definition, cached.
      state.names = Array.isArray(saved.names) && saved.names.length ? fileNamesOf(saved.names) : splitFileNames(state.name);
      if (!state.names.length) state.names = fileNamesOf(state.name);
      setFileLabel(state.names, true);
    } catch (err) { /* corrupt cache — start empty */ }
  }

  function clearAll() {
    state.trades = []; state.cash = []; state.accruals = []; state.months = {};
    state.year = 'all'; state.month = 'all'; state.name = ''; state.names = []; state.format = '';
    state.daily = { ym: null, sel: null };
    state.exclude = [];
    state.include = [];
    state.excludeScope = {};
    state.includeScope = {};
    state.asset = 'all';
    syncAssetToggle();
    lsRemove(CACHE_KEY);
    lsRemove(EXCLUDE_KEY);
    lsRemove(INCLUDE_KEY);
    lsRemove(INCLUDE_SCOPE_KEY);
    lsRemove(EXCLUDE_SCOPE_KEY);
    const input = byId('fileInput');
    if (input) input.value = '';
    setFileLabel([]);
    showError('');
    renderAll();
    renderTickerList();
  }

  // -------------------------------------------------- ticker picker & tabs

  let tickerReturnFocus = null;

  /** Root symbols shown in the picker: every traded root, largest |P&L| first, plus manual picks and scoped entries. */
  function tickerSymbols() {
    const ranked = rankedRoots();
    const seen = new Set(ranked.map(r => r.sym));
    const extra = state.include.concat(state.exclude, Object.keys(state.includeScope), Object.keys(state.excludeScope));
    for (const raw of extra) {
      const sym = up(raw);
      if (!sym || seen.has(sym)) continue;
      seen.add(sym); ranked.push({ sym, pnl: 0, stock: 0, options: 0 });
    }
    return ranked;
  }

  /** #tickerBtn count — how many tickers the modal currently offers. */
  function renderTickerCount() {
    const btn = pickById(TICKER_IDS.openers);
    if (!btn) return;
    const count = tickerSymbols().length;
    btn.textContent = `Tickers (${count})`;
    btn.title = count ? `${count} tickers in this statement` : 'Load a CSV to pick tickers';
  }

  /** Per-row scope <select> (pending until Apply): All / Options only / Stock only. */
  function scopeSelectHtml(sym, scope) {
    const current = normalizeScope(scope);
    const options = ['all', 'options', 'stock'].map(v =>
      `<option value="${v}"${current === v ? ' selected' : ''}>${scopeLabel(v)}</option>`).join('');
    return `<select class="ticker-row__scope" name="assetScope" data-scope aria-label="Asset scope for ${esc(sym)}">${options}</select>`;
  }

  /** Rows for the include/exclude picker (scope select + checkbox per mode, mutual exclusion per ticker). */
  function renderTickerList() {
    const body = pickById(TICKER_IDS.body);
    if (!body) return;
    const ranked = tickerSymbols();
    const asTable = /^(TBODY|TABLE|THEAD)$/.test(String(body.tagName || '').toUpperCase());
    body.innerHTML = ranked.map(r => {
      const included = state.include.indexOf(r.sym) >= 0;
      const excluded = state.exclude.indexOf(r.sym) >= 0;
      const cls = r.pnl > 0 ? 'pos' : r.pnl < 0 ? 'neg' : '';
      const scope = included ? state.includeScope[r.sym] : excluded ? state.excludeScope[r.sym] : state.includeScope[r.sym] || state.excludeScope[r.sym];
      const scopeSelect = scopeSelectHtml(r.sym, scope);
      const split = r.stock && r.options
        ? `<span class="ticker-row__split">Stock ${fmtCompact(r.stock)} · Options ${fmtCompact(r.options)}</span>` : '';
      const boxes =
        `<input type="checkbox" name="tickerInclude" data-mode="include" aria-label="Include ${esc(r.sym)}"${included ? ' checked' : ''}>` +
        `<input type="checkbox" name="tickerExclude" data-mode="exclude" aria-label="Exclude ${esc(r.sym)}"${excluded ? ' checked' : ''}>`;
      return asTable
        ? `<tr data-symbol="${esc(r.sym)}"><td>${esc(r.sym)}${split}</td><td class="num ${cls}">${fmtMoney(r.pnl)}</td><td>${scopeSelect}</td><td class="num">${boxes}</td></tr>`
        : `<label class="ticker-row" data-symbol="${esc(r.sym)}"><span class="ticker-row__symbol">${esc(r.sym)}</span><span class="ticker-row__pnl num ${cls}">${fmtMoney(r.pnl)}</span>${scopeSelect}<span class="ticker-row__modes">${boxes}</span>${split}</label>`;
    }).join('');
    filterTickerList();
  }

  /** #tickerSearch — case-insensitive substring filter over the rendered rows. */
  function filterTickerList() {
    const body = pickById(TICKER_IDS.body);
    if (!body || !body.querySelectorAll) return;
    const input = pickById(TICKER_IDS.search);
    const query = up(input ? input.value : '');
    const rows = body.querySelectorAll('tr[data-symbol], label[data-symbol]');
    let shown = 0;
    for (const row of rows) {
      const match = !query || up(row.getAttribute('data-symbol')).indexOf(query) >= 0;
      row.hidden = !match;
      if (match) shown++;
    }
    const count = pickById(TICKER_IDS.count);
    if (count) {
      count.textContent = query ? `${shown} / ${rows.length}` : String(rows.length);
      count.hidden = rows.length === 0; // no tickers yet — the list owns the empty hint
    }
  }

  /** #tickerSearchClear — empty the modal's filter box, repaint the rows and keep typing. */
  function onSearchClear() {
    const search = pickById(TICKER_IDS.search);
    if (search) search.value = '';
    filterTickerList();
    if (search && typeof search.focus === 'function') search.focus();
  }

  function tickerRowOf(el) {
    return el && el.closest ? el.closest('tr[data-symbol], label[data-symbol]') : null;
  }

  /** Include and exclude are mutually exclusive per ticker — checking one unchecks its twin. */
  function onTickerListChange(e) {
    const box = e.target;
    if (!box) return;
    // Row scope selects stay pending: tickerSelection() reads them when Apply commits.
    if (String(box.tagName || '').toUpperCase() === 'SELECT') return;
    if (String(box.type) !== 'checkbox') return;
    const mode = String(box.getAttribute('data-mode') || '');
    if ((mode !== 'include' && mode !== 'exclude') || !box.checked) return;
    const row = tickerRowOf(box);
    if (!row || !row.querySelector) return;
    const twin = row.querySelector(`input[data-mode="${mode === 'include' ? 'exclude' : 'include'}"]`);
    if (twin) twin.checked = false;
  }

  /** Reads the picker's pending checkboxes + scope selects into { include, exclude, includeScope, excludeScope }. */
  function tickerSelection() {
    const body = pickById(TICKER_IDS.body);
    const out = { include: [], exclude: [], includeScope: {}, excludeScope: {} };
    if (!body || !body.querySelectorAll) return out;
    const rows = body.querySelectorAll('tr[data-symbol], label[data-symbol]');
    for (const row of rows) {
      const sym = up(row.getAttribute('data-symbol'));
      if (!sym) continue;
      const inc = row.querySelector ? row.querySelector('input[data-mode="include"]') : null;
      const exc = row.querySelector ? row.querySelector('input[data-mode="exclude"]') : null;
      const sel = row.querySelector ? row.querySelector('select[data-scope]') : null;
      const scope = normalizeScope(sel ? sel.value : 'all');
      if (inc && inc.checked) { out.include.push(sym); if (scope !== 'all') out.includeScope[sym] = scope; }
      else if (exc && exc.checked) { out.exclude.push(sym); if (scope !== 'all') out.excludeScope[sym] = scope; }
    }
    return out;
  }

  /** Apply = commit the pending checkboxes + scopes, persist once, render once and close. */
  function applyTickerList() {
    const selection = tickerSelection();
    state.include = normalizeSymbols(selection.include);
    state.exclude = normalizeSymbols(selection.exclude);
    state.includeScope = pruneScope(normalizeScopeMap(selection.includeScope), state.include);
    state.excludeScope = pruneScope(normalizeScopeMap(selection.excludeScope), state.exclude);
    saveFilterState();
    renderAll();          // single batched render for list + scope changes
    closeTickerList();
  }

  /** Clear = drop both filters, their scopes and the global asset choice, then stay open for a fresh pick. */
  function clearTickerList() {
    state.include = [];
    state.exclude = [];
    state.includeScope = {};
    state.excludeScope = {};
    setAssetFilter('all', { silent: true });
    saveFilterState();
    const search = pickById(TICKER_IDS.search);
    if (search) search.value = '';
    renderAll();
    renderTickerList();
    filterTickerList(); // the rebuilt rows ignore the now-empty query; this refreshes the count
  }

  let toTopGlowTimer = null;
  /**
   * Both "Tickers ↑" shortcuts — #toTopTickers (Monthly summary header) and
   * #tickersToTop (drill-down header) — share this handler: scroll #tickerBtn into
   * view, focus it and flash .glow for 2.5s. A folded mobile toolbar hides that
   * button, so the fold is opened first (without touching the persisted choice).
   * The pulse itself comes from styles.css; the class is also a plain ring so
   * reduced-motion users still see the target (the global rule flattens the
   * animation, JS still removes the class on the same timer).
   */
  function onToTopTickers() {
    const btn = byId('tickerBtn');
    if (!btn) return;
    const toolbar = byId('toolbar');
    if (toolbar && toolbar.classList && toolbar.classList.contains('is-collapsed')) applyToolbarCollapsed(false);
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof btn.scrollIntoView === 'function') {
      btn.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    }
    if (typeof btn.focus === 'function') btn.focus({ preventScroll: true });
    if (btn.classList) {
      btn.classList.remove('glow');
      if (typeof btn.offsetWidth === 'number') void btn.offsetWidth; // restart on repeat clicks
      btn.classList.add('glow');
      if (toTopGlowTimer) clearTimeout(toTopGlowTimer);
      toTopGlowTimer = setTimeout(function () {
        toTopGlowTimer = null;
        btn.classList.remove('glow');
      }, 2500);
    }
  }

  function restoreTickerFocus() {
    const target = tickerReturnFocus;
    tickerReturnFocus = null;
    if (target && typeof target.focus === 'function') {
      try { target.focus(); } catch (err) { /* element detached */ }
    }
  }

  /**
   * Open the picker: sync the global asset radios, render fresh rows, show the dialog.
   * Focus #tickerSearch only on fine pointers — on touch the dialog keeps its default
   * focus (the checked asset radio) so no soft keyboard pops over the list.
   */
  function openTickerList() {
    syncAssetToggle();
    renderTickerList();
    const dialog = pickById(TICKER_IDS.dialog);
    if (!dialog) return;
    if (typeof document !== 'undefined' && document.activeElement) tickerReturnFocus = document.activeElement;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      // engines without showModal: the open attribute + .modal--fallback CSS stand in
      dialog.setAttribute('open', '');
      dialog.classList.add('modal--fallback');
      if (typeof document !== 'undefined' && document.body) document.body.classList.add('modal-fallback-open');
    }
    const search = pickById(TICKER_IDS.search);
    // User-initiated focus (Tickers button / '+n' chip) only on a fine pointer; the
    // touch branch deliberately leaves the dialog's default focus alone.
    if (!isCoarsePointer() && search && typeof search.focus === 'function') search.focus();
  }
  /** True while the picker is open through the open-attribute fallback. */
  function tickerFallbackOpen() {
    const dialog = pickById(TICKER_IDS.dialog);
    return !!(dialog && typeof dialog.showModal !== 'function' && dialog.hasAttribute('open'));
  }
  /** Close the picker; native close() fires the close event, the fallback unwinds by hand. */
  function closeTickerList() {
    const dialog = pickById(TICKER_IDS.dialog);
    const native = !!dialog && typeof dialog.showModal === 'function' && typeof dialog.close === 'function';
    if (native && dialog.open) { dialog.close(); return; }
    if (dialog) {
      dialog.removeAttribute('open');
      dialog.classList.remove('modal--fallback');
      if (typeof document !== 'undefined' && document.body) document.body.classList.remove('modal-fallback-open');
    }
    restoreTickerFocus(); // without a real <dialog> the close event never fires
    renderTickerList();
  }
  function onTickerDialogClose() {
    renderTickerList();   // discards unapplied checkboxes: state is the source of truth
    restoreTickerFocus();
  }
  /** <dialog closedby="any"> handles Esc/backdrop natively — keep a fallback for older shells. */
  function onTickerDialogClick(e) {
    const dialog = e.currentTarget;
    if (!dialog || e.target !== dialog || typeof dialog.close !== 'function' || !dialog.getBoundingClientRect) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
    dialog.close(); // click landed on ::backdrop
  }

  // ------------------------------------------------ CSV export help (#csvHelpModal)

  let csvHelpReturnFocus = null;

  /** Open #csvHelpModal — same native/fallback contract as the ticker picker. */
  function openCsvHelp() {
    const dialog = byId('csvHelpModal');
    if (!dialog) return;
    if (typeof document !== 'undefined' && document.activeElement) csvHelpReturnFocus = document.activeElement;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      // engines without showModal: the open attribute + .modal--fallback CSS stand in
      dialog.setAttribute('open', '');
      dialog.classList.add('modal--fallback');
      if (typeof document !== 'undefined' && document.body) document.body.classList.add('modal-fallback-open');
    }
    // Native showModal() focuses the first control (the footer Close, at the
    // very bottom), which leaves the long help sheet scrolled to its end. Open
    // at the steps instead: reset the scroll and focus the title (tabindex="-1"
    // in index.html) rather than the Close button.
    dialog.scrollTop = 0;
    const title = byId('csvHelpTitle');
    if (title && typeof title.focus === 'function') title.focus();
  }
  /** True while #csvHelpModal is open through the open-attribute fallback. */
  function csvHelpFallbackOpen() {
    const dialog = byId('csvHelpModal');
    return !!(dialog && typeof dialog.showModal !== 'function' && dialog.hasAttribute('open'));
  }
  /** Close the help dialog; native close() fires the close event, the fallback unwinds by hand. */
  function closeCsvHelp() {
    const dialog = byId('csvHelpModal');
    const native = !!dialog && typeof dialog.showModal === 'function' && typeof dialog.close === 'function';
    if (native && dialog.open) { dialog.close(); return; }
    if (dialog) {
      dialog.removeAttribute('open');
      dialog.classList.remove('modal--fallback');
      if (typeof document !== 'undefined' && document.body) document.body.classList.remove('modal-fallback-open');
    }
    restoreCsvHelpFocus(); // without a real <dialog> the close event never fires
  }
  function onCsvHelpDialogClose() { restoreCsvHelpFocus(); }
  /** <dialog closedby="any"> handles Esc/backdrop natively — keep a fallback for older shells. */
  function onCsvHelpDialogClick(e) {
    const dialog = e.currentTarget;
    if (!dialog || e.target !== dialog || typeof dialog.close !== 'function' || !dialog.getBoundingClientRect) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
    dialog.close(); // click landed on ::backdrop
  }
  function restoreCsvHelpFocus() {
    const target = csvHelpReturnFocus || byId('csvHelpBtn');
    csvHelpReturnFocus = null;
    if (target && typeof target.focus === 'function') {
      try { target.focus(); } catch (err) { /* element detached */ }
    }
  }

  /**
   * Tab trap for shells that opened a dialog via the open attribute: wraps between
   * its first and last control. Native dialogs trap on their own, so this stays
   * idle whenever showModal exists. Shift+Tab from a focused non-control (the
   * tabindex="-1" help title) lands on the last control instead of the page behind.
   */
  function trapFallbackTab(dialog, e) {
    if (typeof document === 'undefined') return;
    const focusables = dialog && dialog.querySelectorAll
      ? dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
      : [];
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1], active = document.activeElement;
    const inside = !!(active && dialog.contains && dialog.contains(active));
    const idx = Array.prototype.indexOf.call(focusables, active);
    if (e.shiftKey && (idx <= 0 || !inside)) { e.preventDefault(); if (last.focus) last.focus(); }
    else if (!e.shiftKey && (idx === focusables.length - 1 || !inside)) { e.preventDefault(); if (first.focus) first.focus(); }
  }
  /**
   * Keyboard fallback for shells that opened a dialog via the open attribute:
   * Esc closes it and Tab wraps between its controls. Native dialogs handle both
   * themselves, so this stays idle whenever showModal exists.
   */
  function onDocumentKeydown(e) {
    const key = e.key;
    if (key === 'Escape') {
      setFilterNoteOpen(false); // collapse the expanded filter note (no-op when closed/absent)
      if (tickerFallbackOpen()) closeTickerList();
      if (csvHelpFallbackOpen()) closeCsvHelp();
      if (dailyPickerFallbackOpen()) closeDailyPicker();
      // A native #dailyPicker handles its own Esc: close it here too (focus return is
      // ours — not every engine fires the dialog close event), and stop, so dismissing
      // the picker never also clears the day selection behind it.
      const picker = byId('dailyPicker');
      if (picker && picker.open) { closeDailyPicker(); return; }
      // Esc also clears the Daily tab's cell selection (the grid handler refocuses the cell;
      // this covers the case where focus has already left the grid, e.g. after a mouse click)
      if (state.daily.sel) { state.daily.sel = null; renderDaily(state.months); }
      return;
    }
    if (key !== 'Tab') return;
    if (tickerFallbackOpen()) trapFallbackTab(pickById(TICKER_IDS.dialog), e);
    else if (csvHelpFallbackOpen()) trapFallbackTab(byId('csvHelpModal'), e);
    else if (dailyPickerFallbackOpen()) trapFallbackTab(byId('dailyPicker'), e);
  }

  /** Tab key for a button/panel: data-tab, aria-controls="tabX" or id="tabBtnX"/"tabX". */
  function tabKeyOf(el) {
    if (!el || !el.getAttribute) return '';
    const explicit = up(el.getAttribute('data-tab'));
    if (explicit) return explicit;
    const target = el.getAttribute('data-tab-panel') || el.getAttribute('aria-controls');
    if (target) return up(target).replace(/^TAB(?:BTN)?-?/, '').replace(/^PANEL-?/, '');
    return up(el.id).replace(/^TAB(?:BTN)?-?/, '').replace(/^PANEL-?/, '');
  }
  function tabNodes(selector) {
    if (typeof document === 'undefined' || !document.querySelectorAll) return [];
    const nodes = document.querySelectorAll(selector);
    const out = [], seen = new Set();
    for (let i = 0; i < nodes.length; i++) if (!seen.has(nodes[i])) { seen.add(nodes[i]); out.push(nodes[i]); }
    return out;
  }
  function tabButtons() { return tabNodes('[data-tab], .tab, [role="tab"]'); }
  /** Panels the shell may use for a tab: [data-tab-panel], .tabpanel/#tabX/#panel-x, aria-controls. */
  function tabPanels() {
    const map = new Map();
    for (const el of tabNodes('[data-tab-panel], .tabpanel, [role="tabpanel"]')) {
      const name = tabKeyOf(el);
      if (name && !map.has(name)) map.set(name, el);
    }
    for (const btn of tabButtons()) {
      const name = tabKeyOf(btn);
      if (!name || map.has(name)) continue;
      const controls = btn.getAttribute('aria-controls');
      const el = (controls ? byId(controls) : null) ||
        byId('tab-' + name.toLowerCase()) || byId('panel-' + name.toLowerCase());
      if (el && el !== btn) map.set(name, el);
    }
    return map;
  }
  /**
   * showTab('interest') — mirrors aria-selected/tabindex on every tab button, toggles the
   * matching panel's hidden attribute and (unless suppressHash) records #name in the URL.
   */
  function showTab(name, suppressHash) {
    const tab = up(String(name == null ? '' : name).replace(/^#/, ''));
    if (!tab) return;
    for (const btn of tabButtons()) {
      const active = tabKeyOf(btn) === tab;
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.setAttribute('tabindex', active ? '0' : '-1');
    }
    const panels = tabPanels();
    panels.forEach((el, panelName) => { el.hidden = panelName !== tab; });
    // The Interest card renders hidden until its tab opens, so its first pass could
    // not measure the .label font (display:none) and kept the static 56/100 budget.
    // Flush the freshly unhidden panel's layout, then re-render: the first
    // measurement of a never-laid-out subtree otherwise still reads 0.
    // Tab keys are uppercased by tabKeyOf(); compare case-insensitively.
    if (String(tab).toLowerCase() === 'interest' && state.months) {
      const panel = panels.get(tab);
      if (panel) void panel.offsetWidth; // forces style+layout so the probe can measure
      renderInterest(state.months);
    }
    if (!suppressHash && typeof history !== 'undefined' && history && history.replaceState && typeof location !== 'undefined') {
      const want = '#' + tab.toLowerCase();
      if (String(location.hash || '') !== want) history.replaceState(null, '', want);
    }
  }
  function hashTabName() {
    return typeof location === 'undefined' ? '' : String(location.hash || '').replace(/^#\/?/, '').replace(/^tab-/, '');
  }
  function onHashChange() { const name = hashTabName(); if (name) showTab(name, true); }

  /** Roving-tablist arrow keys (Left/Right/Home/End) — Enter/Space stay native. */
  function onTabsKeydown(e) {
    const key = e.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
    const target = e.target;
    if (!target || !target.closest) return;
    const btn = target.closest('[role="tab"]');
    if (!btn) return;
    const tabs = tabButtons();
    if (tabs.length < 2) return;
    const at = tabs.indexOf(btn);
    if (at < 0) return;
    const next = key === 'Home' ? 0 : key === 'End' ? tabs.length - 1
      : (at + (key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault(); // arrows must not scroll the page
    showTab(tabKeyOf(tabs[next]), false);
    if (typeof tabs[next].focus === 'function') tabs[next].focus();
  }

  /** Document-level delegation: tab buttons, ticker-picker openers and the filter note. */
  function onDocumentClick(e) {
    const target = e.target;
    if (!target || !target.closest) return;
    // #filterNote: its own click listener toggles, so any click that reaches the document
    // (i.e. anywhere outside the note) collapses an expanded note.
    if (filterNoteOpen() && !target.closest(filterNoteSelector())) setFilterNoteOpen(false);
    const tabBtn = target.closest('[data-tab], .tab, [role="tab"]');
    if (tabBtn) { showTab(tabKeyOf(tabBtn), false); return; }
    const openerSelector = '[data-open-tickers], ' + TICKER_IDS.openers.map(id => '#' + id).join(', ');
    if (target.closest(openerSelector)) { openTickerList(); return; }
    // help opener: handled here (like the ticker openers) so the fallback-dialog
    // dismissal below never sees the opening click as an outside click. Both the
    // toolbar "i" and the hero subtitle "i" open the same #csvHelpModal.
    if (target.closest('#csvHelpBtn, #heroCsvInfo')) { openCsvHelp(); return; }
    // daily picker opener — same early-return contract as the help opener above
    if (target.closest('#dailyPickerBtn')) { openDailyPicker(); return; }
    // fallback dialogs: a click anywhere outside an open one dismisses it
    if (tickerFallbackOpen() && !target.closest('.modal--fallback')) closeTickerList();
    if (csvHelpFallbackOpen() && !target.closest('.modal--fallback')) closeCsvHelp();
    if (dailyPickerFallbackOpen() && !target.closest('.modal--fallback')) closeDailyPicker();
  }

  // ------------------------------------------------------------ listeners

  function onFileChange(e) { readFiles(e.target && e.target.files); }
  function onDrop(e) {
    e.preventDefault(); e.stopPropagation();
    if (e.currentTarget) e.currentTarget.classList.remove('is-dragover');
    readFiles(e.dataTransfer && e.dataTransfer.files);
  }
  function onDragOver(e) {
    e.preventDefault(); e.stopPropagation();
    if (e.currentTarget) e.currentTarget.classList.add('is-dragover');
  }
  function onDragLeave(e) { if (e.currentTarget) e.currentTarget.classList.remove('is-dragover'); }
  function onZoneClick() {
    const input = byId('fileInput');
    const zone = byId('dropZone');
    if (input && !(zone && zone.contains(input))) input.click();
  }
  function onYearChange(e) {
    state.year = e.target.value || 'all';
    renderAll();
  }
  function onChipClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('button[data-month]') : null;
    if (!btn) return;
    state.month = btn.getAttribute('data-month') || 'all';
    if (state.month !== 'all' && state.year === 'all') {
      const match = Object.keys(state.months).filter(k => k.slice(5, 7) === state.month).sort().pop();
      if (match) state.year = match.slice(0, 4);
    }
    renderAll();
  }
  function onRowClick(e) {
    const row = e.target && e.target.closest ? e.target.closest('tr[data-month]') : null;
    if (!row) return;
    const key = row.getAttribute('data-month');
    if (/^\d{4}-\d{2}$/.test(key)) { state.year = key.slice(0, 4); state.month = key.slice(5, 7); }
    renderAll();
  }
  /** Months the rendered aggregate has in the active year filter ('all' → null). */
  function yearMonthKeys() {
    if (!state.year || state.year === 'all') return null;
    return Object.keys(state.months).filter(k => k.slice(0, 4) === state.year).sort();
  }
  /** Clamp a 'yyyy-MM' into the active year: outside it, jump to that year's latest month. */
  function clampDailyYm(ym) {
    const keys = yearMonthKeys();
    if (!keys || !keys.length || ym.slice(0, 4) === state.year) return ym;
    return keys[keys.length - 1];
  }
  /** Daily tab navigation: swap the shown month (or snap to today's) and re-render just the calendar. */
  function dailyGoTo(ym) {
    state.daily.ym = clampDailyYm(ym);
    state.daily.sel = null;
    renderDaily(state.months);
  }
  /** ‹ / › walk one month, but stop at the active year's bounds (no cross-year walk). */
  function dailyStep(delta) {
    const next = shiftMonth(state.daily.ym || currentYm(), delta);
    if (state.year && state.year !== 'all' && next.slice(0, 4) !== state.year) return;
    dailyGoTo(next);
  }
  function onDailyPrev() { dailyStep(-1); }
  function onDailyNext() { dailyStep(1); }
  function onDailyToday() { dailyGoTo(currentYm()); } // clampDailyYm handles the year filter

  // ----------------------------------------- daily month/year picker (#dailyPicker)

  let dailyPickerReturnFocus = null;

  /** Every 'yyyy-MM' the loaded file has (state.months is the unfiltered aggregate). */
  function dailyMonthKeys() { return Object.keys(state.months || {}).filter(k => /^\d{4}-\d{2}$/.test(k)).sort(); }

  /** Years present in the data, ascending. */
  function dailyYears() { return Array.from(new Set(dailyMonthKeys().map(k => k.slice(0, 4)))); }

  /**
   * Fill the picker's selects from the loaded data, preselecting the shown month.
   * Year options are clamped to the global year filter while one is active (the
   * select pins to it and is disabled, so a jump can never ask for another year);
   * with *All years* the list also carries an "All years" entry — that jumps to the
   * latest year on record holding the chosen month.
   */
  function renderDailyPicker() {
    const yearSel = byId('dailyPickerYear');
    const monthSel = byId('dailyPickerMonth');
    const shown = state.daily.ym && /^\d{4}-\d{2}$/.test(state.daily.ym) ? state.daily.ym : currentYm();
    const years = dailyYears();
    const yearActive = !!state.year && state.year !== 'all';
    if (yearSel) {
      const list = yearActive ? [state.year] : years;
      yearSel.innerHTML = (yearActive ? '' : '<option value="all">All years</option>') +
        list.map(y => `<option value="${esc(y)}">${esc(y)}</option>`).join('');
      yearSel.value = yearActive ? state.year
        : list.indexOf(shown.slice(0, 4)) >= 0 ? shown.slice(0, 4)
          : list.length ? list[list.length - 1] : 'all';
      yearSel.disabled = yearActive; // pinned by the global filter — the clamp is the contract
    }
    if (monthSel) {
      monthSel.innerHTML = MONTH_NAMES
        .map((m, i) => `<option value="${String(i + 1).padStart(2, '0')}">${m}</option>`).join('');
      monthSel.value = shown.slice(5, 7);
    }
  }

  /**
   * Picker year + month -> 'yyyy-MM'. 'all' means "the latest year on record that has
   * this month" (falling back to the latest year, then the current one).
   */
  function pickerYm(yearValue, month) {
    let year = yearValue;
    if (year === 'all') {
      const keys = dailyMonthKeys();
      const withMonth = keys.filter(k => k.slice(5, 7) === month).map(k => k.slice(0, 4));
      year = withMonth.length ? withMonth[withMonth.length - 1]
        : keys.length ? keys[keys.length - 1].slice(0, 4)
          : currentYm().slice(0, 4);
    }
    return year + '-' + month;
  }

  /**
   * Open the picker: refresh the selects, show the dialog, focus the dialog itself.
   * Never the Year <select>: a focused select pops the iOS wheel and can jump the page.
   * #dailyPicker carries tabindex="-1" for this; Tab from the dialog reaches Year, then Month.
   */
  function openDailyPicker() {
    const dialog = byId('dailyPicker');
    if (!dialog) return;
    renderDailyPicker();
    if (typeof document !== 'undefined' && document.activeElement) dailyPickerReturnFocus = document.activeElement;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      // engines without showModal: the open attribute + .modal--fallback CSS stand in
      dialog.setAttribute('open', '');
      dialog.classList.add('modal--fallback');
      if (typeof document !== 'undefined' && document.body) document.body.classList.add('modal-fallback-open');
    }
    if (typeof dialog.focus === 'function') dialog.focus();
  }

  /** True while #dailyPicker is open through the open-attribute fallback. */
  function dailyPickerFallbackOpen() {
    const dialog = byId('dailyPicker');
    return !!(dialog && typeof dialog.showModal !== 'function' && dialog.hasAttribute('open'));
  }

  /**
   * Close the picker. The native path calls the UA close() and still restores focus
   * itself, deferred by a task: some engines swallow the dialog close event entirely
   * (and the UA's own restoration lands on <body> when the pre-modal element was
   * re-rendered away), so the opener focus can't depend on the event alone. The
   * fallback path unwinds the open attribute by hand.
   */
  function closeDailyPicker() {
    const dialog = byId('dailyPicker');
    const native = !!dialog && typeof dialog.showModal === 'function' && typeof dialog.close === 'function';
    if (native && dialog.open) { dialog.close(); restoreDailyPickerFocus(); return; }
    if (dialog) {
      dialog.removeAttribute('open');
      dialog.classList.remove('modal--fallback');
      if (typeof document !== 'undefined' && document.body) document.body.classList.remove('modal-fallback-open');
    }
    restoreDailyPickerFocus(); // without a real <dialog> the close event never fires
  }

  /**
   * Focus returns to #dailyPickerBtn (the dialog's only opener). Deferred by a
   * task: the UA's own dialog-close focus restoration can land on <body> when
   * the element that had focus before showModal() was re-rendered away (e.g. the
   * calendar cell the jump replaced), so ours must run after it.
   */
  function restoreDailyPickerFocus() {
    const target = byId('dailyPickerBtn') || dailyPickerReturnFocus;
    dailyPickerReturnFocus = null;
    if (!target || typeof target.focus !== 'function') return;
    const focusIt = () => {
      try { target.focus(); } catch (err) { /* element detached */ }
    };
    if (typeof setTimeout === 'function') setTimeout(focusIt, 0);
    else focusIt();
  }
  function onDailyPickerClose() { restoreDailyPickerFocus(); }
  /** <dialog closedby="any"> handles Esc/backdrop natively — keep a fallback for older shells. */
  function onDailyPickerClick(e) {
    const dialog = e.currentTarget;
    if (!dialog || e.target !== dialog || typeof dialog.close !== 'function' || !dialog.getBoundingClientRect) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
    dialog.close(); // click landed on ::backdrop
  }
  /** Go: jump to the picked year+month (dailyGoTo clamps, clears the selection, re-renders). */
  function onDailyPickerGo() {
    const yearSel = byId('dailyPickerYear');
    const monthSel = byId('dailyPickerMonth');
    const shown = state.daily.ym && /^\d{4}-\d{2}$/.test(state.daily.ym) ? state.daily.ym : currentYm();
    const month = monthSel && monthSel.value ? monthSel.value : shown.slice(5, 7);
    const year = yearSel && yearSel.value ? yearSel.value : shown.slice(0, 4);
    dailyGoTo(pickerYm(year, month));
    closeDailyPicker();
  }

  /** Cell click / Enter: toggle the white selection ring (Escape clears it). */
  function onDailyCellClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('#dailyGrid .cal-cell[data-day]') : null;
    if (!btn) return;
    const key = btn.getAttribute('data-day');
    state.daily.sel = state.daily.sel === key ? null : key;
    renderDaily(state.months);
    // Re-render replaces the button, which would drop keyboard focus to <body> —
    // hand it back to the same day so arrows keep walking from there and Esc still lands on a cell.
    // preventScroll: the refocus must never chase the cell (touch browsers scroll a
    // freshly focused control into view); the phone scroll below owns the viewport.
    const again = byId('dailyGrid') && byId('dailyGrid').querySelector('.cal-cell[data-day="' + key + '"]');
    if (again && typeof again.focus === 'function') again.focus({ preventScroll: true });
    // Every viewport: bring the opened detail card under the sticky toolbar (its
    // scroll-margin-top reserves the band). Keyboard focus already sits on the cell.
    const detail = byId('dailyDetail');
    if (state.daily.sel && detail && !detail.hidden) {
      scrollIntoViewSoft(detail, 'start');
    }
  }
  /**
   * #dailyDetailTop ("Back to calendar", all viewports): return to the calendar card —
   * focus the selected cell without scrolling, then bring #dailyCard under the sticky toolbar.
   */
  function onDailyDetailTop() {
    const grid = byId('dailyGrid');
    const cell = grid && state.daily.sel ? grid.querySelector('.cal-cell--sel[data-day]') : null;
    if (cell && typeof cell.focus === 'function') cell.focus({ preventScroll: true });
    scrollIntoViewSoft(byId('dailyCard'), 'start');
  }
  /** Arrow keys walk the grid (7 = one week); Escape clears the selection and refocuses the cell. */
  function onDailyGridKeydown(e) {
    const key = e.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Escape') return;
    const target = e.target;
    const grid = byId('dailyGrid');
    if (!grid || !target || !target.closest) return;
    const cell = target.closest('.cal-cell[data-day]');
    if (!cell) return;
    if (key === 'Escape') {
      if (!state.daily.sel) return;
      const day = cell.getAttribute('data-day');
      state.daily.sel = null;
      renderDaily(state.months);
      const again = grid.querySelector('.cal-cell[data-day="' + day + '"]');
      if (again && typeof again.focus === 'function') again.focus();
      return;
    }
    const cells = Array.prototype.slice.call(grid.querySelectorAll('.cal-cell[data-day]'));
    const at = cells.indexOf(cell);
    const step = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : key === 'ArrowUp' ? -7 : 7;
    const next = at < 0 ? null : cells[at + step];
    e.preventDefault(); // arrows must not scroll the page, even at a grid edge
    if (!next) return;
    if (typeof next.focus === 'function') next.focus();
  }
  function onChartMove(e) {
    const t = tipTarget(e);
    if (t) showTipFor(t); else hideTip();
  }
  function onChartFocus(e) { const t = tipTarget(e); if (t) showTipFor(t); }
  function onBreakdownMove(e) {
    const t = tipTarget(e);
    if (t) showTipFor(t); else hideBreakdownTip();
  }
  function onBreakdownFocus(e) { const t = tipTarget(e); if (t) showTipFor(t); }
  function onInterestMove(e) {
    const t = tipTarget(e);
    if (t) showTipFor(t); else hideInterestTip();
  }
  function onInterestFocus(e) { const t = tipTarget(e); if (t) showTipFor(t); }
  /** #currencySelect change: render with the rates already held, then fetch a missing one. */
  function onCurrencyChange() {
    const cur = currencyMode();
    renderAll();
    if (cur !== 'usd' && !(Number(state.fx && state.fx.rates && state.fx.rates[cur]) > 0)) resolveFxOnLoad();
  }
  function onIncludeChipsClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('#includeChips button[data-ticker]') : null;
    if (!btn) return;
    const sym = up(btn.getAttribute('data-ticker'));
    if (!sym) return;
    const list = getInclude();
    const at = list.indexOf(sym);
    if (at >= 0) list.splice(at, 1);
    setInclude(list);
  }
  // ---------------------------------------------------------------- theme

  /**
   * Stored theme mode: 'light' | 'dark' | 'system'. Anything else — including
   * no stored value — is 'system' (follow the OS, the markup default).
   */
  function readThemeMode() {
    const raw = lsGet(THEME_KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  }

  /** OS dark preference, guarded for engines/tests without matchMedia. */
  function systemPrefersDark() {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches === true;
    } catch (err) { return false; }
  }

  /** The live (prefers-color-scheme: dark) query while the mode is 'system'. */
  let themeMq = null;

  /** Subscribe/unsubscribe onSystemThemeChange, covering legacy MediaQueryList.addListener. */
  function listenThemeMq(current, on) {
    if (!current) return;
    if (on && typeof current.addEventListener === 'function') current.addEventListener('change', onSystemThemeChange);
    else if (on && typeof current.addListener === 'function') current.addListener(onSystemThemeChange);
    else if (!on && typeof current.removeEventListener === 'function') current.removeEventListener('change', onSystemThemeChange);
    else if (!on && typeof current.removeListener === 'function') current.removeListener(onSystemThemeChange);
  }

  /** #themeCycle click order: each press moves one step right, wrapping back to light. */
  const THEME_CYCLE = ['light', 'dark', 'system'];

  /** The mode currently applied; applyTheme keeps it in step so a cycle starts from what's on screen. */
  let activeThemeMode = 'system';

  /**
   * Point #themeCycle at the applied mode: [data-mode] is what styles.css keys the visible
   * sun/moon/monitor glyph off, and title/aria-label name the mode for pointer/AT users.
   * Null-safe: a shell without the button (or an older one) is simply skipped.
   */
  function syncThemeCycle(mode) {
    const btn = byId('themeCycle');
    if (!btn) return;
    if (typeof btn.setAttribute === 'function') btn.setAttribute('data-mode', mode);
    const label = 'Theme: ' + (mode === 'light' ? 'Light' : mode === 'dark' ? 'Dark' : 'System');
    btn.title = label;
    if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-label', label);
  }

  /**
   * Apply 'light' | 'dark' | 'system': 'system' resolves against the OS, the
   * resolution is stamped as [data-theme] on <html> (styles.css's token switch),
   * the meta theme-color follows the resolved background, the cycle button syncs and the
   * matchMedia subscription exists only while the mode is 'system' — an OS flip
   * then repaints live via onSystemThemeChange. The inline boot script in
   * index.html mirrors this resolution before the stylesheet paints, so a stored
   * dark reload never flashes light. Persisting the pick is onThemeCycle's job;
   * this function is also the restore/console entry point (window.IBKR.applyTheme).
   */
  function applyTheme(mode) {
    const wanted = mode === 'light' || mode === 'dark' ? mode : 'system';
    const dark = wanted === 'dark' || (wanted === 'system' && systemPrefersDark());
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    }
    if (typeof document !== 'undefined' && document.querySelector) {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', dark ? '#0F1419' : '#F7FAFC');
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      if (wanted !== 'system' && themeMq) { listenThemeMq(themeMq, false); themeMq = null; }
      if (wanted === 'system' && !themeMq) {
        themeMq = window.matchMedia('(prefers-color-scheme: dark)');
        listenThemeMq(themeMq, true);
      }
    }
    activeThemeMode = wanted;
    syncThemeCycle(wanted);
  }

  /** OS light/dark flip while the mode is 'system' — repaint immediately. */
  function onSystemThemeChange() {
    if (readThemeMode() === 'system') applyTheme('system');
  }

  /**
   * #themeCycle click — advance Light → Dark → System → Light, persist the pick, then apply
   * it live. The matchMedia listener follows automatically: applyTheme subscribes only while
   * the new mode is 'system'. Keyboard needs no extra handler: a <button> fires click for
   * Enter and Space natively.
   */
  function onThemeCycle() {
    const from = THEME_CYCLE.indexOf(activeThemeMode);
    const next = THEME_CYCLE[(from + 1) % THEME_CYCLE.length];
    lsSet(THEME_KEY, next); // 'system' is stored explicitly: it is a real choice, not an absence
    applyTheme(next);
  }

  // ------------------------------------------------------------ toolbar fold

  /**
   * Mobile toolbar fold — #toolbarToggle flips .toolbar.is-collapsed, which
   * styles.css honours below 620px by hiding every .toolbar__inner child but
   * the toggle (the sticky band shrinks to one 32px row). Expanding is the
   * layout change that matters: the wider row is re-measured for the "+n" chip
   * count (its clip depends on the laid-out width) and for the popover clamps.
   * Restore and the Tickers ↑ shortcut call this directly and never write
   * storage — only onToolbarToggle persists the user's fold.
   */
  function applyToolbarCollapsed(collapsed) {
    const toolbar = byId('toolbar');
    const toggle = byId('toolbarToggle');
    const fold = collapsed === true;
    if (toolbar && toolbar.classList) toolbar.classList.toggle('is-collapsed', fold);
    if (toggle && typeof toggle.setAttribute === 'function') {
      toggle.setAttribute('aria-expanded', fold ? 'false' : 'true');
    }
    if (!fold) {
      measureIncludeOverflow(); // hidden while folded, so refresh the clip after unfolding
      replacePopovers();
    }
  }

  /** #toolbarToggle click — flip the fold, persisting it ('1' folded; key gone while open). */
  function onToolbarToggle() {
    const toolbar = byId('toolbar');
    const collapsed = !(toolbar && toolbar.classList && toolbar.classList.contains('is-collapsed'));
    applyToolbarCollapsed(collapsed);
    if (collapsed) lsSet(TOOLBAR_KEY, '1');
    else lsRemove(TOOLBAR_KEY);
  }

  // ---------------------------------------------------------- install prompt

  /** Chromium's captured beforeinstallprompt (single-use); null once spent/hidden. */
  let installEvent = null;
  /**
   * PWA install affordance. Chromium fires beforeinstallprompt once the shell
   * qualifies (http(s) + manifest + an active service worker): the event is stashed,
   * its mini-infobar suppressed, and #installBtn revealed. A click hands the stashed
   * event to prompt() exactly once; userChoice — or appinstalled — retires the button.
   * Browsers that never fire the event (Safari/iOS) keep it hidden, since the shell
   * ships it with [hidden].
   */
  function setInstallBtnHidden(hidden) {
    const btn = byId('installBtn');
    if (btn) btn.hidden = hidden === true;
  }
  function onBeforeInstallPrompt(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    installEvent = e || null;
    setInstallBtnHidden(!installEvent);
  }
  function onInstallClick() {
    const ev = installEvent;
    installEvent = null; // single-use: a second click can never prompt twice
    if (!ev) { setInstallBtnHidden(true); return; }
    let choice = null;
    try {
      if (typeof ev.prompt === 'function') ev.prompt();
      choice = ev.userChoice || null;
    } catch (err) { choice = null; } // prompt() throws when the event was already used
    const retire = function () { setInstallBtnHidden(true); };
    if (choice && typeof choice.then === 'function') choice.then(retire, retire);
    else retire();
  }
  function onAppInstalled() {
    installEvent = null;
    setInstallBtnHidden(true);
  }

  function wire() {
    listen(byId('fileInput'), 'change', onFileChange);
    listen(byId('dropZone'), 'dragover', onDragOver);
    listen(byId('dropZone'), 'dragenter', onDragOver);
    listen(byId('dropZone'), 'dragleave', onDragLeave);
    listen(byId('dropZone'), 'drop', onDrop);
    listen(byId('dropZone'), 'click', onZoneClick);
    listen(byId('clearBtn'), 'click', clearAll);
    listen(byId('toolbarToggle'), 'click', onToolbarToggle);
    // theme cycle button applies live (the inline boot script painted the stored pick already);
    // Enter/Space need no handler — a real <button> fires click for both natively
    listen(byId('themeCycle'), 'click', onThemeCycle);
    // filter note tap-to-expand (the <p role="button"> gets no synthetic click, so keys are handled)
    listen(pickById(TICKER_IDS.note), 'click', onFilterNoteClick);
    listen(pickById(TICKER_IDS.note), 'keydown', onFilterNoteKeydown);
    // PWA install affordance (Chromium only; the button stays hidden elsewhere)
    listen(byId('installBtn'), 'click', onInstallClick);
    if (typeof window !== 'undefined') {
      listen(window, 'beforeinstallprompt', onBeforeInstallPrompt);
      listen(window, 'appinstalled', onAppInstalled);
    }
    listen(byId('yearSelect'), 'change', onYearChange);
    listen(byId('monthChips'), 'click', onChipClick);
    listen(byId('monthlyBody'), 'click', onRowClick);
    // daily calendar: nav buttons + the delegated grid (click selects, arrows move, Esc clears)
    listen(byId('dailyPrev'), 'click', onDailyPrev);
    listen(byId('dailyNext'), 'click', onDailyNext);
    listen(byId('dailyToday'), 'click', onDailyToday);
    // month/year picker: the opener is delegated in onDocumentClick (next to the ticker
    // and help openers); the dialog's own controls are bound here
    listen(byId('dailyPickerGo'), 'click', onDailyPickerGo);
    listen(byId('dailyPickerClose'), 'click', closeDailyPicker);
    const dailyPicker = byId('dailyPicker');
    if (dailyPicker) {
      listen(dailyPicker, 'close', onDailyPickerClose);
      listen(dailyPicker, 'click', onDailyPickerClick);
    }
    listen(byId('dailyGrid'), 'click', onDailyCellClick);
    listen(byId('dailyGrid'), 'keydown', onDailyGridKeydown);
    listen(byId('dailyDetailTop'), 'click', onDailyDetailTop);
    // interest rows carry data-month too: the same click selects the month
    listen(pickById(['interestBody', 'interestTableBody']), 'click', onRowClick);
    listen(byId('postedToggle'), 'change', renderAll);
    // global asset-class filter radios (#assetToggle) apply live, unlike the pending row controls
    listen(pickById(TICKER_IDS.asset), 'change', onAssetToggleChange);
    // reveal-time edge clamp for the card/footer/legend/hero popovers
    listen(byId('basisInfo'), 'mouseenter', placeBasisTip);
    listen(byId('basisInfo'), 'focusin', placeBasisTip);
    // hero subtitle "i": same .info/.info-tip pair, clamped on reveal
    listen(byId('heroCsvInfo'), 'mouseenter', placeHeroCsvTip);
    listen(byId('heroCsvInfo'), 'focusin', placeHeroCsvTip);
    // legend popover: same clamp-on-reveal pattern as #basisInfo
    listen(byId('incomeInfo'), 'mouseenter', placeIncomeTip);
    listen(byId('incomeInfo'), 'focusin', placeIncomeTip);
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      listen(byId('currencySelect'), 'change', onCurrencyChange);
    }
    listen(byId('chartSvg'), 'mousemove', onChartMove);
    listen(byId('chartSvg'), 'mouseleave', hideTip);
    listen(byId('chartSvg'), 'focusin', onChartFocus);
    listen(byId('chartSvg'), 'focusout', hideTip);
    listen(byId('breakdownSvg'), 'mousemove', onBreakdownMove);
    listen(byId('breakdownSvg'), 'mouseleave', hideBreakdownTip);
    listen(byId('breakdownSvg'), 'focusin', onBreakdownFocus);
    listen(byId('breakdownSvg'), 'focusout', hideBreakdownTip);
    listen(byId('interestSvg'), 'mousemove', onInterestMove);
    listen(byId('interestSvg'), 'mouseleave', hideInterestTip);
    listen(byId('interestSvg'), 'focusin', onInterestFocus);
    listen(byId('interestSvg'), 'focusout', hideInterestTip);
    listen(byId('includeChips'), 'click', onIncludeChipsClick);
    // both Tickers ↑ shortcuts (#toTopTickers + #tickersToTop) — bind every id in
    // the alias list, not just the first present one (pickById would skip the second)
    for (const toTopId of TICKER_IDS.toTop) listen(byId(toTopId), 'click', onToTopTickers);
    listen(pickById(TICKER_IDS.search), 'input', filterTickerList);
    listen(pickById(TICKER_IDS.searchClear), 'click', onSearchClear);
    listen(pickById(TICKER_IDS.body), 'change', onTickerListChange);
    listen(pickById(TICKER_IDS.apply), 'click', applyTickerList);
    listen(pickById(TICKER_IDS.clear), 'click', clearTickerList);
    listen(pickById(TICKER_IDS.close), 'click', closeTickerList);
    const tickerDialog = pickById(TICKER_IDS.dialog);
    if (tickerDialog) {
      listen(tickerDialog, 'close', onTickerDialogClose);
      listen(tickerDialog, 'click', onTickerDialogClick);
    }
    // CSV export help — same dialog wiring as the ticker picker (#csvHelpBtn's
    // opener is delegated in onDocumentClick, next to the ticker openers)
    listen(byId('csvHelpClose'), 'click', closeCsvHelp);
    const csvHelpDialog = byId('csvHelpModal');
    if (csvHelpDialog) {
      listen(csvHelpDialog, 'close', onCsvHelpDialogClose);
      listen(csvHelpDialog, 'click', onCsvHelpDialogClick);
    }
    if (typeof document !== 'undefined') {
      listen(document, 'click', onDocumentClick);
      listen(document, 'keydown', onDocumentKeydown);
      listen(document, 'keydown', onTabsKeydown);
    }
    if (typeof window !== 'undefined') listen(window, 'hashchange', onHashChange);
    onHashChange(); // deep link (#interest, …) selects a tab on load
    listen(byId('fxBadge'), 'mouseenter', placeFxDetail);
    listen(byId('fxBadge'), 'focusin', placeFxDetail);
    // remeasure all four popovers on viewport changes (idempotent; hidden ones re-anchor)
    if (typeof window !== 'undefined') listen(window, 'resize', replacePopovers);
    // the toolbar's width decides how many chips the fixed cluster fits — keep the
    // "+n" #includeMore count (and the clip) in step with it
    if (typeof window !== 'undefined') listen(window, 'resize', measureIncludeOverflow);
    // restore the mobile fold from storage (class + aria only; never persisted here)
    applyToolbarCollapsed(lsGet(TOOLBAR_KEY) === '1');
    // theme: the inline boot script already painted the stored pick; re-apply it to
    // sync the cycle button's data-mode/meta theme-color and attach the matchMedia
    // listener while the mode is 'system' (an OS flip then repaints without a reload)
    applyTheme(readThemeMode());
    const label = byId('fileLabel');
    if (label && !label.textContent.trim() && !hasData()) setFileLabel([]);
  }

  function init() {
    if (typeof document === 'undefined') return;
    wire();
    restore();
    renderAll();
    if (hasData()) resolveFxOnLoad(); // only reach for the network when there is something to convert
    if (typeof window !== 'undefined' && !byId('fileInput') && document.readyState !== 'complete') {
      window.addEventListener('load', function () {
        wire(); restore(); renderAll();
        if (hasData()) resolveFxOnLoad();
      });
    }
  }

  return {
    parseCsv, detectFormat, parseFlex, parseActivityStatement, parseCsvText,
    aggregateByMonth, classify, cashCategory, isAssignmentCode, monthKey, monthLabel, rootOf,
    dayKey, aggregateByDay, renderDaily, renderDailyDetail, dayLabel,
    pickerYm, openDailyPicker,
    tradePasses, prepareTradeFilter, normalizeScope, scopeLabel,
    fmtMoney, fmtCompact, disp, currencyMode, currencySymbol, init, loadText, clearAll, renderAll, renderBreakdown, incomeOf, incomeTipText, state,
    getExclude, setExclude, getInclude, setInclude,
    getIncludeScope, setIncludeScope, getExcludeScope, setExcludeScope,
    getAssetFilter, setAssetFilter,
    applyTheme,
    monthTipText, barTipText, renderInterest, rankedRoots,
    renderTickerList, applyTickerList, clearTickerList, openTickerList, closeTickerList, showTab,
    openCsvHelp, closeCsvHelp,
    fx: { keys: FX_KEYS, baked: FX_BAKED_RATES, currencies: FX_CURRENCIES.slice(), fetchFx, resolveFxOnLoad, render: renderFxRate }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = IBKR;
if (typeof window !== 'undefined') window.IBKR = IBKR;
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', IBKR.init);
  else IBKR.init();
}