const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const pool = require('../db');
const kv = require('../services/kv');
const wa = require('../services/whatsapp');
const sendOTP = wa.sendOTP;
const { authMiddleware, adminMiddleware, getToken, isAdminUser } = require('../middleware/auth');
const { JWT_SECRET, JWT_EXPIRES_IN, OTP_DEV_MODE, isProd } = require('../config');
const { toUser, normalizePhone } = require('../utils/format');
const { generateUsername } = require('../utils/username');

const router = express.Router();

const OTP_TTL = 300; // seconds
const OTP_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN = 30;

const signToken = (user, sessionId) => jwt.sign({ id: user.id, jti: sessionId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
const createSessionToken = async (req, user) => {
  const sessionId = crypto.randomUUID();
  const token = signToken(user, sessionId);
  const decoded = jwt.decode(token);
  const deviceName = String(req.get('x-device-name') || 'Unknown device').trim().slice(0, 120) || 'Unknown device';
  const rawPlatform = String(req.get('x-device-platform') || '').toLowerCase();
  const platform = ['ios', 'android', 'web'].includes(rawPlatform) ? rawPlatform : 'unknown';
  await pool.query('INSERT INTO device_sessions (id, user_id, device_name, platform, expires_at) VALUES (?, ?, ?, ?, FROM_UNIXTIME(?))', [sessionId, user.id, deviceName, platform, decoded.exp]);
  return token;
};
const publicUserOf = (u) => toUser({ ...u, is_admin: isAdminUser(u) });

const loadUser = async (id) => {
  const [rows] = await pool.query(
    'SELECT id, name, email, username, phone, avatar, bio, gender, birthday, status, last_seen, is_private, public_key FROM users WHERE id = ?',
    [id]
  );
  return rows[0] || null;
};

const signupRules = [
  body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Name must be 2-100 characters'),
  body('email').trim().isEmail().withMessage('Valid email required').normalizeEmail({ gmail_remove_dots: false, gmail_remove_subaddress: false }),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
];

// --- Email + password (optional flow) ---
router.post('/signup', signupRules, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ message: errors.array()[0].msg });
  try {
    const { name, email, password } = req.body;
    const phone = req.body.phone ? normalizePhone(req.body.phone) : null;
    const [dup] = await pool.query('SELECT id FROM users WHERE email = ? OR (phone IS NOT NULL AND phone = ?)', [email, phone]);
    if (dup.length) return res.status(409).json({ message: 'User already exists' });

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query('INSERT INTO users (name, email, phone, password) VALUES (?, ?, ?, ?)', [name, email, phone, hash]);
    const username = await generateUsername(name, result.insertId);
    await pool.query('UPDATE users SET username = ? WHERE id = ?', [username, result.insertId]);
    const user = await loadUser(result.insertId);
    res.status(201).json({ token: await createSessionToken(req, user), user: publicUserOf(user) });
  } catch (err) {
    console.error('signup:', err.message);
    res.status(500).json({ message: 'Could not create account' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);
    const row = rows[0];
    if (!row || !row.password || !(await bcrypt.compare(password, row.password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    if (row.banned) return res.status(403).json({ message: 'This account has been suspended' });
    res.json({ token: await createSessionToken(req, row), user: publicUserOf(row) });
  } catch (err) {
    console.error('login:', err.message);
    res.status(500).json({ message: 'Login failed' });
  }
});

// --- Phone OTP flow: send-otp -> verify-otp -> (new users) set-name ---
async function issueOTP(phone) {
  const code = String(crypto.randomInt(1000, 10000)); // 4 digits (matches the mobile UI)
  await kv.set(`otp:${phone}`, code, OTP_TTL);
  await kv.del(`otp_attempts:${phone}`);
  await kv.set(`otp_cooldown:${phone}`, '1', RESEND_COOLDOWN);
  const result = await sendOTP(phone, code);
  return { code, result };
}

const otpHandler = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (phone.replace(/\D/g, '').length < 7) return res.status(400).json({ message: 'Valid phone number required' });

    if (await kv.get(`otp_cooldown:${phone}`)) {
      return res.status(429).json({ message: `Please wait ${RESEND_COOLDOWN} seconds before requesting another code` });
    }
    const { code, result } = await issueOTP(phone);

    if (!result.success && !OTP_DEV_MODE) {
      await kv.del(`otp:${phone}`);
      await kv.del(`otp_cooldown:${phone}`);
      if (result.code === 'NOT_ON_WHATSAPP') {
        return res.status(400).json({ message: 'This phone number is not registered on WhatsApp.' });
      }
      return res.status(503).json({
        message: 'Could not deliver the verification code right now. Please try again later.',
      });
    }
    const payload = { message: result.success ? 'OTP sent' : 'OTP generated (development mode)', sent: !!result.success };
    if (OTP_DEV_MODE && !result.success) payload.devCode = code;
    res.json(payload);
  } catch (err) {
    console.error('send-otp:', err.message);
    res.status(500).json({ message: 'Could not send the code' });
  }
};
router.post('/send-otp', otpHandler);
router.post('/resend-otp', otpHandler);

router.post('/verify-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();
    if (!phone || !code) return res.status(400).json({ message: 'Phone and code required' });

    const attempts = Number(await kv.get(`otp_attempts:${phone}`)) || 0;
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await kv.del(`otp:${phone}`);
      return res.status(429).json({ message: 'Too many attempts. Request a new code.' });
    }
    const stored = await kv.get(`otp:${phone}`);
    if (!stored || stored.length !== code.length || !crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(code))) {
      await kv.incr(`otp_attempts:${phone}`, OTP_TTL);
      return res.status(400).json({ message: 'Invalid or expired code' });
    }
    await kv.del(`otp:${phone}`);
    await kv.del(`otp_attempts:${phone}`);

    const [rows] = await pool.query('SELECT id, banned FROM users WHERE phone = ?', [phone]);
    if (rows.length) {
      if (rows[0].banned) return res.status(403).json({ message: 'This account has been suspended' });
      const user = await loadUser(rows[0].id);
      return res.json({ userExists: true, token: await createSessionToken(req, user), user: publicUserOf(user) });
    }
    // New user: a short lived token proves the phone was verified, it is required by /set-name
    const registrationToken = jwt.sign({ purpose: 'register', phone }, JWT_SECRET, { expiresIn: '15m' });
    res.json({ userExists: false, registrationToken, user: { phone } });
  } catch (err) {
    console.error('verify-otp:', err.message);
    res.status(500).json({ message: 'Verification failed' });
  }
});

