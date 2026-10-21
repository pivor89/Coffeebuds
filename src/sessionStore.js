// express-session store: Postgres (connect-pg-simple) when DATABASE_URL is set, otherwise our SQLite DB.
// Either way logins survive restarts.
const session = require('express-session');
const db = require('./db');

class SqliteStore extends session.Store {
  static async create(ttlMs) {
    await db.run('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)');
    return new SqliteStore(ttlMs);
  }
  constructor(ttlMs = 864e5) {
    super(); this.ttlMs = ttlMs;
    setInterval(() => db.run('DELETE FROM sessions WHERE expires < ?', [Date.now()]).catch(() => {}), 3600e3).unref();
  }
  // Browser-session cookies carry no expiry, so the server row falls back to ttlMs (same lifetime as persistent logins).
  exp(s) { return s?.cookie?.expires ? new Date(s.cookie.expires).getTime() : Date.now() + this.ttlMs; }
  wrap(p, cb, map = () => null) { p.then((r) => cb && cb(null, map(r)), (e) => cb && cb(e)); }
  get(sid, cb) { this.wrap(db.get('SELECT data, expires FROM sessions WHERE sid=?', [sid]), cb, (r) => (r && r.expires > Date.now() ? JSON.parse(r.data) : null)); }
  set(sid, s, cb) { this.wrap(db.run('INSERT OR REPLACE INTO sessions(sid,data,expires) VALUES (?,?,?)', [sid, JSON.stringify(s), this.exp(s)]), cb); }
  destroy(sid, cb) { this.wrap(db.run('DELETE FROM sessions WHERE sid=?', [sid]), cb); }
  touch(sid, s, cb) { this.wrap(db.run('UPDATE sessions SET expires=? WHERE sid=?', [this.exp(s), sid]), cb); }
}

async function createStore({ ttlMs } = {}) {
  if (!db.isPg) return SqliteStore.create(ttlMs);
  const PgStore = require('connect-pg-simple')(session);
  // Table name "session" is connect-pg-simple's default; createTableIfMissing builds it (and its expire index) on startup.
  return new PgStore({ pool: db.pool(), tableName: 'session', createTableIfMissing: true, pruneSessionInterval: 3600,
    ...(ttlMs ? { ttl: Math.round(ttlMs / 1000) } : {}) }); // ttl (seconds) applies to session cookies without an expiry
}
module.exports = { createStore, SqliteStore };
