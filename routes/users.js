const express = require('express');
const pool = require('../db');
const upload = require('../middleware/upload');
const { toUser, publicUser, toInt } = require('../utils/format');
const { isAdminUser } = require('../middleware/auth');

const { notBlocked } = require('../utils/blocks');
const realtime = require('../services/realtime');
const { pushToUsers } = require('../services/push');
const router = express.Router();

// GET /api/users?q=&limit=  (everyone except me)
router.get('/', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = toInt(req.query.limit, 200, 1, 500);
    const params = [req.user.id, req.user.id];
    let where = `id <> ? AND banned = 0 AND ${notBlocked('id')}`;
    if (q) {
      where += ' AND (name LIKE ? OR username LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    params.push(limit);
    const [rows] = await pool.query(
      `SELECT id, name, username, avatar, bio, IF(hide_presence = 1, 'offline', status) AS status, IF(hide_presence = 1, NULL, last_seen) AS last_seen FROM users WHERE ${where} ORDER BY name LIMIT ?`,
      params
    );
    res.json(rows.map(publicUser));
  } catch (err) {
    console.error('users list:', err.message);
    res.status(500).json({ message: 'Could not load users' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, email, username, phone, avatar, bio, gender, birthday, status, last_seen, is_private, public_key FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    res.json(toUser({ ...rows[0], is_admin: isAdminUser(rows[0]) }));
  } catch (err) {
    res.status(500).json({ message: 'Could not load profile' });
  }
});

// PUT /api/users/me  { name?, bio?, username?, gender?, birthday? }
router.put('/me', async (req, res) => {
  try {
    const fields = [];
    const params = [];
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (name.length < 2 || name.length > 100) return res.status(400).json({ message: 'Name must be 2-100 characters' });
      fields.push('name = ?'); params.push(name);
    }
    if (req.body.bio !== undefined) {
      fields.push('bio = ?'); params.push(String(req.body.bio).slice(0, 160) || null);
    }
    if (req.body.username !== undefined) {
      const username = String(req.body.username).trim().toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9_]{3,30}$/.test(username)) {
        return res.status(400).json({ message: 'Username must be 3-30 letters, numbers or underscores' });
      }
      const [dup] = await pool.query('SELECT id FROM users WHERE username = ? AND id <> ?', [username, req.user.id]);
      if (dup.length) return res.status(409).json({ message: 'Username is already taken' });
      fields.push('username = ?'); params.push(username);
    }
    let becamePublic = false;
    if (req.body.is_private !== undefined) {
      const priv = req.body.is_private === true || req.body.is_private === 'true' || req.body.is_private === 1;
      fields.push('is_private = ?'); params.push(priv ? 1 : 0);
      becamePublic = !priv;
    }
    if (req.body.gender !== undefined) { fields.push('gender = ?'); params.push(String(req.body.gender).slice(0, 20) || null); }
    if (req.body.birthday !== undefined) {
      const b = req.body.birthday ? String(req.body.birthday).slice(0, 10) : null;
      if (b && !/^\d{4}-\d{2}-\d{2}$/.test(b)) return res.status(400).json({ message: 'Invalid birthday' });
      fields.push('birthday = ?'); params.push(b);
    }
    if (!fields.length) return res.status(400).json({ message: 'Nothing to update' });
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...params, req.user.id]);
    if (becamePublic) {
      // going public accepts everybody who was waiting
      await pool.query('INSERT IGNORE INTO follows (follower_id, following_id) SELECT follower_id, target_id FROM follow_requests WHERE target_id = ?', [req.user.id]);
      await pool.query('DELETE FROM follow_requests WHERE target_id = ?', [req.user.id]);
    }
    const [rows] = await pool.query(
      'SELECT id, name, email, username, phone, avatar, bio, gender, birthday, status, last_seen, is_private, public_key FROM users WHERE id = ?',
      [req.user.id]
    );
    res.json(toUser({ ...rows[0], is_admin: isAdminUser(rows[0]) }));
  } catch (err) {
    console.error('update me:', err.message);
    res.status(500).json({ message: 'Could not update profile' });
  }
});

// PUT /api/users/me/key  { public_key }  - base64 curve25519 public key (end-to-end encryption)
router.put('/me/key', async (req, res) => {
  try {
    const key = String(req.body.public_key || '').trim();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) return res.status(400).json({ message: 'Invalid public key' });
    const [current] = await pool.query('SELECT public_key, name FROM users WHERE id = ?', [req.user.id]);
    if (!current.length) return res.status(404).json({ message: 'User not found' });
    const previousKey = current[0].public_key;
    await pool.query('UPDATE users SET public_key = ? WHERE id = ?', [key, req.user.id]);
    const changed = !!previousKey && previousKey !== key;
    if (changed) {
      const [peers] = await pool.query("SELECT DISTINCT cp.user_id AS id FROM conversations c JOIN conversation_participants me ON me.conversation_id = c.id AND me.user_id = ? JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id <> ? WHERE c.type = 'direct'", [req.user.id, req.user.id]);
      const peerIds = peers.map((p) => Number(p.id)).filter((id) => id > 0);
      const payload = { userId: req.user.id, userName: current[0].name, changedAt: new Date().toISOString() };
      realtime.emitToUsers(peerIds, 'security_key_changed', payload);
      if (peerIds.length) pushToUsers(peerIds, { title: 'Special security alert', body: current[0].name + ' changed their encryption key. Open the chat and verify the updated safety number before trusting it.', data: { type: 'security_key_changed', userId: req.user.id } }).catch(() => {});
    }
    res.json({ public_key: key, changed });
  } catch (err) {
    res.status(500).json({ message: 'Could not save key' });
  }
});

