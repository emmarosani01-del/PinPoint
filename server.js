const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

const SYSTEM =
  'You are an expert local travel guide with encyclopedic knowledge of every city on earth. ' +
  'You know the REAL names of specific restaurants, temples, markets, viewpoints, and streets. ' +
  'You ALWAYS respond with a single valid JSON object and NOTHING else. ' +
  'No markdown. No backticks. No explanation. No text before or after the JSON. ' +
  'Your very first character is { and your very last character is }.';

function buildItineraryPrompt(params) {
  const { city, nDays, budget, pace, interests, mustdo, startPt, firstDayNum, firstDate, dateStr } = params;

  const budgetDesc = {
    low:      'backpacker budget — hostels, street food, free/cheap attractions, under $30/day',
    medium:   'mid-range — guesthouses, sit-down restaurants, paid attractions, $30-80/day',
    flexible: 'comfortable — nice hotels, good restaurants, any attraction, $80+/day'
  }[budget] || budget;

  const paceDesc = {
    chill:    '2-3 activities per day, relaxed pace with rest time',
    balanced: '4-5 activities per day, moderate pace',
    intense:  '6-7 activities per day, packed schedule'
  }[pace] || pace;

  return `Create a ${nDays}-day travel itinerary for ${city}.

Days: ${dateStr}
Budget: ${budgetDesc}
Pace: ${paceDesc}
Interests: ${interests || 'general sightseeing'}
${mustdo ? 'Must include: ' + mustdo : ''}
${startPt ? 'Starting from: ' + startPt : ''}

Return this exact JSON structure with ${nDays} day objects:

{
  "days": [
    {
      "label": "Day ${firstDayNum}",
      "date": "${firstDate}",
      "city": "${city}",
      "cityNote": "One specific insider tip or surprising fact about ${city} that most tourists don't know",
      "items": [
        {
          "time": "8:30",
          "name": "Exact Real Place Name",
          "meta": "What to do here and which neighbourhood it is in",
          "fact": "One true surprising fact about this specific place",
          "cost": "$3",
          "costLevel": "low",
          "highlight": true
        },
        { "transport": "20 min walk / Bus 15 / tuk-tuk $1" },
        {
          "time": "10:30",
          "name": "Another Real Place Name",
          "meta": "Description of what it is",
          "fact": "Interesting fact about this place",
          "cost": "free",
          "costLevel": "free",
          "highlight": false
        }
      ]
    }
  ]
}

MANDATORY RULES:
1. "name" must ALWAYS be the real specific name of a place that exists in ${city}. Example good names: "Mercado 20 de Noviembre", "Wat Pho", "Jama Masjid", "Trattoria da Remo", "Bar Marsella". NEVER write "local temple" or "historic market" or "street food stall".
2. "fact" must be a genuine verifiable fact about THAT specific place — its history, a record it holds, an unusual feature, something surprising.
3. "cityNote" must be a concrete local tip about ${city} — a timing trick, a hidden spot, a food secret, something specific.
4. Name real restaurants for breakfast, lunch and dinner.
5. Transport connectors must name the real method (bus number, metro line, tuk-tuk cost, walking time).
6. Generate EXACTLY ${nDays} day objects — no more, no fewer.`;
}

