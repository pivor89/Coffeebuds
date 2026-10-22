const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbpeek-')), 't.sqlite');
delete process.env.DATABASE_URL;
const db = require('../src/db');
const { seed, USERS } = require('../src/seed');
const { buildPeek, cachedPeek, safeLabel, initial } = require('../src/peek');

// Keys that must never appear anywhere in the public payload.
const FORBIDDEN_KEYS = /^(id|ids|user_id|userId|creator_id|invite_id|post_id|shop_id|image_id|owner_id|email|emails|name|last_name|full_name|password|password_hash|address|shop_address|location|location_label|lat|lng|lon|latitude|longitude|shop_lat|shop_lng|photo_url|user_photo|creator_photo|note|caption|reason|hidden_at|hidden_reason|suspended_at|reports|is_admin|session|shop_name)$/i;
function walk(v, visit, p = '$') { visit(v, p); if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { visit(k, p + '.' + k, true); walk(x, visit, p + '.' + k); } }
function assertNoPrivate(payload, extraStrings = []) {
  const s = JSON.stringify(payload);
  walk(payload, (v, p, isKey) => { if (isKey) assert.doesNotMatch(v, FORBIDDEN_KEYS, `forbidden key at ${p}`); });
  assert.doesNotMatch(s, /@/, 'no emails');
  assert.doesNotMatch(s.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, ''), /-?\d{1,3}\.\d{2,}/, 'no coordinates (any decimal number outside timestamps)');
  for (const u of USERS) { const [email, full, loc] = u; const last = full.split(' ').slice(1).join(' ');
    assert.ok(!s.includes(email), 'email ' + email); assert.ok(!s.includes(last), 'last name ' + last); assert.ok(!s.includes(full), 'full name ' + full); assert.ok(!s.includes(loc), 'location ' + loc); }
  for (const x of extraStrings) assert.ok(!s.includes(x), 'leaked: ' + x);
}

const hex = (c) => c.repeat(32);
let ids = {};
test.before(async () => {
  await db.init(); await seed();
  const u = async (email) => (await db.get('SELECT id FROM users WHERE email=?', [email])).id;
  ids = { maya: await u('maya@example.com'), jordan: await u('jordan@example.com'), sam: await u('sam@example.com') };
  // Suspended member with a unique topic, an upcoming invite and a photo: none of it may show.
  ids.bad = await db.run("INSERT INTO users(email,password_hash,name,lat,lng,suspended_at) VALUES ('bad@example.com','x','Zed Suspendedson',27.95,-82.45,'2026-01-01 00:00:00')");
  await db.run("INSERT INTO topics(user_id,topic,label,role) VALUES (?, 'lockpicking', 'Lockpicking', 'teach')", [ids.bad]);
  const future = new Date(Date.now() + 3 * 864e5).toISOString(), past = new Date(Date.now() - 3 * 864e5).toISOString();
  await db.run("INSERT INTO invites(creator_id,shop_id,role,topic,topic_label,starts_at,note,max_attendees) VALUES (?,1,'teach','lockpicking','Lockpicking',?,'secret note',4)", [ids.bad, future]);
  // Active member: upcoming invite with a private note (shown anonymized), plus a past invite (not shown).
  ids.inv = await db.run("INSERT INTO invites(creator_id,shop_id,role,topic,topic_label,starts_at,note,max_attendees,radius_mi) VALUES (?,1,'teach','ai','AI',?,'Call me at my flat on Elm St',4,7)", [ids.maya, future]);
  await db.run("INSERT INTO invites(creator_id,shop_id,role,topic,topic_label,starts_at,max_attendees) VALUES (?,1,'learn','old','Old topic',?,4)", [ids.jordan, past]);
  // Reported invite (open report) must not show.
  ids.repInv = await db.run("INSERT INTO invites(creator_id,shop_id,role,topic,topic_label,starts_at,max_attendees) VALUES (?,1,'learn','reportedtopic','Reportedtopic',?,4)", [ids.sam, future]);
  await db.run("INSERT INTO reports(reporter_id,reported_id,invite_id,reason) VALUES (?,?,?,'creepy')", [ids.maya, ids.sam, ids.repInv]);
  // Posts: visible (linked to a café), hidden, from suspended user, reported, and one not taken at a café/meetup.
  const img = (c, owner) => db.run("INSERT INTO images(id,owner_id,kind,mime,data,width,height) VALUES (?,?,'post','image/webp',?,10,10)", [hex(c), owner, new Uint8Array([1])]);
  for (const [c, o] of [['a', ids.maya], ['b', ids.maya], ['c', ids.bad], ['d', ids.jordan], ['e', ids.jordan]]) await img(c, o);
  await db.run("INSERT INTO posts(user_id,image_id,caption,shop_id) VALUES (?,?,'Maya at home on Elm St',1)", [ids.maya, hex('a')]);
  await db.run("INSERT INTO posts(user_id,image_id,caption,shop_id,hidden_at) VALUES (?,?,'hidden one',1,'2026-01-01 00:00:00')", [ids.maya, hex('b')]);
  await db.run("INSERT INTO posts(user_id,image_id,caption,shop_id) VALUES (?,?,'suspended one',1)", [ids.bad, hex('c')]);
  const rp = await db.run("INSERT INTO posts(user_id,image_id,caption,shop_id) VALUES (?,?,'reported one',1)", [ids.jordan, hex('d')]);
  await db.run("INSERT INTO reports(reporter_id,reported_id,post_id,reason) VALUES (?,?,?,'x')", [ids.maya, ids.jordan, rp]);
  await db.run("INSERT INTO posts(user_id,image_id,caption) VALUES (?,?,'living room selfie')", [ids.jordan, hex('e')]);
});

