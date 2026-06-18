const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { URL, URLSearchParams } = require('url');
const pdfParse = require('pdf-parse');

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.txt':  'text/plain',
  '.json': 'application/json',
};

// ─── Response cache ──────────────────────────────────────────────────────────
// Caches Yahoo Finance chart responses for 5 minutes so re-scans are instant.
const yfCache    = new Map();
const CACHE_TTL  = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const entry = yfCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { yfCache.delete(key); return null; }
  return entry;
}
function setCache(key, status, body) {
  yfCache.set(key, { ts: Date.now(), status, body });
}

// ─── PSE EOD PDF scraper ─────────────────────────────────────────────────────

const pseCache = new Map(); // key = 'YYYY-MM-DD', value = { ts, stocks }
const PSE_TTL  = 60 * 60 * 1000; // 1 hour

// ── Persistent history (pse_history.json) ────────────────────────────────────
const PSE_HIST_FILE = path.join(__dirname, 'pse_history.json');

// In-memory history: { dates: string[], stocks: { [sym]: { name, days: { [date]: [o,h,l,c,v,val,nf] } } } }
let pseHistory = { dates: [], stocks: {} };

// Build state (one concurrent build allowed)
let pseBuild = { running: false, total: 0, done: 0, failed: 0, latest: '' };

function loadPSEHistory() {
  try {
    const raw = fs.readFileSync(PSE_HIST_FILE, 'utf8');
    pseHistory = JSON.parse(raw);
    pseHistory.dates = pseHistory.dates || [];
    pseHistory.stocks = pseHistory.stocks || {};
    console.log(`[PSE history] Loaded: ${pseHistory.dates.length} days`);
  } catch { /* file doesn't exist yet */ }
}

function savePSEHistory() {
  try { fs.writeFileSync(PSE_HIST_FILE, JSON.stringify(pseHistory)); }
  catch (e) { console.error('[PSE history] Save failed:', e.message); }
}

// All weekdays (Mon–Fri) going back `days` calendar days from today
function pastWeekdays(calDays) {
  const result = [];
  const now = new Date();
  for (let i = calDays; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    result.push(d.toISOString().split('T')[0]);
  }
  return result;
}

// Merge one day's parsed stocks into the history store
function mergeIntoPSEHistory(dateStr, stocks) {
  if (!pseHistory.dates.includes(dateStr)) pseHistory.dates.push(dateStr);
  for (const s of stocks) {
    if (!pseHistory.stocks[s.symbol])
      pseHistory.stocks[s.symbol] = { name: s.name, days: {} };
    // compact: [open, high, low, close, volume, value, netForeign]
    pseHistory.stocks[s.symbol].days[dateStr] =
      [s.open, s.high, s.low, s.close, s.volume, s.value, s.netForeign];
  }
}

async function runPSEHistoryBuild() {
  if (pseBuild.running) return;

  const targets = pastWeekdays(365);
  const missing = targets.filter(d => !pseHistory.dates.includes(d));

  if (missing.length === 0) {
    console.log('[PSE history] Already up to date');
    return;
  }

  pseBuild.running = true;
  pseBuild.total   = missing.length;
  pseBuild.done    = 0;
  pseBuild.failed  = 0;
  pseBuild.latest  = '';

  console.log(`[PSE history] Building: ${missing.length} days to fetch`);

  for (const dateStr of missing) {
    const stocks = await fetchPSEDay(dateStr);
    if (stocks && stocks.length > 0) {
      mergeIntoPSEHistory(dateStr, stocks);
    } else {
      pseBuild.failed++;
    }
    pseBuild.done++;
    pseBuild.latest = dateStr;

    if (pseBuild.done % 20 === 0) {
      savePSEHistory();
      console.log(`[PSE history] ${pseBuild.done}/${pseBuild.total} done`);
    }

    await new Promise(r => setTimeout(r, 300)); // polite delay
  }

  pseHistory.dates.sort();
  savePSEHistory();
  pseBuild.running = false;
  console.log(`[PSE history] Build complete: ${pseHistory.dates.length} days total`);
}

