const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
let me = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'CoffeeBuds' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'Something went wrong.'); e.status = r.status; throw e; }
  return data;
}
// Upload raw image bytes (already resized/compressed on the device).
async function upload(path, blob, method = 'POST') {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Requested-With': 'CoffeeBuds' }, body: blob });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Upload failed.');
  return data;
}
// Resize + re-encode on the device: handles phone camera photos (incl. HEIC on iOS, which the browser decodes) and keeps uploads small.
async function shrinkImage(file, max) {
  if (!file || !/^image\//.test(file.type || 'image/')) throw new Error('Please choose a photo.');
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("Couldn't read that photo.")); im.src = URL.createObjectURL(file); }); }
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight, k = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement('canvas'); c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  const enc = (type, q) => new Promise((res) => c.toBlob(res, type, q));
  let blob = await enc('image/webp', 0.85);
  if (!blob || blob.type !== 'image/webp') blob = await enc('image/jpeg', 0.85);
  if (!blob) throw new Error("Couldn't process that photo.");
  return blob;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2800); }
const avatar = (u, cls = '') => u.photo_url ? `<img class="avatar ${cls}" src="${esc(u.photo_url)}" alt="" referrerpolicy="no-referrer" data-initial="${esc((u.name || '?')[0].toUpperCase())}">`
  : `<span class="avatar ${cls}">${esc((u.name || '?')[0].toUpperCase())}</span>`;
// Broken avatar images fall back to the initial (no inline handlers, so the CSP can forbid them).
document.addEventListener('error', (e) => { const t = e.target; if (t.tagName === 'IMG' && t.classList.contains('avatar') && t.dataset.initial != null) {
  const sp = document.createElement('span'); sp.className = t.className; sp.textContent = t.dataset.initial; t.replaceWith(sp); } }, true);
const SAFETY = `<div class="card safety"><h3>☕ Safety tips</h3><ul class="small muted" style="margin:6px 0 0;padding-left:18px">
  <li>Meet only in public coffee shops — never at someone's home.</li><li>Tell a friend where you're going and when.</li>
  <li>Keep personal details (address, phone, finances) private until you trust someone.</li><li>Arrange your own transport and leave if you feel uncomfortable.</li>
  <li>Block or report anyone who makes you feel unsafe — reports are reviewed.</li></ul></div>`;
const roleBadge = (r) => r === 'learn' ? '<span class="pill learn">📖 Learn</span>' : '<span class="pill teach">🎓 Teach</span>';
const fmtDate = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const empty = (icon, title, text, cta = '') => `<div class="card empty"><div class="icon">${icon}</div><h3>${title}</h3><p class="muted">${text}</p>${cta}</div>`;
const setBadge = (n) => { const b = $('#badge'); b.hidden = !n; b.textContent = n > 9 ? '9+' : n; };
async function refreshMe() { try { me = await api('/me'); setBadge(me.unread); } catch { me = null; } }