test('peek payload contains no private fields (emails, last names, addresses, lat/lng, ids, notes, captions)', async () => {
  const p = await buildPeek(db);
  assertNoPrivate(p, ['secret note', 'Elm St', 'Buddy Brew', 'Kennedy', 'Suspendedson', 'living room', hex('e')]);
  assert.deepEqual(Object.keys(p).sort(), ['counts', 'generated_at', 'how_it_works', 'ideas', 'max_radius_mi', 'photos', 'topics', 'upcoming']);
  for (const i of p.upcoming) assert.deepEqual(Object.keys(i).sort(), ['host', 'role', 'spots_left', 'starts_at', 'topic', 'within_mi']);
  for (const t of p.topics) assert.deepEqual(Object.keys(t).sort(), ['label', 'learners', 'teachers']);
  for (const ph of p.photos) assert.deepEqual(Object.keys(ph).sort(), ['height', 'image_url', 'topic', 'width']);
});

test('peek shows anonymized real items: first initial, coarse radius, hour-rounded time', async () => {
  const p = await buildPeek(db);
  assert.equal(p.upcoming.length, 1);
  const i = p.upcoming[0];
  assert.equal(i.topic, 'AI'); assert.equal(i.role, 'teach'); assert.equal(i.host, 'M.'); assert.equal(i.within_mi, 7); assert.equal(i.spots_left, 4);
  assert.match(i.starts_at, /T\d\d:00:00\.000Z$/);
  assert.ok(p.topics.some((t) => t.label === 'AI' && t.learners >= 1 && t.teachers >= 1));
  assert.equal(p.counts.members, USERS.length, 'suspended member not counted');
  assert.deepEqual(p.ideas, ['Spanish', 'Guitar', 'AI tools', 'Sourdough', 'Resume help', 'Photography']);
  assert.equal(p.how_it_works.length, 3);
});

test('peek excludes hidden posts, reported items, suspended users, past invites and non-café photos', async () => {
  const p = await buildPeek(db), s = JSON.stringify(p);
  assert.deepEqual(p.photos.map((x) => x.image_url), ['/img/' + hex('a')], 'only the visible café photo');
  for (const h of ['b', 'c', 'd', 'e']) assert.ok(!s.includes(hex(h)), 'photo ' + h + ' excluded');
  assert.equal(p.counts.photos, 1);
  assert.ok(!/lockpicking/i.test(s), 'suspended user topic/invite excluded');
  assert.ok(!/Reportedtopic/.test(s), 'reported invite excluded');
  assert.ok(!/Old topic/.test(s), 'past invite excluded');
  assert.equal(p.counts.upcoming_meetups, 2, 'counts only active members\' upcoming invites (incl. the reported one, without showing it)');
});

