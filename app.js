'use strict';

/*
 * app.js — IBKR dashboard: CSV parser, aggregator and UI wiring.
 *
 * Supports both export shapes:
 *   - Flex Query CSV  — HEADER/DATA rows with section codes (TRNT, CTRN, IACC, ...)
 *   - Activity Statement CSV — Section,Kind,... rows (Trades / Dividends / ...)
 *
 * Zero dependencies, zero network calls; works from file:// via FileReader + localStorage.
 * Every DOM lookup is optional, so the script survives if the shell HTML is missing.
 *
 * DOM contract (see index.html): fileInput dropZone yearSelect monthChips kpiNet
 * kpiMonth kpiBest kpiAvg chartSvg chartTip monthlyBody drillBody drillTitle
 * emptyState errorBox clearBtn postedToggle fileLabel.
 *
 * Browser: window.IBKR = { state, aggregateByMonth, renderAll, ... }.
 * Node (tests): module.exports.
 */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CACHE_KEY = 'ibkr-v1';
const CACHE_MAX_BYTES = 2 * 1024 * 1024; // bigger raw files are parsed but not cached
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
  function fmtMoney(value) {
    const v = Number(value) || 0;
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtCompact(value) {
    const a = Math.abs(Number(value) || 0);
    if (a >= 1000) return (value < 0 ? '-' : '') + '$' + (a / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k';
    if (a === 0) return '$0';
    return (value < 0 ? '-' : '') + '$' + Math.round(a);
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
   * Aggregate trades + cash into { 'yyyy-MM': buckets }. Amounts stay raw (display rounds).
   * interestMode 'accrual' replaces posted cash interest with the Interest Accruals (IACC) split.
   */
  function aggregateByMonth(trades, cash, options) {
    const months = {};
    const bucket = key => months[key] || (months[key] = emptyMonth());
    const opts = options || {};
    const useAccrual = opts.interestMode === 'accrual' && opts.accruals && opts.accruals.length > 0;

    for (const t of trades || []) {
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

  const state = { trades: [], cash: [], accruals: [], months: {}, year: 'all', month: 'all', name: '', format: '' };
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
  function visibleKeys() {
    return Object.keys(state.months)
      .filter(k => state.year === 'all' || !state.year || k.slice(0, 4) === state.year)
      .sort();
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
    const income = sums.interest + sums.dividends + sums.withholding + sums.fees;
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

  // chart hooks: .bar / .bar--neg / .line / .dot / .tick / .label are styled by styles.css
  function showTipFor(target) {
    const tip = byId('chartTip');
    if (!tip || !target || !target.getBoundingClientRect) return;
    const text = target.getAttribute && target.getAttribute('data-tip');
    if (!text) return;
    const host = tip.offsetParent && tip.offsetParent.getBoundingClientRect ? tip.offsetParent : null;
    const base = host ? host.getBoundingClientRect() : { left: 0, top: 0 };
    const r = target.getBoundingClientRect();
    tip.textContent = text;
    tip.hidden = false;
    tip.style.display = 'block';
    tip.style.left = (r.left - base.left + r.width / 2) + 'px';
    tip.style.top = (r.top - base.top) + 'px';
  }
  function hideTip() {
    const tip = byId('chartTip');
    if (!tip) return;
    tip.hidden = true;
    tip.style.display = 'none';
  }
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

  function renderAll() {
    const useAccrual = interestMode() === 'accrual' && state.accruals.length > 0;
    const months = aggregateByMonth(state.trades, state.cash, { interestMode: useAccrual ? 'accrual' : 'posted', accruals: state.accruals });
    state.months = months;
    renderYears(months);
    renderChips();
    renderKpis(months);
    renderChart(months);
    renderTables(months);
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
    try { localStorage.removeItem(CACHE_KEY); } catch (err) { /* ignore */ }
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
    listen(byId('chartSvg'), 'mousemove', onChartMove);
    listen(byId('chartSvg'), 'mouseleave', hideTip);
    listen(byId('chartSvg'), 'focusin', onChartFocus);
    listen(byId('chartSvg'), 'focusout', hideTip);
    const label = byId('fileLabel');
    if (label && !label.textContent.trim() && !hasData()) setFileLabel('No file selected');
  }

  function init() {
    if (typeof document === 'undefined') return;
    wire();
    restore();
    renderAll();
    if (typeof window !== 'undefined' && !byId('fileInput') && document.readyState !== 'complete') {
      window.addEventListener('load', function () { wire(); restore(); renderAll(); });
    }
  }

  return {
    parseCsv, detectFormat, parseFlex, parseActivityStatement, parseCsvText,
    aggregateByMonth, classify, cashCategory, isAssignmentCode, monthKey, monthLabel,
    fmtMoney, init, loadText, clearAll, renderAll, state
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = IBKR;
if (typeof window !== 'undefined') window.IBKR = IBKR;
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', IBKR.init);
  else IBKR.init();
}