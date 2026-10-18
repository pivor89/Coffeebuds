// End-to-end check against a running server: node scripts/e2e.js [baseUrl]
const BASE = process.argv[2] || 'http://localhost:3000';
const assert = require('node:assert');
function client() {
  let cookie = '';
  return async (path, method = 'GET', body) => {
    const r = await fetch(BASE + '/api' + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}
const ok = (m) => console.log('  ✓ ' + m);
const inTwoDays = new Date(Date.now() + 2 * 864e5).toISOString();
(async () => {
  const stamp = Date.now();
  const taylor = client();
  let r = await taylor('/signup', 'POST', { email: 'bad', password: 'x', name: '' }); assert.equal(r.status, 400); ok('signup validation rejects bad input: ' + r.data.error);
  r = await taylor('/signup', 'POST', { email: `taylor${stamp}@example.com`, password: 'secret12', name: 'Taylor Test' }); assert.equal(r.status, 201); ok('signup new user');
  r = await taylor('/profile', 'PUT', { name: 'Taylor Test', location_label: 'Channelside, Tampa', lat: 27.9455, lng: -82.4520 }); assert.equal(r.status, 200); ok('set home location');
  r = await taylor('/topics', 'PUT', { topics: [{ label: '  AI ', role: 'teach' }, { label: 'Cake Decorating', role: 'learn' }] });
  assert.deepEqual(r.data.topics.map((t) => t.topic + ':' + t.role).sort(), ['ai:teach', 'cake decorating:learn']); ok('topics saved & normalized');
  r = await taylor('/invites', 'POST', { role: 'teach', topic: 'AI', shop: { id: 2 }, starts_at: '2000-01-01T00:00:00Z' }); assert.equal(r.status, 400); ok('rejects past date: ' + r.data.error);
  r = await taylor('/invites', 'POST', { role: 'teach', topic: ' ai ', shop: { id: 2 }, starts_at: inTwoDays, note: 'Intro to LLMs, bring a laptop', max_attendees: 3 });
  assert.equal(r.status, 201); const inviteId = r.data.id; ok(`'can teach' AI invite at Kahwa created → ${r.data.recipients} recipients`);

  const demo = client(); await demo('/login', 'POST', { email: 'demo@coffeebuds.app', password: 'coffee123' });
  const jordan = client(); await jordan('/login', 'POST', { email: 'jordan@example.com', password: 'coffee123' });
  const lena = client(); await lena('/login', 'POST', { email: 'lena@example.com', password: 'coffee123' });
  const maya = client(); await maya('/login', 'POST', { email: 'maya@example.com', password: 'coffee123' });
  const has = async (c) => (await c('/invites/inbox')).data.some((i) => i.id === inviteId);
  assert.ok(await has(demo)); ok('demo (wants to learn AI, downtown) received it');
  assert.ok(await has(jordan)); ok('Jordan (wants to learn AI, Seminole Heights) received it');
  assert.ok(!(await has(lena))); ok('Lena (wants to learn AI, St. Pete ~16.5 mi) did NOT receive it (outside 15 mi)');
  assert.ok(!(await has(maya))); ok('Maya (can teach AI — same role) did NOT receive it');
  assert.equal(r.data.recipients, 2); ok('exactly 2 recipients');
  r = await demo('/invites/inbox?role=learn'); assert.ok(!r.data.some((i) => i.id === inviteId)); ok('inbox Learn filter excludes Teach invite');
  r = await demo('/me'); assert.ok(r.data.unread >= 1); ok('demo has unread notification badge: ' + r.data.unread);

  r = await demo(`/invites/${inviteId}/rsvp`, 'POST', { status: 'accepted' }); assert.equal(r.status, 200); ok('demo accepted');
  r = await jordan(`/invites/${inviteId}/rsvp`, 'POST', { status: 'declined' }); assert.equal(r.status, 200); ok('Jordan declined');
  r = await maya(`/invites/${inviteId}/rsvp`, 'POST', { status: 'accepted' }); assert.equal(r.status, 404); ok('non-recipient cannot RSVP');
  r = await taylor('/invites/' + inviteId); assert.deepEqual(r.data.going.map((g) => g.name), ['Alex Rivera']); ok('host sees who is going: ' + r.data.going.map((g) => g.name));
  r = await taylor('/notifications'); assert.equal(r.data.filter((n) => n.type === 'rsvp' && n.invite_id === inviteId).length, 2); ok('host got 2 RSVP notifications');
  r = await demo('/meetups'); assert.ok(r.data.upcoming.some((i) => i.id === inviteId && i.relation === 'attending')); ok("appears in demo's upcoming meetups");

  r = await demo('/invites', 'POST', { role: 'learn', topic: 'cake decorating', shop: { id: 1 }, starts_at: inTwoDays, max_attendees: 4 });
  assert.equal(r.data.recipients, 1); assert.ok(await has.call(null, jordan).then(() => true));
  const jInbox = (await jordan('/invites/inbox')).data; assert.ok(jInbox.some((i) => i.id === r.data.id)); assert.ok(!(await taylor('/invites/inbox')).data.some((i) => i.id === r.data.id));
  ok("'want to learn' cake decorating invite → only Jordan (teacher); Taylor (learner) excluded");

  r = await demo('/invites', 'POST', { role: 'learn', topic: 'Spanish conversation', starts_at: inTwoDays, shop: { name: 'Manual Test Café', address: 'Tampa', lat: 27.95, lng: -82.46 } });
  assert.equal(r.status, 201); ok('manual coffee shop entry works');
  console.log('\nAll E2E checks passed.');
})().catch((e) => { console.error('E2E FAILED:', e); process.exit(1); });
