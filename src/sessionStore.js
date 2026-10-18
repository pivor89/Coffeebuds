// Minimal express-session store backed by our SQLite DB, so logins survive restarts.
const session = require('express-session');
const db = require('./db');
class SqliteStore extends session.Store {
  constructor() {
    super();
    db.run('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)');
    setInterval(() => db.run('DELETE FROM sessions WHERE expires < ?', [Date.now()]), 3600e3).unref();
  }
  exp(s) { return s?.cookie?.expires ? new Date(s.cookie.expires).getTime() : Date.now() + 864e5; }
  get(sid, cb) {
    try { const r = db.get('SELECT data, expires FROM sessions WHERE sid=?', [sid]); cb(null, r && r.expires > Date.now() ? JSON.parse(r.data) : null); } catch (e) { cb(e); }
  }
  set(sid, s, cb) {
    try { db.run('INSERT OR REPLACE INTO sessions(sid,data,expires) VALUES (?,?,?)', [sid, JSON.stringify(s), this.exp(s)]); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) { try { db.run('DELETE FROM sessions WHERE sid=?', [sid]); cb && cb(null); } catch (e) { cb && cb(e); } }
  touch(sid, s, cb) { try { db.run('UPDATE sessions SET expires=? WHERE sid=?', [this.exp(s), sid]); cb && cb(null); } catch (e) { cb && cb(e); } }
}
module.exports = SqliteStore;
