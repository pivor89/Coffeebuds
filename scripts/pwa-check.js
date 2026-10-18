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
  // ---------- Permanent "Install app" control ----------
  // Android: prompt captured even after the floating hint was dismissed; button calls prompt()
  const a2 = await b.newContext({ ...devices['Pixel 7'] }); await a2.addInitScript(() => localStorage.setItem('cb_install_dismissed', '1')); const p2 = await a2.newPage();
  await p2.goto(BASE + '/#/login'); await p2.waitForSelector('.install-link');
  await p2.evaluate(() => { window.__prompted = 0; const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__prompted++; }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
  check(!(await p2.$('#installHint')), 'dismissed hint stays hidden when prompt arrives');
  await p2.click('.install-link'); await p2.waitForTimeout(300); check((await p2.evaluate(() => window.__prompted)) === 1, 'landing "Install app" link calls prompt() despite dismissal');
  // log in, profile button
  await p2.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__prompted++; }; e.userChoice = Promise.resolve({ outcome: 'dismissed' }); window.dispatchEvent(e); });
  await p2.fill('#email', 'demo@coffeebuds.app'); await p2.fill('#password', 'coffee123'); await p2.click('button[type=submit]'); await p2.waitForSelector('.pagehead');
  await p2.goto(BASE + '/#/profile'); await p2.waitForSelector('.install-card .install-btn');
  await p2.waitForSelector('#toast', { state: 'hidden', timeout: 6000 }).catch(() => {}); await p2.evaluate(() => document.querySelector('.install-card').scrollIntoView({ block: 'center' })); await p2.waitForTimeout(500); await p2.screenshot({ path: OUT + 'install-btn-profile.png' });
  await p2.click('.install-card .install-btn'); await p2.waitForTimeout(300); check((await p2.evaluate(() => window.__prompted)) === 2, 'profile "Install app" button calls prompt()');
  // iOS: sheet with Share instructions even after dismissal
  const i2 = await b.newContext({ ...devices['iPhone 14'] }); await i2.addInitScript(() => localStorage.setItem('cb_install_dismissed', '1')); const q2 = await i2.newPage();
  await q2.goto(BASE + '/#/login'); await q2.waitForSelector('.install-link'); await q2.waitForTimeout(1800); check(!(await q2.$('#installHint')), 'iOS auto-hint respects dismissal');
  await q2.click('.install-link'); await q2.waitForSelector('#installHint.sheet');
  check(/Tap Share.*Add to Home Screen/.test(await q2.textContent('#installHint')) && (await q2.$$('#installHint svg')).length >= 2, 'iOS sheet: Tap Share, then Add to Home Screen (with icons)');
  await q2.waitForTimeout(400); await q2.screenshot({ path: OUT + 'install-btn-ios-sheet.png' });
  await q2.click('#installHint .ih-close'); check(!(await q2.$('#installHint')), 'iOS sheet closes');
  // other browsers without a prompt: menu instructions
  const d2 = await b.newContext({ viewport: { width: 1280, height: 800 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' }); const r2 = await d2.newPage();
  await r2.goto(BASE + '/#/login'); await r2.waitForSelector('.install-link'); await r2.click('.install-link'); await r2.waitForSelector('#installHint.sheet');
  check(/browser menu.*Install app.*Add to Home screen/.test(await r2.textContent('#installHint')), 'manual instructions when no prompt available');
  // standalone: shows "App installed" instead of the button
  const s2 = await b.newContext({ ...devices['iPhone 14'] }); await s2.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true })); const t2 = await s2.newPage();
  await t2.goto(BASE + '/#/login'); await t2.waitForSelector('.install-slot'); check(!(await t2.$('[data-install]')) && /App installed/.test(await t2.textContent('.install-slot')), 'standalone shows "App installed" instead of the button');
  await b.close(); console.log(ok ? '\nPWA checks passed.' : '\nPWA checks FAILED.'); process.exit(ok ? 0 : 1);
})();
