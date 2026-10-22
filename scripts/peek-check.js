// Browser check for the logged-out sneak peek. Usage: node scripts/peek-check.js <baseUrl> [screenshotDir] [--member email:password]
// Never creates accounts. The optional --member check logs in with an existing (throwaway/local) account to verify the redirect.
const { chromium, devices } = require('playwright');
const path = require('path');
const [, , BASE, DIR = path.join(__dirname, '..', 'screenshots')] = process.argv;
const memberArg = process.argv.includes('--member') ? process.argv[process.argv.indexOf('--member') + 1] : null;
const phone = { ...devices['iPhone 13'] }; delete phone.defaultBrowserType;
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const settle = (page) => page.waitForFunction(() => !/Brewing/.test(document.querySelector('#app')?.textContent || ''), null, { timeout: 15000 }).then(() => page.waitForTimeout(900));
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

(async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext(phone);
    // The iOS "Install CoffeeBuds" hint (existing behavior) would cover part of the screenshots; dismiss it like a visitor would.
    await ctx.addInitScript(() => { try { localStorage.setItem('cb_install_dismissed', '1'); } catch {} });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/'); await settle(page);
    check('first-time visitor lands on sign-up', page.url().endsWith('#/signup'), page.url());
    check('sign-up form is shown', await page.locator('#f #name').isVisible());
    const heroLink = page.locator('.hero-peek'), formLink = page.locator('.peek-btn');
    check('hero "Peek inside first" link visible above the fold', await heroLink.isVisible() && (await heroLink.boundingBox()).y < phone.viewport.height, JSON.stringify(await heroLink.boundingBox()));
    check('form "Peek inside first" button present', (await formLink.count()) === 1 && (await formLink.getAttribute('href')) === '#/peek');
    check('landing has no horizontal overflow', await noOverflow(page));
    await page.screenshot({ path: path.join(DIR, 'peek-landing.png') });

    await heroLink.click(); await page.waitForFunction(() => location.hash === '#/peek'); await settle(page);
    check('#/peek renders for logged-out visitor', await page.locator('.peek-hero').isVisible() && /How it works/.test(await page.textContent('#app')));
    const txt = await page.textContent('#app');
    check('3 steps shown', (await page.locator('.peek-steps li').count()) === 3 && /We match people within up to 15 miles/.test(txt));
    check('ideas labeled as ideas', /Popular things to learn over coffee/.test(txt) && /not posts from members/.test(txt) && (await page.locator('.chip.idea').count()) >= 6);
    const ctas = await page.locator('a[href="#/signup"]').count();
    check('sign-up CTAs present', ctas >= 3 && /Join free to connect/.test(txt), `${ctas} links to #/signup`);
    const items = await page.locator('.peek-item, .peek-photo').count(), itemCtas = await page.locator('.peek-item .join-cta, .peek-photo .join-cta').count();
    check('every peek item has a join CTA', items === itemCtas, `${items} items, ${itemCtas} CTAs`);
    check('no @/emails on the page', !/@/.test(txt));
    check('peek has no horizontal overflow', await noOverflow(page));
    check('no page errors', errors.length === 0, errors.join(' | '));
    await page.screenshot({ path: path.join(DIR, 'peek-page.png'), fullPage: true });
    console.log('INFO peek text:', txt.replace(/\s+/g, ' ').slice(0, 900));

    await page.locator('.peek-final a.btn').click(); await page.waitForFunction(() => location.hash === '#/signup'); await settle(page);
    check('bottom CTA routes to #/signup with the form', await page.locator('#f #name').isVisible());

    if (memberArg) {
      const [email, pw] = memberArg.split(':');
      const r = await page.evaluate(async ([e, p]) => (await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'CoffeeBuds' }, body: JSON.stringify({ email: e, password: p, remember: true }) })).status, [email, pw]);
      check('member login (throwaway)', r === 200, String(r));
      await page.goto(BASE + '/#/peek'); await settle(page);
      check('logged-in member visiting #/peek is redirected home', page.url().endsWith('#/inbox'), page.url());
    }
    await ctx.close();
  } finally { await browser.close(); }
  console.log(fails ? `${fails} check(s) failed` : 'All peek checks passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
