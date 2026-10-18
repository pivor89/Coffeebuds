const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbsec-')), 't.sqlite');
delete process.env.DATABASE_URL;
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { seed, removeDemoAccounts, coarsenHomeLocations } = require('../src/seed');

test('seed cleanup deletes exactly the seed emails with their data; rounding migration is idempotent', async () => {
  await db.init(); await seed();
  await db.run('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)');
  const maya = await db.get('SELECT id FROM users WHERE email=?', ['maya@example.com']);
  await db.run('INSERT INTO sessions VALUES (?,?,?)', ['s1', JSON.stringify({ userId: maya.id }), Date.now() + 1e6]);
  const real = await db.run('INSERT INTO users(email,password_hash,name,lat,lng) VALUES (?,?,?,?,?)', ['maya2@example.com', bcrypt.hashSync('x', 4), 'Real', 27.12345, -82.98765]);
  await db.run('INSERT INTO users(email,password_hash,name) VALUES (?,?,?)', ['real@coffeebuds.app', bcrypt.hashSync('coffee123', 4), 'Real2']);
  await db.run('INSERT INTO blocks(blocker_id,blocked_id) VALUES (?,?)', [real, maya.id]);
  await db.run('INSERT INTO reports(reporter_id,reported_id,reason) VALUES (?,?,?)', [real, maya.id, 'x']);
  await db.run('INSERT INTO sessions VALUES (?,?,?)', ['s2', JSON.stringify({ userId: real }), Date.now() + 1e6]);
  assert.strictEqual(await removeDemoAccounts(), 8);
  assert.deepStrictEqual((await db.all('SELECT email FROM users ORDER BY email')).map((r) => r.email), ['maya2@example.com', 'real@coffeebuds.app']);
  for (const t of ['topics', 'blocks', 'reports']) assert.strictEqual((await db.get(`SELECT COUNT(*) c FROM ${t}`)).c, 0, t);
  assert.deepStrictEqual((await db.all('SELECT sid FROM sessions')).map((r) => r.sid), ['s2']);
  assert.strictEqual(await removeDemoAccounts(), 0);
  assert.strictEqual(await coarsenHomeLocations(), 1);
  assert.deepStrictEqual(await db.get('SELECT lat,lng FROM users WHERE id=?', [real]), { lat: 27.12, lng: -82.99 });
  assert.strictEqual(await coarsenHomeLocations(), 0);
});
test('stats token comparison is timing-safe (constant-length hash compare)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/stats.js'), 'utf8');
  assert.match(src, /timingSafeEqual/);
});
test('front end has no demo credentials or inline handlers', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(!/coffee123|demo@coffeebuds/.test(app + html));
  assert.ok(!/\son(error|click|load)=/.test(app + html));
  assert.ok(!/<script>/.test(html));
});
