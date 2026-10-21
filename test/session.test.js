const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const vm = require('vm');

// ---------- Server: cookie attributes for "Keep me signed in" ----------
const PORT = 4000 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
let srv;
test.before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'test', DISABLE_RATE_LIMIT: '1', DB_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbsess-')), 't.sqlite') };
  delete env.DATABASE_URL;
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { srv.stdout.on('data', (d) => /running on/.test(d) && res()); srv.on('exit', rej); setTimeout(() => rej(new Error('server start timeout')), 20000); });
});
test.after(() => srv && srv.kill());

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'CoffeeBuds' };
const post = (p, body, cookie) => fetch(base + p, { method: 'POST', headers: { ...H, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const sidCookie = (r) => r.headers.getSetCookie().find((c) => c.startsWith('cb.sid='));
const pair = (c) => c.split(';')[0];
// express-session writes persistence as an Expires date (it never emits Max-Age); 14 days ahead = persistent login.
const assertPersistent14d = (c) => {
  const exp = c.match(/Expires=([^;]+)/i); assert.ok(exp, 'persistent cookie has an expiry: ' + c);
  const days = (new Date(exp[1]) - Date.now()) / 864e5; assert.ok(days > 13.99 && days <= 14.01, `expires in ~14 days (got ${days})`);
};
let n = 0;
const email = () => `sess${Date.now()}${n++}@example.org`;

test('signup without "keep me signed in" sets a browser-session cookie (no Max-Age/Expires)', async () => {
  const r = await post('/api/signup', { email: email(), password: 'password123', name: 'Tab' });
  assert.equal(r.status, 201);
  const c = sidCookie(r); assert.ok(c, 'cb.sid cookie set');
  assert.doesNotMatch(c, /Max-Age/i); assert.doesNotMatch(c, /Expires/i);
  assert.match(c, /HttpOnly/i); assert.match(c, /SameSite=Lax/i);
  const me = await fetch(base + '/api/me', { headers: { ...H, Cookie: pair(c) } });
  assert.equal(me.status, 200, 'session works for later requests (page refresh)');
  assert.equal((await me.json()).remember, false);
});

test('signup with remember=true sets a persistent 14-day cookie', async () => {
  const r = await post('/api/signup', { email: email(), password: 'password123', name: 'Keep', remember: true });
  assert.equal(r.status, 201);
  const c = sidCookie(r);
  assertPersistent14d(c);
});

test('login cookie: session-only when remember is off, 14-day expiry when on; logout clears it', async () => {
  const e = email();
  assert.equal((await post('/api/signup', { email: e, password: 'password123', name: 'L' })).status, 201);
  for (const remember of [undefined, false, 'true', 1]) {
    const r = await post('/api/login', { email: e, password: 'password123', ...(remember === undefined ? {} : { remember }) });
    assert.equal(r.status, 200);
    assert.doesNotMatch(sidCookie(r), /Max-Age|Expires/i, `remember=${remember} must not persist`);
  }
  const r = await post('/api/login', { email: e, password: 'password123', remember: true });
  const c = sidCookie(r);
  assertPersistent14d(c);
  const me = await fetch(base + '/api/me', { headers: { ...H, Cookie: pair(c) } });
  assert.equal((await me.json()).remember, true);
  const out = await post('/api/logout', {}, pair(c));
  assert.equal(out.status, 200);
  assert.match(sidCookie(out), /Expires=Thu, 01 Jan 1970/);
  assert.equal((await fetch(base + '/api/me', { headers: { ...H, Cookie: pair(c) } })).status, 401, 'old session is gone after logout');
});

// ---------- Client: sign-out-on-close logic ----------
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
function loadHelpers({ standalone = false, fullscreen = false, iosStandalone = false } = {}) {
  const src = app.match(/const ALIVE_KEY[\s\S]*?function shouldForceLogout\([^\n]*\n/)[0];
  const m = new Map();
  const ctx = {
    window: { matchMedia: (q) => ({ matches: (q.includes('standalone') && standalone) || (q.includes('fullscreen') && fullscreen) }) },
    navigator: { standalone: iosStandalone },
    sessionStorage: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) },
  };
  vm.runInNewContext(src + '\nObject.assign(this, { isStandalone, markTabAlive, tabAlive, clearTabAlive, shouldForceLogout });', ctx);
  return ctx;
}

test('installed app is detected (standalone, fullscreen, iOS navigator.standalone); a tab is not', () => {
  assert.equal(loadHelpers().isStandalone(), false);
  assert.equal(loadHelpers({ standalone: true }).isStandalone(), true);
  assert.equal(loadHelpers({ fullscreen: true }).isStandalone(), true);
  assert.equal(loadHelpers({ iosStandalone: true }).isStandalone(), true);
});

test('startup forces logout only for a non-remembered session in a browser tab without the login marker', () => {
  const { shouldForceLogout: f } = loadHelpers();
  assert.equal(f({ hasSession: true, remember: false, standalone: false, alive: false }), true, 'restored session cookie after close');
  assert.equal(f({ hasSession: true, remember: false, standalone: false, alive: true }), false, 'refresh in the same tab');
  assert.equal(f({ hasSession: true, remember: true, standalone: false, alive: false }), false, 'keep me signed in');
  assert.equal(f({ hasSession: true, remember: false, standalone: true, alive: false }), false, 'installed app');
  assert.equal(f({ hasSession: false, remember: false, standalone: false, alive: false }), false, 'nobody logged in');
});

test('tab marker lives in sessionStorage and is cleared on logout', () => {
  const ctx = loadHelpers();
  assert.equal(ctx.tabAlive(), false); ctx.markTabAlive(); assert.equal(ctx.tabAlive(), true); ctx.clearTabAlive(); assert.equal(ctx.tabAlive(), false);
  assert.match(app, /markReturning\(\); markTabAlive\(\);/, 'marker set at login/signup');
  assert.match(app, /clearTabAlive\(\); me = null;/, 'marker cleared on logout');
});

test('auth form: "Keep me signed in" unchecked by default, hidden in the app, and the app always sends remember', () => {
  assert.match(app, /<input id="remember" type="checkbox">/);
  assert.doesNotMatch(app, /id="remember"[^>]*checked/);
  assert.match(app, /\$\{isStandalone\(\) \? '' : `<label class="check keep-signed-in"/);
  assert.match(app, /const remember = isStandalone\(\) \|\| !!\$\('#remember'\)\?\.checked;/);
  assert.match(app, /name: \$\('#name'\)\?\.value, remember \}/);
  assert.doesNotMatch(app, /beforeunload|pagehide/, 'no unload-time logout');
});

test('service worker never handles non-GET or /api requests from cache', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(sw, /if \(req\.method !== 'GET'\) return;/);
  assert.match(sw, /pathname\.startsWith\('\/api'\)\) \{\s*\/\/ Network only/);
});
