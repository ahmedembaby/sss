const express = require('express');
const pool = require('../db');
const rt = require('../services/realtime');
const kv = require('../services/kv');
const { publicUser } = require('../utils/format');
const { isAdminUser } = require('../middleware/auth');

const router = express.Router();

// POST /api/safety/block/:id  (toggle)  -> { blocked }
router.post('/block/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id === req.user.id) return res.status(400).json({ message: 'Invalid user' });
    const [u] = await pool.query('SELECT id FROM users WHERE id = ?', [id]);
    if (!u.length) return res.status(404).json({ message: 'User not found' });
    const [del] = await pool.query('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [req.user.id, id]);
    if (del.affectedRows) return res.json({ blocked: false });
    await pool.query('INSERT IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)', [req.user.id, id]);
    // blocking cuts the follow relationship both ways and pending requests
    await pool.query('DELETE FROM follows WHERE (follower_id = ? AND following_id = ?) OR (follower_id = ? AND following_id = ?)', [req.user.id, id, id, req.user.id]);
    await pool.query('DELETE FROM follow_requests WHERE (follower_id = ? AND target_id = ?) OR (follower_id = ? AND target_id = ?)', [req.user.id, id, id, req.user.id]);
    res.json({ blocked: true });
  } catch (err) {
    res.status(500).json({ message: 'Could not update block' });
  }
});

router.get('/blocks', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.username, u.avatar, u.bio, u.status, u.last_seen FROM user_blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = ? ORDER BY b.created_at DESC`, [req.user.id]);
    res.json(rows.map(publicUser));
  } catch (err) {
    res.status(500).json({ message: 'Could not load blocked users' });
  }
});

// GET /api/safety/blocked/:id -> { blocked_by_me, blocked_me }
router.get('/blocked/:id', async (req, res) => {
  try {
    const [r] = await pool.query('SELECT blocker_id FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)', [req.user.id, req.params.id, req.params.id, req.user.id]);
    res.json({ blocked_by_me: r.some((x) => x.blocker_id === req.user.id), blocked_me: r.some((x) => x.blocker_id !== req.user.id) });
  } catch (err) {
    res.status(500).json({ message: 'Could not check block' });
  }
});

const REASONS = ['spam', 'harassment', 'hate', 'violence', 'nudity', 'scam', 'impersonation', 'other'];
const TABLES = { user: 'users', post: 'posts', comment: 'comments', message: 'messages', story: 'stories' };

// POST /api/safety/report { type, id, reason, details? }
router.post('/report', async (req, res) => {
  try {
    const type = String(req.body.type || '');
    const id = Number(req.body.id);
    const reason = REASONS.includes(req.body.reason) ? req.body.reason : 'other';
    if (!TABLES[type] || !Number.isInteger(id)) return res.status(400).json({ message: 'Invalid report' });
    const [t] = await pool.query(`SELECT id FROM ${TABLES[type]} WHERE id = ?`, [id]);
    if (!t.length) return res.status(404).json({ message: 'Content not found' });
    const [dup] = await pool.query("SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open'", [req.user.id, type, id]);
    if (!dup.length) {
      await pool.query('INSERT INTO reports (reporter_id, target_type, target_id, reason, details) VALUES (?, ?, ?, ?, ?)',
        [req.user.id, type, id, reason, String(req.body.details || '').slice(0, 500) || null]);
    }
    res.status(201).json({ message: 'Thanks, we will review this report' });
  } catch (err) {
    console.error('report:', err.message);
    res.status(500).json({ message: 'Could not send report' });
  }
});

// GET /api/safety/export - everything we hold about the caller (JSON download)
router.get('/export', async (req, res) => {
  try {
    const id = req.user.id;
    const q = async (sql) => (await pool.query(sql, [id]))[0];
    const data = {
      exported_at: new Date().toISOString(),
      profile: (await q('SELECT id, name, email, username, phone, bio, gender, birthday, avatar, is_private, created_at FROM users WHERE id = ?'))[0],
      posts: await q('SELECT id, content, image, created_at FROM posts WHERE user_id = ? ORDER BY id DESC LIMIT 5000'),
      comments: await q('SELECT id, post_id, content, created_at FROM comments WHERE user_id = ? ORDER BY id DESC LIMIT 5000'),
      messages_sent: await q('SELECT id, conversation_id, content, type, created_at FROM messages WHERE sender_id = ? ORDER BY id DESC LIMIT 10000'),
      following: await q('SELECT following_id AS user_id FROM follows WHERE follower_id = ?'),
      followers: await q('SELECT follower_id AS user_id FROM follows WHERE following_id = ?'),
      blocked: await q('SELECT blocked_id AS user_id FROM user_blocks WHERE blocker_id = ?'),
      stories: await q('SELECT id, media_url, caption, created_at FROM stories WHERE user_id = ?'),
      note: 'End-to-end encrypted messages appear as encrypted text; only your device can read them.',
    };
    res.setHeader('Content-Disposition', 'attachment; filename="my-data.json"');
    res.json(data);
  } catch (err) {
    console.error('export:', err.message);
    res.status(500).json({ message: 'Could not export data' });
  }
});

// DELETE /api/safety/account { confirm: 'DELETE' } - permanently removes the account
router.delete('/account', async (req, res) => {
  try {
    if (req.body.confirm !== 'DELETE') return res.status(400).json({ message: 'Type DELETE to confirm' });
    if (isAdminUser(req.user)) return res.status(403).json({ message: 'Admin accounts cannot be deleted from the app' });
    const id = req.user.id;
    try {
      await pool.query('DELETE FROM users WHERE id = ?', [id]);
    } catch (e) {
      // a foreign key blocks hard deletion: anonymise and lock the account instead
      await pool.query("UPDATE users SET name = 'Deleted user', username = CONCAT('deleted_', id), email = NULL, phone = NULL, avatar = NULL, bio = NULL, public_key = NULL, banned = 1 WHERE id = ?", [id]);
    }
    try { await kv.set(`blacklist:${req.user.token}`, '1', 60 * 60 * 24 * 30); } catch { /* optional */ }
    rt.emitToUser(id, 'account_deleted', {});
    res.json({ message: 'Account deleted' });
  } catch (err) {
    console.error('delete account:', err.message);
    res.status(500).json({ message: 'Could not delete the account' });
  }
});

module.exports = router;
