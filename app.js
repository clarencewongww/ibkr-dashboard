'use strict';

/*
 * app.js — IBKR dashboard: CSV parser, aggregator and UI wiring.
 *
 * Supports both export shapes:
 *   - Flex Query CSV  — HEADER/DATA rows with section codes (TRNT, CTRN, IACC, ...)
 *   - Activity Statement CSV — Section,Kind,... rows (Trades / Dividends / ...)
 *
 * Zero dependencies; works from file:// via FileReader + localStorage. The only network
 * calls are the optional USD/AUD rate lookups (cached; a baked rate covers offline use).
 * Every DOM lookup is optional, so the script survives if the shell HTML is missing.
 *
 * DOM contract (see index.html): fileInput dropZone yearSelect monthChips kpiNet
 * kpiMonth kpiBest kpiAvg chartSvg chartTip breakdownSvg breakdownTip monthlyBody
 * drillBody drillTitle emptyState errorBox clearBtn postedToggle fileLabel,
 * excludeInput excludeChips fxBadge fxInput fxReset, plus the optional
 * input[name="currencyToggle"] USD/AUD switch.
 *
 * Browser: window.IBKR = { state, aggregateByMonth, renderAll, ... }.
 * Node (tests): module.exports.
 */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CACHE_KEY = 'ibkr-v1';
