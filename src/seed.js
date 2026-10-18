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

// Only seeds an empty database, so real data is never overwritten or duplicated on restart.
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
module.exports = { seed };
