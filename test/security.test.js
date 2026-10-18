const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbsec-')), 't.sqlite');
delete process.env.DATABASE_URL;
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { seed, removeDemoAccounts } = require('../src/seed');

test('removeDemoAccounts deletes only the seeded @coffeebuds.app account', async () => {
  await db.init(); await seed();
  await db.run('INSERT INTO users(email,password_hash,name) VALUES (?,?,?)', ['real@coffeebuds.app', bcrypt.hashSync('coffee123', 4), 'Real']);
  assert.strictEqual(await removeDemoAccounts(), 1);
  assert.ok(!(await db.get('SELECT id FROM users WHERE email=?', ['demo@coffeebuds.app'])));
  assert.ok(await db.get('SELECT id FROM users WHERE email=?', ['real@coffeebuds.app']));
  assert.ok(await db.get('SELECT id FROM users WHERE email=?', ['maya@example.com']));
  assert.strictEqual(await removeDemoAccounts(), 0);
});
test('demo account with a changed password is left alone', async () => {
  await db.run('INSERT INTO users(email,password_hash,name) VALUES (?,?,?)', ['demo@coffeebuds.app', bcrypt.hashSync('owner-changed-it', 4), 'Demo']);
  assert.strictEqual(await removeDemoAccounts(), 0);
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
