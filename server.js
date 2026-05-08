const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { URL, URLSearchParams } = require('url');

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.txt':  'text/plain',
  '.json': 'application/json',
};

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
      res.on('end',  ()      => resolve({ status: res.statusCode, body }));
    });

    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('Yahoo Finance request timed out')));
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');

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