function pseWeekDays() {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun … 6=Sat
  const mon = new Date(now);
  mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  mon.setHours(0, 0, 0, 0);
  const days = [];
  for (let d = 0; d < 5; d++) {
    const day = new Date(mon);
    day.setDate(mon.getDate() + d);
    if (day > now) break;
    days.push(day.toISOString().split('T')[0]);
  }
  return days;
}

function pseDateLabel(dateStr) {
  // 'YYYY-MM-DD' → 'June 17, 2026'
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const [yr, mo, dd] = dateStr.split('-');
  return `${months[parseInt(mo) - 1]} ${dd}, ${yr}`;
}

function downloadBuffer(hostname, urlPath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = https.get({ hostname, path: urlPath, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

function layoutPageRender(pageData) {
  return pageData.getTextContent({ normalizeWhitespace: false }).then(tc => {
    const rows = new Map();
    for (const item of tc.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5] * 10) / 10;
      let rowKey = null;
      for (const k of rows.keys()) {
        if (Math.abs(k - y) <= 1.5) { rowKey = k; break; }
      }
      if (rowKey === null) { rowKey = y; rows.set(rowKey, []); }
      rows.get(rowKey).push({ x: item.transform[4], str: item.str, width: item.width || 0 });
    }
    const sortedRows = [...rows.entries()].sort((a, b) => b[0] - a[0]);
    const lines = [];
    for (const [, items] of sortedRows) {
      items.sort((a, b) => a.x - b.x);
      let line = '';
      let prevEnd = null;
      for (const item of items) {
        if (prevEnd !== null) {
          const gap = item.x - prevEnd;
          const spaces = Math.max(gap > 3 ? 2 : 1, Math.floor(gap / 6));
          line += ' '.repeat(Math.min(spaces, 20));
        }
        line += item.str;
        prevEnd = item.x + (item.width > 0 ? item.width : item.str.length * 5.5);
      }
      if (line.trim()) lines.push(line);
    }
    return lines.join('\n');
  });
}

function pdfToText(buf) {
  return pdfParse(buf, { pagerender: layoutPageRender, version: 'v2.0.550' })
    .then(data => data.text);
}

function parsePSELayout(text, dateStr) {
  const stocks    = [];
  const isTicker  = (s) => /^[A-Z][A-Z0-9]{0,5}$/.test(s);
  const parseNum  = (v) => {
    if (!v || v === '-') return null;
    const n = parseFloat(v.replace(/,/g, '').replace(/^\((.+)\)$/, '-$1'));
    return isNaN(n) ? null : n;
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\*|SECTOR TOTAL|Issue Name|The Philippine|Daily Quotation|MAIN BOARD|ETB BOARD/.test(trimmed)) continue;

    const parts = trimmed.split(/\s{2,}/);
    if (parts.length < 4) continue;
    const sym = parts[1];
    if (!isTicker(sym)) continue;

    // Values after the symbol: Bid Ask Open High Low Close Volume Value NetForeign
    const vals = parts.slice(2);
    if (vals.length < 6) continue;

    const close = parseNum(vals[5]);
    if (close == null) continue; // stock did not trade

    stocks.push({
      symbol:     sym,
      name:       parts[0].trim(),
      date:       dateStr,
      open:       parseNum(vals[2]),
      high:       parseNum(vals[3]),
      low:        parseNum(vals[4]),
      close,
      volume:     vals.length > 6 ? parseNum(vals[6]) : null,
      value:      vals.length > 7 ? parseNum(vals[7]) : null,
      netForeign: vals.length > 8 ? parseNum(vals[8]) : null,
    });
  }
  return stocks;
}

