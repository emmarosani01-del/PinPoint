const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT              = process.env.PORT || 3000;
const API_KEY           = process.env.ANTHROPIC_API_KEY || '';
const SUPABASE_URL      = process.env.SUPABASE_URL || '';
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY || '';
// STRIPE (disabled) — uncomment to enable:
// const STRIPE_SECRET     = process.env.STRIPE_SECRET_KEY || '';
// const STRIPE_PRICE_MON  = process.env.STRIPE_PRICE_MONTHLY || '';
// const STRIPE_PRICE_YEAR = process.env.STRIPE_PRICE_YEARLY || '';
const STRIPE_SECRET = ''; const STRIPE_PRICE_MON = ''; const STRIPE_PRICE_YEAR = '';

console.log('=== PinPoint starting ===');
console.log('PORT:', PORT);
console.log('API_KEY:', API_KEY ? 'SET' : 'MISSING');
console.log('SUPABASE_URL:', SUPABASE_URL ? 'SET' : 'MISSING');
console.log('SUPABASE_KEY:', SUPABASE_KEY ? 'SET' : 'MISSING');
// console.log('STRIPE:', STRIPE_SECRET ? 'SET' : 'MISSING');
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

// Get saved itineraries for user
async function getUserItineraries(userId, userToken) {
  try {
    const r = await supabase('GET', '/rest/v1/itineraries?user_id=eq.' + userId + '&select=*&order=created_at.desc', null, userToken || null);
    if (r.status === 200) return r.body;
    return [];
  } catch(e) { return []; }
}

// Save itinerary to DB
async function saveItinerary(userId, title, cities, daysCount, data, startDate, endDate, userToken) {
  try {
    await supabase('POST', '/rest/v1/itineraries', {
      user_id: userId, title, cities, days_count: daysCount, data,
      start_date: startDate || null, end_date: endDate || null
    }, userToken || null);
  } catch(e) { console.error('Save itinerary error:', e.message); }
}

/* STRIPE HELPERS — uncomment to enable:
// ─── Stripe helper ───────────────────────────────────────────
function stripeRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const auth = 'Basic ' + Buffer.from(STRIPE_SECRET + ':').toString('base64');
    const headers = {
      'Authorization': auth,
      'Content-Type':  'application/x-www-form-urlencoded',
    };
    let payload = null;
    if (body && method !== 'GET') {
      // Convert JSON to URL-encoded for Stripe API
      try {
        const obj = typeof body === 'string' ? JSON.parse(body) : body;
        payload = flattenStripeParams(obj);
        headers['Content-Length'] = Buffer.byteLength(payload);
      } catch(e) { payload = body; }
    }
    const req = https.request({
      hostname: 'api.stripe.com',
      path:     endpoint,
      method,
      headers
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ error: { message: data } }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function flattenStripeParams(obj, prefix) {
  return Object.keys(obj).map(key => {
    const val = obj[key];
    const fullKey = prefix ? prefix + '[' + key + ']' : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      return flattenStripeParams(val, fullKey);
    } else if (Array.isArray(val)) {
      return val.map((item, i) => {
        if (typeof item === 'object') return flattenStripeParams(item, fullKey + '[' + i + ']');
        return encodeURIComponent(fullKey + '[' + i + ']') + '=' + encodeURIComponent(item);
      }).join('&');
    }
    return encodeURIComponent(fullKey) + '=' + encodeURIComponent(val);
  }).join('&');
}

*/

// Update user preferences
async function updatePreferences(userId, lang, currency) {
  try {
    await supabase('PATCH', '/rest/v1/profiles?id=eq.' + userId,
      { preferred_language: lang, preferred_currency: currency }, null);
  } catch(e) {}
}

// ─── Prompt builders ────────────────────────────────────────

