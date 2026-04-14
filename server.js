const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

console.log('PinPoint starting — port:', PORT, '— API key:', API_KEY ? 'SET' : 'MISSING');

const SYSTEM = 'You are an expert local travel guide. Respond ONLY with valid JSON. No markdown, no backticks, no text outside JSON. First character is { and last character is }.';

function buildItineraryPrompt(p) {
  const bDesc = {
    low:      'backpacker budget — hostels, street food, under $30/day',
    medium:   'mid-range — guesthouses, restaurants, $30-80/day',
    flexible: 'comfortable — nice hotels, good restaurants, $80+/day'
  }[p.budget] || p.budget || 'mid-range';

  const pDesc = {
    chill:    '2-3 activities per day, relaxed',
    balanced: '4-5 activities per day',
    intense:  '6-7 activities per day'
  }[p.pace] || p.pace || 'balanced';

  const n    = parseInt(p.nDays) || 3;
  const city = p.city || 'Rome';

  return `Create a ${n}-day itinerary for ${city}.
Days: ${p.dateStr || Array.from({length:n},(_,i)=>'Day '+(i+1)).join(', ')}
Budget: ${bDesc}
Pace: ${pDesc}
Interests: ${p.interests || 'general sightseeing'}
${p.mustdo ? 'Must include: ' + p.mustdo : ''}

Return ONLY valid JSON starting with { ending with }.

{
  "days": [
    {
      "label": "Day 1",
      "date": "${p.firstDate || 'Day 1'}",
      "city": "${city}",
      "cityNote": "one specific insider tip about ${city} tourists rarely know",
      "items": [
        {
          "time": "9:00",
          "name": "REAL PLACE NAME e.g. Pantheon or Wat Pho",
          "meta": "what to do here and exact neighbourhood",
          "fact": "one true surprising fact about this specific place",
          "costDisplay": "$5",
          "cost": 5,
          "costLevel": "low",
          "highlight": true,
          "bookingRequired": true,
          "bookingUrl": "https://real-booking-site.com",
          "infoUrl": "https://official-site-or-tripadvisor.com"
        },
        { "transport": "20 min walk / Bus 15 / tuk-tuk $1" },
        {
          "time": "11:30",
          "name": "REAL RESTAURANT NAME",
          "meta": "what to order and why",
          "fact": "fact about this place",
          "costDisplay": "$12",
          "cost": 12,
          "costLevel": "mid",
          "highlight": false,
          "bookingRequired": false,
          "bookingUrl": "",
          "infoUrl": "https://tripadvisor.com/..."
        }
      ]
    }
  ]
}

MANDATORY RULES:
1. "name" = REAL specific place name in ${city}. NEVER "local temple" or "street food stall".
2. "cost" = integer in USD (0 if free). Used to calculate total budget.
3. "costDisplay" = readable string like "$8", "free", "€12".
4. "bookingRequired" = true for famous museums, top restaurants, guided tours, shows. false for markets, open churches, walks.
5. "bookingUrl" = real URL to book (GetYourGuide, Viator, official site). Empty string if not needed.
6. "infoUrl" = real URL for info (official site, TripAdvisor, Google Maps). Always provide one.
7. "fact" = real verifiable fact about THAT specific place.
8. "cityNote" = concrete local tip about ${city}.
9. Include real named restaurants for every meal.
10. Generate EXACTLY ${n} day objects.`;
}

function buildQAPrompt(p) {
  const city     = p.city || 'the city';
  const existing = (p.existingActivities || []).length
    ? ' Current activities: ' + p.existingActivities.join(', ') + '.' : '';
  const ctx = 'I am in ' + city + (p.dayDate ? ' on ' + p.dayDate : '') + '.';

  const questions = {
    cheaper:  ctx + existing + ' Give me 4 real cheaper/free alternatives in ' + city + '.',
    closer:   ctx + ' Give me 4 real places within 15 min walk in ' + city + '.',
    outdoors: ctx + ' Give me 4 real outdoor activities near ' + city + '.',
    shorter:  ctx + existing + ' Give me 4 ways to shorten my day.',
    extend:   ctx + ' Give me 4 real evening venues in ' + city + ' (bars, live music, night markets).',
    alts:     ctx + existing + ' Give me 4 real backup options in ' + city + ' for rain or closures.'
  };

  return (questions[p.type] || ctx + ' Give me 4 things to do in ' + city + '.') + `

Return ONLY this JSON with exactly 4 options:
{"options":[{
  "label": "Real Place Name",
  "sub": "one sentence: what it is, distance, local tip",
  "costDisplay": "$X or free",
  "cost": 5,
  "costLevel": "low",
  "bookingRequired": false,
  "bookingUrl": "",
  "infoUrl": "https://..."
}]}

Rules: every label must be a REAL named place in ${city}. infoUrl must be a real URL.`;
}

function callAnthropic(message, maxTokens, res) {
  if (!API_KEY) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({error:'ANTHROPIC_API_KEY not set. Add it in Render Environment Variables.'}));
    return;
  }

  const body = JSON.stringify({
    model:      'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    system:     SYSTEM,
    messages:   [{role:'user', content:message}]
  });

  const req = https.request({
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    method:   'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length':    Buffer.byteLength(body)
    }
  }, apiRes => {
    let data = '';
    apiRes.on('data', c => { data += c; });
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.content && parsed.content[0]) {
          console.log('[Claude] preview:', parsed.content[0].text.slice(0, 200));
        } else if (parsed.error) {
          console.error('[Claude] error:', parsed.error);
        }
      } catch(e) {}
      res.writeHead(apiRes.statusCode, {'Content-Type':'application/json'});
      res.end(data);
    });
  });

  req.on('error', err => {
    console.error('[Request error]', err.message);
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({error: err.message}));
  });
  req.write(body);
  req.end();
}

function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try { cb(null, JSON.parse(body)); }
    catch(e) { cb(e); }
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, apiKey:!!API_KEY, port:PORT}));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/itinerary') {
    readBody(req, (err, p) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({error:'Bad JSON'})); return; }
      console.log('[/api/itinerary]', p.city, p.nDays+'d');
      const maxTok = Math.min(1500 + (parseInt(p.nDays)||3) * 1000, 6000);
      callAnthropic(buildItineraryPrompt(p), maxTok, res);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/qa') {
    readBody(req, (err, p) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({error:'Bad JSON'})); return; }
      console.log('[/api/qa]', p.type, 'in', p.city);
      callAnthropic(buildQAPrompt(p), 1400, res);
    });
    return;
  }

  if (req.method === 'GET') {
    const file = path.join(__dirname, 'pinpoint.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, {'Content-Type':'text/plain'});
      res.end('pinpoint.html not found');
      return;
    }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(fs.readFileSync(file));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('PinPoint running on port ' + PORT);
  console.log('API key:', API_KEY ? 'SET ('+API_KEY.length+' chars)' : 'MISSING');
  console.log('HTML:', fs.existsSync(path.join(__dirname,'pinpoint.html')) ? 'FOUND' : 'NOT FOUND');
});
