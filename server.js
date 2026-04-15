const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT         = process.env.PORT || 3000;
const API_KEY      = process.env.ANTHROPIC_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

console.log('=== PinPoint starting ===');
console.log('PORT:', PORT);
console.log('API_KEY:', API_KEY ? 'SET' : 'MISSING');
console.log('SUPABASE_URL:', SUPABASE_URL ? 'SET' : 'MISSING');
console.log('SUPABASE_KEY:', SUPABASE_KEY ? 'SET' : 'MISSING');
console.log('HTML:', fs.existsSync(path.join(__dirname,'pinpoint.html')) ? 'FOUND' : 'NOT FOUND');

// ─── Supabase helpers ────────────────────────────────────────

function supabase(method, endpoint, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': token ? 'Bearer ' + token : 'Bearer ' + SUPABASE_KEY,
    };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const url = new URL(SUPABASE_URL + endpoint);
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Verify JWT token with Supabase and return user
async function getUser(token) {
  if (!token) return null;
  try {
    const r = await supabase('GET', '/auth/v1/user', null, token);
    if (r.status === 200 && r.body.id) return r.body;
    return null;
  } catch(e) { return null; }
}

// Get user profile (plan, trip_count)
async function getProfile(userId) {
  try {
    const r = await supabase('GET', '/rest/v1/profiles?id=eq.' + userId + '&select=*', null, null);
    if (r.status === 200 && r.body.length) return r.body[0];
    return null;
  } catch(e) { return null; }
}

// Increment trip count
async function incrementTripCount(userId, currentCount) {
  try {
    await supabase('PATCH', '/rest/v1/profiles?id=eq.' + userId, { trip_count: currentCount + 1 }, null);
  } catch(e) {}
}

// Save itinerary to DB
async function saveItinerary(userId, title, cities, daysCount, data) {
  try {
    await supabase('POST', '/rest/v1/itineraries', { user_id: userId, title, cities, days_count: daysCount, data }, null);
  } catch(e) {}
}

// Get saved itineraries for user
async function getUserItineraries(userId) {
  try {
    const r = await supabase('GET', '/rest/v1/itineraries?user_id=eq.' + userId + '&select=*&order=created_at.desc', null, null);
    if (r.status === 200) return r.body;
    return [];
  } catch(e) { return []; }
}

// ─── Prompt builders ────────────────────────────────────────

function itineraryPrompt(p) {
  const budget = {
    low:      'backpacker under $30/day (hostels, street food, free attractions)',
    medium:   'mid-range $30-80/day (guesthouses, restaurants, paid attractions)',
    flexible: 'comfortable $80+/day (hotels, fine dining, any attraction)'
  }[p.budget] || p.budget || 'mid-range';

  const pace = {
    chill:    '2-3 activities per day, relaxed',
    balanced: '4-5 activities per day',
    intense:  '6-7 activities per day, packed'
  }[p.pace] || p.pace || 'balanced';

  const n    = parseInt(p.nDays) || 3;
  const city = p.city || 'Rome';

  return `Create a ${n}-day travel itinerary for ${city}.

Days: ${p.dateStr || 'Day 1, Day 2, Day 3'}
Budget: ${budget}
Pace: ${pace}
Interests: ${p.interests || 'general sightseeing'}
${p.mustdo ? 'Must include: ' + p.mustdo : ''}

Respond with ONLY valid JSON. No markdown. No backticks. Start with { end with }.

{
  "days": [
    {
      "label": "Day 1",
      "date": "${p.firstDate || 'Day 1'}",
      "city": "${city}",
      "cityNote": "one specific insider tip about ${city} most tourists never know",
      "items": [
        {
          "time": "9:00",
          "name": "REAL PLACE NAME e.g. Pantheon",
          "meta": "what to do here and exact neighbourhood",
          "fact": "one true surprising fact about this specific place",
          "costDisplay": "$5",
          "cost": 5,
          "costLevel": "low",
          "highlight": true,
          "bookingRequired": false,
          "bookingUrl": "",
          "infoUrl": "https://www.tripadvisor.com/..."
        },
        { "transport": "15 min walk to next area" },
        {
          "time": "11:30",
          "name": "REAL RESTAURANT NAME",
          "meta": "what to order here",
          "fact": "fact about this place",
          "costDisplay": "$12",
          "cost": 12,
          "costLevel": "mid",
          "highlight": false,
          "bookingRequired": false,
          "bookingUrl": "",
          "infoUrl": ""
        }
      ]
    }
  ]
}

RULES (no exceptions):
1. name = real specific place that exists in ${city}. NEVER "local temple" or "street food stall".
2. cost = integer USD (0 if free). Used for budget calculation.
3. costDisplay = readable e.g. "$8" or "free".
4. bookingRequired = true only for famous museums, top restaurants, guided tours, shows.
5. bookingUrl = real URL to book (GetYourGuide, Viator, official site). Empty string otherwise.
6. infoUrl = real URL for info (TripAdvisor, official site, Google Maps). Always provide.
7. fact = real verifiable fact about THAT specific place.
8. cityNote = concrete local tip about ${city}.
9. Include real named restaurants for every meal.
10. Generate EXACTLY ${n} day objects.`;
}

