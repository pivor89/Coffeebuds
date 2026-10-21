const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('public/app.js');

// Pull the small pure helpers out of app.js and run them against a fake localStorage.
function loadDefaultAuthRoute(store) {
  const src = app.match(/const RETURNING_KEY[\s\S]*?function defaultAuthRoute\(\) \{[^\n]*\}/)[0];
  const ctx = { localStorage: store };
  vm.runInNewContext(src + '\nthis.defaultAuthRoute = defaultAuthRoute; this.markReturning = markReturning;', ctx);
  return ctx;
}
const fakeStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

test('first-time logged-out visitor defaults to sign-up', () => {
  const ctx = loadDefaultAuthRoute(fakeStore());
  assert.equal(ctx.defaultAuthRoute(), 'signup');
});

test('returning visitor on this device defaults to log in', () => {
  const ctx = loadDefaultAuthRoute(fakeStore());
  ctx.markReturning();
  assert.equal(ctx.defaultAuthRoute(), 'login');
});

test('storage errors fall back to sign-up', () => {
  const ctx = loadDefaultAuthRoute({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  assert.doesNotThrow(() => ctx.markReturning());
  assert.equal(ctx.defaultAuthRoute(), 'signup');
});

test('router redirects logged-out users to the default auth route; logout still goes to #/login', () => {
  assert.match(app, /location\.hash = '#\/' \+ defaultAuthRoute\(\)/);
  assert.match(app, /setBadge\(0\); location\.hash = '#\/login'/);
  assert.match(app, /Create your account/);
  assert.match(app, /Already a member\? <a href="#\/login"/);
});

test('no city names in user-visible client files', () => {
  for (const f of ['public/app.js', 'public/index.html', 'public/manifest.webmanifest', 'public/offline.html', 'public/offline.js', 'public/pwa.js']) {
    assert.doesNotMatch(read(f), /Tampa|Vancouver|Portland/i, f);
  }
  assert.match(app, /made with espresso ☕/);
});

test('service worker version bumped', () => {
  assert.match(read('public/sw.js'), /const VERSION = 'v1\.3\.5'/);
});
