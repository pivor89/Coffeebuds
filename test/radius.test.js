const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { findRecipients, clampRadius } = require('../src/matching');

const shop = { lat: 27.9506, lng: -82.4572 };
const MI = 1 / 69.09; // ~1 mile of latitude in degrees
const at = (id, mi, extra = {}) => ({ id, lat: shop.lat + mi * MI, lng: shop.lng, topics: [{ topic: 'x', role: 'teach' }], ...extra });
const ids = (r) => r.map((x) => x.userId);
const inv = { creatorId: 0, role: 'learn', topic: 'x' };

test('clampRadius: integer 1-15, default 15, rejects junk', () => {
  assert.strictEqual(clampRadius(undefined), 15);
  assert.strictEqual(clampRadius(null), 15);
  assert.strictEqual(clampRadius(''), 15);
  assert.strictEqual(clampRadius(7), 7);
  assert.strictEqual(clampRadius('7'), 7);
  assert.strictEqual(clampRadius(7.4), 7);
  assert.strictEqual(clampRadius(7.6), 8);
  assert.strictEqual(clampRadius(0), 1);
  assert.strictEqual(clampRadius(-5), 1);
  assert.strictEqual(clampRadius(99), 15);
  assert.strictEqual(clampRadius('abc'), null);
  assert.strictEqual(clampRadius(Infinity), null);
  assert.strictEqual(clampRadius({}), null);
  assert.strictEqual(clampRadius([5]), null);
  assert.strictEqual(clampRadius(true), null);
});

test('recipients must be within the invite radius', () => {
  const users = [at(1, 0.5), at(2, 2.9), at(3, 3.1), at(4, 14.9)];
  assert.deepStrictEqual(ids(findRecipients(users, shop, inv, 3)), [1, 2]);
  assert.deepStrictEqual(ids(findRecipients(users, shop, inv, 1)), [1]);
  assert.deepStrictEqual(ids(findRecipients(users, shop, inv)), [1, 2, 3, 4]); // default 15
  assert.deepStrictEqual(ids(findRecipients(users, shop, inv, 50)), [1, 2, 3, 4]); // clamped to 15
});

test("a user is only invited when distance <= min(invite radius, user's max_distance_mi)", () => {
  const users = [at(1, 4, { max_distance_mi: 5 }), at(2, 6, { max_distance_mi: 5 }), at(3, 6, { max_distance_mi: 15 }), at(4, 6, { max_distance_mi: null }), at(5, 9.9, { max_distance_mi: 10 })];
  assert.deepStrictEqual(ids(findRecipients(users, shop, inv, 15)), [1, 3, 4, 5]);
  assert.deepStrictEqual(ids(findRecipients(users, shop, inv, 8)), [1, 3, 4]);
  assert.deepStrictEqual(ids(findRecipients(users, shop, inv, 3)), []);
});

