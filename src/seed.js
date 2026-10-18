const bcrypt = require('bcryptjs');
const db = require('./db');
const { normalizeTopic } = require('./matching');

const USERS = [
  ['demo@coffeebuds.app', 'Alex Rivera', 'Downtown Tampa', 27.9506, -82.4572, [['AI', 'learn'], ['Cake decorating', 'learn'], ['Product management', 'teach'], ['Spanish', 'teach']]],
  ['maya@example.com', 'Maya Chen', 'Hyde Park, Tampa', 27.9378, -82.4795, [['AI', 'teach'], ['Baking cookies', 'learn'], ['Data science careers', 'teach']]],
  ['jordan@example.com', 'Jordan Brooks', 'Seminole Heights, Tampa', 27.9978, -82.4590, [['Cake decorating', 'teach'], ['Baking cookies', 'teach'], ['AI', 'learn']]],
  ['priya@example.com', 'Priya Patel', 'Westchase', 28.0553, -82.6090, [['AI', 'teach'], ['Product management', 'learn'], ['Nursing careers', 'teach']]],
  ['sam@example.com', 'Sam Okafor', 'Ybor City, Tampa', 27.9608, -82.4370, [['Spanish', 'learn'], ['Photography', 'teach'], ['Product management', 'learn']]],
  ['lena@example.com', 'Lena Novak', 'St. Petersburg', 27.7676, -82.6403, [['Photography', 'learn'], ['Cake decorating', 'teach'], ['AI', 'learn']]],
  ['diego@example.com', 'Diego Morales', 'Brandon', 27.9378, -82.2859, [['Woodworking', 'teach'], ['Spanish', 'learn'], ['AI', 'teach']]],
  ['grace@example.com', 'Grace Kim', 'Lakeland (out of range)', 28.0395, -81.9498, [['AI', 'teach'], ['Baking cookies', 'learn']]],
];
const SHOPS = [
  ['Buddy Brew Coffee', '2020 W Kennedy Blvd, Tampa, FL', 27.9446, -82.4823],
  ['Kahwa Coffee', '204 E South St, Tampa, FL', 27.9425, -82.4560],
  ['Blind Tiger Cafe', '1901 E 7th Ave, Tampa, FL (Ybor)', 27.9606, -82.4381],
  ['Jet City Espresso', '3404 N Florida Ave, Tampa, FL', 27.9744, -82.4597],
];

// Dev/test only (never runs when NODE_ENV=production). Only seeds an empty database, so real data is never overwritten or duplicated on restart.
async function seed() {
  if ((await db.get('SELECT COUNT(*) c FROM users')).c > 0) return false;
  const hash = bcrypt.hashSync('coffee123', 10);
  await db.tx(async () => {
    for (const [email, name, loc, lat, lng, topics] of USERS) {
      const id = await db.run('INSERT INTO users(email,password_hash,name,location_label,lat,lng,photo_url) VALUES (?,?,?,?,?,?,?)',
        [email, hash, name, loc, lat, lng, `https://i.pravatar.cc/150?u=${email}`]);
      for (const [t, r] of topics) await db.run('INSERT INTO topics(user_id,topic,label,role) VALUES (?,?,?,?)', [id, normalizeTopic(t), t, r]);
    }
    for (const s of SHOPS) await db.run('INSERT INTO shops(name,address,lat,lng) VALUES (?,?,?,?)', s);
  });
  return true;
}
// Production clean-up (approved by Alex): delete every seeded sample account whose email EXACTLY matches the seed list above,
// with their topics, invites (+ RSVPs/notifications), notifications, blocks, reports and sessions. No other account is touched.
// Deletes a user and everything they own (topics, invites + RSVPs/notifications, posts + images, blocks, reports, sessions).
async function deleteUserCascade(uid) {
  await db.tx(async () => {
    const inv = 'SELECT id FROM invites WHERE creator_id=?';
    await db.run(`DELETE FROM invite_recipients WHERE user_id=? OR invite_id IN (${inv})`, [uid, uid]);
    await db.run(`DELETE FROM notifications WHERE user_id=? OR invite_id IN (${inv})`, [uid, uid]);
    await db.run(`DELETE FROM reports WHERE reporter_id=? OR reported_id=? OR invite_id IN (${inv}) OR post_id IN (SELECT id FROM posts WHERE user_id=?)`, [uid, uid, uid, uid]);
    await db.run(`DELETE FROM images WHERE id IN (SELECT image_id FROM posts WHERE user_id=? OR invite_id IN (${inv}))`, [uid, uid]);
    await db.run(`DELETE FROM posts WHERE user_id=? OR invite_id IN (${inv})`, [uid, uid]);
    await db.run('DELETE FROM images WHERE owner_id=?', [uid]);
    await db.run('DELETE FROM invites WHERE creator_id=?', [uid]);
    await db.run('DELETE FROM topics WHERE user_id=?', [uid]);
    await db.run('DELETE FROM blocks WHERE blocker_id=? OR blocked_id=?', [uid, uid]);
    if (db.isPg) await db.run("DELETE FROM session WHERE (sess::jsonb->>'userId') = ?", [String(uid)]).catch(() => {});
    else await db.run("DELETE FROM sessions WHERE json_extract(data,'$.userId') = ?", [uid]).catch(() => {});
    await db.run('DELETE FROM users WHERE id=?', [uid]);
  });
}
async function removeDemoAccounts() {
  let n = 0;
  for (const email of USERS.map((u) => u[0])) {
    const u = await db.get('SELECT id FROM users WHERE email=?', [email]);
    if (!u) continue;
    await deleteUserCascade(u.id);
    n++;
  }
  console.log(`Seed cleanup: deleted ${n} seeded sample account(s).`);
  return n;
}
// One-off, idempotent: round stored home coordinates to 2 decimals (~1 km).
async function coarsenHomeLocations() {
  const sql = db.isPg
    ? 'UPDATE users SET lat=ROUND(lat::numeric,2)::float8, lng=ROUND(lng::numeric,2)::float8 WHERE lat IS NOT NULL AND (lat<>ROUND(lat::numeric,2)::float8 OR lng<>ROUND(lng::numeric,2)::float8)'
    : 'UPDATE users SET lat=ROUND(lat,2), lng=ROUND(lng,2) WHERE lat IS NOT NULL AND (lat<>ROUND(lat,2) OR lng<>ROUND(lng,2))';
  const before = (await db.get(db.isPg ? 'SELECT COUNT(*) c FROM users WHERE lat IS NOT NULL AND (lat<>ROUND(lat::numeric,2)::float8 OR lng<>ROUND(lng::numeric,2)::float8)'
    : 'SELECT COUNT(*) c FROM users WHERE lat IS NOT NULL AND (lat<>ROUND(lat,2) OR lng<>ROUND(lng,2))')).c;
  if (before) await db.run(sql);
  console.log(`Location migration: rounded ${before} home location(s) to ~1 km.`);
  return before;
}
module.exports = { deleteUserCascade, seed, removeDemoAccounts, coarsenHomeLocations, USERS };
