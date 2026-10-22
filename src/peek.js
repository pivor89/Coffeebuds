// Public, logged-out "sneak peek". Read-only and privacy-first: only aggregated / anonymized data ever leaves this module.
// Every field in the response is built explicitly below (never spread from a DB row), so new columns can't leak by accident.
// Excluded: emails, last names, addresses, coordinates, user/invite/post ids, notes/captions (free text), shop names,
// anything from suspended users, hidden posts, and posts/invites that have a non-dismissed report.

// Shown as ideas/prompts (clearly labeled in the UI), never as other people's posts.
const IDEAS = ['Spanish', 'Guitar', 'AI tools', 'Sourdough', 'Resume help', 'Photography'];

// Topic labels are free text: drop anything that looks like contact info or a link.
const safeLabel = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!t || /@|https?:|www\.|\.(com|org|net|io|app)\b|\d{3,}/i.test(t)) return null;
  return t;
};
// First initial only ("M."), never a full or last name.
const initial = (name) => { const c = [...String(name ?? '').trim()][0]; return c && /\p{L}/u.test(c) ? c.toLocaleUpperCase() + '.' : null; };
const n = (v) => Number(v) || 0;

async function buildPeek(db, now = Date.now()) {
  const nowIso = new Date(now).toISOString();
  const members = n((await db.get('SELECT COUNT(*) n FROM users WHERE suspended_at IS NULL')).n);

  const topicRows = await db.all(`SELECT t.topic, MIN(t.label) label,
      SUM(CASE WHEN t.role='learn' THEN 1 ELSE 0 END) learners, SUM(CASE WHEN t.role='teach' THEN 1 ELSE 0 END) teachers
    FROM topics t JOIN users u ON u.id=t.user_id WHERE u.suspended_at IS NULL
    GROUP BY t.topic ORDER BY COUNT(*) DESC, t.topic LIMIT 200`);
  const topics = topicRows.map((r) => ({ label: safeLabel(r.label), learners: n(r.learners), teachers: n(r.teachers) }))
    .filter((t) => t.label).slice(0, 12);

  // Open requests = upcoming invites from active members that still have room.
  const invRows = await db.all(`SELECT i.role, i.topic_label, i.starts_at, i.max_attendees, i.radius_mi, u.name,
      (SELECT COUNT(*) FROM invite_recipients r WHERE r.invite_id=i.id AND r.status='accepted') going
    FROM invites i JOIN users u ON u.id=i.creator_id
    WHERE u.suspended_at IS NULL AND i.starts_at >= ?
      AND NOT EXISTS (SELECT 1 FROM reports rp WHERE rp.invite_id=i.id AND rp.status<>'dismissed')
    ORDER BY i.starts_at LIMIT 20`, [nowIso]);
  const upcoming = invRows.filter((i) => n(i.going) < n(i.max_attendees)).map((i) => {
    const d = new Date(i.starts_at); d.setUTCMinutes(0, 0, 0); // hour precision is enough for a teaser
    return { role: i.role === 'teach' ? 'teach' : 'learn', topic: safeLabel(i.topic_label), host: initial(i.name),
      starts_at: isNaN(d) ? null : d.toISOString(), within_mi: Math.min(Math.max(n(i.radius_mi) || 15, 1), 15),
      spots_left: Math.max(n(i.max_attendees) - n(i.going), 0) };
  }).filter((i) => i.topic && i.starts_at).slice(0, 4);

  // Photos: visible wall posts taken at a café or meetup (public places), from active members, never reported.
  const photoWhere = `p.hidden_at IS NULL AND u.suspended_at IS NULL AND (p.invite_id IS NOT NULL OR p.shop_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM reports rp WHERE rp.post_id=p.id AND rp.status<>'dismissed')`;
  const photoRows = await db.all(`SELECT p.image_id, im.width, im.height, i.topic_label
    FROM posts p JOIN users u ON u.id=p.user_id JOIN images im ON im.id=p.image_id LEFT JOIN invites i ON i.id=p.invite_id
    WHERE ${photoWhere} ORDER BY p.id DESC LIMIT 3`);
  const photos = photoRows.filter((p) => /^[a-f0-9]{32}$/.test(String(p.image_id)))
    .map((p) => ({ image_url: '/img/' + p.image_id, width: n(p.width) || null, height: n(p.height) || null, topic: safeLabel(p.topic_label) }));
  const photoCount = n((await db.get(`SELECT COUNT(*) n FROM posts p JOIN users u ON u.id=p.user_id WHERE ${photoWhere}`)).n);
  const upcomingCount = n((await db.get(`SELECT COUNT(*) n FROM invites i JOIN users u ON u.id=i.creator_id WHERE u.suspended_at IS NULL AND i.starts_at >= ?`, [nowIso])).n);

  return {
    generated_at: nowIso,
    counts: { members, topics: topicRows.length, upcoming_meetups: upcomingCount, photos: photoCount },
    topics, upcoming, photos,
    ideas: IDEAS,
    how_it_works: ['Ask to learn or offer to teach', 'We match people within up to 15 miles', 'Meet over coffee'],
    max_radius_mi: 15,
  };
}

// Tiny in-memory cache so the public endpoint costs at most one set of queries per minute.
function cachedPeek(db, ttlMs = 60e3) {
  let hit = null, inflight = null;
  return async () => {
    if (hit && Date.now() - hit.t < ttlMs) return hit.v;
    if (!inflight) inflight = buildPeek(db).then((v) => { hit = { v, t: Date.now() }; return v; }).finally(() => { inflight = null; });
    return inflight;
  };
}

module.exports = { buildPeek, cachedPeek, safeLabel, initial, IDEAS };