test('SQLite migration adds radius_mi / max_distance_mi with default 15 to existing rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbrad-')), file = path.join(dir, 'old.sqlite');
  const SQL = await require('sql.js')();
  const old = new SQL.Database();
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL, photo_url TEXT, location_label TEXT, lat REAL, lng REAL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE invites (id INTEGER PRIMARY KEY, creator_id INTEGER NOT NULL, shop_id INTEGER NOT NULL, role TEXT NOT NULL, topic TEXT NOT NULL, topic_label TEXT NOT NULL, starts_at TEXT NOT NULL, note TEXT, max_attendees INTEGER NOT NULL DEFAULT 4, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO users(email,password_hash,name) VALUES ('old@example.com','x','Old');
    INSERT INTO invites(creator_id,shop_id,role,topic,topic_label,starts_at) VALUES (1,1,'learn','ai','AI','2030-01-01T00:00:00Z');`);
  fs.writeFileSync(file, Buffer.from(old.export()));
  const out = await new Promise((resolve, reject) => {
    const code = `const db=require(${JSON.stringify(path.join(__dirname, '../src/db'))});(async()=>{await db.init();await db.init();
      console.log(JSON.stringify({u:await db.get('SELECT max_distance_mi FROM users'),i:await db.get('SELECT radius_mi FROM invites')}));})()`;
    const env = { ...process.env, DB_PATH: file }; delete env.DATABASE_URL;
    const p = spawn(process.execPath, ['-e', code], { env }); let o = '', e = '';
    p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d));
    p.on('close', (c) => (c ? reject(new Error(e)) : resolve(JSON.parse(o.trim().split('\n').pop()))));
  });
  assert.deepStrictEqual(out, { u: { max_distance_mi: 15 }, i: { radius_mi: 15 } });
});

test('API: invite radius is stored/clamped and respects recipients\' max distance', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbapi-')), port = 41000 + Math.floor(Math.random() * 2000);
  const env = { ...process.env, DB_PATH: path.join(dir, 'api.sqlite'), PORT: String(port), HOST: '127.0.0.1', DISABLE_RATE_LIMIT: '1', NODE_ENV: 'test', OVERPASS_URL: 'http://127.0.0.1:9/' };
  delete env.DATABASE_URL;
  const srv = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => srv.kill());
  await new Promise((res, rej) => { let o = ''; srv.stdout.on('data', (d) => { o += d; if (o.includes('running on')) res(); }); srv.on('close', () => rej(new Error('server exited: ' + o))); });
  const client = () => { let cookie = ''; return async (p, method = 'GET', body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'CoffeeBuds', cookie }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { status: r.status, data: await r.json().catch(() => null) }; }; };
  const login = async (email) => { const c = client(); assert.strictEqual((await c('/login', 'POST', { email, password: 'coffee123' })).status, 200); return c; };
  // Seed: demo (downtown, wants to learn AI) and Jordan (Seminole Heights, ~3.3 mi from Kahwa, wants to learn AI).
  const host = client();
  assert.strictEqual((await host('/signup', 'POST', { email: 'host@example.com', password: 'secret123', name: 'Host' })).status, 201);
  await host('/profile', 'PUT', { name: 'Host', lat: 27.9455, lng: -82.452 });
  await host('/topics', 'PUT', { topics: [{ label: 'AI', role: 'teach' }] });
  const demo = await login('demo@coffeebuds.app'), jordan = await login('jordan@example.com');
  const when = new Date(Date.now() + 2 * 864e5).toISOString();
  const mk = (extra) => host('/invites', 'POST', { role: 'teach', topic: 'AI', shop: { id: 2 }, starts_at: when, ...extra });
  const inbox = async (c, id) => (await c('/invites/inbox')).data.some((i) => i.id === id);

  let me = (await demo('/me')).data; assert.strictEqual(me.max_distance_mi, 15);
  let r = await mk({}); assert.strictEqual(r.status, 201); assert.strictEqual(r.data.radius_mi, 15);
  assert.ok(await inbox(demo, r.data.id)); assert.ok(await inbox(jordan, r.data.id));
  assert.strictEqual((await host('/invites/' + r.data.id)).data.radius_mi, 15);

  r = await mk({ radius_mi: 2 }); assert.strictEqual(r.data.radius_mi, 2);
  assert.ok(await inbox(demo, r.data.id)); assert.ok(!(await inbox(jordan, r.data.id)), 'Jordan is ~3.3 mi away, outside a 2 mi invite');
  assert.strictEqual((await mk({ radius_mi: 99 })).data.radius_mi, 15);
  assert.strictEqual((await mk({ radius_mi: 0 })).data.radius_mi, 1);
  assert.strictEqual((await mk({ radius_mi: '6.6' })).data.radius_mi, 7);
  assert.strictEqual((await mk({ radius_mi: 'far' })).status, 400);

  // Jordan limits himself to 3 miles -> not invited even to a 15 mi invite; profile value is clamped.
  r = await jordan('/profile', 'PUT', { name: 'Jordan Brooks', lat: 28.0, lng: -82.46, max_distance_mi: 3 }); assert.strictEqual(r.data.max_distance_mi, 3);
  r = await mk({ radius_mi: 15 }); assert.ok(!(await inbox(jordan, r.data.id))); assert.ok(await inbox(demo, r.data.id));
  assert.strictEqual((await jordan('/profile', 'PUT', { name: 'Jordan Brooks', lat: 28.0, lng: -82.46, max_distance_mi: 40 })).data.max_distance_mi, 15);
  assert.strictEqual((await jordan('/profile', 'PUT', { name: 'Jordan Brooks', lat: 28.0, lng: -82.46 })).data.max_distance_mi, 15, 'omitted keeps current');
  assert.strictEqual((await jordan('/profile', 'PUT', { name: 'Jordan Brooks', max_distance_mi: 'x' })).status, 400);
});
