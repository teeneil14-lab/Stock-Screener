const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { URL, URLSearchParams } = require('url');

const PORT = 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.txt':  'text/plain',
  '.json': 'application/json',
};

function proxyYahoo(ticker, range, interval) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      range,
      interval,
      events:               'history',
      includeAdjustedClose: 'true',
    });
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path:     `/v8/finance/chart/${encodeURIComponent(ticker)}?${qs}`,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'application/json, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://finance.yahoo.com/',
      },
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

server.listen(PORT, () => {
  console.log(`CTS Screener running → http://localhost:${PORT}/screener.html`);
  console.log(`Yahoo Finance proxy  → http://localhost:${PORT}/api/yf?ticker=AAPL&range=1y&interval=1d`);
});