function qaPrompt(p) {
  const city = p.city || 'the city';
  const ex   = (p.existingActivities || []).length
    ? ' Current activities: ' + p.existingActivities.join(', ') + '.' : '';
  const ctx  = 'I am in ' + city + (p.dayDate ? ' on ' + p.dayDate : '') + '.';

  const q = {
    cheaper:  ctx + ex + ' Give me 4 real cheaper/free alternatives in ' + city + '.',
    closer:   ctx + ' Give me 4 real places within 15 min walk in ' + city + '.',
    outdoors: ctx + ' Give me 4 real outdoor activities near ' + city + '.',
    shorter:  ctx + ex + ' Give me 4 ways to shorten my day.',
    extend:   ctx + ' Give me 4 real evening venues in ' + city + '.',
    alts:     ctx + ex + ' Give me 4 real backup options in ' + city + ' for rain or closures.'
  }[p.type] || ctx + ' Give me 4 things to do in ' + city + '.';

  return q + `

Respond with ONLY valid JSON. Start with { end with }.
{
  "options": [
    {
      "label": "Real Place Name",
      "sub": "one sentence: what it is, how far, local tip",
      "costDisplay": "$X or free",
      "cost": 5,
      "costLevel": "low",
      "bookingRequired": false,
      "bookingUrl": "",
      "infoUrl": "https://..."
    }
  ]
}
Exactly 4 options. Every label must be a real named place in ${city}.`;
}

// ─── Claude caller ───────────────────────────────────────────

function askClaude(message, maxTokens, res) {
  if (!API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set.' }));
    return;
  }

  const body = JSON.stringify({
    model:      'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    system:     'You are an expert local travel guide. Respond ONLY with valid JSON on a SINGLE LINE. No markdown. No backticks. No newlines inside the JSON. No text outside the JSON object. First character is { and last is }.',
    messages:   [{ role: 'user', content: message }]
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
        if (parsed.content?.[0]) console.log('[Claude OK]', parsed.content[0].text.slice(0, 100));
        else if (parsed.error)   console.error('[Claude ERR]', parsed.error);
      } catch(e) {}
      res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(data);
    });
  });

  req.on('error', err => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
  req.write(body);
  req.end();
}

// ─── HTTP server ─────────────────────────────────────────────

function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try { cb(null, JSON.parse(body)); }
    catch(e) { cb(new Error('Invalid JSON')); }
  });
}

function getToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const json = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    json(200, { ok: true, apiKey: !!API_KEY, supabase: !!SUPABASE_URL, port: PORT });
    return;
  }

  // ── Auth: Sign up ──
  if (req.method === 'POST' && req.url === '/api/auth/signup') {
    readBody(req, async (err, p) => {
      if (err) { json(400, { error: err.message }); return; }
      try {
        const r = await supabase('POST', '/auth/v1/signup', {
          email: p.email, password: p.password
        }, null);
        json(r.status, r.body);
      } catch(e) { json(500, { error: e.message }); }
    });
    return;
  }

  // ── Auth: Sign in ──
  if (req.method === 'POST' && req.url === '/api/auth/signin') {
    readBody(req, async (err, p) => {
      if (err) { json(400, { error: err.message }); return; }
      try {
        const r = await supabase('POST', '/auth/v1/token?grant_type=password', {
          email: p.email, password: p.password
        }, null);
        json(r.status, r.body);
      } catch(e) { json(500, { error: e.message }); }
    });
    return;
  }

  // ── Auth: Get current user + profile ──
  if (req.method === 'GET' && req.url === '/api/auth/me') {
    const token = getToken(req);
    const user  = await getUser(token);
    if (!user) { json(401, { error: 'Not authenticated' }); return; }
    const profile = await getProfile(user.id);
    json(200, { user, profile });
    return;
  }

  // ── Get saved itineraries ──
  if (req.method === 'GET' && req.url === '/api/itineraries') {
    const token = getToken(req);
    const user  = await getUser(token);
    if (!user) { json(401, { error: 'Not authenticated' }); return; }
    const itins = await getUserItineraries(user.id);
    json(200, { itineraries: itins });
    return;
  }

  // ── Generate itinerary ──
  if (req.method === 'POST' && req.url === '/api/itinerary') {
    readBody(req, async (err, p) => {
      if (err) { json(400, { error: err.message }); return; }

      // Auth check
      const token   = getToken(req);
      const user    = token ? await getUser(token) : null;
      const profile = user ? await getProfile(user.id) : null;

      // Free plan limit enforcement
      if (user && profile && profile.plan === 'free') {
        if (profile.trip_count >= 2) {
          json(403, { error: 'FREE_LIMIT_REACHED', message: 'Free plan allows 2 trips. Upgrade to Premium for unlimited.' });
          return;
        }
        await incrementTripCount(user.id, profile.trip_count);
      }

      console.log('[/api/itinerary]', p.city, p.nDays + 'd', user ? '(user: ' + user.email + ')' : '(guest)');
      const maxTok = Math.min(1500 + (parseInt(p.nDays) || 3) * 1000, 6000);
      askClaude(itineraryPrompt(p), maxTok, res);
    });
    return;
  }

  // ── Save itinerary ──
  if (req.method === 'POST' && req.url === '/api/itineraries/save') {
    readBody(req, async (err, p) => {
      if (err) { json(400, { error: err.message }); return; }
      const token = getToken(req);
      const user  = await getUser(token);
      if (!user) { json(401, { error: 'Not authenticated' }); return; }
      await saveItinerary(user.id, p.title, p.cities, p.daysCount, p.data);
      json(200, { ok: true });
    });
    return;
  }

  // ── Quick adjustments ──
  if (req.method === 'POST' && req.url === '/api/qa') {
    readBody(req, (err, p) => {
      if (err) { json(400, { error: err.message }); return; }
      console.log('[/api/qa]', p.type, 'in', p.city);
      askClaude(qaPrompt(p), 1400, res);
    });
    return;
  }

  // ── Serve HTML ──
  if (req.method === 'GET') {
    const file = path.join(__dirname, 'pinpoint.html');
    if (!fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>pinpoint.html not found</h1>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('PinPoint listening on port ' + PORT);
});
