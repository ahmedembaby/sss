const pool = require('../db');

const DEFAULT_NOTIF = { like: true, comment: true, follow: true, mention: true, message: true, group: true };
const CATEGORY = {
  like: 'like', comment: 'comment', follow: 'follow', follow_request: 'follow', follow_accepted: 'follow',
  mention: 'mention', group_invite: 'group', group_request: 'group', group_approved: 'group', message: 'message',
};

const parse = (txt) => {
  let s = {};
  try { s = JSON.parse(txt || '{}') || {}; } catch { s = {}; }
  return {
    notif: { ...DEFAULT_NOTIF, ...(s.notif || {}) },
    quiet: { enabled: false, start: 22, end: 7, tz: 0, ...(s.quiet || {}) },
  };
};

// quiet hours are stored as local hours + the phone's UTC offset in minutes
const inQuiet = (q, now = new Date()) => {
  if (!q.enabled) return false;
  const local = (((now.getUTCHours() * 60 + now.getUTCMinutes() + (Number(q.tz) || 0)) % 1440) + 1440) % 1440 / 60;
  const { start, end } = q;
  return start === end ? false : start < end ? local >= start && local < end : local >= start || local < end;
};

/** Which of these users should get a mobile push for this kind of event right now. */
async function pushAllowed(userIds, kindOrType) {
  if (!userIds || !userIds.length) return [];
  const kind = CATEGORY[kindOrType] || kindOrType;
  const [rows] = await pool.query('SELECT id, settings FROM users WHERE id IN (?)', [userIds]);
  return rows.filter((r) => {
    const p = parse(r.settings);
    return p.notif[kind] !== false && !inQuiet(p.quiet);
  }).map((r) => r.id);
}

module.exports = { parse, inQuiet, pushAllowed, DEFAULT_NOTIF };
