// Browser check for sign-out-on-close / "Keep me signed in". Usage: node scripts/keep-signed-in-check.js <baseUrl> <email> <password> [screenshotPath]
const { chromium, devices } = require('playwright');
const [, , BASE, EMAIL, PW, SHOT] = process.argv;
const phone = { ...devices['iPhone 13'], defaultBrowserType: undefined };
delete phone.defaultBrowserType;
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const meStatus = (page) => page.evaluate(() => fetch('/api/me', { headers: { 'X-Requested-With': 'CoffeeBuds' } }).then((r) => r.status));
const settle = (page) => page.waitForFunction(() => !/Brewing/.test(document.querySelector('#app')?.textContent || ''), null, { timeout: 15000 }).then(() => page.waitForTimeout(800));
// What survives a real browser restart: persistent cookies + localStorage (session cookies and sessionStorage do not).
const afterRestart = (state) => ({ ...state, cookies: state.cookies.filter((c) => c.expires > 0) });

async function login(browser, { remember, standalone = false, signup = false }) {
  const ctx = await browser.newContext(phone);
  if (standalone) await ctx.addInitScript(() => { const mm = window.matchMedia.bind(window); window.matchMedia = (q) => (/display-mode: standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q)); });
  const page = await ctx.newPage();
  await page.goto(BASE + '/#/' + (signup ? 'signup' : 'login')); await settle(page);
  if (signup) await page.fill('#name', 'Keep Signed In Test');
  await page.fill('#email', EMAIL); await page.fill('#password', PW);
  const box = page.locator('#remember');
  if (standalone) check('installed app: checkbox hidden', (await box.count()) === 0);
  else { check(`checkbox present and unchecked by default (${signup ? 'signup' : 'login'})`, (await box.count()) === 1 && !(await box.isChecked())); if (remember) await box.check(); }
  await page.click('button[type=submit]');
  await page.waitForFunction(() => /#\/(inbox|profile)/.test(location.hash), null, { timeout: 15000 }); await settle(page);
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch();
  try {
    // Screenshot of the login form with the checkbox.
    { const ctx = await browser.newContext(phone); const page = await ctx.newPage();
      await page.goto(BASE + '/#/login'); await settle(page); await page.waitForSelector('#remember');
      if (SHOT) { await page.locator('#f').scrollIntoViewIfNeeded(); await page.screenshot({ path: SHOT, fullPage: false }); await page.locator('#f').screenshot({ path: SHOT.replace(/\.png$/, '-form.png') }); }
      await ctx.close(); }

    // 1) Default (box unchecked): refresh keeps you in; closing logs you out.
    { const { ctx, page } = await login(browser, { remember: false, signup: process.env.SIGNUP === '1' });
      const sid = (await ctx.cookies()).find((c) => c.name === 'cb.sid');
      check('unchecked: cb.sid is a session cookie (no expiry)', sid && sid.expires === -1, `expires=${sid?.expires}`);
      await page.reload(); await settle(page);
      check('unchecked: refresh stays logged in', (await meStatus(page)) === 200 && !/login|signup/.test(page.url()), page.url());
      const state = await ctx.storageState(); await ctx.close();
      const c2 = await browser.newContext({ ...phone, storageState: afterRestart(state) }); const p2 = await c2.newPage();
      await p2.goto(BASE + '/'); await settle(p2);
      check('unchecked: after closing, new context is logged out at #/login', (await meStatus(p2)) === 401 && /#\/login/.test(p2.url()), p2.url());
      await c2.close();
      // Browser "continue where you left off" restores the session cookie but not this tab's sessionStorage marker.
      const c3 = await browser.newContext({ ...phone, storageState: state }); const p3 = await c3.newPage();
      await p3.goto(BASE + '/#/meetups'); await settle(p3);
      check('unchecked: restored session cookie without tab marker => forced logout to #/login', (await meStatus(p3)) === 401 && /#\/login/.test(p3.url()), p3.url());
      const next = await p3.evaluate(() => sessionStorage.getItem('cb_next'));
      check('unchecked: deep link kept for after login', next === '#/meetups', String(next));
      await c3.close(); }

    // 2) Box checked: stays signed in after closing.
    { const { ctx, page } = await login(browser, { remember: true });
      const sid = (await ctx.cookies()).find((c) => c.name === 'cb.sid');
      const days = sid && sid.expires > 0 ? (sid.expires * 1000 - Date.now()) / 864e5 : 0;
      check('checked: cb.sid persistent (~14 days)', days > 13.9 && days <= 14.01, `days=${days.toFixed(3)}`);
      await page.reload(); await settle(page);
      check('checked: refresh stays logged in', (await meStatus(page)) === 200, page.url());
      const state = await ctx.storageState(); await ctx.close();
      const c2 = await browser.newContext({ ...phone, storageState: afterRestart(state) }); const p2 = await c2.newPage();
      await p2.goto(BASE + '/'); await settle(p2);
      const st = await meStatus(p2);
      check('checked: after closing, new context is still logged in', st === 200 && !/#\/(login|signup)/.test(p2.url()) && await p2.locator('#topbar').isVisible(), `me=${st} ${p2.url()}`);
      // logout still works
      await p2.goto(BASE + '/#/profile'); await settle(p2); await p2.click('[data-logout]');
      await p2.waitForTimeout(1500);
      const lo = await meStatus(p2); check('logout works', lo === 401 && /#\/login/.test(p2.url()), `me=${lo} ${p2.url()}`);
      await c2.close(); }

    // 3) Installed app (display-mode: standalone emulated): no checkbox, persistent login, no forced logout.
    { const { ctx } = await login(browser, { standalone: true });
      const sid = (await ctx.cookies()).find((c) => c.name === 'cb.sid');
      check('installed app: cb.sid persistent', sid && sid.expires > 0, `expires=${sid?.expires}`);
      const state = await ctx.storageState(); await ctx.close();
      const c2 = await browser.newContext({ ...phone, storageState: afterRestart(state) });
      await c2.addInitScript(() => { const mm = window.matchMedia.bind(window); window.matchMedia = (q) => (/display-mode: standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q)); });
      const p2 = await c2.newPage(); await p2.goto(BASE + '/'); await settle(p2);
      check('installed app: reopened app is still logged in', (await meStatus(p2)) === 200, p2.url());
      await p2.evaluate(() => fetch('/api/logout', { method: 'POST', headers: { 'X-Requested-With': 'CoffeeBuds', 'Content-Type': 'application/json' }, body: '{}' }));
      await c2.close(); }
  } finally { await browser.close(); }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
