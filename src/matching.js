// Core matching logic (pure, unit-tested)
const EARTH_RADIUS_MI = 3958.8;
const MATCH_RADIUS_MI = 15; // maximum (and default) match radius
const MIN_RADIUS_MI = 1;

// Clamp a radius to an integer in [1, 15]. Missing/blank -> fallback (default 15); non-numeric -> null (caller rejects).
function clampRadius(v, fallback = MATCH_RADIUS_MI) {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(MATCH_RADIUS_MI, Math.max(MIN_RADIUS_MI, Math.round(n)));
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
}

function normalizeTopic(t) {
  return String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function oppositeRole(role) {
  if (role === 'learn') return 'teach';
  if (role === 'teach') return 'learn';
  throw new Error('invalid role: ' + role);
}

/**
 * users: [{id, lat, lng, max_distance_mi?, topics:[{topic, role}]}]
 * shop: {lat, lng}; invite: {creatorId, role, topic}
 * radius: the invite's radius (1-15 mi). A user is only included if distance <= min(radius, their max_distance_mi).
 * Returns [{userId, distance}] sorted by distance.
 */
function findRecipients(users, shop, invite, radius = MATCH_RADIUS_MI) {
  const topic = normalizeTopic(invite.topic);
  const want = oppositeRole(invite.role);
  const out = [];
  for (const u of users) {
    if (u.id === invite.creatorId) continue;
    if (u.lat == null || u.lng == null || isNaN(u.lat) || isNaN(u.lng)) continue;
    if (!(u.topics || []).some((t) => normalizeTopic(t.topic) === topic && t.role === want)) continue;
    const limit = Math.min(clampRadius(radius) ?? MATCH_RADIUS_MI, clampRadius(u.max_distance_mi) ?? MATCH_RADIUS_MI);
    const d = haversineMiles(shop.lat, shop.lng, u.lat, u.lng);
    if (d <= limit) out.push({ userId: u.id, distance: Math.round(d * 10) / 10 });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

module.exports = { haversineMiles, normalizeTopic, oppositeRole, findRecipients, clampRadius, MATCH_RADIUS_MI, MIN_RADIUS_MI };