// GET/PUT /api/users/me/settings - privacy + notification preferences
const prefs = require('../services/prefs');
const settingsOut = async (id) => {
  const [r] = await pool.query('SELECT hide_presence, read_receipts, who_can_message, settings, is_private FROM users WHERE id = ?', [id]);
  const u = r[0] || {};
  const p = prefs.parse(u.settings);
  return { hide_presence: !!u.hide_presence, read_receipts: u.read_receipts !== 0, who_can_message: u.who_can_message || 'everyone', is_private: !!u.is_private, notif: p.notif, quiet: p.quiet };
};
router.get('/me/settings', async (req, res) => {
  try { res.json(await settingsOut(req.user.id)); } catch { res.status(500).json({ message: 'Could not load settings' }); }
});
router.put('/me/settings', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = []; const params = [];
    if (b.hide_presence !== undefined) { sets.push('hide_presence = ?'); params.push(b.hide_presence ? 1 : 0); }
    if (b.read_receipts !== undefined) { sets.push('read_receipts = ?'); params.push(b.read_receipts ? 1 : 0); }
    if (b.who_can_message !== undefined) {
      if (!['everyone', 'followed', 'nobody'].includes(b.who_can_message)) return res.status(400).json({ message: 'Invalid value' });
      sets.push('who_can_message = ?'); params.push(b.who_can_message);
    }
    if (b.notif || b.quiet) {
      const cur = prefs.parse((await pool.query('SELECT settings FROM users WHERE id = ?', [req.user.id]))[0][0].settings);
      const notif = { ...cur.notif };
      for (const k of Object.keys(prefs.DEFAULT_NOTIF)) if (b.notif && typeof b.notif[k] === 'boolean') notif[k] = b.notif[k];
      const q = { ...cur.quiet };
      if (b.quiet) {
        if (typeof b.quiet.enabled === 'boolean') q.enabled = b.quiet.enabled;
        for (const k of ['start', 'end']) if (Number.isInteger(b.quiet[k]) && b.quiet[k] >= 0 && b.quiet[k] < 24) q[k] = b.quiet[k];
        if (Number.isInteger(b.quiet.tz) && Math.abs(b.quiet.tz) <= 840) q.tz = b.quiet.tz;
      }
      sets.push('settings = ?'); params.push(JSON.stringify({ notif, quiet: q }));
    }
    if (sets.length) await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, req.user.id]);
    res.json(await settingsOut(req.user.id));
  } catch (err) {
    res.status(500).json({ message: 'Could not save settings' });
  }
});

// Encrypted backup of the end-to-end key: the app encrypts it with the user's passphrase, so the server only stores an unreadable blob.
router.put('/me/key-backup', async (req, res) => {
  try {
    const backup = String(req.body.backup || '');
    if (backup.length < 20 || backup.length > 4000) return res.status(400).json({ message: 'Invalid backup' });
    await pool.query('UPDATE users SET key_backup = ? WHERE id = ?', [backup, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Could not save backup' });
  }
});
router.get('/me/key-backup', async (req, res) => {
  try {
    const [r] = await pool.query('SELECT key_backup FROM users WHERE id = ?', [req.user.id]);
    if (!r[0] || !r[0].key_backup) return res.status(404).json({ message: 'No backup' });
    res.json({ backup: r[0].key_backup });
  } catch (err) {
    res.status(500).json({ message: 'Could not load backup' });
  }
});

// POST /api/users/lookup-phones  { phones: ['+2010...', '010...'] }
// Matches contacts to registered users by the last 9 digits (so local and international formats both match).
router.post('/lookup-phones', async (req, res) => {
  try {
    const raw = Array.isArray(req.body.phones) ? req.body.phones.slice(0, 1000) : [];
    const tails = [...new Set(raw.map((p) => String(p).replace(/\D/g, '')).filter((d) => d.length >= 7).map((d) => d.slice(-9)))];
    if (!tails.length) return res.json([]);
    const [rows] = await pool.query(
      `SELECT id, name, username, avatar, bio, IF(hide_presence = 1, 'offline', status) AS status, IF(hide_presence = 1, NULL, last_seen) AS last_seen, is_private, RIGHT(phone, 9) AS phone_tail
       FROM users WHERE banned = 0 AND id <> ? AND phone IS NOT NULL AND ${notBlocked('id')} AND RIGHT(phone, 9) IN (?)`,
      [req.user.id, req.user.id, tails]
    );
    res.json(rows.map((u) => ({ ...publicUser(u), phone_tail: u.phone_tail })));
  } catch (err) {
    res.status(500).json({ message: 'Lookup failed' });
  }
});

// PUT /api/users/avatar  (multipart field "avatar")
router.put('/avatar', upload.avatar.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Image file required (field "avatar")' });
    const url = `/uploads/avatars/${req.file.filename}`;
    await pool.query('UPDATE users SET avatar = ? WHERE id = ?', [url, req.user.id]);
    res.json({ avatar: url, url });
  } catch (err) {
    console.error('avatar:', err.message);
    res.status(500).json({ message: 'Could not update avatar' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, username, avatar, bio, IF(hide_presence = 1, \'offline\', status) AS status, IF(hide_presence = 1, NULL, last_seen) AS last_seen FROM users WHERE id = ? AND banned = 0',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    res.json(publicUser(rows[0]));
  } catch (err) {
    res.status(500).json({ message: 'Could not load user' });
  }
});

module.exports = router;
