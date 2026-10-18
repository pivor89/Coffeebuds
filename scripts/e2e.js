// End-to-end check against a running server: node scripts/e2e.js [baseUrl]
const BASE = process.argv[2] || 'http://localhost:3000';
const assert = require('node:assert');
function client() {
  let cookie = '';
  const fn = async (path, method = 'GET', body) => {
    const r = await fetch(BASE + '/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'CoffeeBuds', cookie }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    fn.cookie = cookie;
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return fn;
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

  // ---------- Security protections ----------
  const raw = (path, opts = {}) => fetch(BASE + '/api' + path, opts);
  let x = await raw('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@coffeebuds.app', password: 'coffee123' }) });
  assert.equal(x.status, 403); ok('CSRF: POST without X-Requested-With header rejected');
  x = await raw('/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'CoffeeBuds', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(x.status, 403); ok('CSRF: cross-origin Origin rejected');
  x = await raw('/me'); const h = x.headers;
  assert.ok(h.get('content-security-policy')?.includes("frame-ancestors 'none'")); assert.equal(h.get('x-content-type-options'), 'nosniff'); assert.ok(!h.get('x-powered-by')); ok('security headers present (CSP, nosniff, no x-powered-by)');
  r = await taylor('/me'); assert.ok(!('password_hash' in r.data)); assert.equal(r.data.lat, 27.95); ok('home location stored coarsely (~1 km) and no hash in /me');
  r = await demo('/invites/' + inviteId); assert.ok(!JSON.stringify(r.data).match(/password|@example\.com|"email"/)); ok('invite payload leaks no emails/hashes');
  r = await taylor('/profile', 'PUT', { name: 'y'.repeat(81) }); assert.equal(r.status, 400); ok('name length limit');
  r = await taylor("/invites/1%20OR%201=1"); assert.equal(r.status, 404); ok('non-numeric ids rejected');
  r = await taylor('/signup', 'POST', { email: `short${stamp}@example.com`, password: 'short', name: 'S' }); assert.equal(r.status, 400); ok('password min length 8');
  const t2 = client(); r = await t2('/login', 'POST', { email: 'nobody@example.com', password: 'whatever1' }); const r2 = await t2('/login', 'POST', { email: `taylor${stamp}@example.com`, password: 'wrongpass' });
  assert.equal(r.data.error, r2.data.error); ok('login error identical for unknown email vs wrong password');
  r = await demo('/invites/' + inviteId + '/rsvp', 'POST', { status: 'declined' }); // demo (recipient) is fine
  r = await maya('/invites/' + inviteId); assert.equal(r.status, 404); ok('non-recipient cannot view invite');
  // block / report
  const taylorId = (await taylor('/me')).data.id, jordanId = (await jordan('/me')).data.id;
  r = await jordan(`/users/${taylorId}/report`, 'POST', { reason: 'Made me uncomfortable', invite_id: inviteId }); assert.equal(r.status, 201); ok('report user');
  r = await jordan(`/users/${taylorId}/report`, 'POST', { reason: '' }); assert.equal(r.status, 400); ok('report requires a reason');
  r = await jordan(`/users/${taylorId}/block`, 'POST'); assert.equal(r.status, 200);
  assert.ok(!(await has(jordan))); r = await jordan('/invites/' + inviteId); assert.equal(r.status, 404); ok('blocked host\'s invite hidden from blocker');
  r = await jordan('/blocks'); assert.deepEqual(r.data.map((b) => b.id), [taylorId]); ok('block list');
  r = await taylor('/invites', 'POST', { role: 'teach', topic: 'AI', shop: { id: 2 }, starts_at: inTwoDays }); assert.equal(r.status, 201);
  assert.ok(!(await jordan('/invites/inbox')).data.some((i) => i.id === r.data.id)); ok('blocked user cannot invite the blocker');
  r = await jordan('/invites', 'POST', { role: 'learn', topic: 'AI', shop: { id: 2 }, starts_at: inTwoDays }); const jid = r.data.id;
  assert.ok(!(await taylor('/invites/inbox')).data.some((i) => i.id === jid)); ok('blocker\'s invites do not reach the blocked user either');
  r = await jordan(`/users/${taylorId}/block`, 'DELETE'); assert.equal((await jordan('/blocks')).data.length, 0); ok('unblock');
  r = await jordan(`/users/${jordanId}/block`, 'POST'); assert.equal(r.status, 400); ok('cannot block yourself');

  // ---------- Photos ----------
  const sharp = require('sharp');
  const exifJpeg = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#a0522d' } }).jpeg()
    .withExif({ IFD0: { Copyright: 'SECRET-EXIF-MARKER', ImageDescription: 'GPS 27.95 -82.45' } }).toBuffer();
  assert.ok((await sharp(exifJpeg).metadata()).exif); // fixture really has EXIF
  const up = (c, path, buf, type = 'image/jpeg') => fetch(BASE + '/api' + path, { method: 'POST', headers: { 'Content-Type': type, 'X-Requested-With': 'CoffeeBuds', cookie: c.cookie }, body: buf })
    .then(async (x) => ({ status: x.status, data: await x.json().catch(() => null) }));
  // expose cookies from client() for raw uploads
  const ck = async (c) => { const m = await c('/me'); return m; };
  await ck(taylor);
  x = await fetch(BASE + '/api/uploads', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Requested-With': 'CoffeeBuds' }, body: exifJpeg }); assert.equal(x.status, 401); ok('upload requires login');
  r = await up(taylor, '/uploads', Buffer.from('<?php echo 1; ?> definitely not an image....'));
  assert.equal(r.status, 400); ok('upload rejects non-image by magic bytes: ' + r.data.error);
  r = await up(taylor, '/uploads', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]), 'image/png');
  assert.equal(r.status, 400); ok('corrupt PNG rejected');
  r = await up(taylor, '/uploads', Buffer.alloc(7 * 1024 * 1024, 1)); assert.equal(r.status, 413); ok('size cap enforced (413)');
  r = await up(taylor, '/uploads', exifJpeg); assert.equal(r.status, 201); const imgId = r.data.id;
  assert.ok(r.data.width <= 1600 && r.data.height <= 1600); ok(`wall photo resized to ${r.data.width}x${r.data.height}`);
  x = await fetch(BASE + r.data.url); const ib = Buffer.from(await x.arrayBuffer());
  assert.equal(x.headers.get('content-type'), 'image/webp'); assert.match(x.headers.get('cache-control'), /max-age=31536000.*immutable/);
  const meta = await sharp(ib).metadata(); assert.ok(!meta.exif && !ib.includes('SECRET-EXIF-MARKER')); ok('served from /img with long cache, re-encoded WebP, EXIF stripped');
  x = await fetch(BASE + '/img/' + 'f'.repeat(32)); assert.equal(x.status, 404); x = await fetch(BASE + '/img/../server.js'); assert.notEqual(x.headers.get('content-type'), 'application/javascript'); ok('unknown/invalid image ids 404');
  r = await up(taylor, '/profile/photo', exifJpeg); assert.equal(r.status, 201); assert.match(r.data.photo_url, /^\/img\/[a-f0-9]{32}$/);
  const av = await sharp(Buffer.from(await (await fetch(BASE + r.data.photo_url)).arrayBuffer())).metadata(); assert.ok(av.width <= 512 && !av.exif); ok('avatar upload → 512px, no EXIF');
  r = await taylor('/profile', 'PUT', { name: 'Taylor Test', photo_url: 'https://evil.example/x.png' }); assert.match(r.data.photo_url, /^\/img\//); ok('photo_url can no longer be set via profile');
  // posts
  r = await taylor('/posts', 'POST', { image_id: imgId, caption: 'z'.repeat(281) }); assert.equal(r.status, 400); ok('caption length limit');
  r = await demo('/posts', 'POST', { image_id: imgId }); assert.equal(r.status, 400); ok("can't post someone else's upload");
  r = await taylor('/posts', 'POST', { image_id: imgId, caption: 'Great chat about LLMs <script>alert(1)</script>', invite_id: jid }); assert.equal(r.status, 400); ok("can't link a meetup you didn't host/attend");
  r = await taylor('/posts', 'POST', { image_id: imgId, caption: 'Great chat about LLMs <script>alert(1)</script>', invite_id: inviteId });
  assert.equal(r.status, 201); assert.equal(r.data.shop_name, 'Kahwa Coffee'); const postId = r.data.id; ok('post with linked meetup (shop derived)');
  r = await taylor('/posts', 'POST', { image_id: imgId }); assert.equal(r.status, 400); ok('an upload can only be posted once');
  r = await demo('/posts'); const p0 = r.data.items.find((p) => p.id === postId); assert.ok(p0 && !p0.mine && !JSON.stringify(p0).match(/email|password|lat/)); ok('feed shows post, no private fields');
  r = await demo('/posts/' + postId, 'DELETE'); assert.equal(r.status, 403); ok("can't delete others' posts");
  r = await demo(`/posts/${postId}/report`, 'POST', { reason: 'Not a coffee photo' }); assert.equal(r.status, 201); ok('report post');
  r = await taylor(`/posts/${postId}/report`, 'POST', { reason: 'x' }); assert.equal(r.status, 400); ok("can't report own post");
  await demo(`/users/${taylorId}/block`, 'POST');
  assert.ok(!(await demo('/posts')).data.items.some((p) => p.id === postId)); ok('blocked user\'s posts hidden from blocker');
  const demoUp = await up(demo, '/uploads', exifJpeg); const dp = await demo('/posts', 'POST', { image_id: demoUp.data.id, caption: 'demo post' });
  assert.ok(!(await taylor('/posts')).data.items.some((p) => p.id === dp.data.id)); ok('blocker\'s posts hidden from blocked user');
  await demo(`/users/${taylorId}/block`, 'DELETE');
  // pagination
  const ids = []; for (let k = 0; k < 3; k++) { const u2 = await up(maya, '/uploads', exifJpeg); ids.push((await maya('/posts', 'POST', { image_id: u2.data.id, caption: 'p' + k })).data.id); }
  r = await maya('/posts?limit=2'); assert.equal(r.data.items.length, 2); assert.ok(r.data.next_before);
  const r2b = await maya('/posts?limit=2&before=' + r.data.next_before); assert.ok(r2b.data.items.every((p) => p.id < r.data.next_before)); ok('feed newest-first with cursor pagination');
  r = await taylor('/posts/' + postId, 'DELETE'); assert.equal(r.status, 200); x = await fetch(BASE + '/img/' + imgId); assert.equal(x.status, 404); ok('delete own post removes its image');
  r = await fetch(BASE + '/api/posts'); assert.equal(r.status, 401); ok('feed requires login');
  console.log('\nAll E2E checks passed.');
})().catch((e) => { console.error('E2E FAILED:', e); process.exit(1); });