router.post('/set-name', async (req, res) => {
  try {
    const regToken = req.body.registrationToken || getToken(req);
    let decoded;
    try { decoded = jwt.verify(regToken, JWT_SECRET); } catch { decoded = null; }
    if (!decoded || decoded.purpose !== 'register') {
      return res.status(401).json({ message: 'Phone verification expired. Please start again.' });
    }
    const name = String(req.body.name || '').trim();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ message: 'Name must be 2-100 characters' });

    const [exists] = await pool.query('SELECT id FROM users WHERE phone = ?', [decoded.phone]);
    if (exists.length) return res.status(409).json({ message: 'Account already exists, please log in' });

    const [result] = await pool.query('INSERT INTO users (name, phone) VALUES (?, ?)', [name, decoded.phone]);
    const username = await generateUsername(name, result.insertId);
    await pool.query('UPDATE users SET username = ? WHERE id = ?', [username, result.insertId]);
    const user = await loadUser(result.insertId);
    res.status(201).json({ token: await createSessionToken(req, user), user: publicUserOf(user) });
  } catch (err) {
    console.error('set-name:', err.message);
    res.status(500).json({ message: 'Could not create account' });
  }
});

// --- Session ---
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    const decoded = jwt.decode(req.token);
    const ttl = decoded && decoded.exp ? Math.max(decoded.exp - Math.floor(Date.now() / 1000), 1) : 3600;
    await kv.set(`blacklist:${req.token}`, '1', ttl);
    if (req.user.sessionId) await pool.query('UPDATE device_sessions SET revoked_at = NOW() WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [req.user.sessionId, req.user.id]);
    await pool.query('UPDATE users SET push_token = NULL WHERE id = ?', [req.user.id]);
    res.json({ message: 'Logged out' });
  } catch (err) {
    res.status(500).json({ message: 'Logout failed' });
  }
});

router.get('/sessions', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, device_name, platform, created_at, last_active_at, expires_at, (id = ?) AS is_current FROM device_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW() ORDER BY is_current DESC, last_active_at DESC', [req.user.sessionId || '', req.user.id]);
    res.json(rows);
  } catch (err) { console.error('list sessions:', err.message); res.status(500).json({ message: 'Could not load sessions' }); }
});

router.delete('/sessions/:id', authMiddleware, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return res.status(400).json({ message: 'Invalid session id' });
    const [result] = await pool.query('UPDATE device_sessions SET revoked_at = NOW() WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [sessionId, req.user.id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Session not found or already revoked' });
    require('../services/realtime').disconnectSession(sessionId);
    if (sessionId === req.user.sessionId) {
      const decoded = jwt.decode(req.token);
      const ttl = decoded && decoded.exp ? Math.max(decoded.exp - Math.floor(Date.now() / 1000), 1) : 3600;
      await kv.set(`blacklist:${req.token}`, '1', ttl);
    }
    res.json({ revoked: true, current: sessionId === req.user.sessionId });
  } catch (err) { console.error('revoke session:', err.message); res.status(500).json({ message: 'Could not revoke session' }); }
});
router.post('/push/register', authMiddleware, async (req, res) => {
  try {
    const token = String(req.body.token || '').trim();
    if (!token) return res.status(400).json({ message: 'token required' });
    // A device token belongs to a single account
    await pool.query('UPDATE users SET push_token = NULL WHERE push_token = ? AND id <> ?', [token, req.user.id]);
    await pool.query('UPDATE users SET push_token = ? WHERE id = ?', [token, req.user.id]);
    res.json({ message: 'Push token registered' });
  } catch (err) {
    res.status(500).json({ message: 'Could not register push token' });
  }
});

module.exports = router;
