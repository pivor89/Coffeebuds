// Data layer with two backends behind one async API (all/get/run/tx):
//  - Postgres (via `pg`) when DATABASE_URL is set, e.g. a free Neon database. Durable across restarts.
//  - SQLite via sql.js (pure WASM) otherwise, persisted to DB_PATH after each write. Used for local dev/tests.
// Queries are written with `?` placeholders; they're rewritten to $1..$n for Postgres.
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const DATABASE_URL = process.env.DATABASE_URL || '';
const isPg = !!DATABASE_URL;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'coffeebuds.sqlite');
const txStore = new AsyncLocalStorage();

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  name TEXT NOT NULL, photo_url TEXT, location_label TEXT, lat REAL, lng REAL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  max_distance_mi INTEGER NOT NULL DEFAULT 15);
CREATE TABLE IF NOT EXISTS topics (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, topic TEXT NOT NULL, label TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('learn','teach')), UNIQUE(user_id, topic, role));
CREATE TABLE IF NOT EXISTS shops (id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT, lat REAL NOT NULL, lng REAL NOT NULL, osm_id TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS invites (id INTEGER PRIMARY KEY, creator_id INTEGER NOT NULL, shop_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('learn','teach')), topic TEXT NOT NULL, topic_label TEXT NOT NULL, starts_at TEXT NOT NULL,
  note TEXT, max_attendees INTEGER NOT NULL DEFAULT 4, created_at TEXT DEFAULT CURRENT_TIMESTAMP, radius_mi INTEGER NOT NULL DEFAULT 15);
CREATE TABLE IF NOT EXISTS invite_recipients (invite_id INTEGER NOT NULL, user_id INTEGER NOT NULL, distance_mi REAL,
  status TEXT NOT NULL DEFAULT 'pending', responded_at TEXT, PRIMARY KEY(invite_id, user_id));
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL,
  invite_id INTEGER, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS blocks (blocker_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(blocker_id, blocked_id));
CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, reporter_id INTEGER NOT NULL, reported_id INTEGER NOT NULL, invite_id INTEGER, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL,
  width INTEGER, height INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, image_id TEXT NOT NULL, caption TEXT, invite_id INTEGER, shop_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`;

// Postgres equivalent. Timestamps stay TEXT in SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC) format so app behavior is identical.
const PG_NOW = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;
const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  name TEXT NOT NULL, photo_url TEXT, location_label TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, created_at TEXT DEFAULT ${PG_NOW},
  max_distance_mi INTEGER NOT NULL DEFAULT 15);
CREATE TABLE IF NOT EXISTS topics (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, topic TEXT NOT NULL, label TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('learn','teach')), UNIQUE(user_id, topic, role));
CREATE TABLE IF NOT EXISTS shops (id SERIAL PRIMARY KEY, name TEXT NOT NULL, address TEXT, lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL, osm_id TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS invites (id SERIAL PRIMARY KEY, creator_id INTEGER NOT NULL, shop_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('learn','teach')), topic TEXT NOT NULL, topic_label TEXT NOT NULL, starts_at TEXT NOT NULL,
  note TEXT, max_attendees INTEGER NOT NULL DEFAULT 4, created_at TEXT DEFAULT ${PG_NOW}, radius_mi INTEGER NOT NULL DEFAULT 15);
CREATE TABLE IF NOT EXISTS invite_recipients (invite_id INTEGER NOT NULL, user_id INTEGER NOT NULL, distance_mi DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'pending', responded_at TEXT, PRIMARY KEY(invite_id, user_id));
CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL,
  invite_id INTEGER, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT ${PG_NOW});
CREATE INDEX IF NOT EXISTS idx_topics_topic ON topics(topic);
CREATE INDEX IF NOT EXISTS idx_invites_creator ON invites(creator_id);
CREATE INDEX IF NOT EXISTS idx_recipients_user ON invite_recipients(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE TABLE IF NOT EXISTS blocks (blocker_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL, created_at TEXT DEFAULT ${PG_NOW}, PRIMARY KEY(blocker_id, blocked_id));
CREATE TABLE IF NOT EXISTS reports (id SERIAL PRIMARY KEY, reporter_id INTEGER NOT NULL, reported_id INTEGER NOT NULL, invite_id INTEGER, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT DEFAULT ${PG_NOW});
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);
CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, data BYTEA NOT NULL,
  width INTEGER, height INTEGER, created_at TEXT DEFAULT ${PG_NOW});
CREATE TABLE IF NOT EXISTS posts (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, image_id TEXT NOT NULL, caption TEXT, invite_id INTEGER, shop_id INTEGER,
  created_at TEXT DEFAULT ${PG_NOW});
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS post_id INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS hidden_at TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
-- Adjustable match radius (1-15 mi). Constant defaults backfill existing rows with 15 (the previous fixed radius).
ALTER TABLE invites ADD COLUMN IF NOT EXISTS radius_mi INTEGER NOT NULL DEFAULT 15;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_distance_mi INTEGER NOT NULL DEFAULT 15;
CREATE TABLE IF NOT EXISTS admin_actions (id SERIAL PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id INTEGER, reason TEXT, created_at TEXT DEFAULT ${PG_NOW});
`;

