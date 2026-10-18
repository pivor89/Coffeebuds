const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbstats-')), 't.sqlite');
delete process.env.DATABASE_URL;
const db = require('../src/db');
const stats = require('../src/stats');

test('visits: pageviews + daily uniques, no IPs stored', async () => {
  await db.init(); await stats.init();
  const ua = 'Mozilla/5.0 Safari';
  await stats.recordVisit('1.2.3.4', ua); await stats.recordVisit('1.2.3.4', ua); await stats.recordVisit('5.6.7.8', ua);
  await stats.recordVisit('9.9.9.9', 'Googlebot');
  const s = await stats.summary();
  assert.strictEqual(s.today.pageviews, 3); assert.strictEqual(s.today.visitors, 2);
  assert.strictEqual(s.all_time.visitors, 2); assert.strictEqual(s.yesterday.pageviews, 0);
  const dump = JSON.stringify(await db.all('SELECT * FROM stats_visitors'));
  assert.ok(!dump.includes('1.2.3.4'));
  assert.strictEqual(stats.addDays('2026-03-01', -1), '2026-02-28');
});
