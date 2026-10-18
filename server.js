const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./src/db');
const { seed } = require('./src/seed');
const { findRecipients, normalizeTopic, haversineMiles, MATCH_RADIUS_MI } = require('./src/matching');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
if (!process.env.SESSION_SECRET) console.warn('WARNING: SESSION_SECRET not set; using an insecure dev fallback. Set SESSION_SECRET in production.');
const UA = 'CoffeeBuds/1.0 (demo app)';
app.set('trust proxy', process.env.TRUST_PROXY ?? true); // behind Render/Fly/Cloudflare tunnels
app.use(express.json({ limit: '100kb' }));
let sessionMw;
app.use((req, res, next) => sessionMw(req, res, next));
const sessionOpts = {
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me', resave: false, saveUninitialized: false,
  proxy: true,
  // 'auto' = Secure cookie when the request arrived over HTTPS (incl. via a trusted proxy/tunnel), plain on http://localhost
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 24 * 14 },
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
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'icons', 'favicon-32.png')));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public')));

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const auth = (req, res, next) => (req.session.userId ? next() : bad(res, 'Please log in.', 401));
const isNum = (v) => v !== '' && v != null && !isNaN(Number(v));
const validLatLng = (lat, lng) => isNum(lat) && isNum(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

async function userPayload(id) {
  const u = await db.get('SELECT id,email,name,photo_url,location_label,lat,lng FROM users WHERE id=?', [id]);
  if (!u) return null;
  u.topics = await db.all('SELECT topic,label,role FROM topics WHERE user_id=? ORDER BY role,label', [id]);
  u.unread = (await db.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0', [id])).c;
  return u;
}
async function notify(userId, type, message, inviteId) {
  await db.run('INSERT INTO notifications(user_id,type,message,invite_id) VALUES (?,?,?,?)', [userId, type, message, inviteId]);
}

// ---------- Auth ----------
app.post('/api/signup', async (req, res) => {
  const { email, password, name } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return bad(res, 'Please enter a valid email.');
  if (!password || String(password).length < 6) return bad(res, 'Password must be at least 6 characters.');
  if (!name || !String(name).trim()) return bad(res, 'Please enter your name.');
  if (await db.get('SELECT id FROM users WHERE email=?', [e])) return bad(res, 'An account with that email already exists.', 409);
  const id = await db.run('INSERT INTO users(email,password_hash,name) VALUES (?,?,?)', [e, bcrypt.hashSync(String(password), 10), String(name).trim().slice(0, 80)]);
  const payload = await userPayload(id);
  req.session.regenerate(() => { req.session.userId = id; res.status(201).json(payload); });
});
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const u = await db.get('SELECT id,password_hash FROM users WHERE email=?', [String(email || '').trim().toLowerCase()]);
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) return bad(res, 'Incorrect email or password.', 401);
  const payload = await userPayload(u.id);
  req.session.regenerate(() => { req.session.userId = u.id; res.json(payload); });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', auth, async (req, res) => res.json(await userPayload(req.session.userId)));

// ---------- Profile ----------
app.put('/api/profile', auth, async (req, res) => {
  const { name, photo_url, location_label, lat, lng } = req.body || {};
  if (!name || !String(name).trim()) return bad(res, 'Name is required.');
  if (photo_url && !/^https?:\/\//i.test(photo_url)) return bad(res, 'Photo URL must start with http(s)://');
  const hasLoc = isNum(lat) || isNum(lng);
  if (hasLoc && !validLatLng(lat, lng)) return bad(res, 'Latitude/longitude are invalid.');
  await db.run('UPDATE users SET name=?,photo_url=?,location_label=?,lat=?,lng=? WHERE id=?',
    [String(name).trim(), photo_url || null, location_label || null, hasLoc ? Number(lat) : null, hasLoc ? Number(lng) : null, req.session.userId]);
  res.json(await userPayload(req.session.userId));
});
app.put('/api/topics', auth, async (req, res) => {
  const list = Array.isArray(req.body?.topics) ? req.body.topics : null;
  if (!list) return bad(res, 'topics must be an array.');
  const clean = [];
  for (const t of list) {
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
  if (q.length < 3) return bad(res, 'Type at least 3 characters.');
  try { res.json(await geocode(q)); }
  catch { bad(res, 'Geocoding is unavailable right now — enter latitude/longitude manually.', 503); }
});
app.get('/api/shops/nearby', auth, async (req, res) => {
  const { lat, lng } = req.query;
  if (!validLatLng(lat, lng)) return bad(res, 'Set your location first (lat/lng).');
  const radiusM = Math.min(Number(req.query.radius_m) || 5000, 15000);
  const local = (await db.all('SELECT * FROM shops')).map((s) => ({ ...s, source: 'saved', distance: haversineMiles(+lat, +lng, s.lat, s.lng) }))
    .filter((s) => s.distance <= MATCH_RADIUS_MI)
    .filter((s, i, arr) => arr.findIndex((o) => o.name.toLowerCase() === s.name.toLowerCase() && Math.abs(o.lat - s.lat) < 0.002) === i);
  let osm = [], warning = null;
  try {
    if (Date.now() < overpassDownUntil) throw new Error('overpass circuit open');
    const q = `[out:json][timeout:10];(node["amenity"="cafe"](around:${radiusM},${lat},${lng});way["amenity"="cafe"](around:${radiusM},${lat},${lng}););out center 40;`;
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
async function resolveShop(body, creator) {
  const s = body.shop || {};
  if (s.id) { const row = await db.get('SELECT * FROM shops WHERE id=?', [s.id]); if (row) return row; }
  if (s.osm_id) { const row = await db.get('SELECT * FROM shops WHERE osm_id=?', [s.osm_id]); if (row) return row; }
  const name = String(s.name || '').trim();
  if (!name) throw new Error('Choose a coffee shop or type one in.');
  if (!validLatLng(s.lat, s.lng)) throw new Error('Coffee shop needs a location — search it or use the map.');
  const dup = await db.get('SELECT * FROM shops WHERE lower(name)=lower(?) AND abs(lat-?)<0.002 AND abs(lng-?)<0.002', [name, +s.lat, +s.lng]);
  if (dup) return dup;
  const id = await db.run('INSERT INTO shops(name,address,lat,lng,osm_id) VALUES (?,?,?,?,?)', [name.slice(0, 120), s.address || null, +s.lat, +s.lng, s.osm_id || null]);
  return db.get('SELECT * FROM shops WHERE id=?', [id]);
}
app.post('/api/invites', auth, async (req, res) => {
  const b = req.body || {}, me = req.session.userId;
  const topicLabel = String(b.topic || '').trim().slice(0, 60), topic = normalizeTopic(topicLabel);
  if (!['learn', 'teach'].includes(b.role)) return bad(res, 'Choose "I want to learn" or "I can teach".');
  if (!topic) return bad(res, 'Pick or type a topic.');
  const when = new Date(b.starts_at);
  if (isNaN(when)) return bad(res, 'Choose a valid date and time.');
  if (when < Date.now() - 60000) return bad(res, 'Meetup time must be in the future.');
  const max = parseInt(b.max_attendees ?? 4, 10);
  if (!(max >= 1 && max <= 50)) return bad(res, 'Max attendees must be between 1 and 50.');
  try {
    const result = await db.tx(async () => {
      const shop = await resolveShop(b, me);
      const id = await db.run('INSERT INTO invites(creator_id,shop_id,role,topic,topic_label,starts_at,note,max_attendees) VALUES (?,?,?,?,?,?,?,?)',
        [me, shop.id, b.role, topic, topicLabel, when.toISOString(), String(b.note || '').slice(0, 500) || null, max]);
      const users = await db.all('SELECT id,lat,lng FROM users WHERE lat IS NOT NULL');
      const topics = await db.all('SELECT user_id,topic,role FROM topics WHERE topic=?', [topic]);
      users.forEach((u) => (u.topics = topics.filter((t) => t.user_id === u.id)));
      const recips = findRecipients(users, shop, { creatorId: me, role: b.role, topic });
      const creator = await db.get('SELECT name FROM users WHERE id=?', [me]);
      for (const r of recips) {
        await db.run('INSERT INTO invite_recipients(invite_id,user_id,distance_mi) VALUES (?,?,?)', [id, r.userId, r.distance]);
        await notify(r.userId, 'invite', `${creator.name} ${b.role === 'learn' ? 'wants to learn' : 'can teach'} ${topicLabel} at ${shop.name}`, id);
      }
      return { id, recipients: recips.length };
    });
    res.status(201).json(result);
  } catch (e) { bad(res, e.message); }
});

// Same value/format as SQLite's datetime('now','-1 day'), computed in JS so it works on both backends.
const oneDayAgo = () => new Date(Date.now() - 864e5).toISOString().replace('T', ' ').slice(0, 19);
const INVITE_SELECT = `SELECT i.*, s.name shop_name, s.address shop_address, s.lat shop_lat, s.lng shop_lng,
  u.name creator_name, u.photo_url creator_photo,
  (SELECT COUNT(*) FROM invite_recipients r2 WHERE r2.invite_id=i.id AND r2.status='accepted') accepted_count
  FROM invites i JOIN shops s ON s.id=i.shop_id JOIN users u ON u.id=i.creator_id`;
const going = (id) => db.all(`SELECT u.id,u.name,u.photo_url FROM invite_recipients r JOIN users u ON u.id=r.user_id WHERE r.invite_id=? AND r.status='accepted'`, [id]);

app.get('/api/invites/inbox', auth, async (req, res) => {
  const role = ['learn', 'teach'].includes(req.query.role) ? req.query.role : null;
  const rows = (await db.all(`${INVITE_SELECT} JOIN invite_recipients r ON r.invite_id=i.id
    WHERE r.user_id=? ${role ? 'AND i.role=?' : ''} AND i.starts_at >= ? ORDER BY i.starts_at`,
    role ? [req.session.userId, role, oneDayAgo()] : [req.session.userId, oneDayAgo()])).map((i) => i);
  const mine = await db.all('SELECT invite_id,status,distance_mi FROM invite_recipients WHERE user_id=?', [req.session.userId]);
  res.json(await Promise.all(rows.map(async (i) => { const m = mine.find((x) => x.invite_id === i.id); return { ...i, my_status: m.status, distance_mi: m.distance_mi, going: await going(i.id) }; })));
});
app.get('/api/invites/:id', auth, async (req, res) => {
  const i = await db.get(`${INVITE_SELECT} WHERE i.id=?`, [req.params.id]);
  const r = await db.get('SELECT status,distance_mi FROM invite_recipients WHERE invite_id=? AND user_id=?', [req.params.id, req.session.userId]);
  if (!i || (i.creator_id !== req.session.userId && !r)) return bad(res, 'Invite not found.', 404);
  const counts = await db.get(`SELECT COUNT(*) total, SUM(CASE WHEN status='declined' THEN 1 ELSE 0 END) declined, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending FROM invite_recipients WHERE invite_id=?`, [i.id]);
  res.json({ ...i, my_status: r?.status || 'host', distance_mi: r?.distance_mi, going: await going(i.id), counts });
});
app.post('/api/invites/:id/rsvp', auth, async (req, res) => {
  const status = req.body?.status;
  if (!['accepted', 'declined'].includes(status)) return bad(res, 'Status must be accepted or declined.');
  const i = await db.get(`${INVITE_SELECT} WHERE i.id=?`, [req.params.id]);
  const r = i && await db.get('SELECT status FROM invite_recipients WHERE invite_id=? AND user_id=?', [i.id, req.session.userId]);
  if (!r) return bad(res, 'Invite not found.', 404);
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

app.use('/api', (req, res) => bad(res, 'Not found', 404));
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

(async () => {
  await db.init();
  console.log(`Database: ${db.isPg ? 'Postgres (DATABASE_URL)' : 'SQLite (sql.js) at ' + (process.env.DB_PATH || 'data/coffeebuds.sqlite')}`);
  sessionMw = session({ ...sessionOpts, store: await require('./src/sessionStore').createStore() });
  if (await seed()) console.log('Seeded demo data. Demo login: demo@coffeebuds.app / coffee123');
  app.listen(PORT, HOST, () => console.log(`CoffeeBuds running on http://${HOST}:${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'})`));
})().catch((e) => { console.error('Startup failed:', e); process.exit(1); });
