const http = require('http');
const https = require('https');

// ─── CONFIG ───────────────────────────────────────────────
const PORT = 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || 'YOUR_API_KEY_HERE';
// ──────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS headers — allow requests from the HTML file opened locally
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/generate') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const payload = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 6000,
        messages: parsed.messages
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const apiReq = https.request(options, apiRes => {
        let data = '';
        apiRes.on('data', chunk => { data += chunk; });
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });

      apiReq.on('error', err => {
        console.error('Anthropic API error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });

      apiReq.write(payload);
      apiReq.end();
    });
    return;
  }

  // Serve the HTML file
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, 'pinpoint.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404); res.end('pinpoint.html not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ✦ PinPoint server running');
  console.log('  → Open: http://localhost:' + PORT);
  console.log('');
  if (API_KEY === 'YOUR_API_KEY_HERE') {
    console.log('  ⚠️  Set your API key:');
    console.log('     ANTHROPIC_API_KEY=sk-ant-... node server.js');
    console.log('');
  }
});
