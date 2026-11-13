const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const kv = require('../services/kv');
const { JWT_SECRET, ADMIN_IDS, ADMIN_PHONES } = require('../config');

const getToken = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
};

// Verifies a session token and returns the (non banned) user row, or null.
async function authenticateToken(token, device = {}) {
  if (!token) return null;
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
  if (decoded.purpose) return null; // registration tokens are not session tokens
  if (await kv.get(`blacklist:${token}`)) return null;
  const findActiveSession = async (where, params) => {
    const [rows] = await pool.query(
      `SELECT ds.id, ds.device_name,
              (ds.last_active_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)) AS stale,
              u.id AS user_id, u.name, u.username, u.avatar, u.phone, u.banned
       FROM device_sessions ds
       JOIN users u ON u.id = ds.user_id
       WHERE ${where} AND ds.user_id = ? AND ds.revoked_at IS NULL AND ds.expires_at > NOW()
       LIMIT 1`,
      params
    );
    return rows[0] || null;
  };

  let activeSession;
  if (decoded.jti) {
    activeSession = await findActiveSession('ds.id = ?', [decoded.jti, decoded.id]);
    if (!activeSession) return null;
  } else {
    // Adopt legacy JWTs once, preserving their original expiry and avoiding a forced logout.
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    activeSession = await findActiveSession('ds.token_hash = ?', [tokenHash, decoded.id]);
    if (!activeSession) {
      const id = crypto.randomUUID();
      const exp = decoded.exp || Math.floor(Date.now() / 1000) + 86400;
      const name = String(device.name || 'Previously signed-in device').slice(0, 120);
      const platform = ['ios', 'android', 'web'].includes(device.platform) ? device.platform : 'unknown';
      await pool.query(
        'INSERT IGNORE INTO device_sessions (id, token_hash, user_id, device_name, platform, expires_at) VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(?))',
        [id, tokenHash, decoded.id, name, platform, exp]
      );
      activeSession = await findActiveSession('ds.token_hash = ?', [tokenHash, decoded.id]);
    }
    if (!activeSession) return null;
  }

  const sessionId = activeSession.id;
  // Only write when the activity timestamp is stale or a legacy placeholder needs a name.
  const deviceName = String(device.name || '').trim().slice(0, 120);
  const platform = ['ios', 'android', 'web'].includes(device.platform) ? device.platform : null;
  const rename = !!deviceName && activeSession.device_name === 'Previously signed-in device';
  const stale = !!Number(activeSession.stale);
  if (rename || stale) {
    await pool.query(
      'UPDATE device_sessions SET last_active_at = IF(?, NOW(), last_active_at), device_name = IF(?, ?, device_name), platform = IF(?, COALESCE(?, platform), platform) WHERE id = ?',
      [stale, rename, deviceName, rename, platform, sessionId]
    );
  }

  if (activeSession.banned) return null;
  return {
    id: activeSession.user_id,
    name: activeSession.name,
    username: activeSession.username,
    avatar: activeSession.avatar,
    phone: activeSession.phone,
    token,
    sessionId,
  };
}

const authMiddleware = async (req, res, next) => {
  try {
    const user = await authenticateToken(getToken(req), { name: req.get('x-device-name'), platform: req.get('x-device-platform') });
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    req.user = user;
    req.token = user.token;
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(500).json({ message: 'Authentication failed' });
  }
};

// user: any row/object with id and/or phone
const isAdminUser = (u) => !!u && (ADMIN_IDS.includes(Number(u.id)) || (!!u.phone && ADMIN_PHONES.includes(u.phone)));
const isAdminId = async (id) => {
  const [rows] = await pool.query('SELECT id, phone FROM users WHERE id = ?', [id]);
  return rows.length ? isAdminUser(rows[0]) : false;
};

const adminMiddleware = (req, res, next) => {
  if (!req.user || !isAdminUser(req.user)) return res.status(403).json({ message: 'Admin access required' });
  next();
};

module.exports = { authMiddleware, adminMiddleware, authenticateToken, isAdminId, isAdminUser, getToken };
