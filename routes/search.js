const express = require('express');
const pool = require('../db');
const { publicUser, toInt } = require('../utils/format');
const { formatPosts, POST_SELECT, POST_VISIBLE } = require('../utils/posts');

const { notBlocked } = require('../utils/blocks');
const router = express.Router();

router.get('/users', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const [rows] = await pool.query(
      `SELECT id, name, username, avatar, bio, IF(hide_presence = 1, 'offline', status) AS status, IF(hide_presence = 1, NULL, last_seen) AS last_seen FROM users
       WHERE id <> ? AND banned = 0 AND ${notBlocked('id')} AND (name LIKE ? OR username LIKE ? OR phone LIKE ?)
       ORDER BY name LIMIT 50`,
      [req.user.id, req.user.id, `%${q}%`, `%${q}%`, `%${q}%`]
    );
    res.json(rows.map(publicUser));
  } catch (err) {
    res.status(500).json({ message: 'Search failed' });
  }
});

router.get('/posts', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const limit = toInt(req.query.limit, 30, 1, 100);
    const [rows] = await pool.query(`${POST_SELECT} WHERE p.content LIKE ? AND ${POST_VISIBLE} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`, [`%${q}%`, req.user.id, req.user.id, req.user.id, limit]);
    res.json(await formatPosts(rows, req.user.id));
  } catch (err) {
    res.status(500).json({ message: 'Search failed' });
  }
});

module.exports = router;