test('empty database gives an honest empty state (no fake activity)', async () => {
  const empty = { get: async () => ({ n: 0 }), all: async () => [] };
  const p = await buildPeek(empty);
  assert.deepEqual(p.upcoming, []); assert.deepEqual(p.photos, []); assert.deepEqual(p.topics, []);
  assert.equal(p.counts.members, 0); assert.ok(p.ideas.length >= 6);
});

test('label + initial helpers strip contact info and surnames', () => {
  assert.equal(safeLabel('Spanish'), 'Spanish');
  assert.equal(safeLabel('email me a@b.co'), null); assert.equal(safeLabel('call 555-1234'), null); assert.equal(safeLabel('see www.x.com'), null);
  assert.equal(initial('maya chen'), 'M.'); assert.equal(initial(''), null); assert.equal(initial('  Émile Zola'), 'É.');
});

test('peek is cached (one build per TTL)', async () => {
  let calls = 0; const fake = { get: async () => { calls++; return { n: 0 }; }, all: async () => [] };
  const get = cachedPeek(fake, 60e3); await get(); const after = calls; await get(); await get();
  assert.equal(calls, after, 'second and third calls served from cache');
});

test('GET /api/public/peek works logged out: safe JSON, cache headers, no session cookie', { timeout: 60000 }, async (t) => {
  const port = 43000 + Math.floor(Math.random() * 2000);
  const env = { ...process.env, DB_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbpeekapi-')), 't.sqlite'), PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', DISABLE_RATE_LIMIT: '1' };
  delete env.DATABASE_URL;
  const srv = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => srv.kill());
  await new Promise((res, rej) => { let o = ''; srv.stdout.on('data', (d) => { o += d; if (o.includes('running on')) res(); }); srv.on('close', () => rej(new Error('server exited: ' + o))); });
  const r = await fetch(`http://127.0.0.1:${port}/api/public/peek`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.match(r.headers.get('cache-control'), /max-age=60/);
  assert.equal(r.headers.get('set-cookie'), null, 'no session created for anonymous viewers');
  const body = await r.json();
  assertNoPrivate(body);
  assert.ok(body.topics.length > 0, 'seeded dev topics are aggregated');
  // Other APIs stay private.
  for (const p of ['/api/me', '/api/posts', '/api/topics/popular', '/api/invites/inbox']) assert.equal((await fetch(`http://127.0.0.1:${port}${p}`)).status, 401, p);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/admin/overview`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/public/peek`, { method: 'POST', headers: { 'X-Requested-With': 'CoffeeBuds' } })).status, 404, 'read-only');
});

test('client: #/peek is public, linked from sign-up, members redirect home; SW keeps /api network-only', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  assert.match(app, /const PUBLIC_ROUTES = \['login', 'signup', 'peek'\]/);
  assert.match(app, /if \(me && PUBLIC_ROUTES\.includes\(name\)\) return \(location\.hash = '#\/inbox'\)/);
  assert.match(app, /href="#\/peek" data-peek-link>👀 Peek inside first →/);
  assert.match(app, /return \(location\.hash = '#\/' \+ defaultAuthRoute\(\)\)/, 'sign-up/log-in stays the default first view');
  assert.match(app, /Join free to connect/); assert.match(app, /Be one of the first in your area/);
  assert.match(app, /Popular things to learn over coffee/); assert.match(app, /not posts from members/);
  assert.match(app, /We match people within up to 15 miles/);
  assert.match(sw, /url\.pathname\.startsWith\('\/api'\)\) \{\s*\/\/ Network only/);
  assert.match(sw, /const VERSION = 'v1\.3\.6'/);
});