async function fetchPSEDay(dateStr) {
  const cached = pseCache.get(dateStr);
  if (cached && Date.now() - cached.ts < PSE_TTL) return cached.stocks;

  const label    = pseDateLabel(dateStr);
  const urlPath  = `/market_report/${label.replace(/ /g, '%20').replace(/,/g, '%2C')}-EOD.pdf`;

  try {
    const buf    = await downloadBuffer('documents.pse.com.ph', urlPath);
    const text   = await pdfToText(buf);
    const stocks = parsePSELayout(text, dateStr);
    if (stocks.length > 0) pseCache.set(dateStr, { ts: Date.now(), stocks });
    console.log(`[PSE] ${dateStr}: ${stocks.length} stocks parsed`);
    return stocks;
  } catch (e) {
    console.log(`[PSE] ${dateStr}: skipped (${e.message})`);
    return null;
  }
}

// ─── Yahoo Finance crumb management ─────────────────────────────────────────
// YF's v8 chart API requires a "crumb" token (tied to a session cookie).
// We fetch one crumb at startup and refresh it every 25 minutes.

let _yfCrumb   = null;
let _yfCookie  = null;
let _yfCrumbTs = 0;
const CRUMB_TTL = 25 * 60 * 1000; // 25 min

function rawHttpsGet(opts) {
  return new Promise((resolve, reject) => {
    const req = https.get(opts, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end',  () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(14000, () => req.destroy(new Error('timeout')));
  });
}

async function refreshYFCrumb() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  // Strategy A — try the crumb endpoint directly (no cookie).
  // Works in many server environments where Yahoo doesn't enforce the consent flow.
  try {
    const r = await rawHttpsGet({
      hostname: 'query2.finance.yahoo.com',
      path: '/v1/test/getcrumb',
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://finance.yahoo.com/' },
    });
    const crumb = r.body.trim();
    if (r.status === 200 && crumb && crumb !== 'Unauthorized' && crumb.length > 2) {
      _yfCrumb   = crumb;
      _yfCrumbTs = Date.now();
      console.log(`[YF crumb] OK (direct) — ${crumb.substring(0, 8)}…`);
      return;
    }
  } catch (e) { console.warn(`[YF crumb] direct attempt: ${e.message}`); }

  // Strategy B — get a lightweight page first to collect the session cookie,
  // then exchange it for a crumb.  We use the /robots.txt path which is tiny
  // and unlikely to trigger the large Set-Cookie header flood from the homepage.
  try {
    const r1 = await rawHttpsGet({
      hostname: 'finance.yahoo.com',
      path: '/robots.txt',
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
    });
    const rawCookies = Array.isArray(r1.headers['set-cookie'])
      ? r1.headers['set-cookie']
      : (r1.headers['set-cookie'] ? [r1.headers['set-cookie']] : []);
    const cookie = rawCookies.map(c => c.split(';')[0]).join('; ');

    const r2 = await rawHttpsGet({
      hostname: 'query1.finance.yahoo.com',
      path: '/v1/test/getcrumb',
      headers: {
        'User-Agent': UA, 'Accept': '*/*',
        'Referer':    'https://finance.yahoo.com/',
        ...(cookie ? { 'Cookie': cookie } : {}),
      },
    });
    const crumb = r2.body.trim();
    if (r2.status === 200 && crumb && crumb !== 'Unauthorized' && crumb.length > 2) {
      _yfCrumb   = crumb;
      _yfCookie  = cookie || null;
      _yfCrumbTs = Date.now();
      console.log(`[YF crumb] OK (cookie flow) — ${crumb.substring(0, 8)}…`);
      return;
    }
    console.warn(`[YF crumb] cookie flow status=${r2.status}: ${r2.body.substring(0, 60)}`);
  } catch (e) { console.warn(`[YF crumb] cookie flow error: ${e.message}`); }

  console.warn('[YF crumb] All strategies failed — requests will proceed without crumb');
}

async function ensureCrumb() {
  if (!_yfCrumb || Date.now() - _yfCrumbTs > CRUMB_TTL) {
    await refreshYFCrumb();
  }
}

