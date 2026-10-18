// SQLite via sql.js (pure WASM, no native build needed). Persisted to a file after each write.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'coffeebuds.sqlite');
let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  name TEXT NOT NULL, photo_url TEXT, location_label TEXT, lat REAL, lng REAL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS topics (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, topic TEXT NOT NULL, label TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('learn','teach')), UNIQUE(user_id, topic, role));
CREATE TABLE IF NOT EXISTS shops (id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT, lat REAL NOT NULL, lng REAL NOT NULL, osm_id TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS invites (id INTEGER PRIMARY KEY, creator_id INTEGER NOT NULL, shop_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('learn','teach')), topic TEXT NOT NULL, topic_label TEXT NOT NULL, starts_at TEXT NOT NULL,
  note TEXT, max_attendees INTEGER NOT NULL DEFAULT 4, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS invite_recipients (invite_id INTEGER NOT NULL, user_id INTEGER NOT NULL, distance_mi REAL,
  status TEXT NOT NULL DEFAULT 'pending', responded_at TEXT, PRIMARY KEY(invite_id, user_id));
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL,
  invite_id INTEGER, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`;

async function init() {
  const SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  db.exec(SCHEMA);
  save();
}
function save() { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
function all(sql, params = []) {
  const st = db.prepare(sql); st.bind(params); const rows = [];
  while (st.step()) rows.push(st.getAsObject());
  st.free(); return rows;
}
function get(sql, params = []) { return all(sql, params)[0]; }
function run(sql, params = [], persist = true) {
  db.run(sql, params);
  const id = get('SELECT last_insert_rowid() AS id').id;
  if (persist) save();
  return id;
}
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); save(); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
module.exports = { init, all, get, run, tx, save };