const CACHE_MAX_BYTES = 2 * 1024 * 1024; // bigger raw files are parsed but not cached
const EXCLUDE_KEY = 'ibkr-exclude-v1';   // persisted root-symbol exclude list
const FX_KEYS = { cache: 'fx-audusd-v1', override: 'fx_override' };
const FX_TTL_MS = 12 * 60 * 60 * 1000;   // fresh-cache window for the FX rate
const FX_TIMEOUT_MS = 5000;              // per-provider request timeout
const FX_BAKED_RATE = 1.423;             // offline USD->AUD approximation
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
  function ymd(value) {
    const m = /^(\d{4})[-/.](\d{2})[-/.](\d{2})/.exec(String(value == null ? '' : value).trim());
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function monthLabel(key) {
    const n = +String(key).slice(5, 7);
    return MONTH_NAMES[n - 1] ? MONTH_NAMES[n - 1] + ' ' + String(key).slice(0, 4) : String(key);
  }
  /** 1 while displaying USD; state.fx.rate while displaying AUD. */
  function fxRateFor(currency) {
    if (currency !== 'aud') return 1;
    const rate = Number(state.fx && state.fx.rate);
    return isFinite(rate) && rate > 0 ? rate : 1;
  }
  /** Raw USD amount -> amount in the active display currency. */
  function disp(value) {
    return (Number(value) || 0) * fxRateFor(currencyMode());
  }
  /** fmtMoney(value[, 'usd'|'aud']) — value is always raw USD; currency defaults to the active mode. */
  function fmtMoney(value, currency) {
    const cur = currency === 'aud' || currency === 'usd' ? currency : currencyMode();
    const v = (Number(value) || 0) * fxRateFor(cur);
    return (v < 0 ? '-' : '') + (cur === 'aud' ? 'A$' : '$') +
      Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtCompact(value, currency) {
    const cur = currency === 'aud' || currency === 'usd' ? currency : currencyMode();
    const n = (Number(value) || 0) * fxRateFor(cur);
    const a = Math.abs(n), sym = cur === 'aud' ? 'A$' : '$';
    if (a >= 1000) return (n < 0 ? '-' : '') + sym + (a / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k';
    if (a === 0) return sym + '0';
    return (n < 0 ? '-' : '') + sym + Math.round(a);
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

  function emptyMonth() {
    return { options: 0, assign: 0, otherStock: 0, otherStockCount: 0, interest: 0, dividends: 0, withholding: 0, fees: 0, count: 0, wins: 0, flat: 0, total: 0 };
  }

  /**
   * Aggregate trades + cash into { 'yyyy-MM': buckets }. Amounts stay raw USD (display converts).
   * interestMode 'accrual' replaces posted cash interest with the Interest Accruals (IACC) split.
   * opts.exclude (array of root symbols, default []) hides matching trades; cash rows are only
   * filtered when they carry an explicit symbol.
   */
  function aggregateByMonth(trades, cash, options) {
    const months = {};
    const bucket = key => months[key] || (months[key] = emptyMonth());
    const opts = options || {};
    const useAccrual = opts.interestMode === 'accrual' && opts.accruals && opts.accruals.length > 0;
    const excludeParts = Array.isArray(opts.exclude) ? opts.exclude : String(opts.exclude == null ? '' : opts.exclude).split(/[,;]+/);
    const exclude = new Set(excludeParts.map(up).filter(Boolean));
    const isExcluded = symbol => exclude.size > 0 && exclude.has(rootOf(symbol));

    for (const t of trades || []) {
      if (isExcluded(t.symbol)) continue;
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
      if (isExcluded(c.symbol)) continue; // ticker-less cash descriptions are never filtered
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

  // ------------------------------------------------------------- UI state

  const state = {
    trades: [], cash: [], accruals: [], months: {}, year: 'all', month: 'all', name: '', format: '',
    exclude: [],                 // root symbols skipped during aggregation (persisted)
    currency: 'usd',             // fallback when no currencyToggle input exists
    fx: { rate: 1, fetchedAt: 0, source: 'usd', date: '' }
  };
  const boundEvents = new WeakMap();
  let restoreTried = false;

  const byId = id => (typeof document === 'undefined' ? null : document.getElementById(id));
  const hasData = () => state.trades.length > 0 || state.cash.length > 0;
  function setText(id, text) { const el = byId(id); if (el) el.textContent = text; }
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
  function setFileLabel(name) {
    const el = byId('fileLabel');
    if (!el) return;
    el.textContent = name;
    el.title = name;
  }
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
  /** 'aud' when the toggle says so (or state.currency does), otherwise 'usd'. */
  function currencyMode() {
    if (typeof document !== 'undefined' && document.querySelector) {
      const checked = document.querySelector('input[name="currencyToggle"]:checked');
      if (checked) {
        const v = String(checked.value || '').trim().toLowerCase();
        if (v === 'aud' || v === 'usd') state.currency = v;
      }
    }
    return state.currency === 'aud' ? 'aud' : 'usd';
  }
  function visibleKeys() {
    return Object.keys(state.months)
      .filter(k => state.year === 'all' || !state.year || k.slice(0, 4) === state.year)
      .sort();
  }

  // ------------------------------------------------------- exclude/currency

  function getExclude() { return state.exclude.slice(); }
  /** setExclude(['AMD', ...]) / setExclude('AMD,MSFT') — normalizes, persists, re-renders. */
  function setExclude(list) {
    const parts = Array.isArray(list) ? list : String(list == null ? '' : list).split(/[,;]+/);
    const seen = new Set(), out = [];
    for (const part of parts) {
      const sym = up(part);
      if (!sym || seen.has(sym)) continue;
      seen.add(sym); out.push(sym);
    }
    state.exclude = out;
    lsSet(EXCLUDE_KEY, JSON.stringify(out));
    renderAll();
    return out;
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

  // USD -> AUD chain: manual override > fresh cache > providers > stale cache > baked rate.
  const FX_PROVIDERS = [
    {
      source: 'frankfurter', url: 'https://api.frankfurter.dev/v2/rate/USD/AUD',
      pick: j => ({ rate: j && j.rate, payloadDate: j && j.date })
    },
    {
      source: 'er-api', url: 'https://open.er-api.com/v6/latest/USD',
      pick: j => ({ rate: j && j.result === 'success' && j.rates ? j.rates.AUD : NaN, payloadDate: j && j.time_last_update_utc })
    },
    {
      source: 'fawazahmed0', url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json',
      pick: j => ({ rate: j && j.usd ? j.usd.aud : NaN, payloadDate: j && j.date })
    }
  ];

  /** Manual override (plain number or {"rate":1.5,"date":"..."}) — wins and never hits the network. */
  function readFxOverride() {
    const raw = lsGet(FX_KEYS.override);
    if (!raw) return null;
    const s = String(raw).trim();
    let rate = NaN, payloadDate = '';
    try {
      if (s.charAt(0) === '{') {
        const o = JSON.parse(s) || {};
        rate = Number(o.rate); payloadDate = String(o.date || o.payloadDate || '');
      } else rate = Number(s);
    } catch (err) { rate = Number(s); }
    if (!isFinite(rate) || rate <= 0) return null;
    return { rate, fetchedAt: Date.now(), source: 'manual', payloadDate };
  }

  function readFxCache() {
    const raw = lsGet(FX_KEYS.cache);
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) || {};
      const rate = Number(o.rate);
      if (!isFinite(rate) || rate <= 0) return null;
      return {
        rate, fetchedAt: Number(o.fetchedAt) || 0,
        source: String(o.source || 'cache'), payloadDate: String(o.payloadDate || o.date || '')
      };
    } catch (err) { return null; }
  }
  function fxFresh(fx) { return !!fx && fx.fetchedAt > 0 && Date.now() - fx.fetchedAt < FX_TTL_MS; }

  function applyFx(fx) {
    state.fx = {
      rate: fx.rate,
      fetchedAt: fx.fetchedAt || Date.now(),
      source: fx.source || 'cache',
      date: fx.payloadDate || ''
    };
    return state.fx;
  }
  function writeFxCache(fx) {
    lsSet(FX_KEYS.cache, JSON.stringify({ rate: fx.rate, fetchedAt: fx.fetchedAt, source: fx.source, payloadDate: fx.payloadDate || '' }));
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

  async function fromProviders() {
    for (const p of FX_PROVIDERS) {
      try {
        const picked = p.pick(await fetchJson(p.url, FX_TIMEOUT_MS)) || {};
        const rate = Number(picked.rate);
        if (isFinite(rate) && rate > 0) {
          return { rate, fetchedAt: Date.now(), source: p.source, payloadDate: String(picked.payloadDate || '') };
        }
      } catch (err) { /* try the next provider */ }
    }
    return null;
  }

  /** Resolve the USD/AUD rate through the fallback chain and apply it to state.fx. */
  async function fetchFx(force) {
    const override = readFxOverride();
    if (override) return applyFx(override);
    const cached = readFxCache();
    if (cached && !force && fxFresh(cached)) return applyFx(cached);
    const fresh = await fromProviders();
    // a manual rate set while the network was in flight always wins (and suppresses refetch)
    const manual = readFxOverride();
    if (manual) return applyFx(manual);
    if (fresh) { writeFxCache(fresh); return applyFx(fresh); }
    if (cached) {
      return applyFx({ rate: cached.rate, fetchedAt: cached.fetchedAt, source: (cached.source || 'cache') + ' (stale)', payloadDate: cached.payloadDate });
    }
    return applyFx({ rate: FX_BAKED_RATE, fetchedAt: Date.now(), source: 'approximate', payloadDate: '' });
  }

  let fxInFlight = null;
  /**
   * Non-blocking FX kickoff: an override/cache is applied synchronously so the next paint can
   * convert, then renderAll() runs again once the network (or a fallback) resolves.
   */
  function resolveFxOnLoad(force) {
    if (fxInFlight) return fxInFlight;
    const quick = readFxOverride() || readFxCache();
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
    const host = tip.offsetParent && tip.offsetParent.getBoundingClientRect ? tip.offsetParent : null;
    const base = host ? host.getBoundingClientRect() : { left: 0, top: 0 };
    const r = target.getBoundingClientRect();
    let left = r.left - base.left + r.width / 2;
    tip.style.left = left + 'px';
    tip.style.top = (r.top - base.top) + 'px';
    // Keep the tip fully on screen: only bars near the edges shift, and only as far as
    // needed, so a tooltip can never extend the page's scrollWidth (the 375px smoke test).
    if (tip.getBoundingClientRect && typeof document !== 'undefined' && document.documentElement) {
      const docW = document.documentElement.clientWidth;
      const box = tip.getBoundingClientRect();
      const overRight = box.right - (docW - 4);
      const overLeft = 4 - box.left;
      if (overRight > 0 && box.width <= docW - 8) left -= overRight;
      else if (overLeft > 0) left += overLeft;
      if (overRight > 0 || overLeft > 0) tip.style.left = Math.max(0, left) + 'px';
    }
  }
  function hideTipFor(tip) { if (tip) tip.hidden = true; } // stays laid out, styles.css fades it out
  function hideTip() { hideTipFor(byId('chartTip')); }
  function hideBreakdownTip() { hideTipFor(byId('breakdownTip')); }
  function tipTarget(e) {
    const t = e.target;
    return t && t.getAttribute && t.getAttribute('data-tip') ? t : null;
  }

  function renderChart(months) {
    const svg = byId('chartSvg');
    if (!svg) return;
    const keys = visibleKeys();
    const W = 720, H = 300, pl = 72, pr = 20, pt = 28, pb = 46;
    const iw = W - pl - pr, ih = H - pt - pb;
    if (!keys.length) {
      hideTip();
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML = '<g id="chartPlaceholder"><text class="chart__hint" x="360" y="150" text-anchor="middle">Load a CSV to plot monthly totals</text></g>';
      return;
    }
    const totals = keys.map(k => months[k].total);
    const cumulative = [];
    let run = 0;
    for (const t of totals) { run += t; cumulative.push(run); }
    let hi = Math.max(0, ...totals, ...cumulative);
    let lo = Math.min(0, ...totals, ...cumulative);
    const pad = (hi - lo) * 0.1 || 1;
    hi += pad; lo -= pad;
    const y = v => pt + ih * (hi - v) / (hi - lo);
    const band = iw / keys.length;
    const cx = i => pl + band * (i + 0.5);
    const barW = Math.max(6, Math.min(12, band - 6));
    const zero = y(0);
    const multiYear = state.year === 'all' && new Set(keys.map(k => k.slice(0, 4))).size > 1;
    let out = '';
    for (const v of [hi, 0, lo]) {
      const yy = y(v).toFixed(1);
      out += `<line class="grid" x1="${pl}" y1="${yy}" x2="${W - pr}" y2="${yy}" stroke="currentColor" stroke-opacity="0.5" />`;
      out += `<text class="label" x="${pl - 8}" y="${(+yy + 3).toFixed(1)}" text-anchor="end">${fmtCompact(v)}</text>`;
    }
    keys.forEach((k, i) => {
      const total = totals[i];
      const top = total >= 0 ? y(total) : zero;
      const height = Math.max(1, Math.abs(y(total) - zero));
      const label = monthLabel(k);
      const tip = `${label} · Net ${fmtMoney(total)} · Running ${fmtMoney(cumulative[i])}`;
      if (state.month !== 'all' && k === `${state.year}-${state.month}`) {
        out += `<rect x="${(pl + band * i + 2).toFixed(1)}" y="${pt}" width="${(band - 4).toFixed(1)}" height="${ih}" rx="4" fill="currentColor" fill-opacity="0.05" />`;
      }
      out += `<rect class="bar${total < 0 ? ' bar--neg' : ''}" x="${(cx(i) - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW}" height="${height.toFixed(1)}" rx="2" fill="${total >= 0 ? '#48BB78' : '#F56565'}" tabindex="0" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
      out += `<text class="label" x="${cx(i).toFixed(1)}" y="${H - 16}" text-anchor="middle">${MONTH_NAMES[+k.slice(5, 7) - 1] || k}${multiYear ? " '" + k.slice(2, 4) : ''}</text>`;
    });
    out += `<polyline class="line" points="${keys.map((k, i) => `${cx(i).toFixed(1)},${y(cumulative[i]).toFixed(1)}`).join(' ')}" fill="none" stroke="#4FD1C5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
    for (let i = 0; i < keys.length; i++) {
      out += `<circle class="dot" cx="${cx(i).toFixed(1)}" cy="${y(cumulative[i]).toFixed(1)}" r="2.5" />`;
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
          name: s.name, cls: s.cls, fill: s.fill,
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
    let out = '';
    for (const v of [hi, 0, lo]) {
      const yy = y(v).toFixed(1);
      out += `<line class="grid" x1="${pl}" y1="${yy}" x2="${W - pr}" y2="${yy}" stroke="currentColor" stroke-opacity="0.5" />`;
      out += `<text class="label" x="${pl - 8}" y="${(+yy + 3).toFixed(1)}" text-anchor="end">${fmtCompact(v)}</text>`;
    }
    stacks.forEach((st, i) => {
      const label = monthLabel(st.key);
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
        const pct = st.total ? Math.round(s.value / st.total * 100) : null;
        const tip = `${label} · ${s.name} ${fmtMoney(s.value)}` + (pct == null ? '' : ` (${pct}% of net)`);
        out += `<rect class="bar ${s.cls}" x="${(cx(i) - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" rx="2" fill="${s.fill}" tabindex="0" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
      }
      out += `<text class="label" x="${cx(i).toFixed(1)}" y="${H - 16}" text-anchor="middle">${MONTH_NAMES[+st.key.slice(5, 7) - 1] || st.key}${multiYear ? " '" + st.key.slice(2, 4) : ''}</text>`;
    });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = out;
  }

  function renderTables(months) {
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
    for (const t of state.trades) {
      if (monthKey(t.date) !== key) continue;
      if (state.exclude.length && state.exclude.indexOf(rootOf(t.symbol)) >= 0) continue;
      const where = classify(t);
      add(t.symbol || '—', where === 'options' ? 'Options' : where === 'assign' ? 'Assignment' : 'Stock (other)', Number(t.pnl) || 0);
    }
    const CAT = { interest: 'Interest', dividends: 'Dividends', withholding: 'Withholding', fees: 'Fees' };
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
   * #excludeChips — the 12 largest instruments by |P&L| (all months), plus any ticker that
   * was excluded manually. aria-pressed mirrors "excluded"; the click handler toggles it.
   */
  function renderExcludeChips() {
    const el = byId('excludeChips');
    if (!el) return;
    const totals = new Map();
    for (const t of state.trades) {
      const sym = rootOf(t.symbol);
      if (!sym) continue;
      totals.set(sym, (totals.get(sym) || 0) + (Number(t.pnl) || 0));
    }
    const ranked = Array.from(totals.keys())
      .sort((a, b) => Math.abs(totals.get(b)) - Math.abs(totals.get(a)) || (a < b ? -1 : a > b ? 1 : 0));
    const chips = ranked.slice(0, 12);
    for (const sym of state.exclude) if (chips.indexOf(sym) < 0) chips.push(sym);
    el.innerHTML = chips.map(sym => {
      const excluded = state.exclude.indexOf(sym) >= 0;
      const title = excluded
        ? `Excluded from every total — click to include ${sym}`
        : `Click to exclude ${sym} from every total`;
      return `<button type="button" class="chip" data-ticker="${esc(sym)}" aria-pressed="${excluded}" title="${esc(title)}">${esc(sym)}</button>`;
    }).join('');
  }

  /** Footer FX badge: source label + payload date + the exact rate being applied. */
  function renderFxBadge() {
    const fx = state.fx || {};
    if (!fx.source || fx.source === 'usd') { // no resolution yet
      setText('fxBadge', hasData() ? 'FX: loading' : 'FX: waiting for a CSV');
      return;
    }
    let label = String(fx.source);
    if (label === 'cache' || label === 'cached') label = 'cached';
    const rate = Number(fx.rate);
    const rateText = isFinite(rate) && rate > 0 ? String(Math.round(rate * 10000) / 10000) : '—';
    const date = fx.date ? ' · ' + fx.date : '';
    setText('fxBadge', `FX: ${label}${date} · 1 USD=${rateText} AUD`);
  }

  function renderAll() {
    const useAccrual = interestMode() === 'accrual' && state.accruals.length > 0;
    const months = aggregateByMonth(state.trades, state.cash, { interestMode: useAccrual ? 'accrual' : 'posted', accruals: state.accruals, exclude: state.exclude });
    state.months = months;
    renderYears(months);
    renderChips();
    renderKpis(months);
    renderChart(months);
    renderBreakdown(months);
    renderTables(months);
    renderExcludeChips();
    renderFxBadge();
    const empty = byId('emptyState');
    if (empty) {
      const has = hasData();
      empty.hidden = has;
      empty.classList.toggle('is-hidden', has);
    }
    const toggle = byId('postedToggle');
    if (toggle) toggle.title = (interestMode() === 'accrual' && !state.accruals.length) ? 'No Interest Accruals section in this file — showing posted interest' : '';
  }

  // ------------------------------------------------------------------ data

  function loadParsed(parsed, name, bytes) {
    state.trades = parsed.trades;
    state.cash = parsed.cash;
    state.accruals = parsed.accruals || [];
    state.format = parsed.format || '';
    state.name = name || '';
    state.year = 'all';
    state.month = 'all';
    try {
      if (!bytes || bytes <= CACHE_MAX_BYTES) {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 1, name: state.name, savedAt: new Date().toISOString(), parsed }));
      } else {
        localStorage.removeItem(CACHE_KEY);
      }
    } catch (err) { /* storage disabled or full — parsed result still renders */ }
    showError('');
    renderAll();
    resolveFxOnLoad(); // render first, then patch in the resolved FX rate
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
    const name = files.map(f => f.name).join(', ');
    setFileLabel(name);
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
      loadParsed(merged, name, bytes);
    }).catch(err => showError(err && err.message ? err.message : 'Could not read that file.'));
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
      setFileLabel(state.name + ' (cached)');
    } catch (err) { /* corrupt cache — start empty */ }
  }

  function clearAll() {
    state.trades = []; state.cash = []; state.accruals = []; state.months = {};
    state.year = 'all'; state.month = 'all'; state.name = ''; state.format = '';
    state.exclude = [];
    lsRemove(CACHE_KEY);
    lsRemove(EXCLUDE_KEY);
    const input = byId('fileInput');
    if (input) input.value = '';
    setFileLabel('No file selected');
    showError('');
    renderAll();
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
  function onCurrencyChange() {
    if (currencyMode() === 'aud' && state.fx.source === 'usd') resolveFxOnLoad();
    renderAll();
  }
  /** Add every token in #excludeInput to the exclude list, then clear the box. */
  function commitExcludeInput() {
    const input = byId('excludeInput');
    if (!input) return;
    const parts = String(input.value || '').split(/[,;]+/).map(up).filter(Boolean);
    if (!parts.length) return;
    setExclude(getExclude().concat(parts));
    input.value = '';
  }
  function onExcludeKeydown(e) {
    const key = e.key;
    if (key !== 'Enter' && key !== ',' && key !== ';') return;
    e.preventDefault(); // the chip replaces the separator
    commitExcludeInput();
  }
  // paste / IME path: a value that already carries separators commits every token
  function onExcludeInput(e) {
    const input = e.target;
    if (!input || !/[,;]/.test(String(input.value || ''))) return;
    commitExcludeInput();
  }
  function onExcludeChipsClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('#excludeChips button[data-ticker]') : null;
    if (!btn) return;
    const sym = up(btn.getAttribute('data-ticker'));
    if (!sym) return;
    const list = getExclude();
    const at = list.indexOf(sym);
    if (at >= 0) list.splice(at, 1); else list.push(sym);
    setExclude(list);
  }
  function syncFxInput() {
    const input = byId('fxInput');
    if (!input || (typeof document !== 'undefined' && document.activeElement === input)) return;
    const override = readFxOverride();
    input.value = override ? String(override.rate) : '';
  }
  /** A manual rate wins over the automatic chain and suppresses the network lookup. */
  function onFxInputChange() {
    const input = byId('fxInput');
    if (!input) return;
    const raw = String(input.value || '').trim();
    if (!raw) { onFxResetClick(); return; } // emptied box = back to automatic
    const rate = parseFloat(raw.replace(/[,\s$]/g, ''));
    if (!isFinite(rate) || rate <= 0) { syncFxInput(); return; }
    lsSet(FX_KEYS.override, JSON.stringify({ rate, date: new Date().toISOString().slice(0, 10) }));
    applyFx({ rate, fetchedAt: Date.now(), source: 'manual', payloadDate: '' });
    renderAll();
  }
  function onFxResetClick() {
    lsRemove(FX_KEYS.override);
    const input = byId('fxInput');
    if (input) input.value = '';
    resolveFxOnLoad(true); // cache first, then a fresh provider lookup
    renderAll();
  }

  function wire() {
    listen(byId('fileInput'), 'change', onFileChange);
    listen(byId('dropZone'), 'dragover', onDragOver);
    listen(byId('dropZone'), 'dragenter', onDragOver);
    listen(byId('dropZone'), 'dragleave', onDragLeave);
    listen(byId('dropZone'), 'drop', onDrop);
    listen(byId('dropZone'), 'click', onZoneClick);
    listen(byId('clearBtn'), 'click', clearAll);
    listen(byId('yearSelect'), 'change', onYearChange);
    listen(byId('monthChips'), 'click', onChipClick);
    listen(byId('monthlyBody'), 'click', onRowClick);
    listen(byId('postedToggle'), 'change', renderAll);
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      const toggles = document.querySelectorAll('input[name="currencyToggle"]');
      for (let i = 0; i < toggles.length; i++) listen(toggles[i], 'change', onCurrencyChange);
    }
    listen(byId('chartSvg'), 'mousemove', onChartMove);
    listen(byId('chartSvg'), 'mouseleave', hideTip);
    listen(byId('chartSvg'), 'focusin', onChartFocus);
    listen(byId('chartSvg'), 'focusout', hideTip);
    listen(byId('breakdownSvg'), 'mousemove', onBreakdownMove);
    listen(byId('breakdownSvg'), 'mouseleave', hideBreakdownTip);
    listen(byId('breakdownSvg'), 'focusin', onBreakdownFocus);
    listen(byId('breakdownSvg'), 'focusout', hideBreakdownTip);
    listen(byId('excludeInput'), 'keydown', onExcludeKeydown);
    listen(byId('excludeInput'), 'input', onExcludeInput);
    listen(byId('excludeChips'), 'click', onExcludeChipsClick);
    listen(byId('fxInput'), 'change', onFxInputChange);
    listen(byId('fxReset'), 'click', onFxResetClick);
    syncFxInput();
    const label = byId('fileLabel');
    if (label && !label.textContent.trim() && !hasData()) setFileLabel('No file selected');
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
    fmtMoney, fmtCompact, disp, currencyMode, init, loadText, clearAll, renderAll, renderBreakdown, incomeOf, state,
    getExclude, setExclude, fx: { keys: FX_KEYS, baked: FX_BAKED_RATE, fetchFx, resolveFxOnLoad }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = IBKR;
if (typeof window !== 'undefined') window.IBKR = IBKR;
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', IBKR.init);
  else IBKR.init();
}