function yfHeaders() {
  const h = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':          'application/json, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer':         'https://finance.yahoo.com/',
  };
  if (_yfCookie) h['Cookie'] = _yfCookie;
  return h;
}

// ─── Yahoo Finance chart proxy ───────────────────────────────────────────────
async function proxyYahoo(ticker, range, interval) {
  const cacheKey = `${ticker}|${range}|${interval}`;
  const cached   = getCached(cacheKey);
  if (cached) return { status: cached.status, body: cached.body };

  await ensureCrumb();

  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      range,
      interval,
      events:               'history',
      includeAdjustedClose: 'true',
    });
    if (_yfCrumb) qs.set('crumb', _yfCrumb);

    const options = {
      hostname: 'query1.finance.yahoo.com',
      path:     `/v8/finance/chart/${encodeURIComponent(ticker)}?${qs}`,
      headers:  yfHeaders(),
    };

    const req = https.get(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end',  () => {
        if (res.statusCode === 200) setCache(cacheKey, res.statusCode, body);
        resolve({ status: res.statusCode, body });
      });
    });

    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('Yahoo Finance request timed out')));
  });
}

// Extract just {t,c} bars from a raw Yahoo Finance chart response body
function parseYFBars(body) {
  try {
    const d      = JSON.parse(body);
    const result = d?.chart?.result?.[0];
    if (!result) return null;
    const ts     = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const bars   = [];
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] == null) continue;
      bars.push({ t: ts[i] * 1000, c: closes[i] });
    }
    return bars.length ? bars : null;
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');

  // Batch endpoint: one request → parallel server-side fetches → one response
  if (reqUrl.pathname === '/api/yf-batch') {
    const tickersParam = reqUrl.searchParams.get('tickers');
    const range        = reqUrl.searchParams.get('range')    || '1y';
    const interval     = reqUrl.searchParams.get('interval') || '1d';

    if (!tickersParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing tickers parameter' }));
    }

    const tickers = tickersParam.split(',').map(s => s.trim()).filter(Boolean);
    const settled = await Promise.allSettled(
      tickers.map(t => proxyYahoo(t, range, interval))
    );

    const out = {};
    for (let i = 0; i < tickers.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled' && r.value.status === 200) {
        const bars = parseYFBars(r.value.body);
        if (bars) out[tickers[i]] = { bars };
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out));
  }

  if (reqUrl.pathname === '/api/yf') {
    const ticker   = reqUrl.searchParams.get('ticker');
    const range    = reqUrl.searchParams.get('range')    || '1y';
    const interval = reqUrl.searchParams.get('interval') || '1d';

    if (!ticker) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing ticker parameter' }));
    }

    try {
      const { status, body } = await proxyYahoo(ticker, range, interval);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (e) {
      console.error(`[proxy] ${ticker}: ${e.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (reqUrl.pathname === '/api/yf-quote') {
    const tickersParam = reqUrl.searchParams.get('tickers');
    if (!tickersParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing tickers parameter' }));
    }

    await ensureCrumb();

    function fetchSector(ticker) {
      return new Promise((resolve) => {
        const qs = new URLSearchParams({ q: ticker, quotesCount: '1', newsCount: '0' });
        if (_yfCrumb) qs.set('crumb', _yfCrumb);
        const opts = {
          hostname: 'query1.finance.yahoo.com',
          path:     `/v1/finance/search?${qs}`,
          headers:  yfHeaders(),
        };
        const req = https.get(opts, (r) => {
          let b = '';
          r.on('data', chunk => { b += chunk; });
          r.on('end', () => {
            try {
              const d = JSON.parse(b);
              const quote = (d?.quotes || []).find(q => q.symbol === ticker);
              resolve({ ticker, sector: quote?.sector || null });
            } catch { resolve({ ticker, sector: null }); }
          });
        });
        req.on('error', () => resolve({ ticker, sector: null }));
        req.setTimeout(8000, () => { req.destroy(); resolve({ ticker, sector: null }); });
      });
    }

    // Fetch all tickers in parallel (max 10 concurrent)
    const symbols   = tickersParam.split(',').map(s => s.trim()).filter(Boolean);
    const CONC      = 10;
    const sectorMap = {};
    for (let i = 0; i < symbols.length; i += CONC) {
      const batch   = symbols.slice(i, i + CONC);
      const results = await Promise.all(batch.map(fetchSector));
      results.forEach(({ ticker, sector }) => { if (sector) sectorMap[ticker] = sector; });
      if (i + CONC < symbols.length) await new Promise(r => setTimeout(r, 150));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sectorMap));
    return;
  }

  if (reqUrl.pathname === '/api/yf-earnings') {
    const tickersParam = reqUrl.searchParams.get('tickers');
    if (!tickersParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing tickers parameter' }));
    }

    await ensureCrumb();

    function fetchEarningsTimestamps(symbols) {
      return new Promise((resolve) => {
        const qs = new URLSearchParams({
          symbols:   symbols.join(','),
          fields:    'earningsTimestamp,earningsTimestampStart,earningsTimestampEnd',
          formatted: 'false',
        });
        if (_yfCrumb) qs.set('crumb', _yfCrumb);
        const opts = {
          hostname: 'query1.finance.yahoo.com',
          path:     `/v7/finance/quote?${qs}`,
          headers:  yfHeaders(),
        };
        const req = https.get(opts, (r) => {
          let b = '';
          r.on('data', chunk => { b += chunk; });
          r.on('end', () => {
            try {
              const d    = JSON.parse(b);
              const list = d?.quoteResponse?.result || [];
              const map  = {};
              list.forEach(q => {
                // Use earningsTimestampStart (earliest edge of the estimate window)
                const ts = q.earningsTimestampStart || q.earningsTimestamp;
                if (ts) map[q.symbol] = ts; // Unix seconds
              });
              resolve(map);
            } catch { resolve({}); }
          });
        });
        req.on('error', () => resolve({}));
        req.setTimeout(10000, () => { req.destroy(); resolve({}); });
      });
    }

    const symbols     = tickersParam.split(',').map(s => s.trim()).filter(Boolean);
    const BATCH       = 100;
    const earningsMap = {};
    for (let i = 0; i < symbols.length; i += BATCH) {
      const batch  = symbols.slice(i, i + BATCH);
      const result = await fetchEarningsTimestamps(batch);
      Object.assign(earningsMap, result);
      if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 200));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(earningsMap));
    return;
  }

  // ── Stooq proxy (used for Philippine / PSE stock data) ──────────────────────
  if (reqUrl.pathname === '/api/stooq') {
    const symbol   = reqUrl.searchParams.get('symbol')   || '';
    const interval = reqUrl.searchParams.get('interval') || 'd';
    const d1       = reqUrl.searchParams.get('d1')       || '';
    const d2       = reqUrl.searchParams.get('d2')       || '';

    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing symbol' }));
    }

    try {
      const qs = new URLSearchParams({ s: symbol, i: interval });
      if (d1) qs.set('d1', d1);
      if (d2) qs.set('d2', d2);

      const raw = await new Promise((resolve, reject) => {
        const opts = {
          hostname: 'stooq.com',
          path:     `/q/d/l/?${qs}`,
          headers:  { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        };
        const r = https.get(opts, (resp) => {
          let body = '';
          resp.on('data', c => { body += c; });
          resp.on('end',  () => resolve({ status: resp.statusCode, body }));
        });
        r.on('error', reject);
        r.setTimeout(14000, () => r.destroy(new Error('Stooq timeout')));
      });

      // Stooq returns CSV: Date,Open,High,Low,Close,Volume
      const lines = raw.body.trim().split('\n');
      const bars  = [];
      for (let i = 1; i < lines.length; i++) {
        const p = lines[i].split(',');
        if (p.length < 5) continue;
        const c = parseFloat(p[4]);
        if (!c || isNaN(c)) continue;
        bars.push({
          t: new Date(p[0]).getTime(),       // ms since epoch
          o: parseFloat(p[1]) || c,
          h: parseFloat(p[2]) || c,
          l: parseFloat(p[3]) || c,
          c,
          v: parseFloat(p[5]) || 0,
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ bars }));
    } catch (e) {
      console.error(`[stooq] ${symbol}: ${e.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Finviz Elite groups proxy (sector / industry 1-week performance) ─────────
  if (reqUrl.pathname === '/api/finviz-groups') {
    const type = (reqUrl.searchParams.get('type') || 'sector').replace(/[^a-z]/gi, '');
    if (type !== 'sector' && type !== 'industry') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'type must be sector or industry' }));
    }

    const FINVIZ_AUTH = 'aef22707-59f4-492a-be23-ed3f64945fcb';
    const CACHE_TTL   = 15 * 60 * 1000;

    if (!server._finvizCache) server._finvizCache = new Map();
    const cached = server._finvizCache.get(type);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(cached.data));
    }

    function parseCSVLine(line) {
      const cells = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') { inQ = !inQ; }
        else if (line[i] === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
        else { cur += line[i]; }
      }
      cells.push(cur.trim());
      return cells;
    }

    function parseFinvizCSV(csv) {
      const lines = csv.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return null;
      const headers = parseCSVLine(lines[0]);
      const nameIdx = headers.findIndex(h => /^name$/i.test(h) || /^sector$/i.test(h) || /^industry$/i.test(h));
      const perfIdx = headers.findIndex(h =>
        /perf.*week/i.test(h) || /^performance$/i.test(h) || /perf\s*1w/i.test(h) ||
        /^1w$/i.test(h) || /^week$/i.test(h)
      );
      if (nameIdx < 0 || perfIdx < 0) {
        return { error: `Columns not found. Headers: ${headers.join(', ')}` };
      }
      const results = [];
      for (let i = 1; i < lines.length; i++) {
        const cells = parseCSVLine(lines[i]);
        if (cells.length <= Math.max(nameIdx, perfIdx)) continue;
        const name = cells[nameIdx];
        const val  = parseFloat(cells[perfIdx].replace('%', '').replace('+', ''));
        if (!name || isNaN(val)) continue;
        results.push({ name, perf1w: val });
      }
      return results.length > 0 ? results : { error: 'No rows parsed from CSV' };
    }

    try {
      // v=140 = performance view with "Performance (Week)" column; auth= token, no cookies needed
      const path = `/grp_export?g=${type}&v=140&auth=${FINVIZ_AUTH}`;
      const raw  = await rawHttpsGet({ hostname: 'elite.finviz.com', path, headers: {} });

      console.log(`[finviz] ${type} status=${raw.status} preview: ${raw.body.substring(0, 200)}`);

      if (raw.status !== 200) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Finviz returned HTTP ${raw.status}`, preview: raw.body.substring(0, 200) }));
      }

      const data = parseFinvizCSV(raw.body);
      if (!data || data.error) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: (data && data.error) || 'Failed to parse CSV', preview: raw.body.substring(0, 200) }));
      }

      if (type === 'industry') data.sort((a, b) => b.perf1w - a.perf1w);

      server._finvizCache.set(type, { ts: Date.now(), data });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      console.error(`[finviz] ${type}: ${e.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── PSE history: start build ─────────────────────────────────────────────────
  if (reqUrl.pathname === '/api/pse/build-history' && req.method === 'POST') {
    if (!pseBuild.running) runPSEHistoryBuild().catch(e => console.error('[PSE build]', e.message));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ started: true }));
  }

  // ── PSE history: status ───────────────────────────────────────────────────────
  if (reqUrl.pathname === '/api/pse/history-status') {
    const dates   = pseHistory.dates.sort();
    const oldest  = dates[0]       || null;
    const newest  = dates[dates.length - 1] || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      cached:  dates.length,
      oldest,
      newest,
      running: pseBuild.running,
      total:   pseBuild.total,
      done:    pseBuild.done,
      failed:  pseBuild.failed,
      latest:  pseBuild.latest,
    }));
  }

  // ── PSE EOD weekly scan ──────────────────────────────────────────────────────
  if (reqUrl.pathname === '/api/pse/week') {
    try {
      const days    = pseWeekDays();
      const settled = await Promise.allSettled(days.map(fetchPSEDay));
      const weekData = {};
      days.forEach((d, i) => {
        const r = settled[i];
        if (r.status === 'fulfilled' && r.value && r.value.length > 0)
          weekData[d] = r.value;
      });

      const dates = Object.keys(weekData).sort();
      if (dates.length === 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No PSE data available for this week yet' }));
      }

      const latestDate = dates[dates.length - 1];
      const stockMap   = {};

      for (const [dateStr, stocks] of Object.entries(weekData)) {
        for (const s of stocks) {
          if (!stockMap[s.symbol])
            stockMap[s.symbol] = { symbol: s.symbol, name: s.name, days: {} };
          stockMap[s.symbol].days[dateStr] = {
            open: s.open, high: s.high, low: s.low, close: s.close,
            volume: s.volume, value: s.value, netForeign: s.netForeign,
          };
        }
      }

      const output = [];
      for (const data of Object.values(stockMap)) {
        const dayEntries = Object.entries(data.days).sort(([a], [b]) => a.localeCompare(b));
        const latest = data.days[latestDate];
        if (!latest || latest.close == null) continue;

        const highs   = dayEntries.map(([, d]) => d.high).filter(v => v != null);
        const lows    = dayEntries.map(([, d]) => d.low).filter(v => v != null);
        const weekHigh = highs.length ? Math.max(...highs) : latest.high;
        const weekLow  = lows.length  ? Math.min(...lows)  : latest.low;
        const range    = (weekHigh != null && weekLow != null) ? weekHigh - weekLow : 0;
        const rangePos = range > 0 ? Math.round((latest.close - weekLow) / range * 100) : 50;

        const prevVols = dayEntries
          .filter(([d]) => d !== latestDate)
          .map(([, d]) => d.volume)
          .filter(v => v != null && v > 0);
        const avgPrevVol  = prevVols.length ? Math.round(prevVols.reduce((a, b) => a + b, 0) / prevVols.length) : null;
        const volumeRatio = avgPrevVol && latest.volume ? Math.round(latest.volume / avgPrevVol * 10) / 10 : null;

        output.push({
          symbol: data.symbol, name: data.name, latestDate,
          close: latest.close, open: latest.open,
          high: latest.high, low: latest.low,
          weekHigh, weekLow, rangePos,
          volume: latest.volume, avgPrevVol, volumeRatio,
          netForeign: latest.netForeign,
          daysAvailable: dayEntries.length,
        });
      }

      output.sort((a, b) => b.rangePos - a.rangePos);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ dates, latestDate, stocks: output }));
    } catch (e) {
      console.error(`[PSE] ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Static file server
  let filePath = reqUrl.pathname === '/' ? '/screener.html' : reqUrl.pathname;
  const fullPath = path.join(__dirname, filePath);
  const ext = path.extname(fullPath).toLowerCase();

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } else {
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      res.end(content);
    }
  });
});

// Fetch crumb at startup so the first scan request doesn't have to wait for it
refreshYFCrumb().catch(() => {});
// Refresh every 24 minutes to stay within the 25-min TTL
setInterval(() => refreshYFCrumb().catch(() => {}), 24 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`CTS Screener running → http://localhost:${PORT}/screener.html`);
  console.log(`Yahoo Finance proxy  → http://localhost:${PORT}/api/yf?ticker=AAPL&range=1y&interval=1d`);
});
