// Hands-on QA walk-through: node scripts/qa.js [mobile|desktop]
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:3000', OUT = __dirname + '/../screenshots/';
const mode = process.argv[2] || 'mobile';
const ctxOpts = mode === 'mobile' ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1280, height: 860 } };
const pre = mode === 'mobile' ? 'mobile-' : 'desktop-';
const issues = [];
(async () => {
  const b = await chromium.launch();
  async function session(email) {
    const ctx = await b.newContext(ctxOpts); await ctx.addInitScript(() => localStorage.setItem('cb_install_dismissed', '1')); const p = await ctx.newPage();
    p.on('console', (m) => m.type() === 'error' && issues.push(`[console ${email}] ${m.text()}`));
    p.on('pageerror', (e) => issues.push(`[pageerror ${email}] ${e.message}`));
    p.on('response', (r) => r.status() >= 500 && issues.push(`[5xx] ${r.url()}`));
    await p.goto(BASE + '/#/login'); await p.waitForSelector('#f');
    await p.fill('#email', email); await p.fill('#password', 'coffee123'); await p.click('button[type=submit]');
    await p.waitForSelector('.pagehead'); return p;
  }
  const shot = async (p, name, full = false) => { await p.waitForTimeout(700); await p.screenshot({ path: OUT + pre + name + '.png', fullPage: full }); };
  const overflow = async (p, label) => {
    const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth,
      wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('.leaflet-container')).slice(0, 5).map((e) => e.tagName + '.' + e.className) }));
    if (r.sw > r.w) issues.push(`[overflow ${label}] scrollWidth ${r.sw} > ${r.w}: ${r.wide.join(', ')}`);
  };
  // logged-out pages
  const ctx0 = await b.newContext(ctxOpts); await ctx0.addInitScript(() => localStorage.setItem('cb_install_dismissed', '1')); const p0 = await ctx0.newPage();
  await p0.goto(BASE + '/#/login'); await p0.waitForSelector('#f'); await overflow(p0, 'login'); await shot(p0, 'login');
  await p0.goto(BASE + '/#/signup'); await p0.waitForSelector('#name'); await p0.click('button[type=submit]'); await shot(p0, 'signup-validation');

  const demo = await session('demo@coffeebuds.app');
  await overflow(demo, 'inbox'); await shot(demo, 'inbox', true);
  // profile: add topics
  await demo.goto(BASE + '/#/profile'); await demo.waitForSelector('#tlist');
  await demo.fill('#tnew', 'Sourdough Baking'); await demo.selectOption('#trole', 'learn'); await demo.click('#tf button');
  await demo.fill('#tnew', 'Resume Writing'); await demo.selectOption('#trole', 'teach'); await demo.click('#tf button');
  await demo.click('#tsave'); await demo.waitForTimeout(500);
  await overflow(demo, 'profile'); await shot(demo, 'profile', true);
  // new 'learn' meetup with searched cafe
  await demo.goto(BASE + '/#/new'); await demo.waitForSelector('.shopitem', { timeout: 20000 });
  await overflow(demo, 'new'); await shot(demo, 'new-meetup', true);
  // --- map checks ---
  await demo.waitForFunction(() => document.querySelectorAll('#map img.leaflet-tile-loaded').length >= 4, null, { timeout: 15000 }).catch(() => issues.push('[map] tiles did not load'));
  const mapInfo = await demo.evaluate(() => ({ tiles: document.querySelectorAll('#map img.leaflet-tile-loaded').length, markers: document.querySelectorAll('#map .cafe-marker').length, h: document.querySelector('#map').offsetHeight, w: document.querySelector('#map').offsetWidth }));
  console.log('map:', JSON.stringify(mapInfo));
  if (mapInfo.markers < 1) issues.push('[map] no cafe markers');
  await demo.locator('#map .cafe-marker').nth(1).dispatchEvent('click'); await demo.waitForTimeout(400);
  const chosen = await demo.textContent('#chosen'); console.log('marker click ->', chosen.trim()); if (!chosen.includes('Selected')) issues.push('[map] marker click did not select');
  await demo.waitForTimeout(700); await demo.locator('.card:has(#map)').screenshot({ path: OUT + pre + 'map-marker-selected.png' });
  await demo.fill('#areaQ', 'Ybor City, Tampa'); await demo.click('#areaGo'); await demo.waitForTimeout(4000);
  const c = await demo.evaluate(() => document.querySelector('#nearMsg').textContent); console.log('area search ->', c);
  await demo.waitForTimeout(1500); await demo.locator('.card:has(#map)').screenshot({ path: OUT + pre + 'map-area-search.png' });
  await demo.fill('#topic', 'AI'); await demo.click('.shopitem');
  await demo.fill('#note', 'QA: want to learn AI'); await demo.click('#f button[type=submit]');
  await demo.waitForSelector('.section-title', { timeout: 10000 }).catch(() => issues.push('[flow] learn invite submit did not navigate'));
  // new 'teach' meetup with manual cafe
  await demo.goto(BASE + '/#/new'); await demo.waitForSelector('#roleSeg');
  await demo.click('#roleSeg [data-v="teach"]'); await demo.fill('#topic', 'Resume writing');
  await demo.click('details summary'); await demo.fill('#mName', 'QA Corner Café'); await demo.fill('#mAddr', 'Tampa');
  await demo.fill('#mLat', '27.9600'); await demo.fill('#mLng', '-82.4600'); await demo.click('#mUse');
  await demo.click('#f button[type=submit]');
  await demo.waitForSelector('.section-title', { timeout: 10000 }).catch(() => issues.push('[flow] teach invite submit did not navigate'));
  await overflow(demo, 'meetups'); await shot(demo, 'meetups', true);

  // Maya (can teach AI) should get the learn invite
  const maya = await session('maya@example.com');
  const cards = await maya.$$eval('.invite h3', (els) => els.map((e) => e.textContent));
  if (!cards.includes('AI')) issues.push('[match] Maya did not receive demo AI invite: ' + cards);
  await overflow(maya, 'maya-inbox'); await shot(maya, 'inbox-recipient', true);
  const card = await maya.$('.invite:has(h3:text-is("AI")) [data-rsvp="accepted"]'); if (card) await card.click(); await maya.waitForTimeout(600);
  
  await maya.goto(BASE + '/#/notifications'); await maya.waitForSelector('.pagehead'); await overflow(maya, 'notifs'); await shot(maya, 'notifications-recipient');
  // filter
  await maya.goto(BASE + '/#/inbox'); await maya.waitForSelector('#seg'); await maya.click('#seg [data-v="teach"]'); await maya.waitForTimeout(400); await shot(maya, 'inbox-filter-teach');

  // demo sees RSVP notification + invite detail
  await demo.goto(BASE + '/#/notifications'); await demo.waitForSelector('.pagehead'); await shot(demo, 'notifications');
  const link = await demo.$('.notif'); if (link) { await link.click(); await demo.waitForSelector('#dmap'); await overflow(demo, 'detail'); await shot(demo, 'invite-detail', true); }
  // sign out
  await demo.goto(BASE + '/#/profile'); await demo.waitForSelector('#tlist');
  const lo = await demo.$('[data-logout]');
  if (!lo) issues.push('[ui] No sign-out control'); else { await lo.click(); await demo.waitForSelector('#f'); if (!demo.url().includes('login')) issues.push('[flow] logout did not land on login'); }
  // nav fit
  const nav = await maya.evaluate(() => { const n = document.querySelector('.nav'); return n && [n.scrollWidth, n.clientWidth]; });
  if (nav && nav[0] > nav[1]) issues.push('[nav] mobile nav overflows ' + nav);
  await b.close();
  console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'No issues detected');
})().catch((e) => { console.error('QA crashed:', e.message); console.log(issues.join('\n')); process.exit(1); });
