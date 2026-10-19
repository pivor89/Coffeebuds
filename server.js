const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const db = require('./src/db');
const { seed, removeDemoAccounts, coarsenHomeLocations, deleteUserCascade } = require('./src/seed');
const stats = require('./src/stats');
const images = require('./src/images');
const { findRecipients, normalizeTopic, haversineMiles, clampRadius, MATCH_RADIUS_MI } = require('./src/matching');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PROD = process.env.NODE_ENV === 'production';
if (PROD && !process.env.SESSION_SECRET) { console.error('SESSION_SECRET must be set in production.'); process.exit(1); }
if (!process.env.SESSION_SECRET) console.warn('WARNING: SESSION_SECRET not set; using an insecure dev fallback. Set SESSION_SECRET in production.');
const UA = 'CoffeeBuds/1.0 (demo app)';
// Render puts exactly one proxy in front of us; trusting only that hop keeps req.ip (used by rate limits) unspoofable via X-Forwarded-For.
const tp = process.env.TRUST_PROXY ?? '1';
app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? true : tp === 'false' ? false : tp);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: { useDefaults: false, directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https://unpkg.com'],
    scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com'], // inline style attrs are used by the UI and Leaflet
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'], // OSM tiles + user https avatar URLs
    connectSrc: ["'self'", 'https://nominatim.openstreetmap.org', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://unpkg.com'],
    workerSrc: ["'self'"], manifestSrc: ["'self'"], frameSrc: ["'none'"], frameAncestors: ["'none'"], objectSrc: ["'none'"],
    baseUri: ["'self'"], formAction: ["'self'"], ...(PROD ? { upgradeInsecureRequests: [] } : {}),
  } },
  crossOriginEmbedderPolicy: false, // cross-origin tiles/fonts/avatars
  strictTransportSecurity: PROD ? { maxAge: 31536000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use((req, res, next) => { res.set('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()'); next(); });
app.use(express.json({ limit: '20kb' }));
// CSRF: every state-changing API call must carry a custom header (forces a CORS preflight, which we never allow) and,
// when the browser sends Origin, it must be our own host. Combined with SameSite=Lax cookies.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/mod/')) return next(); // machine API: Bearer token only, no cookies -> not CSRF-able
  const origin = req.get('origin');
  let originOk = true;
  if (origin) { try { originOk = new URL(origin).host === req.get('host'); } catch { originOk = false; } }
  if (req.get('x-requested-with') !== 'CoffeeBuds' || !originOk) return res.status(403).json({ error: 'Request blocked (CSRF check failed). Refresh and try again.' });
  next();
});
let sessionMw;
app.use((req, res, next) => sessionMw(req, res, next));
const sessionOpts = {
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me', resave: false, saveUninitialized: false,
  proxy: true, name: 'cb.sid',
  // Production: always Secure. Dev: 'auto' (Secure over HTTPS, plain on http://localhost).
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROD ? true : 'auto', maxAge: 1000 * 60 * 60 * 24 * 14 },
};
// Theme switcher (legacy): Paris is now the default for every visitor; the client ignores classic/lounge cookies.
// The cookie handling below is kept but has no visible effect on the look.
const THEMES = ['paris', 'lounge'];
app.use((req, res, next) => {
  const t = typeof req.query.theme === 'string' ? req.query.theme.toLowerCase() : null;
  if (t && THEMES.includes(t)) res.cookie('theme', t, { sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 365, path: '/' });
  else if (t && ['classic', 'default', 'none'].includes(t)) res.clearCookie('theme', { path: '/' });
  next();
});
app.get('/sw.js', (req, res) => {
  res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Service-Worker-Allowed': '/' });
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.get('/manifest.webmanifest', (req, res) => {
  res.set({ 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.ico')));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
// User images live in the DB under unguessable random ids; content never changes for an id, so cache it for a year.
app.get('/img/:imgId', async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.imgId)) return res.status(404).end();
  const row = await db.get('SELECT mime,data FROM images WHERE id=?', [req.params.imgId]);
  if (!row) return res.status(404).set('Cache-Control', 'no-store').end();
  res.set({ 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'same-origin' });
  res.send(Buffer.from(row.data));
});
app.use(stats.middleware);
app.use(express.static(path.join(__dirname, 'public')));

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const limiter = (windowMin, limit, msg) => rateLimit({ windowMs: windowMin * 60e3, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  skip: () => process.env.DISABLE_RATE_LIMIT === '1' && !PROD, handler: (req, res) => bad(res, msg, 429) });
const loginLimiter = limiter(15, 10, 'Too many login attempts. Please wait 15 minutes and try again.');
const signupLimiter = limiter(60, 5, 'Too many sign-ups from this network. Please try again later.');
const inviteLimiter = limiter(60, 20, "You're creating invites too quickly. Please try again later.");
const uploadLimiter = limiter(60, 30, 'Too many uploads. Please try again later.');
const postLimiter = limiter(60, 10, "You're posting too quickly — try again in a bit.");
const rawImage = express.raw({ type: ['image/*', 'application/octet-stream'], limit: images.MAX_INPUT_BYTES });
const reportLimiter = limiter(60, 10, 'Too many reports. Please try again later.');
const BCRYPT_COST = 12;
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-password', BCRYPT_COST);
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const isId = (v) => /^\d{1,10}$/.test(String(v));
// Home locations are stored rounded to 2 decimals (~1 km) so even a DB leak never reveals an exact address; plenty for 1-15 mile matching.
const coarse = (n) => Math.round(Number(n) * 100) / 100;
const blockedWith = (me) => db.all('SELECT blocked_id AS id FROM blocks WHERE blocker_id=? UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id=?', [me, me])
  .then((r) => new Set(r.map((x) => x.id)));
// Every authenticated request re-checks the account: deleted or suspended users lose access immediately.
const auth = async (req, res, next) => {
  if (!req.session.userId) return bad(res, 'Please log in.', 401);
  const u = await db.get('SELECT email,suspended_at FROM users WHERE id=?', [req.session.userId]);
  if (!u || u.suspended_at) { req.session.destroy(() => {}); return bad(res, u ? 'This account is suspended.' : 'Please log in.', u ? 403 : 401); }
  req.userEmail = u.email; next();
};
const ADMIN_EMAILS = new Set(String(process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
const isAdminEmail = (e) => ADMIN_EMAILS.has(String(e || '').toLowerCase());
const adminAuth = (req, res, next) => auth(req, res, () => (isAdminEmail(req.userEmail) ? next() : bad(res, 'Not found', 404)));
const isNum = (v) => v !== '' && v != null && !isNaN(Number(v));
const validLatLng = (lat, lng) => isNum(lat) && isNum(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

async function userPayload(id) {
  const u = await db.get('SELECT id,email,name,photo_url,location_label,lat,lng,max_distance_mi FROM users WHERE id=?', [id]);
  if (!u) return null;
  u.is_admin = isAdminEmail(u.email);
  u.topics = await db.all('SELECT topic,label,role FROM topics WHERE user_id=? ORDER BY role,label', [id]);
  u.unread = (await db.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0', [id])).c;
  return u;
}
async function notify(userId, type, message, inviteId) {
  await db.run('INSERT INTO notifications(user_id,type,message,invite_id) VALUES (?,?,?,?)', [userId, type, message, inviteId]);
}

// ---------- Auth ----------
app.post('/api/signup', signupLimiter, async (req, res) => {
  const { email, password, name } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return bad(res, 'Please enter a valid email.');
  if (e.length > 254) return bad(res, 'Please enter a valid email.');
  if (typeof password !== 'string' || password.length < 8) return bad(res, 'Password must be at least 8 characters.');
  if (password.length > 128 || Buffer.byteLength(password) > 72) return bad(res, 'Password is too long (max 72 bytes).');
  if (typeof name !== 'string' || !name.trim()) return bad(res, 'Please enter your name.');
  if (await db.get('SELECT id FROM users WHERE email=?', [e])) return bad(res, 'An account with that email already exists. Try logging in.', 409);
  const id = await db.run('INSERT INTO users(email,password_hash,name) VALUES (?,?,?)', [e, await bcrypt.hash(password, BCRYPT_COST), str(name, 80)]);
  const payload = await userPayload(id);
  req.session.regenerate((err) => { if (err) return bad(res, 'Session error.', 500); req.session.userId = id; res.status(201).json(payload); });
});
app.post('/api/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const pw = typeof password === 'string' ? password.slice(0, 128) : '';
  const u = await db.get('SELECT id,password_hash,suspended_at FROM users WHERE email=?', [str(email, 254).toLowerCase()]);
  // Always run one bcrypt compare so response time doesn't reveal whether the email exists.
  const okPw = await bcrypt.compare(pw, u ? u.password_hash : DUMMY_HASH);
  if (!u || !okPw) return bad(res, 'Incorrect email or password.', 401);
  if (u.suspended_at) return bad(res, 'This account is suspended. Contact support if you think this is a mistake.', 403);
  if (bcrypt.getRounds(u.password_hash) < BCRYPT_COST) await db.run('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(pw, BCRYPT_COST), u.id]); // upgrade legacy cost-10 hashes
  const payload = await userPayload(u.id);
  req.session.regenerate((err) => { if (err) return bad(res, 'Session error.', 500); req.session.userId = u.id; res.json(payload); });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => { res.clearCookie('cb.sid', { path: '/' }); res.json({ ok: true }); }));
app.get('/api/me', auth, async (req, res) => res.json(await userPayload(req.session.userId)));

// ---------- Profile ----------
app.put('/api/profile', auth, async (req, res) => {
  const { name, location_label, lat, lng, max_distance_mi } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return bad(res, 'Name is required.');
  if (name.trim().length > 80) return bad(res, 'Name must be 80 characters or fewer.');
  if (location_label != null && String(location_label).length > 200) return bad(res, 'Location must be 200 characters or fewer.');
  const hasLoc = isNum(lat) || isNum(lng);
  if (hasLoc && !validLatLng(lat, lng)) return bad(res, 'Latitude/longitude are invalid.');
  // Optional: "Only invite me to meetups within N miles" (integer 1-15). Omitted -> keep the current value.
  const maxDist = max_distance_mi == null || max_distance_mi === '' ? null : clampRadius(max_distance_mi);
  if (max_distance_mi != null && max_distance_mi !== '' && maxDist == null) return bad(res, 'Distance must be a number of miles between 1 and 15.');
  await db.run('UPDATE users SET name=?,location_label=?,lat=?,lng=?,max_distance_mi=COALESCE(?,max_distance_mi) WHERE id=?',
    [name.trim(), str(location_label, 200) || null, hasLoc ? coarse(lat) : null, hasLoc ? coarse(lng) : null, maxDist, req.session.userId]);
  res.json(await userPayload(req.session.userId));
});
// Profile photo: client sends the (already resized) image bytes; we sniff, re-encode to 512px WebP without metadata and store it.
const ownImageId = (url) => (typeof url === 'string' && /^\/img\/([a-f0-9]{32})$/.exec(url)?.[1]) || null;
app.post('/api/profile/photo', auth, uploadLimiter, rawImage, async (req, res) => {
  let img; try { img = await images.processImage(req.body, 512); } catch (e) { return bad(res, e.user ? e.message : 'Upload failed.'); }
  const me = req.session.userId, prev = ownImageId((await db.get('SELECT photo_url FROM users WHERE id=?', [me]))?.photo_url);
  await db.tx(async () => {
    const id = await images.saveImage(me, img, 'avatar');
    await db.run('UPDATE users SET photo_url=? WHERE id=?', ['/img/' + id, me]);
    if (prev) await db.run("DELETE FROM images WHERE id=? AND owner_id=? AND kind='avatar'", [prev, me]);
  });
  res.status(201).json(await userPayload(me));
});
app.delete('/api/profile/photo', auth, async (req, res) => {
  const me = req.session.userId, prev = ownImageId((await db.get('SELECT photo_url FROM users WHERE id=?', [me]))?.photo_url);
  await db.run('UPDATE users SET photo_url=NULL WHERE id=?', [me]);
  if (prev) await db.run("DELETE FROM images WHERE id=? AND owner_id=? AND kind='avatar'", [prev, me]);
  res.json(await userPayload(me));
});
app.put('/api/topics', auth, async (req, res) => {
  const list = Array.isArray(req.body?.topics) ? req.body.topics : null;
  if (!list) return bad(res, 'topics must be an array.');
  if (list.length > 40) return bad(res, 'Up to 40 topics, please.');
  const clean = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') return bad(res, 'Invalid topic.');
    const label = String(t.label || t.topic || '').trim().slice(0, 60), topic = normalizeTopic(label);
    if (!topic) continue;
    if (!['learn', 'teach'].includes(t.role)) return bad(res, `Invalid role for "${label}".`);
    if (!clean.some((c) => c.topic === topic && c.role === t.role)) clean.push({ topic, label, role: t.role });
  }
  await db.tx(async () => {
    await db.run('DELETE FROM topics WHERE user_id=?', [req.session.userId]);
    for (const c of clean) await db.run('INSERT INTO topics(user_id,topic,label,role) VALUES (?,?,?,?)', [req.session.userId, c.topic, c.label, c.role]);
  });
  res.json(await userPayload(req.session.userId));
});
app.get('/api/topics/popular', auth, async (req, res) =>
  res.json(await db.all('SELECT topic, MIN(label) label, COUNT(*) n FROM topics GROUP BY topic ORDER BY n DESC LIMIT 20')));

// ---------- Geo (OpenStreetMap, with graceful fallback) ----------
async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), opts.timeout || 8000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}
// Nominatim policy: max 1 req/sec -> serialize calls; cache results to avoid rate limits
let overpassDownUntil = 0;
const cache = new Map(); const TTL = 15 * 60 * 1000;
const cached = async (key, fn) => { const c = cache.get(key); if (c && c.t > Date.now() - TTL) return c.v; const v = await fn(); cache.set(key, { v, t: Date.now() }); if (cache.size > 500) cache.delete(cache.keys().next().value); return v; };
let nomChain = Promise.resolve();
function nominatim(url) {
  const run = nomChain.then(() => fetchJson(url));
  nomChain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
  return run;
}
async function geocode(q) {
  const data = await cached('geo:' + q.toLowerCase(), () => nominatim('https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' + encodeURIComponent(q)));
  return data.map((d) => ({ label: d.display_name, lat: Number(d.lat), lng: Number(d.lon) }));
}
app.get('/api/geocode', auth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length > 200) return bad(res, 'Search is too long.');
  if (q.length < 3) return bad(res, 'Type at least 3 characters.');
  try { res.json(await geocode(q)); }
  catch { bad(res, 'Geocoding is unavailable right now — enter latitude/longitude manually.', 503); }
});
app.get('/api/shops/nearby', auth, async (req, res) => {
  const { lat, lng } = req.query;
  if (!validLatLng(lat, lng)) return bad(res, 'Set your location first (lat/lng).');
  const la0 = Number(lat), lo0 = Number(lng);
  const radiusM = Math.min(Number(req.query.radius_m) || 5000, 15000);
  const local = (await db.all('SELECT * FROM shops')).map((s) => ({ ...s, source: 'saved', distance: haversineMiles(+lat, +lng, s.lat, s.lng) }))
    .filter((s) => s.distance <= MATCH_RADIUS_MI)
    .filter((s, i, arr) => arr.findIndex((o) => o.name.toLowerCase() === s.name.toLowerCase() && Math.abs(o.lat - s.lat) < 0.002) === i);
  let osm = [], warning = null;
  try {
    if (Date.now() < overpassDownUntil) throw new Error('overpass circuit open');
    const q = `[out:json][timeout:10];(node["amenity"="cafe"](around:${radiusM},${la0},${lo0});way["amenity"="cafe"](around:${radiusM},${la0},${lo0}););out center 40;`;
    const data = await cached(`ovp:${(+lat).toFixed(3)},${(+lng).toFixed(3)},${radiusM}`, () => fetchJson(process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter', { timeout: 5000, method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
    osm = data.elements.filter((e) => e.tags?.name).map((e) => {
      const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon, t = e.tags;
      return { osm_id: `${e.type}/${e.id}`, name: t.name, lat: la, lng: lo, source: 'osm', distance: haversineMiles(+lat, +lng, la, lo),
        address: [t['addr:housenumber'], t['addr:street'], t['addr:city']].filter(Boolean).join(' ') || null };
    });
  } catch (err) {
    if (!String(err.message).includes('circuit')) overpassDownUntil = Date.now() + 10 * 60 * 1000; // skip Overpass for 10 min after a failure
    // Fallback: Nominatim amenity search in a bounding box around the user
    try {
      const d = radiusM / 111000, dl = d / Math.cos((+lat * Math.PI) / 180);
      const vb = [+lng - dl, +lat + d, +lng + dl, +lat - d].join(',');
      const data = await cached(`nomcafe:${vb}`, () => nominatim(`https://nominatim.openstreetmap.org/search?format=json&limit=40&bounded=1&viewbox=${vb}&q=cafe`));
      osm = data.filter((e) => e.name).map((e) => ({ osm_id: `${e.osm_type}/${e.osm_id}`, name: e.name, lat: +e.lat, lng: +e.lon, source: 'osm',
        distance: haversineMiles(+lat, +lng, +e.lat, +e.lon), address: e.display_name.split(',').slice(1, 3).join(',').trim() }));
    } catch { warning = 'Live OpenStreetMap search is unavailable; showing saved shops. You can also type a shop manually.'; }
  }
  const seen = new Set(local.map((s) => s.name.toLowerCase()));
  const merged = [...local, ...osm.filter((s) => !seen.has(s.name.toLowerCase()))].sort((a, b) => a.distance - b.distance)
    .map((s) => ({ ...s, distance: Math.round(s.distance * 10) / 10 }));
  res.json({ shops: merged, warning });
});

// ---------- Invites ----------
const userErr = (m) => Object.assign(new Error(m), { user: true });
async function resolveShop(body, creator) {
  const s = body.shop || {};
  if (s.id != null && !isId(s.id)) throw userErr('Invalid coffee shop.');
  if (s.osm_id != null && !/^(node|way|relation)\/\d{1,15}$/.test(String(s.osm_id))) throw userErr('Invalid coffee shop.');
  if (s.id) { const row = await db.get('SELECT * FROM shops WHERE id=?', [s.id]); if (row) return row; }
  if (s.osm_id) { const row = await db.get('SELECT * FROM shops WHERE osm_id=?', [s.osm_id]); if (row) return row; }
  const name = String(s.name || '').trim().slice(0, 120);
  if (!name) throw userErr('Choose a coffee shop or type one in.');
  if (!validLatLng(s.lat, s.lng)) throw userErr('Coffee shop needs a location — search it or use the map.');
  const dup = await db.get('SELECT * FROM shops WHERE lower(name)=lower(?) AND abs(lat-?)<0.002 AND abs(lng-?)<0.002', [name, +s.lat, +s.lng]);
  if (dup) return dup;
  const id = await db.run('INSERT INTO shops(name,address,lat,lng,osm_id) VALUES (?,?,?,?,?)', [name, str(s.address, 200) || null, +s.lat, +s.lng, s.osm_id || null]);
  return db.get('SELECT * FROM shops WHERE id=?', [id]);
}
app.post('/api/invites', auth, inviteLimiter, async (req, res) => {
  const b = req.body || {}, me = req.session.userId;
  const topicLabel = String(b.topic || '').trim().slice(0, 60), topic = normalizeTopic(topicLabel);
  if (!['learn', 'teach'].includes(b.role)) return bad(res, 'Choose "I want to learn" or "I can teach".');
  if (!topic) return bad(res, 'Pick or type a topic.');
  const when = new Date(String(b.starts_at || '').slice(0, 40));
  if (isNaN(when)) return bad(res, 'Choose a valid date and time.');
  if (when < Date.now() - 60000) return bad(res, 'Meetup time must be in the future.');
  if (when > Date.now() + 366 * 864e5) return bad(res, 'Meetup must be within the next year.');
  const max = parseInt(b.max_attendees ?? 4, 10);
  if (!(max >= 1 && max <= 50)) return bad(res, 'Max attendees must be between 1 and 50.');
  const radius = clampRadius(b.radius_mi); // integer 1-15, default 15
  if (radius == null) return bad(res, 'Invite radius must be a number of miles between 1 and 15.');
  try {
    const result = await db.tx(async () => {
      const shop = await resolveShop(b, me);
      const id = await db.run('INSERT INTO invites(creator_id,shop_id,role,topic,topic_label,starts_at,note,max_attendees,radius_mi) VALUES (?,?,?,?,?,?,?,?,?)',
        [me, shop.id, b.role, topic, topicLabel, when.toISOString(), String(b.note || '').slice(0, 500) || null, max, radius]);
      const users = await db.all('SELECT id,lat,lng,max_distance_mi FROM users WHERE lat IS NOT NULL AND suspended_at IS NULL');
      const topics = await db.all('SELECT user_id,topic,role FROM topics WHERE topic=?', [topic]);
      users.forEach((u) => (u.topics = topics.filter((t) => t.user_id === u.id)));
      const blocked = await blockedWith(me);
      const recips = findRecipients(users.filter((u) => !blocked.has(u.id)), shop, { creatorId: me, role: b.role, topic }, radius);
      const creator = await db.get('SELECT name FROM users WHERE id=?', [me]);
      for (const r of recips) {
        await db.run('INSERT INTO invite_recipients(invite_id,user_id,distance_mi) VALUES (?,?,?)', [id, r.userId, r.distance]);
        await notify(r.userId, 'invite', `${creator.name} ${b.role === 'learn' ? 'wants to learn' : 'can teach'} ${topicLabel} at ${shop.name}`, id);
      }
      return { id, recipients: recips.length, radius_mi: radius };
    });
    res.status(201).json(result);
  } catch (e) { if (!e.user) { console.error(e); return bad(res, 'Could not create the invite.', 500); } bad(res, e.message); }
});

// Same value/format as SQLite's datetime('now','-1 day'), computed in JS so it works on both backends.
const oneDayAgo = () => new Date(Date.now() - 864e5).toISOString().replace('T', ' ').slice(0, 19);
const INVITE_SELECT = `SELECT i.*, s.name shop_name, s.address shop_address, s.lat shop_lat, s.lng shop_lng,
  u.name creator_name, u.photo_url creator_photo, CASE WHEN u.suspended_at IS NULL THEN 0 ELSE 1 END creator_suspended,
  (SELECT COUNT(*) FROM invite_recipients r2 WHERE r2.invite_id=i.id AND r2.status='accepted') accepted_count
  FROM invites i JOIN shops s ON s.id=i.shop_id JOIN users u ON u.id=i.creator_id`;
const going = (id) => db.all(`SELECT u.id,u.name,u.photo_url FROM invite_recipients r JOIN users u ON u.id=r.user_id WHERE r.invite_id=? AND r.status='accepted' AND u.suspended_at IS NULL`, [id]);

app.param('id', (req, res, next, id) => (isId(id) ? next() : bad(res, 'Not found.', 404)));
const notBlocked = `AND u.suspended_at IS NULL AND i.creator_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id=?) AND i.creator_id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id=?)`;
app.get('/api/invites/inbox', auth, async (req, res) => {
  const role = ['learn', 'teach'].includes(req.query.role) ? req.query.role : null;
  const rows = (await db.all(`${INVITE_SELECT} JOIN invite_recipients r ON r.invite_id=i.id
    WHERE r.user_id=? ${role ? 'AND i.role=?' : ''} AND i.starts_at >= ? ${notBlocked} ORDER BY i.starts_at`,
    [req.session.userId, ...(role ? [role] : []), oneDayAgo(), req.session.userId, req.session.userId]));
  const mine = await db.all('SELECT invite_id,status,distance_mi FROM invite_recipients WHERE user_id=?', [req.session.userId]);
  res.json(await Promise.all(rows.map(async (i) => { const m = mine.find((x) => x.invite_id === i.id); return { ...i, my_status: m.status, distance_mi: m.distance_mi, going: await going(i.id) }; })));
});
app.get('/api/invites/:id', auth, async (req, res) => {
  const i = await db.get(`${INVITE_SELECT} WHERE i.id=?`, [req.params.id]);
  const r = await db.get('SELECT status,distance_mi FROM invite_recipients WHERE invite_id=? AND user_id=?', [req.params.id, req.session.userId]);
  if (!i || (i.creator_id !== req.session.userId && !r)) return bad(res, 'Invite not found.', 404);
  if (i.creator_id !== req.session.userId && (i.creator_suspended || (await blockedWith(req.session.userId)).has(i.creator_id))) return bad(res, 'Invite not found.', 404);
  const counts = await db.get(`SELECT COUNT(*) total, SUM(CASE WHEN status='declined' THEN 1 ELSE 0 END) declined, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending FROM invite_recipients WHERE invite_id=?`, [i.id]);
  res.json({ ...i, my_status: r?.status || 'host', distance_mi: r?.distance_mi, going: await going(i.id), counts });
});
app.post('/api/invites/:id/rsvp', auth, async (req, res) => {
  const status = req.body?.status;
  if (!['accepted', 'declined'].includes(status)) return bad(res, 'Status must be accepted or declined.');
  const i = await db.get(`${INVITE_SELECT} WHERE i.id=?`, [req.params.id]);
  const r = i && await db.get('SELECT status FROM invite_recipients WHERE invite_id=? AND user_id=?', [i.id, req.session.userId]);
  if (!r) return bad(res, 'Invite not found.', 404);
  if (i.creator_suspended || (await blockedWith(req.session.userId)).has(i.creator_id)) return bad(res, 'Invite not found.', 404);
  if (new Date(i.starts_at) < Date.now()) return bad(res, 'This meetup has already happened.');
  if (status === 'accepted' && r.status !== 'accepted' && i.accepted_count >= i.max_attendees) return bad(res, 'Sorry — this meetup is full.', 409);
  const me = await db.get('SELECT name FROM users WHERE id=?', [req.session.userId]);
  await db.tx(async () => {
    await db.run(`UPDATE invite_recipients SET status=?, responded_at=CURRENT_TIMESTAMP WHERE invite_id=? AND user_id=?`, [status, i.id, req.session.userId]);
    if (r.status !== status) await notify(i.creator_id, 'rsvp', `${me.name} ${status === 'accepted' ? 'is in for' : 'declined'} ${i.topic_label} at ${i.shop_name}`, i.id);
  });
  res.json({ ok: true, status });
});
app.get('/api/meetups', auth, async (req, res) => {
  const me = req.session.userId;
  const created = (await db.all(`${INVITE_SELECT} WHERE i.creator_id=?`, [me])).map((i) => ({ ...i, relation: 'host' }));
  const accepted = (await db.all(`${INVITE_SELECT} JOIN invite_recipients r ON r.invite_id=i.id WHERE r.user_id=? AND r.status='accepted'`, [me])).map((i) => ({ ...i, relation: 'attending' }));
  const now = Date.now(), all = await Promise.all([...created, ...accepted].map(async (i) => ({ ...i, going: await going(i.id) })));
  res.json({
    upcoming: all.filter((i) => new Date(i.starts_at) >= now).sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    past: all.filter((i) => new Date(i.starts_at) < now).sort((a, b) => b.starts_at.localeCompare(a.starts_at)),
  });
});

// ---------- Notifications ----------
app.get('/api/notifications', auth, async (req, res) =>
  res.json(await db.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', [req.session.userId])));
app.post('/api/notifications/read', auth, async (req, res) => {
  await db.run('UPDATE notifications SET is_read=1 WHERE user_id=?', [req.session.userId]); res.json({ ok: true });
});

// ---------- Photo wall ----------
app.post('/api/uploads', auth, uploadLimiter, rawImage, async (req, res) => {
  let img; try { img = await images.processImage(req.body, 1600); } catch (e) { return bad(res, e.user ? e.message : 'Upload failed.'); }
  const id = await images.saveImage(req.session.userId, img, 'post');
  res.status(201).json({ id, url: '/img/' + id, width: img.width, height: img.height });
});
const POST_SELECT = `SELECT p.id,p.user_id,p.caption,p.created_at,p.invite_id,p.shop_id,'/img/'||p.image_id AS image_url,im.width,im.height,
  u.name AS user_name,u.photo_url AS user_photo,s.name AS shop_name,i.topic_label AS invite_topic
  FROM posts p JOIN users u ON u.id=p.user_id JOIN images im ON im.id=p.image_id LEFT JOIN shops s ON s.id=p.shop_id LEFT JOIN invites i ON i.id=p.invite_id`;
app.get('/api/posts', auth, async (req, res) => {
  const me = req.session.userId, limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 30);
  const before = isId(req.query.before) ? Number(req.query.before) : null;
  const rows = await db.all(`${POST_SELECT} WHERE p.hidden_at IS NULL AND u.suspended_at IS NULL AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id=?) AND p.user_id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id=?)
    ${before ? 'AND p.id<?' : ''} ORDER BY p.id DESC LIMIT ?`, [me, me, ...(before ? [before] : []), limit + 1]);
  const more = rows.length > limit; const items = rows.slice(0, limit).map((p) => ({ ...p, mine: p.user_id === me }));
  res.json({ items, next_before: more ? items[items.length - 1].id : null });
});
app.post('/api/posts', auth, postLimiter, async (req, res) => {
  const me = req.session.userId, b = req.body || {};
  if (typeof b.image_id !== 'string' || !/^[a-f0-9]{32}$/.test(b.image_id)) return bad(res, 'Add a photo first.');
  const img = await db.get("SELECT id FROM images WHERE id=? AND owner_id=? AND kind='post'", [b.image_id, me]);
  if (!img || await db.get('SELECT id FROM posts WHERE image_id=?', [b.image_id])) return bad(res, 'Add a photo first.');
  if (b.caption != null && String(b.caption).length > 280) return bad(res, 'Caption must be 280 characters or fewer.');
  let inviteId = null, shopId = null;
  if (b.invite_id != null && b.invite_id !== '') {
    if (!isId(b.invite_id)) return bad(res, 'Invalid meetup.');
    const inv = await db.get(`SELECT i.id,i.shop_id FROM invites i WHERE i.id=? AND (i.creator_id=? OR EXISTS (SELECT 1 FROM invite_recipients r WHERE r.invite_id=i.id AND r.user_id=? AND r.status='accepted'))`, [b.invite_id, me, me]);
    if (!inv) return bad(res, 'You can only link meetups you hosted or attended.');
    inviteId = inv.id; shopId = inv.shop_id;
  } else if (b.shop_id != null && b.shop_id !== '') {
    if (!isId(b.shop_id) || !(await db.get('SELECT id FROM shops WHERE id=?', [b.shop_id]))) return bad(res, 'Invalid coffee shop.');
    shopId = Number(b.shop_id);
  }
  const id = await db.run('INSERT INTO posts(user_id,image_id,caption,invite_id,shop_id) VALUES (?,?,?,?,?)', [me, b.image_id, str(b.caption, 280) || null, inviteId, shopId]);
  res.status(201).json({ ...(await db.get(`${POST_SELECT} WHERE p.id=?`, [id])), mine: true });
});
app.delete('/api/posts/:id', auth, async (req, res) => {
  const p = await db.get('SELECT id,user_id,image_id FROM posts WHERE id=?', [req.params.id]);
  if (!p) return bad(res, 'Post not found.', 404);
  if (p.user_id !== req.session.userId) return bad(res, 'You can only delete your own posts.', 403);
  await db.tx(async () => { await db.run('DELETE FROM posts WHERE id=?', [p.id]); await images.deleteImage(p.image_id); });
  res.json({ ok: true });
});
app.post('/api/posts/:id/report', auth, reportLimiter, async (req, res) => {
  const me = req.session.userId, reason = str(req.body?.reason, 1000);
  const p = await db.get('SELECT id,user_id FROM posts WHERE id=?', [req.params.id]);
  if (!p || (await blockedWith(me)).has(p.user_id)) return bad(res, 'Post not found.', 404);
  if (p.user_id === me) return bad(res, "You can't report your own post.");
  if (!reason) return bad(res, 'Please describe the problem.');
  await db.run('INSERT INTO reports(reporter_id,reported_id,post_id,reason) VALUES (?,?,?,?)', [me, p.user_id, p.id, reason]);
  console.warn(`SAFETY REPORT: user ${me} reported post ${p.id} by user ${p.user_id}`);
  res.status(201).json({ ok: true });
});
// Uploaded wall photos that never became a post are removed after an hour.
const sweepOrphans = () => db.run("DELETE FROM images WHERE kind='post' AND created_at < ? AND id NOT IN (SELECT image_id FROM posts)",
  [new Date(Date.now() - 3600e3).toISOString().replace('T', ' ').slice(0, 19)]).catch((e) => console.error('orphan sweep:', e.message));
setInterval(sweepOrphans, 3600e3).unref();

// ---------- Moderation ----------
const logAction = (actor, action, targetType, targetId, reason) =>
  db.run('INSERT INTO admin_actions(actor,action,target_type,target_id,reason) VALUES (?,?,?,?,?)', [actor, action, targetType, targetId, reason ? String(reason).slice(0, 500) : null]);
const nowTs = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
// Shared moderation operations (used by the admin page and the machine API). Return false when the target doesn't exist.
const mod = {
  async hidePost(id, reason) { const p = await db.get('SELECT id FROM posts WHERE id=?', [id]); if (!p) return false;
    await db.run('UPDATE posts SET hidden_at=COALESCE(hidden_at,?), hidden_reason=? WHERE id=?', [nowTs(), reason ? String(reason).slice(0, 500) : null, id]); return true; },
  async unhidePost(id) { const p = await db.get('SELECT id FROM posts WHERE id=?', [id]); if (!p) return false; await db.run('UPDATE posts SET hidden_at=NULL, hidden_reason=NULL WHERE id=?', [id]); return true; },
  async deletePost(id) { const p = await db.get('SELECT id,image_id FROM posts WHERE id=?', [id]); if (!p) return false;
    await db.tx(async () => { await db.run("UPDATE reports SET status='resolved' WHERE post_id=? AND status='open'", [id]); await db.run('DELETE FROM posts WHERE id=?', [id]); await images.deleteImage(p.image_id); }); return true; },
  async suspendUser(id) { const u = await db.get('SELECT id FROM users WHERE id=?', [id]); if (!u) return false;
    await db.run('UPDATE users SET suspended_at=COALESCE(suspended_at,?) WHERE id=?', [nowTs(), id]);
    if (db.isPg) await db.run("DELETE FROM session WHERE (sess::jsonb->>'userId') = ?", [String(id)]).catch(() => {});
    else await db.run("DELETE FROM sessions WHERE json_extract(data,'$.userId') = ?", [id]).catch(() => {});
    return true; },
  async unsuspendUser(id) { const u = await db.get('SELECT id FROM users WHERE id=?', [id]); if (!u) return false; await db.run('UPDATE users SET suspended_at=NULL WHERE id=?', [id]); return true; },
  async dismissReport(id) { const r = await db.get("SELECT id FROM reports WHERE id=?", [id]); if (!r) return false; await db.run("UPDATE reports SET status='dismissed' WHERE id=?", [id]); return true; },
};
const REPORT_SELECT = `SELECT r.id,r.reason,r.status,r.created_at,r.invite_id,r.post_id,r.reporter_id,ru.name AS reporter_name,r.reported_id,tu.name AS target_name,
  CASE WHEN tu.suspended_at IS NULL THEN 0 ELSE 1 END AS target_suspended,p.caption AS post_caption,p.hidden_at AS post_hidden_at,
  CASE WHEN p.image_id IS NULL THEN NULL ELSE '/img/'||p.image_id END AS post_image,i.topic_label AS invite_topic
  FROM reports r LEFT JOIN users ru ON ru.id=r.reporter_id LEFT JOIN users tu ON tu.id=r.reported_id LEFT JOIN posts p ON p.id=r.post_id LEFT JOIN invites i ON i.id=r.invite_id`;
const ADMIN_POST_SELECT = `SELECT p.id,p.user_id,u.name AS user_name,CASE WHEN u.suspended_at IS NULL THEN 0 ELSE 1 END AS user_suspended,p.caption,'/img/'||p.image_id AS image_url,
  p.created_at,p.hidden_at,p.hidden_reason,s.name AS shop_name FROM posts p JOIN users u ON u.id=p.user_id LEFT JOIN shops s ON s.id=p.shop_id`;

// Admin page: /admin is only served to admins; everyone else gets a plain 404 (doesn't reveal it exists).
const adminLimiter = limiter(15, 300, 'Too many admin requests. Slow down a little.');
app.get('/admin', adminLimiter, async (req, res) => {
  const u = req.session.userId && await db.get('SELECT email,suspended_at FROM users WHERE id=?', [req.session.userId]);
  if (!u || u.suspended_at || !isAdminEmail(u.email)) return res.status(404).type('text').set('Cache-Control', 'no-store').send('Not found');
  res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use('/api/admin', adminLimiter, adminAuth);
app.get('/api/admin/overview', async (req, res) => {
  const c = async (sql) => Number((await db.get(sql)).n) || 0;
  res.json({
    counts: { users: await c('SELECT COUNT(*) n FROM users'), suspended: await c('SELECT COUNT(*) n FROM users WHERE suspended_at IS NOT NULL'),
      posts: await c('SELECT COUNT(*) n FROM posts'), hidden_posts: await c('SELECT COUNT(*) n FROM posts WHERE hidden_at IS NOT NULL'),
      open_reports: await c("SELECT COUNT(*) n FROM reports WHERE status='open'"), invites: await c('SELECT COUNT(*) n FROM invites') },
    reports: await db.all(`${REPORT_SELECT} WHERE r.status='open' ORDER BY r.id DESC LIMIT 100`),
    posts: await db.all(`${ADMIN_POST_SELECT} ORDER BY p.id DESC LIMIT 50`),
    suspended: await db.all('SELECT id,name,suspended_at FROM users WHERE suspended_at IS NOT NULL ORDER BY suspended_at DESC LIMIT 100'),
    actions: await db.all('SELECT id,actor,action,target_type,target_id,reason,created_at FROM admin_actions ORDER BY id DESC LIMIT 30'),
  });
});
const adminOp = (action, targetType, fn) => async (req, res) => {
  const id = Number(req.params.id);
  if (targetType === 'user' && id === req.session.userId) return bad(res, "You can't do that to your own account.");
  if (!(await fn(id))) return bad(res, 'Not found.', 404);
  await logAction(req.userEmail, action, targetType, id, req.body?.reason);
  res.json({ ok: true });
};
app.post('/api/admin/reports/:id/dismiss', adminOp('dismiss_report', 'report', (id) => mod.dismissReport(id)));
app.post('/api/admin/posts/:id/hide', adminOp('hide_post', 'post', (id) => mod.hidePost(id, 'Hidden by admin')));
app.post('/api/admin/posts/:id/unhide', adminOp('unhide_post', 'post', (id) => mod.unhidePost(id)));
app.delete('/api/admin/posts/:id', adminOp('delete_post', 'post', (id) => mod.deletePost(id)));
app.post('/api/admin/users/:id/suspend', adminOp('suspend_user', 'user', (id) => mod.suspendUser(id)));
app.post('/api/admin/users/:id/unsuspend', adminOp('unsuspend_user', 'user', (id) => mod.unsuspendUser(id)));
app.delete('/api/admin/users/:id', adminOp('delete_user', 'user', async (id) => {
  const u = await db.get('SELECT id,email FROM users WHERE id=?', [id]); if (!u || isAdminEmail(u.email)) return false;
  await deleteUserCascade(id); return true;
}));

// Machine moderation API (monitoring routine). Bearer STATS_TOKEN, timing-safe compare. No emails are ever returned.
const modLimiter = limiter(1, 60, 'Too many requests.');
const modAuth = (req, res, next) => {
  const expected = process.env.STATS_TOKEN, given = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!expected) return bad(res, 'Moderation API disabled (STATS_TOKEN not set).', 503);
  if (!given || !stats.safeEqual(given, expected)) return bad(res, 'Unauthorized', 401);
  next();
};
app.use('/api/mod', modLimiter, modAuth);
app.get('/api/mod/queue', async (req, res) => {
  const t = req.query.since ? new Date(String(req.query.since).slice(0, 40)) : new Date(Date.now() - 864e5);
  if (isNaN(t)) return bad(res, 'since must be an ISO 8601 timestamp.');
  const since = t.toISOString().replace('T', ' ').slice(0, 19), base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const abs = (u) => (u ? base + u : null);
  const reports = (await db.all(`${REPORT_SELECT} WHERE r.status='open' AND r.created_at>=? ORDER BY r.id`, [since])).map((r) => ({
    id: r.id, created_at: r.created_at, reason: r.reason, reporter: { id: r.reporter_id, name: r.reporter_name },
    target_user: { id: r.reported_id, name: r.target_name, suspended: !!r.target_suspended },
    post: r.post_id ? { id: r.post_id, caption: r.post_caption, image_url: abs(r.post_image), hidden: !!r.post_hidden_at } : null, invite_id: r.invite_id }));
  const posts = (await db.all(`${ADMIN_POST_SELECT} WHERE p.created_at>=? ORDER BY p.id`, [since])).map((p) => ({
    id: p.id, created_at: p.created_at, caption: p.caption, image_url: abs(p.image_url), hidden: !!p.hidden_at, user: { id: p.user_id, name: p.user_name, suspended: !!p.user_suspended } }));
  const photos = (await db.all(`SELECT im.id AS image_id,im.created_at,u.id AS user_id,u.name FROM images im JOIN users u ON u.id=im.owner_id AND u.photo_url='/img/'||im.id
    WHERE im.kind='avatar' AND im.created_at>=? ORDER BY im.created_at`, [since])).map((x) => ({ type: 'avatar', image_url: abs('/img/' + x.image_id), created_at: x.created_at, user: { id: x.user_id, name: x.name } }));
  res.json({ generated_at: new Date().toISOString(), since: t.toISOString(),
    open_reports_total: Number((await db.get("SELECT COUNT(*) n FROM reports WHERE status='open'")).n), reports, posts, photos });
});
app.post('/api/mod/action', async (req, res) => {
  const { type, id, reason } = req.body || {};
  const ops = { hide_post: ['post', (x) => mod.hidePost(x, reason || 'Hidden by monitor')], suspend_user: ['user', (x) => mod.suspendUser(x)], dismiss_report: ['report', (x) => mod.dismissReport(x)] };
  if (!ops[type]) return bad(res, 'type must be hide_post, suspend_user or dismiss_report.');
  if (!isId(id)) return bad(res, 'id must be a positive integer.');
  const [targetType, fn] = ops[type];
  if (type === 'suspend_user') { const u = await db.get('SELECT email FROM users WHERE id=?', [Number(id)]); if (u && isAdminEmail(u.email)) return bad(res, 'Admins cannot be suspended via the API.', 403); }
  if (!(await fn(Number(id)))) return bad(res, 'Not found.', 404);
  await logAction('bubba-monitor', type, targetType, Number(id), reason);
  res.json({ ok: true, type, id: Number(id) });
});

// ---------- Safety: block & report ----------
app.post('/api/users/:id/block', auth, async (req, res) => {
  const id = Number(req.params.id), me = req.session.userId;
  if (id === me) return bad(res, "You can't block yourself.");
  if (!(await db.get('SELECT id FROM users WHERE id=?', [id]))) return bad(res, 'User not found.', 404);
  await db.tx(async () => {
    await db.run('INSERT INTO blocks(blocker_id,blocked_id) VALUES (?,?) ON CONFLICT DO NOTHING', [me, id]);
    // Drop pending invitations between the two people in either direction.
    await db.run("DELETE FROM invite_recipients WHERE status='pending' AND user_id=? AND invite_id IN (SELECT id FROM invites WHERE creator_id=?)", [me, id]);
    await db.run("DELETE FROM invite_recipients WHERE status='pending' AND user_id=? AND invite_id IN (SELECT id FROM invites WHERE creator_id=?)", [id, me]);
  });
  res.json({ ok: true });
});
app.delete('/api/users/:id/block', auth, async (req, res) => {
  await db.run('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?', [req.session.userId, Number(req.params.id)]); res.json({ ok: true });
});
app.get('/api/blocks', auth, async (req, res) =>
  res.json(await db.all('SELECT u.id,u.name FROM blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=? ORDER BY u.name', [req.session.userId])));
app.post('/api/users/:id/report', auth, reportLimiter, async (req, res) => {
  const id = Number(req.params.id), me = req.session.userId, reason = str(req.body?.reason, 1000);
  const inviteId = isId(req.body?.invite_id) ? Number(req.body.invite_id) : null;
  if (id === me) return bad(res, "You can't report yourself.");
  if (!reason) return bad(res, 'Please describe what happened.');
  if (!(await db.get('SELECT id FROM users WHERE id=?', [id]))) return bad(res, 'User not found.', 404);
  await db.run('INSERT INTO reports(reporter_id,reported_id,invite_id,reason) VALUES (?,?,?,?)', [me, id, inviteId, reason]);
  console.warn(`SAFETY REPORT: user ${me} reported user ${id}${inviteId ? ' (invite ' + inviteId + ')' : ''}`);
  res.status(201).json({ ok: true });
});

app.get('/api/stats', stats.handler);
app.use('/api', (req, res) => bad(res, 'Not found', 404));
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return bad(res, 'Request too large.', 413);
  if (err.type === 'entity.parse.failed') return bad(res, 'Invalid JSON.');
  console.error(err); bad(res, 'Something went wrong.', 500);
});

(async () => {
  await db.init();
  await stats.init();
  console.log(`Database: ${db.isPg ? 'Postgres (DATABASE_URL)' : 'SQLite (sql.js) at ' + (process.env.DB_PATH || 'data/coffeebuds.sqlite')}`);
  sessionMw = session({ ...sessionOpts, store: await require('./src/sessionStore').createStore() });
  if (PROD) await removeDemoAccounts();
  else if (await seed()) console.log('Seeded local demo data (dev only).');
  await coarsenHomeLocations();
  if (ADMIN_EMAILS.size) {
    const n = Number((await db.get(`SELECT COUNT(*) n FROM users WHERE lower(email) IN (${[...ADMIN_EMAILS].map(() => '?').join(',')})`, [...ADMIN_EMAILS])).n);
    console.log(`Admin accounts present: ${n} of ${ADMIN_EMAILS.size} configured.`);
  } else console.log('Admin accounts present: 0 (ADMIN_EMAILS not set).');
  sweepOrphans();
  app.listen(PORT, HOST, () => console.log(`CoffeeBuds running on http://${HOST}:${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'})`));
})().catch((e) => { console.error('Startup failed:', e); process.exit(1); });
