// Privacy-friendly analytics. No cookies, no IPs stored.
// Page views are counted per UTC day. Unique visitors are counted with a hash of (daily random salt + IP + user agent);
// the salt rotates every UTC day and old salts/hashes are deleted, so visitors can't be linked across days or re-identified.
// Signups / invites / matches are derived from existing app tables.
const crypto = require('crypto');
const db = require('./db');

const day = (d = new Date()) => d.toISOString().slice(0, 10);
const addDays = (s, n) => day(new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5));
const BOT_RE = /bot|crawl|spider|slurp|preview|monitor|uptime|curl|wget|python|node-fetch|axios|headless|lighthouse/i;

async function init() {
  for (const q of [
    'CREATE TABLE IF NOT EXISTS stats_daily (day TEXT NOT NULL, metric TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, metric))',
    'CREATE TABLE IF NOT EXISTS stats_salt (day TEXT PRIMARY KEY, salt TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS stats_visitors (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(day, hash))',
  ]) await db.run(q);
}

const bump = (d, metric) => db.run('INSERT INTO stats_daily(day,metric,count) VALUES (?,?,1) ON CONFLICT(day,metric) DO UPDATE SET count=stats_daily.count+1', [d, metric]);

let saltCache = { day: null, salt: null };
async function saltFor(d) {
  if (saltCache.day === d) return saltCache.salt;
  await db.run('INSERT INTO stats_salt(day,salt) VALUES (?,?) ON CONFLICT(day) DO NOTHING', [d, crypto.randomBytes(32).toString('hex')]);
  const { salt } = await db.get('SELECT salt FROM stats_salt WHERE day=?', [d]);
  // Rotation: forget previous days' salts and visitor hashes.
  await db.run('DELETE FROM stats_salt WHERE day<?', [d]);
  await db.run('DELETE FROM stats_visitors WHERE day<?', [d]);
  saltCache = { day: d, salt };
  return salt;
}

async function recordVisit(ip, ua) {
  if (!ua || BOT_RE.test(ua)) return;
  const d = day();
  await bump(d, 'pageviews');
  const hash = crypto.createHash('sha256').update(`${await saltFor(d)}|${ip || ''}|${ua}`).digest('hex');
  if (!(await db.get('SELECT 1 AS x FROM stats_visitors WHERE day=? AND hash=?', [d, hash]))) {
    await db.run('INSERT INTO stats_visitors(day,hash) VALUES (?,?) ON CONFLICT(day,hash) DO NOTHING', [d, hash]);
    await bump(d, 'visitors');
  }
}

// Express middleware: count HTML page navigations (not API calls, assets, or the service worker).
function middleware(req, res, next) {
  if (req.method === 'GET' && !req.path.startsWith('/api') && (req.path === '/' || !/\.[a-z0-9]+$/i.test(req.path) || req.path.endsWith('.html'))
    && (req.get('accept') || '').includes('text/html') && req.get('purpose') !== 'prefetch') {
    recordVisit(req.ip, req.get('user-agent')).catch((e) => console.error('stats:', e.message));
  }
  next();
}

// Totals for [from, to] inclusive (YYYY-MM-DD, UTC). from=null => all-time.
async function range(from, to) {
  const lo = from || '0000-00-00', hi = to + ' 99'; // created_at is 'YYYY-MM-DD HH:MM:SS'
  const m = Object.fromEntries((await db.all('SELECT metric, SUM(count) AS n FROM stats_daily WHERE day>=? AND day<=? GROUP BY metric', [lo, to])).map((r) => [r.metric, Number(r.n)]));
  const n = async (sql) => Number((await db.get(sql, [lo, hi])).n) || 0;
  return {
    pageviews: m.pageviews || 0,
    visitors: m.visitors || 0, // sum of daily uniques (cross-day uniqueness is intentionally not tracked)
    signups: await n('SELECT COUNT(*) AS n FROM users WHERE created_at>=? AND created_at<=?'),
    invites: await n('SELECT COUNT(*) AS n FROM invites WHERE created_at>=? AND created_at<=?'),
    matches: await n('SELECT COUNT(*) AS n FROM invite_recipients r JOIN invites i ON i.id=r.invite_id WHERE i.created_at>=? AND i.created_at<=?'),
    accepted: await n("SELECT COUNT(*) AS n FROM invite_recipients WHERE status='accepted' AND responded_at>=? AND responded_at<=?"),
  };
}

async function summary(now = new Date()) {
  const today = day(now), yesterday = addDays(today, -1);
  return {
    generated_at: now.toISOString(), timezone: 'UTC',
    today: { date: today, ...(await range(today, today)) },
    yesterday: { date: yesterday, ...(await range(yesterday, yesterday)) },
    last_7_days: { from: addDays(today, -6), to: today, ...(await range(addDays(today, -6), today)) },
    all_time: await range(null, today),
    notes: 'visitors = daily unique visitors via daily-rotating salted hash (no cookies/IPs stored); matches = invite recipients matched when invites were created; accepted = RSVPs accepted.',
  };
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

async function handler(req, res) {
  const expected = process.env.STATS_TOKEN;
  const bearer = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  const given = bearer || (typeof req.query.token === 'string' ? req.query.token : '');
  res.set('Cache-Control', 'no-store');
  if (!expected) return res.status(503).json({ error: 'Stats disabled (STATS_TOKEN not set).' });
  if (!given || !safeEqual(given, expected)) return res.status(401).json({ error: 'Unauthorized' });
  res.json(await summary());
}

module.exports = { init, recordVisit, middleware, summary, handler, day, addDays };
