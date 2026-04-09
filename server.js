const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

const SYSTEM_PROMPT =
  'You are a world-class travel planner. ' +
  'You always respond with ONLY a valid JSON object — no markdown, no backticks, no explanation, no preamble. ' +
  'Your first character is always { and your last character is always }. ' +
  'Every place name you suggest must be a real, specific, currently existing location. ' +
  'Costs must be realistic in USD for the destination city.';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* ── /api/generate  POST ── */
  if (req.method === 'POST' && req.url === '/api/generate') {
    if (!API_KEY) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'ANTHROPIC_API_KEY not set on server'}));
      return;
    }

    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let client;
      try { client = JSON.parse(body); }
      catch(e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Invalid JSON body'}));
        return;
      }

      const payload = JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system:     SYSTEM_PROMPT,
        messages:   client.messages
      });

      const opts = {
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers: {
          'Content-Type':    'application/json',
          'x-api-key':       API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length':  Buffer.byteLength(payload)
        }
      };

      const apiReq = https.request(opts, apiRes => {
        let data = '';
        apiRes.on('data', c => { data += c; });
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, {'Content-Type':'application/json'});
          res.end(data);
        });
      });
      apiReq.on('error', err => {
        console.error('Anthropic error:', err.message);
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error: err.message}));
      });
      apiReq.write(payload);
      apiReq.end();
    });
    return;
  }

  /* ── serve pinpoint.html for all GET ── */
  if (req.method === 'GET') {
    const file = path.join(__dirname, 'pinpoint.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('pinpoint.html not found'); return; }
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log('PinPoint on port ' + PORT));