function buildQAPrompt(params) {
  const { type, city, dayLabel, dayDate, existingActivities } = params;

  const context = `I am in ${city}${dayDate ? ' on ' + dayDate : ''} (${dayLabel}).`;
  const existing = existingActivities && existingActivities.length
    ? ' Current activities: ' + existingActivities.join(', ') + '.'
    : '';

  const questions = {
    cheaper:  `${context}${existing} Give me 4 specific cheaper or free alternatives that are real named places in ${city}.`,
    closer:   `${context} Give me 4 specific places or activities within easy walking distance (under 15 min) in ${city}. Use real venue names and neighbourhood names.`,
    outdoors: `${context} Give me 4 specific outdoor activities, parks, viewpoints or nature spots that actually exist in or near ${city}.`,
    shorter:  `${context}${existing} Give me 4 specific suggestions to shorten my day — what to skip or replace, with time saved.`,
    extend:   `${context} Give me 4 specific evening venues that actually exist in ${city} — bars, live music, night markets, rooftop bars, shows.`,
    alts:     `${context}${existing} My plans might change. Give me 4 specific backup options in ${city} for rain, closures or last-minute changes.`,
  };

  return `${questions[type] || questions.alts}

Return this exact JSON with exactly 4 options:
{
  "options": [
    {
      "label": "Real Place or Activity Name",
      "sub": "One sentence: what it is, why it fits, how far, any tip",
      "cost": "$X or free",
      "costLevel": "free"
    }
  ]
}

Rules: every "label" must be a real named place or activity in ${city}. No generic descriptions.`;
}

function callAnthropic(userMessage, maxTokens, callback) {
  if (!API_KEY) {
    callback(null, { error: 'ANTHROPIC_API_KEY not set on server' });
    return;
  }

  const payload = JSON.stringify({
    model:      'claude-sonnet-4-20250514',
    max_tokens: maxTokens || 4000,
    system:     SYSTEM,
    messages:   [{ role: 'user', content: userMessage }]
  });

  const opts = {
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    method:   'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length':    Buffer.byteLength(payload)
    }
  };

  const req = https.request(opts, res => {
    let data = '';
    res.on('data', c => { data += c; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        // Log what Claude actually returned (first 400 chars)
        if (parsed.content && parsed.content[0]) {
          const preview = parsed.content[0].text.slice(0, 400);
          console.log('Claude response preview:', preview);
        } else if (parsed.error) {
          console.error('Claude error:', parsed.error);
        }
        callback(null, parsed);
      } catch(e) {
        callback(e, null);
      }
    });
  });

  req.on('error', err => callback(err, null));
  req.write(payload);
  req.end();
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── /api/itinerary — build and execute itinerary prompt server-side ──
  if (req.method === 'POST' && req.url === '/api/itinerary') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body); } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
      }

      const prompt = buildItineraryPrompt(p);
      const maxTok = Math.min(1500 + (p.nDays || 1) * 900, 5000);

      console.log('\n=== ITINERARY REQUEST:', p.city, p.nDays + ' days ===');
      console.log('Prompt length:', prompt.length, 'chars');

      callAnthropic(prompt, maxTok, (err, data) => {
        if (err) {
          res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return;
        }
        res.writeHead(data.error ? 400 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      });
    });
    return;
  }

  // ── /api/qa — quick adjustment prompt server-side ──
  if (req.method === 'POST' && req.url === '/api/qa') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body); } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
      }

      const prompt = buildQAPrompt(p);
      console.log('\n=== QA REQUEST:', p.type, 'for', p.city, '===');

      callAnthropic(prompt, 1200, (err, data) => {
        if (err) {
          res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return;
        }
        res.writeHead(data.error ? 400 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      });
    });
    return;
  }

  // ── /api/generate — legacy endpoint (kept for compatibility) ──
  if (req.method === 'POST' && req.url === '/api/generate') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let client;
      try { client = JSON.parse(body); } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
      }
      const payload = JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: Math.min(client.max_tokens || 4000, 8000),
        system:     SYSTEM,
        messages:   client.messages
      });
      const opts = {
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload)
        }
      };
      const apiReq = https.request(opts, apiRes => {
        let data = '';
        apiRes.on('data', c => { data += c; });
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });
      apiReq.on('error', err => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
      apiReq.write(payload); apiReq.end();
    });
    return;
  }

  // ── serve HTML ──
  if (req.method === 'GET') {
    const file = path.join(__dirname, 'pinpoint.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('pinpoint.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('PinPoint running on port ' + PORT);
  if (!API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY is not set!');
});
