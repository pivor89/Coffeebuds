// Mobile screenshots of each selectable theme: node scripts/theme-screenshots.js [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:3000', OUT = __dirname + '/../screenshots/';
(async () => {
  const b = await chromium.launch();
  for (const theme of ['paris', 'lounge']) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const m = await ctx.newPage();
    await m.goto(BASE + '/?theme=' + theme + '#/login'); await m.waitForSelector('#f'); await m.waitForTimeout(1200);
    await m.screenshot({ path: OUT + `theme-${theme}-1-home.png` });
    // the cookie keeps the theme on later visits without ?theme
    await m.goto(BASE + '/#/login'); await m.waitForSelector('#f');
    if (await m.getAttribute('html', 'data-theme') !== theme) throw new Error('theme cookie not applied for ' + theme);
    await m.fill('#email', 'demo@coffeebuds.app'); await m.fill('#password', 'coffee123'); await m.click('button[type=submit]');
    await m.waitForSelector('.invite'); await m.waitForTimeout(1000);
    await m.screenshot({ path: OUT + `theme-${theme}-2-invites.png` });
    await m.goto(BASE + '/#/new'); await m.waitForSelector('.shopitem', { timeout: 20000 }); await m.click('.shopitem'); await m.waitForTimeout(2000);
    await m.screenshot({ path: OUT + `theme-${theme}-3-new-meetup.png`, fullPage: true });
    await m.goto(BASE + '/#/profile'); await m.waitForSelector('#tlist'); await m.evaluate(() => window.scrollTo(0, 0)); await m.waitForTimeout(1000);
    await m.screenshot({ path: OUT + `theme-${theme}-4-profile.png` });
    await ctx.close();
  }
  await b.close(); console.log('theme screenshots saved');
})().catch((e) => { console.error(e); process.exit(1); });