// ---------- Router ----------
const routes = { login: authView('login'), signup: authView('signup'), inbox, wall, new: newMeetup, meetups, profile, notifications, invite: inviteDetail };
async function router() {
  const [, name = 'inbox', arg] = location.hash.split('/');
  if (!me && !['login', 'signup'].includes(name)) await refreshMe();
  if (!me && !['login', 'signup'].includes(name)) return (location.hash = '#/login');
  if (me && ['login', 'signup'].includes(name)) return (location.hash = '#/inbox');
  $('#topbar').hidden = !me; app.className = me ? 'container' : '';
  document.body.className = 'page-' + (routes[name] ? name : 'inbox');
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  app.innerHTML = '<p class="muted">Brewing…</p>';
  try { await (routes[name] || inbox)(arg); app.firstElementChild?.classList.add('view-enter'); } catch (e) { app.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
  if (me) api('/me').then((u) => { me = u; setBadge(u.unread); }).catch(() => {});
}
addEventListener('hashchange', router);
document.addEventListener('click', async (e) => {
  const lo = e.target.closest('[data-logout]'); if (!lo) return;
  e.preventDefault(); await api('/logout', { method: 'POST' }).catch(() => {}); me = null; setBadge(0); location.hash = '#/login'; toast('Signed out. See you soon ☕');
});
setInterval(() => me && api('/me').then((u) => { me = u; setBadge(u.unread); }).catch(() => {}), 30000);

// ---------- Auth ----------
function authView(mode) {
  return () => {
    const isUp = mode === 'signup';
    app.innerHTML = `<div class="auth">
      <section class="hero"><svg class="art" viewBox="0 0 200 200" aria-hidden="true"><g class="steam" fill="none" stroke="#F7F1E8" stroke-width="5" stroke-linecap="round" opacity=".7"><path d="M78 52c-10-12 10-18 0-32"/><path d="M100 50c-10-12 10-18 0-32"/><path d="M122 52c-10-12 10-18 0-32"/></g><ellipse cx="100" cy="172" rx="78" ry="12" fill="#000" opacity=".18"/><path d="M38 70h124l-12 86a18 18 0 0 1-18 16H68a18 18 0 0 1-18-16z" fill="#F7F1E8"/><path d="M162 86h8a22 22 0 0 1 0 44h-12l2-12h10a10 10 0 0 0 0-20h-10z" fill="#F7F1E8"/><ellipse cx="100" cy="70" rx="62" ry="10" fill="#C8894B"/><ellipse cx="100" cy="70" rx="48" ry="6" fill="#8A5A30"/><path d="M58 108h84" stroke="#C8894B" stroke-width="6" stroke-linecap="round" opacity=".6"/></svg><div><div class="brand" style="color:var(--cream)">☕ CoffeeBuds</div></div>
        <div><h1>Learn something new,<br><em>one cup at a time.</em></h1>
        <p style="max-width:420px;opacity:.85">Meet neighbors over coffee to swap skills — from AI to cake decorating to career advice. Ask to learn, offer to teach, and we'll invite the right people within 15 miles.</p>
        <div class="feats"><span>📖 Learn</span><span>🎓 Teach</span><span>📍 15-mile matching</span></div></div><p class="foot small" style="opacity:.6">Tampa Bay · made with espresso</p></section>
      <section class="panel"><form class="card" id="f" novalidate>
        <h2>${isUp ? 'Create your account' : 'Welcome back'}</h2>
        <p class="muted small" style="margin-top:-4px">${isUp ? 'Takes 30 seconds.' : 'Log in to see your invites.'}</p>
        <div id="err"></div>
        ${isUp ? '<div class="field"><label for="name">Name</label><input id="name" autocomplete="name" maxlength="80" required></div>' : ''}
        <div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="email" maxlength="254" required></div>
        <div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="${isUp ? 'new-password' : 'current-password'}" minlength="${isUp ? 8 : 1}" maxlength="128" required></div>
        <button class="btn block" type="submit">${isUp ? 'Sign up' : 'Log in'}</button>
        <p class="small muted" style="text-align:center;margin-top:16px">${isUp ? 'Already have an account? <a href="#/login">Log in</a>' : 'New here? <a href="#/signup">Create an account</a>'}</p>
      </form></section></div>`;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const body = { email: $('#email').value, password: $('#password').value, name: $('#name')?.value };
      try { me = await api(isUp ? '/signup' : '/login', { method: 'POST', body }); location.hash = isUp ? '#/profile' : '#/inbox'; if (isUp) toast('Welcome! Add your location and topics to get matched.'); }
      catch (err) { $('#err').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
    };
  };
}

// ---------- Invite card ----------
function inviteCard(i, { actions = true } = {}) {
  const st = i.my_status;
  return `<article class="card invite" data-id="${i.id}">
    ${avatar({ name: i.creator_name, photo_url: i.creator_photo })}
    <div><div class="row" style="gap:8px">${roleBadge(i.role)}${st && st !== 'host' ? `<span class="pill status-${st}">${st}</span>` : ''}${i.relation ? `<span class="pill status-pending">${i.relation === 'host' ? 'Hosting' : 'Attending'}</span>` : ''}</div>
      <h3 style="margin:8px 0 0"><a href="#/invite/${i.id}" style="color:inherit;text-decoration:none">${esc(i.topic_label)}</a></h3>
      <div class="small muted">${esc(i.creator_name)} ${i.role === 'learn' ? 'wants to learn this' : 'can teach this'}</div>
      <div class="meta"><span>☕ ${esc(i.shop_name)}</span><span>🗓 ${fmtDate(i.starts_at)}</span>${i.distance_mi != null ? `<span>📍 ${i.distance_mi} mi from you</span>` : ''}<span>👥 ${i.accepted_count}/${i.max_attendees} going</span></div>
      ${i.note ? `<div class="note">“${esc(i.note)}”</div>` : ''}
      ${i.going?.length ? `<div class="row small muted" style="margin-top:10px"><div class="avatars">${i.going.slice(0, 5).map((g) => avatar(g)).join('')}</div>${i.going.map((g) => esc(g.name.split(' ')[0])).join(', ')} going</div>` : ''}
    </div>
    ${actions && st && st !== 'host' && new Date(i.starts_at) > Date.now() ? `<div class="actions row" style="flex-direction:column;align-items:stretch">
      <button class="btn caramel sm" data-rsvp="accepted" ${st === 'accepted' ? 'disabled' : ''}>${st === 'accepted' ? '✓ Going' : 'Accept'}</button>
      <button class="btn ghost sm" data-rsvp="declined" ${st === 'declined' ? 'disabled' : ''}>Decline</button></div>` : ''}
  </article>`;
}
function bindRsvp(root, after) {
  root.querySelectorAll('[data-rsvp]').forEach((b) => (b.onclick = async () => {
    const id = b.closest('[data-id]').dataset.id;
    try { await api(`/invites/${id}/rsvp`, { method: 'POST', body: { status: b.dataset.rsvp } }); toast(b.dataset.rsvp === 'accepted' ? "You're in! ☕" : 'Declined.'); after(); }
    catch (e) { toast(e.message); }
  }));
}

// ---------- Inbox ----------
async function inbox() {
  let filter = '';
  const render = async () => {
    const list = await api('/invites/inbox' + (filter ? '?role=' + filter : ''));
    app.innerHTML = `<div class="row between pagehead"><div><h1>Your invites</h1><p class="muted" style="margin-top:-6px">Coffee meetups that match your topics nearby.</p></div>
      <div class="seg" id="seg">${[['', 'All'], ['learn', 'Learn'], ['teach', 'Teach']].map(([v, l]) => `<button data-v="${v}" class="${filter === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="stack" style="margin-top:20px">${list.length ? list.map((i) => inviteCard(i)).join('') :
        empty('🫖', 'No invites yet', !me.lat ? 'Set your home location and topics so neighbors can find you.' : 'When someone nearby wants to learn what you teach (or teach what you want to learn), it shows up here.',
          `<a class="btn" href="${!me.lat || !me.topics.length ? '#/profile' : '#/new'}">${!me.lat || !me.topics.length ? 'Complete your profile' : 'Start a meetup'}</a>`)}</div>`;
    $('#seg').querySelectorAll('button').forEach((b) => (b.onclick = () => { filter = b.dataset.v; render(); }));
    bindRsvp(app, render);
  };
  await render();
}

async function inviteDetail(id) {
  const i = await api('/invites/' + id);
  app.innerHTML = `<a href="#/inbox" class="small">← Back</a><div class="stack" style="margin-top:12px">${inviteCard(i)}
    <div class="card"><h3>Where</h3><p class="muted">${esc(i.shop_name)}${i.shop_address ? ' · ' + esc(i.shop_address) : ''}</p><div class="map" id="dmap"></div>
    ${i.my_status === 'host' ? `<p class="small muted" style="margin-top:12px">Invited ${i.counts.total} · ${i.going.length} going · ${i.counts.declined || 0} declined · ${i.counts.pending || 0} pending</p>` : ''}</div>
    ${i.creator_id !== me.id ? `<div class="card"><h3>Hosted by ${esc(i.creator_name)}</h3><p class="small muted">Something off? Blocking hides you from each other; reports go to the CoffeeBuds team.</p>
      <div class="row" style="gap:8px"><button class="btn ghost sm" id="block">Block ${esc(i.creator_name.split(' ')[0])}</button><button class="btn ghost sm" id="report">Report</button></div></div>` : ''}
    ${SAFETY}</div>`;
  $('#block')?.addEventListener('click', async () => {
    if (!confirm(`Block ${i.creator_name}? You won't see each other's invites.`)) return;
    try { await api(`/users/${i.creator_id}/block`, { method: 'POST' }); toast('Blocked.'); location.hash = '#/inbox'; } catch (e) { toast(e.message); }
  });
  $('#report')?.addEventListener('click', async () => {
    const reason = prompt(`Report ${i.creator_name}: what happened? (required)`); if (reason == null) return;
    if (!reason.trim()) return toast('Please describe what happened.');
    try { await api(`/users/${i.creator_id}/report`, { method: 'POST', body: { reason: reason.slice(0, 1000), invite_id: i.id } }); toast('Thanks — your report was sent.'); } catch (e) { toast(e.message); }
  });
  bindRsvp(app, () => inviteDetail(id));
  if (window.L) { const m = L.map('dmap').setView([i.shop_lat, i.shop_lng], 15); tiles(m); L.marker([i.shop_lat, i.shop_lng]).addTo(m).bindPopup(esc(i.shop_name)); }
}
const tiles = (m) => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);

// ---------- New meetup ----------
async function newMeetup() {
  if (me.lat == null) { app.innerHTML = empty('📍', 'Set your location first', 'We use it to find coffee shops near you.', '<a class="btn" href="#/profile">Go to profile</a>'); return; }
  let role = 'learn', shop = null, shops = [], marker;
  const popular = await api('/topics/popular').catch(() => []);
  const def = new Date(Date.now() + 2 * 864e5); def.setHours(9, 0, 0, 0);
  const local = new Date(def - def.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  app.innerHTML = `<div class="pagehead"><h1>Start a coffee meetup</h1><p class="muted" style="margin:-6px 0 0">We'll invite everyone within 15 miles of the shop with the opposite role on your topic.</p></div>
  <form id="f" class="stack" novalidate style="margin-top:20px"><div id="err"></div>
   <div class="card"><h3>1 · What kind of meetup?</h3>
     <div class="seg" id="roleSeg"><button type="button" data-v="learn" class="on">📖 I want to learn</button><button type="button" data-v="teach">🎓 I can teach</button></div>
     <div class="field" style="margin-top:16px"><label for="topic">Topic</label><input id="topic" list="topicList" placeholder="e.g. AI, baking cookies, nursing careers" maxlength="60">
     <datalist id="topicList">${[...new Set([...me.topics.map((t) => t.label), ...popular.map((p) => p.label)])].map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>
     <div class="chips">${me.topics.map((t) => `<span class="chip suggest" data-topic="${esc(t.label)}" data-role="${t.role}">${esc(t.label)}</span>`).join('')}</div>
     <p class="small muted" id="hint" style="margin-top:10px"></p></div>
   <div class="card"><h3>2 · Pick a coffee shop</h3>
     <div class="grid two"><div><div class="map" id="map"></div></div>
       <div><div class="row" id="areaForm" style="flex-wrap:nowrap;margin-bottom:8px"><input id="areaQ" placeholder="Search near… (e.g. Ybor City)" aria-label="Search cafés near a place"><button class="btn ghost sm" type="button" id="areaGo">Go</button></div><div class="row" style="margin-bottom:8px"><button type="button" class="btn ghost sm" id="near">Search this map area</button><button type="button" class="btn ghost sm" id="home">Near me</button><span class="small muted" id="nearMsg"></span></div>
       <div class="shoplist" id="shoplist"><p class="small muted" style="padding:12px">Loading shops…</p></div></div></div>
     <details style="margin-top:14px"><summary class="small" style="cursor:pointer">Or type a shop manually</summary>
       <div class="grid two" style="margin-top:12px"><div class="field"><label>Shop name</label><input id="mName" placeholder="Corner Café"></div>
       <div class="field"><label>Address</label><div class="row" style="flex-wrap:nowrap"><input id="mAddr" placeholder="123 Main St, Tampa"><button type="button" class="btn ghost sm" id="mGeo">Locate</button></div></div>
       <div class="field"><label>Latitude</label><input id="mLat" inputmode="decimal"></div><div class="field"><label>Longitude</label><input id="mLng" inputmode="decimal"></div></div>
       <p class="small muted">Tip: click the map to drop a pin, or use “Locate”. <button type="button" class="btn sm" id="mUse">Use this shop</button></p></details>
     <p id="chosen" class="small" style="margin-top:10px"></p></div>
   <div class="card"><h3>3 · When &amp; details</h3><div class="grid two">
     <div class="field"><label for="when">Date &amp; time</label><input id="when" type="datetime-local" value="${local}"></div>
     <div class="field"><label for="max">Max attendees</label><input id="max" type="number" min="1" max="50" value="4"></div></div>
     <div class="field"><label for="note">Note (optional)</label><textarea id="note" rows="3" maxlength="500" placeholder="I'll grab a table by the window — beginners welcome!"></textarea></div>
     <button class="btn caramel" type="submit">Send invites</button></div>${SAFETY}</form>`;
  const hint = () => ($('#hint').textContent = role === 'learn' ? 'Invites go to nearby people who can teach this topic.' : 'Invites go to nearby people who want to learn this topic.');
  hint();
  $('#roleSeg').querySelectorAll('button').forEach((b) => (b.onclick = () => { role = b.dataset.v; $('#roleSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); hint(); }));
  app.querySelectorAll('[data-topic]').forEach((c) => (c.onclick = () => { $('#topic').value = c.dataset.topic; $(`#roleSeg [data-v="${c.dataset.role}"]`).click(); }));
  let map;
  if (window.L) {
    map = L.map('map').setView([me.lat, me.lng], 12); tiles(map);
    L.circleMarker([me.lat, me.lng], { radius: 7, color: '#3B2A20', fillColor: '#C8894B', fillOpacity: 1 }).addTo(map).bindTooltip('You');
    map.on('click', (e) => { $('details').open = true; $('#mLat').value = e.latlng.lat.toFixed(5); $('#mLng').value = e.latlng.lng.toFixed(5); });
  } else $('#map').outerHTML = '<div class="warn">Map unavailable offline — use the list or manual entry.</div>';
  const layer = window.L ? L.layerGroup().addTo(map) : null;
  const choose = (s) => {
    shop = s; $('#chosen').innerHTML = `Selected: <b>☕ ${esc(s.name)}</b>${s.address ? ' · ' + esc(s.address) : ''}`;
    app.querySelectorAll('.shopitem').forEach((el) => el.classList.toggle('sel', +el.dataset.i === shops.indexOf(s)));
    if (map) { marker?.remove(); marker = L.marker([s.lat, s.lng], { zIndexOffset: 1000 }).addTo(map).bindPopup(esc(s.name)); map.setView([s.lat, s.lng], 14); }
  };
  const load = async (lat = me.lat, lng = me.lng) => {
    const msg = (t) => { const el = $('#nearMsg'); if (el) el.textContent = t; };
    msg('Searching…'); $('#shoplist') && ($('#shoplist').innerHTML = '<p class="small muted" style="padding:12px">Finding cafés…</p>');
    try {
      const r = await api(`/shops/nearby?lat=${lat}&lng=${lng}`); if (!document.body.contains($('#shoplist'))) return; shops = r.shops;
      msg(r.warning ? '' : `${shops.length} found`);
      $('#shoplist').innerHTML = (r.warning ? `<div class="warn" style="margin:8px">${esc(r.warning)}</div>` : '') + (shops.length ? shops.map((s, i) =>
        `<div class="shopitem" data-i="${i}"><div><b>${esc(s.name)}</b><div class="small muted">${esc(s.address || (s.source === 'osm' ? 'OpenStreetMap' : ''))}</div></div><span class="small muted">${s.distance} mi</span></div>`).join('') : '<p class="small muted" style="padding:12px">No cafés found — type one manually below.</p>');
      app.querySelectorAll('.shopitem').forEach((el) => (el.onclick = () => choose(shops[+el.dataset.i])));
      if (layer) { layer.clearLayers(); shops.forEach((s) => L.circleMarker([s.lat, s.lng], { radius: 9, weight: 2, color: '#fff', fillColor: '#C8894B', fillOpacity: .95, className: 'cafe-marker' }).addTo(layer).on('click', () => choose(s)).bindTooltip(esc(s.name)));
        if (shops.length && !shop) map.fitBounds(L.latLngBounds(shops.slice(0, 15).map((s) => [s.lat, s.lng])).extend([lat, lng]), { padding: [24, 24], maxZoom: 15 }); }
    } catch (e) { msg(''); if ($('#shoplist')) $('#shoplist').innerHTML = `<div class="warn" style="margin:8px">${esc(e.message)}</div>`; }
  };
  $('#near').onclick = () => { if (!map) return load(); const c = map.getCenter(); load(c.lat.toFixed(5), c.lng.toFixed(5)); };
  $('#home').onclick = () => { map?.setView([me.lat, me.lng], 13); load(); };
  $('#areaQ').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#areaGo').click(); } };
  $('#areaGo').onclick = async () => {
    const q = $('#areaQ').value.trim(); if (q.length < 3) return toast('Type a place (3+ characters).');
    try { const [g] = await api('/geocode?q=' + encodeURIComponent(q)); if (!g) return toast('Place not found.'); map?.setView([g.lat, g.lng], 14); load(g.lat, g.lng); }
    catch (err) { toast(err.message); }
  };
  load();
  $('#mGeo').onclick = async () => {
    try { const [g] = await api('/geocode?q=' + encodeURIComponent($('#mAddr').value || $('#mName').value)); if (!g) return toast('No match — drop a pin or enter lat/lng.'); $('#mLat').value = g.lat.toFixed(5); $('#mLng').value = g.lng.toFixed(5); }
    catch (e) { toast(e.message); }
  };
  $('#mUse').onclick = () => {
    const s = { name: $('#mName').value.trim(), address: $('#mAddr').value.trim(), lat: parseFloat($('#mLat').value), lng: parseFloat($('#mLng').value) };
    if (!s.name) return toast('Enter a shop name.'); if (isNaN(s.lat) || isNaN(s.lng)) return toast('Add a location: Locate, drop a pin, or type lat/lng.');
    choose(s);
  };
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const errs = [];
    if (!$('#topic').value.trim()) errs.push('Pick or type a topic.');
    if (!shop) errs.push('Choose a coffee shop.');
    if (!$('#when').value) errs.push('Choose a date and time.');
    if (errs.length) { $('#err').innerHTML = `<div class="error">${errs.join('<br>')}</div>`; scrollTo({ top: 0, behavior: 'smooth' }); return; }
    try {
      const r = await api('/invites', { method: 'POST', body: { role, topic: $('#topic').value, starts_at: new Date($('#when').value).toISOString(), note: $('#note').value, max_attendees: $('#max').value,
        shop: shop.id ? { id: shop.id } : { name: shop.name, address: shop.address, lat: shop.lat, lng: shop.lng, osm_id: shop.osm_id } } });
      toast(r.recipients ? `Invite sent to ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'} nearby ☕` : 'Meetup created — no matches nearby yet.');
      location.hash = '#/meetups';
    } catch (err) { $('#err').innerHTML = `<div class="error">${esc(err.message)}</div>`; scrollTo({ top: 0, behavior: 'smooth' }); }
  };
}

// ---------- My meetups ----------
async function meetups() {
  const { upcoming, past } = await api('/meetups');
  app.innerHTML = `<div class="row between pagehead"><h1 style="margin:0">My meetups</h1><a class="btn caramel sm" href="#/new">+ New meetup</a></div>
    <div class="section-title"><h2>Upcoming</h2><span class="small muted">${upcoming.length}</span></div>
    <div class="stack">${upcoming.length ? upcoming.map((i) => inviteCard(i, { actions: false })).join('') : empty('☕', 'Nothing on the calendar', 'Host a meetup or accept an invite to see it here.', '<a class="btn" href="#/new">Host a meetup</a>')}</div>
    <div class="section-title"><h2>Past</h2><span class="small muted">${past.length}</span></div>
    <div class="stack">${past.length ? past.map((i) => inviteCard(i, { actions: false })).join('') : '<p class="muted small">Your past meetups will appear here.</p>'}</div>`;
}

// ---------- Profile ----------
async function profile() {
  let topics = me.topics.map((t) => ({ label: t.label, role: t.role }));
  app.innerHTML = `<div class="pagehead"><h1>Your profile</h1><p style="margin:4px 0 0">Tell neighbors what you want to learn and what you can teach.</p></div>
  <div class="grid two" style="margin-top:16px;align-items:start">
   <form class="card" id="pf" novalidate><div id="perr"></div>
     <div class="row" style="margin-bottom:16px"><label class="avatar-upload" title="Change photo">${avatar(me, 'lg')}<span class="cam" aria-hidden="true">📷</span>
       <input type="file" id="photoFile" accept="image/*" hidden aria-label="Upload profile photo"></label>
       <div><h3 style="margin:0">${esc(me.name)}</h3><div class="small muted">${esc(me.email)}</div>
       <div class="small" style="margin-top:4px"><a href="#" id="photoPick">${me.photo_url ? 'Change photo' : 'Add a photo'}</a>${me.photo_url ? ' · <a href="#" id="photoDel">Remove</a>' : ''} <span id="photoMsg" class="muted"></span></div></div></div>
     <div class="field"><label>Name</label><input id="name" maxlength="80" value="${esc(me.name)}"></div>
     <div class="field"><label>Home location</label><div class="row" style="flex-wrap:nowrap"><input id="loc" maxlength="200" value="${esc(me.location_label || '')}" placeholder="Address, neighborhood or city"><button type="button" class="btn ghost sm" id="geo">Find</button></div>
       <div id="geoRes" class="small" style="margin-top:6px"></div></div>
     <div class="grid two"><div class="field"><label>Latitude</label><input id="lat" inputmode="decimal" value="${me.lat ?? ''}"></div><div class="field"><label>Longitude</label><input id="lng" inputmode="decimal" value="${me.lng ?? ''}"></div></div>
     <p class="small muted" style="margin-top:-6px">Geocoding uses OpenStreetMap. If it's unavailable, enter coordinates manually. <a href="#" id="gps">Use my device location</a></p>
     <div class="row between"><button class="btn" type="submit">Save profile</button><button type="button" class="btn ghost sm" data-logout>Sign out</button></div></form>
   <div class="card"><h3>Your topics</h3><p class="small muted">Free text is fine — we match case-insensitively.</p>
     <form id="tf" class="row" style="flex-wrap:nowrap;margin:12px 0"><input id="tnew" placeholder="e.g. Sourdough baking" maxlength="60">
       <select id="trole" style="width:auto"><option value="learn">Want to learn</option><option value="teach">Can teach</option></select><button class="btn sm">Add</button></form>
     <div id="tlist"></div><button class="btn caramel block" id="tsave" style="margin-top:16px">Save topics</button></div>
   <div class="card"><h3>Blocked people</h3><div id="blist" class="small muted">Loading…</div>
     <p class="small muted" style="margin-top:10px">Your exact home coordinates are never shown to others; we only use them (rounded to about 1 km) to match nearby invites.</p></div></div>`;
  $('#photoPick').onclick = (e) => { e.preventDefault(); $('#photoFile').click(); };
  $('#photoFile').onchange = async () => {
    const f = $('#photoFile').files[0]; if (!f) return; $('#photoMsg').textContent = 'Uploading…';
    try { me = await upload('/profile/photo', await shrinkImage(f, 512)); toast('Photo updated'); profile(); } catch (e) { $('#photoMsg').textContent = ''; toast(e.message); }
  };
  $('#photoDel')?.addEventListener('click', async (e) => { e.preventDefault(); try { me = await api('/profile/photo', { method: 'DELETE' }); toast('Photo removed'); profile(); } catch (err) { toast(err.message); } });
  const drawBlocks = async () => { const l = await api('/blocks').catch(() => []); const el = $('#blist'); if (!el) return;
    el.innerHTML = l.length ? l.map((b) => `<div class="row between" style="margin:6px 0"><span>${esc(b.name)}</span><button class="btn ghost sm" data-unblock="${b.id}">Unblock</button></div>`).join('') : 'Nobody — block someone from an invite page.';
    el.querySelectorAll('[data-unblock]').forEach((x) => (x.onclick = async () => { await api(`/users/${x.dataset.unblock}/block`, { method: 'DELETE' }).catch((e) => toast(e.message)); drawBlocks(); })); };
  drawBlocks();
  const drawTopics = () => {
    const sec = (r, title) => { const l = topics.filter((t) => t.role === r);
      return `<p class="small" style="font-weight:600;margin:12px 0 6px">${title}</p><div class="chips">${l.length ? l.map((t) => `<span class="chip ${r}">${esc(t.label)}<button type="button" data-del="${topics.indexOf(t)}" aria-label="Remove">×</button></span>`).join('') : '<span class="small muted">None yet</span>'}</div>`; };
    $('#tlist').innerHTML = sec('learn', '📖 Want to learn') + sec('teach', '🎓 Can teach / have experience');
    app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { topics.splice(+b.dataset.del, 1); drawTopics(); }));
  };
  drawTopics();
  $('#tf').onsubmit = (e) => { e.preventDefault(); const label = $('#tnew').value.trim(); if (!label) return;
    const norm = label.toLowerCase().replace(/\s+/g, ' ');
    if (topics.some((t) => t.label.toLowerCase().replace(/\s+/g, ' ') === norm && t.role === $('#trole').value)) return toast('Already added.');
    topics.push({ label, role: $('#trole').value }); $('#tnew').value = ''; drawTopics(); };
  $('#tsave').onclick = async () => { try { me = await api('/topics', { method: 'PUT', body: { topics } }); toast('Topics saved'); } catch (e) { toast(e.message); } };
  $('#geo').onclick = async () => {
    $('#geoRes').textContent = 'Searching…';
    try { const res = await api('/geocode?q=' + encodeURIComponent($('#loc').value));
      $('#geoRes').innerHTML = res.length ? res.map((g, i) => `<div><a href="#" data-g="${i}">${esc(g.label)}</a></div>`).join('') : 'No results — enter coordinates manually.';
      app.querySelectorAll('[data-g]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); const g = res[+a.dataset.g]; $('#lat').value = g.lat.toFixed(5); $('#lng').value = g.lng.toFixed(5); $('#geoRes').textContent = '✓ Location set'; }));
    } catch (e) { $('#geoRes').innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`; }
  };
  $('#gps').onclick = (e) => { e.preventDefault(); navigator.geolocation?.getCurrentPosition((p) => { $('#lat').value = p.coords.latitude.toFixed(5); $('#lng').value = p.coords.longitude.toFixed(5); }, () => toast('Could not get device location.')); };
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    try { me = await api('/profile', { method: 'PUT', body: { name: $('#name').value, location_label: $('#loc').value, lat: $('#lat').value, lng: $('#lng').value } }); toast('Profile saved'); profile(); }
    catch (err) { $('#perr').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  };
}

// ---------- Photo wall ----------
const ago = (ts) => { const d = (Date.now() - new Date(ts.replace(' ', 'T') + 'Z')) / 1000;
  return d < 60 ? 'just now' : d < 3600 ? Math.floor(d / 60) + 'm ago' : d < 86400 ? Math.floor(d / 3600) + 'h ago' : d < 604800 ? Math.floor(d / 86400) + 'd ago' : fmtDate(ts.replace(' ', 'T') + 'Z'); };
const postCard = (p) => `<figure class="post" data-post="${p.id}">
  <img src="${esc(p.image_url)}" alt="${esc(p.caption || 'Coffee meetup photo')}" loading="lazy" ${p.width ? `width="${p.width}" height="${p.height}"` : ''}>
  <figcaption>${p.caption ? `<p class="cap">${esc(p.caption)}</p>` : ''}
    ${p.shop_name || p.invite_topic ? `<div class="tags">${p.invite_topic ? `<span class="pill status-pending">${esc(p.invite_topic)}</span>` : ''}${p.shop_name ? `<span class="small muted">☕ ${esc(p.shop_name)}</span>` : ''}</div>` : ''}
    <div class="by">${avatar({ name: p.user_name, photo_url: p.user_photo })}<span class="small"><b>${esc(p.user_name)}</b> · <span class="muted">${ago(p.created_at)}</span></span>
      ${p.mine ? `<button class="linkbtn" data-delpost="${p.id}">Delete</button>` : `<button class="linkbtn" data-reportpost="${p.id}">Report</button>`}</div></figcaption></figure>`;
async function wall() {
  let next = null, loading = false, blob = null, preview = null;
  const [first, mine] = await Promise.all([api('/posts?limit=12'), api('/meetups').catch(() => ({ upcoming: [], past: [] }))]);
  const meets = [...mine.past, ...mine.upcoming];
  next = first.next_before;
  app.innerHTML = `<div class="pagehead"><h1>Meetups</h1><p style="margin:4px 0 0">Little moments from coffee meetups around town.</p></div>
  <form class="card composer" id="pf" novalidate><div id="perr"></div>
    <div class="composer-grid"><label class="drop" id="drop"><input type="file" id="pfile" accept="image/*" hidden><span class="drop-empty"><span class="big">📷</span><b>Add a photo</b><span class="small muted">Camera or library</span></span></label>
    <div class="stack" style="gap:10px"><div class="field" style="margin:0"><label for="cap">Caption <span class="muted small" id="capn">0/280</span></label><textarea id="cap" rows="3" maxlength="280" placeholder="Flat whites and a great chat about sourdough…"></textarea></div>
      <div class="field" style="margin:0"><label for="plink">Link a meetup (optional)</label><select id="plink"><option value="">— None —</option>${meets.map((m) => `<option value="${m.id}">${esc(m.topic_label)} · ${esc(m.shop_name)} · ${new Date(m.starts_at).toLocaleDateString()}</option>`).join('')}</select></div>
      <button class="btn caramel" id="pbtn" type="submit" disabled>Share photo</button></div></div></form>
  <div class="wall" id="wall">${first.items.map(postCard).join('')}</div>
  <div id="wallEnd">${first.items.length ? '' : empty('📸', 'No photos yet', 'Snap a picture at your next coffee meetup and be the first to share it.')}</div>`;
  const pick = async () => { const f = $('#pfile').files[0]; if (!f) return;
    try { $('#drop').classList.add('busy'); blob = await shrinkImage(f, 1600); if (preview) URL.revokeObjectURL(preview); preview = URL.createObjectURL(blob);
      $('#drop').innerHTML = `<img src="${preview}" alt="Preview"><span class="change">Change</span>`; $('#drop').append($('#pfile') || Object.assign(document.createElement('input'), { type: 'file', id: 'pfile', accept: 'image/*', hidden: true }));
      $('#pfile').onchange = pick; $('#pbtn').disabled = false; } catch (e) { toast(e.message); } finally { $('#drop').classList.remove('busy'); } };
  $('#pfile').onchange = pick;
  $('#cap').oninput = () => ($('#capn').textContent = $('#cap').value.length + '/280');
  $('#pf').onsubmit = async (e) => {
    e.preventDefault(); if (!blob) return toast('Add a photo first.');
    $('#pbtn').disabled = true; $('#pbtn').textContent = 'Sharing…';
    try { const up = await upload('/uploads', blob);
      const post = await api('/posts', { method: 'POST', body: { image_id: up.id, caption: $('#cap').value, invite_id: $('#plink').value || null } });
      toast('Shared ☕'); $('#wallEnd').innerHTML = ''; $('#wall').insertAdjacentHTML('afterbegin', postCard(post)); bindPosts();
      blob = null; $('#cap').value = ''; $('#capn').textContent = '0/280'; $('#plink').value = '';
      $('#drop').innerHTML = '<input type="file" id="pfile" accept="image/*" hidden><span class="drop-empty"><span class="big">📷</span><b>Add a photo</b><span class="small muted">Camera or library</span></span>'; $('#pfile').onchange = pick;
    } catch (err) { $('#perr').innerHTML = `<div class="error">${esc(err.message)}</div>`; $('#pbtn').disabled = false; }
    finally { $('#pbtn').textContent = 'Share photo'; }
  };
  function bindPosts() {
    app.querySelectorAll('[data-delpost]').forEach((b) => (b.onclick = async () => { if (!confirm('Delete this photo?')) return;
      try { await api('/posts/' + b.dataset.delpost, { method: 'DELETE' }); b.closest('.post').remove(); toast('Deleted.'); } catch (e) { toast(e.message); } }));
    app.querySelectorAll('[data-reportpost]').forEach((b) => (b.onclick = async () => { const reason = prompt("What's wrong with this photo?"); if (reason == null) return;
      if (!reason.trim()) return toast('Please describe the problem.');
      try { await api(`/posts/${b.dataset.reportpost}/report`, { method: 'POST', body: { reason: reason.slice(0, 1000) } }); toast('Thanks — reported.'); } catch (e) { toast(e.message); } }));
  }
  bindPosts();
  const more = async () => { if (loading || !next || !document.body.contains($('#wall'))) return; loading = true;
    try { const r = await api(`/posts?limit=12&before=${next}`); next = r.next_before; $('#wall').insertAdjacentHTML('beforeend', r.items.map(postCard).join('')); bindPosts(); } catch (e) { toast(e.message); } finally { loading = false; } };
  const sentinel = document.createElement('div'); sentinel.style.height = '1px'; $('#wallEnd').after(sentinel);
  new IntersectionObserver((es, ob) => { if (!document.body.contains(sentinel)) return ob.disconnect(); if (es[0].isIntersecting) more(); }, { rootMargin: '600px' }).observe(sentinel);
}

// ---------- Notifications ----------
async function notifications() {
  const list = await api('/notifications');
  app.innerHTML = `<div class="row between pagehead"><h1>Notifications</h1>${list.some((n) => !n.is_read) ? '<button class="btn ghost sm" id="mark">Mark all read</button>' : ''}</div>
    ${list.length ? `<div class="card" style="padding:8px 18px">${list.map((n) => `<a href="#/invite/${n.invite_id}" class="notif ${n.is_read ? '' : 'unread'}" style="color:inherit;text-decoration:none">
      <span class="dot"></span><span>${n.type === 'invite' ? '✉️' : '✅'}</span><div><div>${esc(n.message)}</div><div class="small muted" style="font-weight:400">${fmtDate(n.created_at.replace(' ', 'T') + 'Z')}</div></div></a>`).join('')}</div>`
    : empty('🔔', "You're all caught up", 'New invites and RSVPs will show up here.')}`;
  $('#mark')?.addEventListener('click', async () => { await api('/notifications/read', { method: 'POST' }); setBadge(0); notifications(); });
}

router();
