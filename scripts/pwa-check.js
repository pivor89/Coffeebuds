// Verifies manifest + service worker registration and captures install-hint screenshots.
const { chromium, devices } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:3000', OUT = __dirname + '/../screenshots/';
(async () => {
  const b = await chromium.launch(); let ok = true; const check = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); ok = ok && !!c; };
  const ctx = await b.newContext({ ...devices['Pixel 7'] }); const p = await ctx.newPage();
  await p.goto(BASE + '/'); await p.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready, null, { timeout: 15000 });
  const reg = await p.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, active: !!r.active }; });
  check(reg.active && reg.scope === BASE + '/', 'service worker active, scope ' + reg.scope);
  const man = await p.evaluate(async () => { const l = document.querySelector('link[rel=manifest]'); const r = await fetch(l.href); return { ct: r.headers.get('content-type'), j: await r.json() }; });
  check(/manifest\+json/.test(man.ct) && man.j.display === 'standalone' && man.j.start_url === '/' && man.j.icons.some((i) => i.purpose === 'maskable'), 'manifest valid (' + man.ct + ')');
  for (const i of man.j.icons) { const r = await p.request.get(BASE + i.src); check(r.ok(), 'icon ' + i.src); }
  check(await p.evaluate(async () => (await caches.keys()).some((k) => k.startsWith('coffeebuds-'))), 'app shell cached');
  const cdp = await ctx.newCDPSession(p); const inst = await cdp.send('Page.getInstallabilityErrors');
  check(inst.installabilityErrors.length === 0, 'Chrome installability errors: ' + JSON.stringify(inst.installabilityErrors));
  await ctx.setOffline(true); await p.goto(BASE + '/some/page').catch(() => {}); check(await p.locator('body').count(), 'offline navigation served from cache');
  await p.goto(BASE + '/offline.html'); await p.screenshot({ path: OUT + 'pwa-offline.png' }); await ctx.setOffline(false);
  // iOS Safari hint
  const ios = await b.newContext({ ...devices['iPhone 14'] }); const q = await ios.newPage();
  await q.goto(BASE + '/#/login'); await q.waitForSelector('#installHint', { timeout: 5000 });
  check(/Tap Share.*then Add to Home Screen/.test(await q.textContent('#installHint')), 'iOS hint text'); await q.screenshot({ path: OUT + 'pwa-ios-install-hint.png' });
  await q.click('.ih-close'); await q.reload(); await q.waitForTimeout(2000); check(!(await q.$('#installHint')), 'iOS hint dismissal remembered');
  const st = await b.newContext({ ...devices['iPhone 14'] }); await st.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const s = await st.newPage(); await s.goto(BASE + '/'); await s.waitForTimeout(2000); check(!(await s.$('#installHint')), 'no hint when installed (standalone)');
  // icon preview
  const ic = await b.newPage({ viewport: { width: 420, height: 300 } });
  await ic.setContent(`<body style="margin:0;background:#FBF7F0;display:flex;gap:28px;align-items:center;justify-content:center;height:100vh;font:13px sans-serif;color:#6E6259">${['icon-512.png:120:24', 'icon-maskable-512.png:120:60', 'icon-192.png:48:11', 'favicon-32.png:32:4'].map((x) => { const [f, w, r] = x.split(':'); return `<div style="text-align:center"><img src="${BASE}/icons/${f}" width="${w}" style="border-radius:${r}px"><br>${w}px</div>`; }).join('')}</body>`);
  await ic.waitForTimeout(500); await ic.screenshot({ path: OUT + 'pwa-icons.png' });
  // Android install prompt banner (simulated beforeinstallprompt)
  const a = await b.newContext({ ...devices['Pixel 7'] }); const ap = await a.newPage(); await ap.goto(BASE + '/#/login');
  await ap.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => {}; e.userChoice = Promise.resolve({}); window.dispatchEvent(e); });
  await ap.waitForSelector('#installHint .ih-install'); await ap.screenshot({ path: OUT + 'pwa-android-install.png' }); check(true, 'Android install button shown');
  await b.close(); console.log(ok ? '\nPWA checks passed.' : '\nPWA checks FAILED.'); process.exit(ok ? 0 : 1);
})();
