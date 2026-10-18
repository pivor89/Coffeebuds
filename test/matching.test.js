const test = require('node:test');
const assert = require('node:assert');
const { haversineMiles, normalizeTopic, oppositeRole, findRecipients } = require('../src/matching');

const shop = { lat: 27.9506, lng: -82.4572 }; // downtown Tampa
const users = [
  { id: 1, lat: 27.95, lng: -82.46, topics: [{ topic: 'AI', role: 'learn' }] },               // creator
  { id: 2, lat: 27.96, lng: -82.45, topics: [{ topic: 'ai', role: 'teach' }] },               // near, teaches
  { id: 3, lat: 27.97, lng: -82.44, topics: [{ topic: ' AI ', role: 'learn' }] },             // near, same role
  { id: 4, lat: 28.54, lng: -81.38, topics: [{ topic: 'ai', role: 'teach' }] },               // Orlando, too far
  { id: 5, lat: 28.05, lng: -82.40, topics: [{ topic: 'Baking Cookies', role: 'teach' }] },   // other topic
  { id: 6, lat: 28.06, lng: -82.41, topics: [{ topic: 'ai', role: 'teach' }, { topic: 'baking  cookies', role: 'learn' }] },
  { id: 7, lat: null, lng: null, topics: [{ topic: 'ai', role: 'teach' }] },                  // no location
];

test('haversine: Tampa to Orlando ~ 77-80 mi', () => {
  const d = haversineMiles(27.9506, -82.4572, 28.5383, -81.3792);
  assert.ok(d > 75 && d < 82, String(d));
  assert.strictEqual(haversineMiles(1, 1, 1, 1), 0);
});

test('normalizeTopic lowercases, trims, collapses spaces', () => {
  assert.strictEqual(normalizeTopic('  Cake   Decorating '), 'cake decorating');
});

test('oppositeRole', () => {
  assert.strictEqual(oppositeRole('learn'), 'teach');
  assert.strictEqual(oppositeRole('teach'), 'learn');
  assert.throws(() => oppositeRole('x'));
});

test('"want to learn" invite goes to nearby teachers only, excluding creator', () => {
  const r = findRecipients(users, shop, { creatorId: 1, role: 'learn', topic: 'AI' });
  assert.deepStrictEqual(r.map((x) => x.userId), [2, 6]);
});

test('"can teach" invite goes to nearby learners only', () => {
  const r = findRecipients(users, shop, { creatorId: 2, role: 'teach', topic: 'ai' });
  assert.deepStrictEqual(r.map((x) => x.userId), [1, 3]);
});

test('topic matching is normalized', () => {
  const r = findRecipients(users, shop, { creatorId: 99, role: 'learn', topic: '  BAKING cookies' });
  assert.deepStrictEqual(r.map((x) => x.userId), [5]);
});

test('15 mile boundary is inclusive and excludes beyond', () => {
  // 1 degree latitude ~ 69.09 mi -> 15 mi ~ 0.2171 deg
  const near = { id: 10, lat: shop.lat + 0.2165, lng: shop.lng, topics: [{ topic: 'x', role: 'teach' }] };
  const far = { id: 11, lat: shop.lat + 0.2185, lng: shop.lng, topics: [{ topic: 'x', role: 'teach' }] };
  const r = findRecipients([near, far], shop, { creatorId: 0, role: 'learn', topic: 'x' });
  assert.deepStrictEqual(r.map((x) => x.userId), [10]);
});

test('distance is measured from the shop, not the creator', () => {
  const farShop = { lat: 28.5383, lng: -81.3792 };
  const r = findRecipients(users, farShop, { creatorId: 1, role: 'learn', topic: 'ai' });
  assert.deepStrictEqual(r.map((x) => x.userId), [4]);
});