const LANG_NAMES = {
  en:'English',es:'Spanish',it:'Italian',fr:'French',de:'German',
  pt:'Portuguese',ja:'Japanese',zh:'Chinese',ko:'Korean',
  ar:'Arabic',hi:'Hindi',ru:'Russian',nl:'Dutch',tr:'Turkish',pl:'Polish'
};

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
  const lang = p.language || 'en';
  const langName = LANG_NAMES[lang] || 'English';
  const langInstruction = lang !== 'en'
    ? `\nIMPORTANT: Write ALL text fields (meta, cityNote, fact, transport) in ${langName}. Keep place names in their original language.`
    : '';

  return `Create a ${n}-day travel itinerary for ${city}.

Days: ${p.dateStr || 'Day 1, Day 2, Day 3'}
Budget: ${budget}
Pace: ${pace}
Interests: ${p.interests || 'general sightseeing'}
${p.mustdo ? 'Must include: ' + p.mustdo : ''}${langInstruction}

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
  const lang = p.language || 'en';
  const langName = LANG_NAMES[lang] || 'English';
  const langInstruction = lang !== 'en'
    ? ` Write the "sub" field in ${langName}.` : '';

  const q = {
    cheaper:  ctx + ex + ' Give me 4 real cheaper/free alternatives in ' + city + '.',
    closer:   ctx + ' Give me 4 real places within 15 min walk in ' + city + '.',
    outdoors: ctx + ' Give me 4 real outdoor activities near ' + city + '.',
    shorter:  ctx + ex + ' Give me 4 ways to shorten my day.',
    extend:   ctx + ' Give me 4 real evening venues in ' + city + '.',
    alts:     ctx + ex + ' Give me 4 real backup options in ' + city + ' for rain or closures.'
  }[p.type] || ctx + ' Give me 4 things to do in ' + city + '.';

  return q + langInstruction + `

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
    const itins = await getUserItineraries(user.id, token);
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
      await saveItinerary(user.id, p.title, p.cities, p.daysCount, p.data, p.startDate, p.endDate, token);
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

  // ── Waitlist signup ──
  if (req.method === 'POST' && req.url === '/api/waitlist') {
    readBody(req, async (err, p) => {
      if (err) { json(400, { error: err.message }); return; }
      if (!p.email || !p.email.includes('@')) { json(400, { error: 'Invalid email' }); return; }
      try {
        await supabase('POST', '/rest/v1/waitlist', {
          email: p.email.toLowerCase().trim(),
          lang: p.lang || 'en',
          source: 'premium_modal'
        }, null);
        console.log('[waitlist] New signup:', p.email);
        json(200, { ok: true });
      } catch(e) { json(500, { error: e.message }); }
    });
    return;
  }

  // ── Save preferences ──
  if (req.method === 'POST' && req.url === '/api/preferences') {
    readBody(req, async (err, p) => {
      if (err) { json(400, { error: err.message }); return; }
      const token = getToken(req);
      const user  = await getUser(token);
      if (!user) { json(401, { error: 'Not authenticated' }); return; }
      await updatePreferences(user.id, p.language || 'en', p.currency || 'USD');
      json(200, { ok: true });
    });
    return;
  }

  // ── Update itinerary dates ──
  if (req.method === 'POST' && req.url === '/api/itineraries/dates') {
    readBody(req, async (err, p) => {
      if (err) { json(400, { error: err.message }); return; }
      const token = getToken(req);
      const user  = await getUser(token);
      if (!user) { json(401, { error: 'Not authenticated' }); return; }
      try {
        const r = await supabase('PATCH',
          '/rest/v1/itineraries?id=eq.' + p.id + '&user_id=eq.' + user.id,
          { start_date: p.startDate, end_date: p.endDate }, token);
        json(r.status < 300 ? 200 : r.status, r.status < 300 ? { ok: true } : r.body);
      } catch(e) { json(500, { error: e.message }); }
    });
    return;
  }

  // ── Get bucket list ──
  if (req.method === 'GET' && req.url === '/api/bucket') {
    const token = getToken(req);
    const user  = await getUser(token);
    if (!user) { json(401, { error: 'Not authenticated' }); return; }
    try {
      const r = await supabase('GET', '/rest/v1/bucket_list?user_id=eq.'+user.id+'&select=*&order=created_at.desc', null, token);
      json(200, { items: r.status===200 ? r.body : [] });
    } catch(e) { json(200, { items: [] }); }
    return;
  }

  // ── Add bucket item ──
  if (req.method === 'POST' && req.url === '/api/bucket') {
    readBody(req, async (err, p) => {
      if (err) { json(400, { error: err.message }); return; }
      const token = getToken(req);
      const user  = await getUser(token);
      if (!user) { json(401, { error: 'Not authenticated' }); return; }
      try {
        const r = await supabase('POST', '/rest/v1/bucket_list', {
          user_id: user.id, destination: p.destination,
          description: p.description||'', category: p.category||'destination'
        }, token);
        json(r.status < 300 ? 200 : r.status, r.status < 300 ? { ok: true } : r.body);
      } catch(e) { json(500, { error: e.message }); }
    });
    return;
  }

  // ── Delete bucket item ──
  if (req.method === 'DELETE' && req.url.startsWith('/api/bucket/')) {
    const id = req.url.split('/').pop();
    const token = getToken(req);
    const user  = await getUser(token);
    if (!user) { json(401, { error: 'Not authenticated' }); return; }
    try {
      await supabase('DELETE', '/rest/v1/bucket_list?id=eq.'+id+'&user_id=eq.'+user.id, null, token);
      json(200, { ok: true });
    } catch(e) { json(500, { error: e.message }); }
    return;
  }

  // ── Get blog posts ──
  if (req.method === 'GET' && req.url === '/api/blog/posts') {
    try {
      const r = await supabase('GET',
        '/rest/v1/blog_posts?select=*&order=created_at.desc&limit=50',
        null, null);
      json(200, { posts: r.status === 200 ? r.body : [] });
    } catch(e) { json(200, { posts: [] }); }
    return;
  }

  // ── Get comments for a post ──
  if (req.method === 'GET' && req.url.startsWith('/api/blog/comments/')) {
    const postId = req.url.split('/').pop();
    try {
      const r = await supabase('GET',
        '/rest/v1/blog_comments?post_id=eq.' + postId + '&select=*&order=created_at.asc',
        null, null);
      json(200, { comments: r.status === 200 ? r.body : [] });
    } catch(e) { json(200, { comments: [] }); }
    return;
  }

  // ── Publish blog post ──
  if (req.method === 'POST' && req.url === '/api/blog/posts') {
    readBody(req, async (err, p) => {
      if (err) { json(400, { error: err.message }); return; }
      const token = getToken(req);
      const user  = token ? await getUser(token) : null;
      const userId = user ? user.id : null;
      const authorName = user ? user.email.split('@')[0] : 'Guest';
      const colors = [
        'linear-gradient(135deg,#FF4C6A,#FF2050)',
        'linear-gradient(135deg,#9B6FFF,#7B4FFF)',
        'linear-gradient(135deg,#00E5C4,#00B89A)',
        'linear-gradient(135deg,#FFB830,#E09000)'
      ];
      const color = colors[Math.floor(Math.random() * colors.length)];
      try {
        const r = await supabase('POST', '/rest/v1/blog_posts', {
          user_id:         userId,
          author_name:     authorName,
          author_initial:  authorName[0].toUpperCase(),
          author_color:    color,
          dest:            p.dest,
          hero_title:      p.dest,
          emoji:           p.emoji || '✈️',
          tag_style:       'background:rgba(255,76,106,.2);color:#FF4C6A',
          title:           p.title,
          body:            p.body,
          tags:            p.tags || [],
          likes:           0
        }, token || null);
        json(r.status < 300 ? 200 : r.status, r.status < 300 ? { ok: true } : r.body);
      } catch(e) { json(500, { error: e.message }); }
    });
    return;
  }

  // ── Post a comment ──
  if (req.method === 'POST' && req.url === '/api/blog/comments') {
    readBody(req, async (err, p) => {
      if (err) { json(400, { error: err.message }); return; }
      const token = getToken(req);
      const user  = token ? await getUser(token) : null;
      const colors = ['linear-gradient(135deg,#FF4C6A,#FF2050)','linear-gradient(135deg,#9B6FFF,#7B4FFF)','linear-gradient(135deg,#00E5C4,#00B89A)','linear-gradient(135deg,#FFB830,#E09000)'];
      const color  = colors[Math.floor(Math.random() * colors.length)];
      const author = user ? user.email.split('@')[0] : 'Guest';
      try {
        const r = await supabase('POST', '/rest/v1/blog_comments', {
          post_id:     p.postId,
          user_id:     user ? user.id : null,
          author_name: author,
          author_color: color,
          text:        p.text
        }, token || null);
        json(r.status < 300 ? 200 : r.status, r.status < 300 ? { ok: true, author, color } : r.body);
      } catch(e) { json(500, { error: e.message }); }
    });
    return;
  }

  // ── Toggle like ──
  if (req.method === 'POST' && req.url === '/api/blog/like') {
    readBody(req, async (err, p) => {
      if (err) { json(400, { error: err.message }); return; }
      const token = getToken(req);
      const user  = await getUser(token);
      if (!user) { json(401, { error: 'Sign in to like posts' }); return; }
      try {
        // Check if already liked
        const check = await supabase('GET',
          '/rest/v1/blog_likes?user_id=eq.' + user.id + '&post_id=eq.' + p.postId,
          null, token);
        const alreadyLiked = check.status === 200 && check.body.length > 0;
        if (alreadyLiked) {
          await supabase('DELETE',
            '/rest/v1/blog_likes?user_id=eq.' + user.id + '&post_id=eq.' + p.postId,
            null, token);
          await supabase('PATCH', '/rest/v1/blog_posts?id=eq.' + p.postId,
            { likes: Math.max(0, (p.currentLikes||0) - 1) }, null);
          json(200, { liked: false, likes: Math.max(0, (p.currentLikes||0) - 1) });
        } else {
          await supabase('POST', '/rest/v1/blog_likes',
            { user_id: user.id, post_id: p.postId }, token);
          await supabase('PATCH', '/rest/v1/blog_posts?id=eq.' + p.postId,
            { likes: (p.currentLikes||0) + 1 }, null);
          json(200, { liked: true, likes: (p.currentLikes||0) + 1 });
        }
      } catch(e) { json(500, { error: e.message }); }
    });
    return;
  }

  /* STRIPE ENDPOINTS — uncomment to enable:
  // ── Stripe: Create checkout session ──
  if (req.method === 'POST' && req.url === '/api/stripe/checkout') {
    readBody(req, async (err, p) => {
      if (err) { json(400, { error: err.message }); return; }
      const token = getToken(req);
      const user  = await getUser(token);
      if (!user) { json(401, { error: 'Not authenticated' }); return; }
      if (!STRIPE_SECRET) { json(500, { error: 'Stripe not configured' }); return; }

      const priceId = p.plan === 'yearly' ? STRIPE_PRICE_YEAR : STRIPE_PRICE_MON;
      const appUrl  = p.appUrl || 'https://pinpoint.onrender.com';

      const stripeBody = JSON.stringify({
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: appUrl + '?payment=success&session_id={CHECKOUT_SESSION_ID}',
        cancel_url:  appUrl + '?payment=cancelled',
        client_reference_id: user.id,
        customer_email: user.email,
        subscription_data: {
          trial_period_days: 7,
          metadata: { user_id: user.id }
        }
      });

      try {
        const stripeRes = await stripeRequest('POST', '/v1/checkout/sessions', stripeBody);
        if (stripeRes.url) {
          json(200, { url: stripeRes.url, sessionId: stripeRes.id });
        } else {
          console.error('[Stripe] checkout error:', JSON.stringify(stripeRes));
          json(500, { error: stripeRes.error?.message || 'Stripe error' });
        }
      } catch(e) { json(500, { error: e.message }); }
    });
    return;
  }

  // ── Stripe: Webhook (payment confirmed) ──
  if (req.method === 'POST' && req.url === '/api/stripe/webhook') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const event = JSON.parse(body);
        console.log('[Stripe webhook]', event.type);
        if (event.type === 'checkout.session.completed' ||
            event.type === 'invoice.payment_succeeded') {
          const userId = event.data.object.client_reference_id ||
                         event.data.object.subscription_data?.metadata?.user_id;
          if (userId) {
            await supabase('PATCH', '/rest/v1/profiles?id=eq.' + userId,
              { plan: 'premium' }, null);
            console.log('[Stripe] Upgraded user', userId, 'to premium');
          }
        }
        if (event.type === 'customer.subscription.deleted') {
          const userId = event.data.object.metadata?.user_id;
          if (userId) {
            await supabase('PATCH', '/rest/v1/profiles?id=eq.' + userId,
              { plan: 'free' }, null);
            console.log('[Stripe] Downgraded user', userId, 'to free');
          }
        }
        res.writeHead(200); res.end('ok');
      } catch(e) {
        console.error('[Stripe webhook error]', e.message);
        res.writeHead(400); res.end('error');
      }
    });
    return;
  }

  // ── Stripe: Cancel subscription ──
  if (req.method === 'POST' && req.url === '/api/stripe/cancel') {
    readBody(req, async (err, p) => {
      if (err) { json(400, { error: err.message }); return; }
      const token = getToken(req);
      const user  = await getUser(token);
      if (!user) { json(401, { error: 'Not authenticated' }); return; }
      // Find subscription via customer email
      try {
        const customers = await stripeRequest('GET',
          '/v1/customers?email=' + encodeURIComponent(user.email) + '&limit=1', null);
        const customerId = customers.data?.[0]?.id;
        if (!customerId) { json(404, { error: 'No subscription found' }); return; }
        const subs = await stripeRequest('GET',
          '/v1/subscriptions?customer=' + customerId + '&status=active&limit=1', null);
        const subId = subs.data?.[0]?.id;
        if (!subId) { json(404, { error: 'No active subscription' }); return; }
        await stripeRequest('DELETE', '/v1/subscriptions/' + subId, null);
        await supabase('PATCH', '/rest/v1/profiles?id=eq.' + user.id,
          { plan: 'free' }, null);
        json(200, { ok: true });
      } catch(e) { json(500, { error: e.message }); }
    });
    return;
  }

  */

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