// ---------------- SQLite (sql.js) backend ----------------
let sdb;
let sqliteLock = Promise.resolve(); // serializes sqlite transactions against other statements
const sqlite = {
  async init() {
    const SQL = await require('sql.js')();
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    sdb = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
    sdb.exec(SQLITE_SCHEMA);
    sdb.exec(`CREATE INDEX IF NOT EXISTS idx_topics_topic ON topics(topic);
      CREATE INDEX IF NOT EXISTS idx_invites_creator ON invites(creator_id);
      CREATE INDEX IF NOT EXISTS idx_recipients_user ON invite_recipients(user_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);`);
    for (const q of ['ALTER TABLE reports ADD COLUMN post_id INTEGER', 'ALTER TABLE users ADD COLUMN suspended_at TEXT', 'ALTER TABLE posts ADD COLUMN hidden_at TEXT', 'ALTER TABLE posts ADD COLUMN hidden_reason TEXT',
      'ALTER TABLE invites ADD COLUMN radius_mi INTEGER NOT NULL DEFAULT 15', 'ALTER TABLE users ADD COLUMN max_distance_mi INTEGER NOT NULL DEFAULT 15']) {
      try { sdb.exec(q); } catch { /* column already there */ }
    }
    sdb.exec('CREATE TABLE IF NOT EXISTS admin_actions (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id INTEGER, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
    sqlite.save();
  },
  save() { fs.writeFileSync(DB_PATH, Buffer.from(sdb.export())); },
  allSync(sql, params) {
    const st = sdb.prepare(sql); st.bind(params); const rows = [];
    while (st.step()) rows.push(st.getAsObject());
    st.free(); return rows;
  },
  async wait() { if (!txStore.getStore()) await sqliteLock; },
  async all(sql, params) { await sqlite.wait(); return sqlite.allSync(sql, params); },
  async run(sql, params) {
    await sqlite.wait();
    sdb.run(sql, params);
    const id = sqlite.allSync('SELECT last_insert_rowid() AS id', [])[0].id;
    if (!txStore.getStore()) sqlite.save();
    return id;
  },
  async tx(fn) {
    if (txStore.getStore()) return fn();
    const prev = sqliteLock; let release;
    sqliteLock = new Promise((r) => (release = r));
    await prev;
    try {
      return await txStore.run(true, async () => {
        sdb.exec('BEGIN');
        try { const r = await fn(); sdb.exec('COMMIT'); sqlite.save(); return r; } catch (e) { sdb.exec('ROLLBACK'); throw e; }
      });
    } finally { release(); }
  },
};

// ---------------- Postgres backend ----------------
let pool;
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i).replace(/CURRENT_TIMESTAMP/g, PG_NOW); };
const pg = {
  async init() {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, Number); // int8 (COUNT/SUM) -> number, like SQLite
    types.setTypeParser(1700, Number); // numeric -> number
    // Neon URLs include ?sslmode=require; pg would let that override our ssl object, so strip it and set SSL explicitly.
    // Plain local servers (localhost / sslmode=disable) connect without SSL.
    const url = new URL(DATABASE_URL);
    const noSsl = url.searchParams.get('sslmode') === 'disable' || (['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) && !url.searchParams.get('sslmode'));
    ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'channel_binding'].forEach((k) => url.searchParams.delete(k));
    pool = new Pool({ connectionString: url.toString(), ssl: noSsl ? false : { rejectUnauthorized: false }, max: Number(process.env.PG_POOL_MAX) || 5 });
    pool.on('error', (e) => console.error('Postgres pool error:', e.message));
    await pool.query(PG_SCHEMA);
  },
  client() { return txStore.getStore() || pool; },
  async all(sql, params) { return (await pg.client().query(toPg(sql), params)).rows; },
  async run(sql, params) {
    let q = toPg(sql);
    // Mirror sqlite's last_insert_rowid() for tables with a serial id
    const wantsId = /^\s*INSERT\s+INTO\s+(users|topics|shops|invites|notifications|reports|posts|admin_actions)\b/i.test(q) && !/RETURNING/i.test(q);
    if (wantsId) q += ' RETURNING id';
    const r = await pg.client().query(q, params);
    return wantsId ? r.rows[0]?.id : undefined;
  },
  async tx(fn) {
    if (txStore.getStore()) return fn();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await txStore.run(c, fn);
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  },
};

const impl = isPg ? pg : sqlite;
module.exports = {
  isPg,
  init: () => impl.init(),
  all: (sql, params = []) => impl.all(sql, params),
  get: async (sql, params = []) => (await impl.all(sql, params))[0],
  run: (sql, params = []) => impl.run(sql, params), // returns the new row id for INSERTs
  tx: (fn) => impl.tx(fn), // fn is async; every db call inside it (in the same async context) joins the transaction
  pool: () => pool,
};
