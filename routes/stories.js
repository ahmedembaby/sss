const express = require('express');
const pool = require('../db');
const upload = require('../middleware/upload');
const rt = require('../services/realtime');
const { shapeUser } = require('../utils/posts');

const { notBlocked, isBlockedBetween } = require('../utils/blocks');
const router = express.Router();
const TTL_HOURS = 24;

const shape = (s) => ({
  id: String(s.id),
  media_url: s.media_url,
  media_type: s.media_type,
  caption: s.caption || undefined,
  created_at: s.created_at,
  expires_at: s.expires_at,
  seen: !!s.seen,
  views_count: s.views_count !== undefined ? Number(s.views_count) : undefined,
});

// can `viewerId` see the stories of `ownerId`?
async function canView(viewerId, ownerId) {
  if (Number(viewerId) === Number(ownerId)) return true;
  if (await isBlockedBetween(viewerId, ownerId)) return false;
  const [u] = await pool.query('SELECT is_private FROM users WHERE id = ? AND banned = 0', [ownerId]);
  if (!u.length) return false;
  if (!u[0].is_private) return true;
  const [f] = await pool.query('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?', [viewerId, ownerId]);
  return f.length > 0;
}

// POST /api/stories  (multipart field "media", optional caption)
router.post('/', upload.story.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Media file required (field "media")' });
    const isVideo = /video\//.test(req.file.mimetype || '') || /\.(mp4|mov|3gp|webm)$/i.test(req.file.originalname || '');
    const [r] = await pool.query(
      'INSERT INTO stories (user_id, media_url, media_type, caption, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))',
      [req.user.id, `/uploads/stories/${req.file.filename}`, isVideo ? 'video' : 'image', String(req.body.caption || '').slice(0, 300) || null, TTL_HOURS]
    );
    const [rows] = await pool.query('SELECT * FROM stories WHERE id = ?', [r.insertId]);
    res.status(201).json(shape(rows[0]));
  } catch (err) {
    console.error('story:', err.message);
    res.status(500).json({ message: 'Could not publish story' });
  }
});

// GET /api/stories/feed - my stories + stories of the people I follow, grouped by user (unseen first)
router.get('/feed', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.*, u.name, u.username, u.avatar,
              EXISTS(SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.user_id = ?) AS seen
       FROM stories s JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > NOW() AND u.banned = 0 AND ${notBlocked('s.user_id')}
         AND (s.user_id = ? OR s.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?))
       ORDER BY s.created_at ASC, s.id ASC`,
      [req.user.id, req.user.id, req.user.id, req.user.id]
    );
    const groups = new Map();
    for (const s of rows) {
      if (!groups.has(s.user_id)) groups.set(s.user_id, { user: shapeUser(s.user_id, s.name, s.username, s.avatar), stories: [], all_seen: true });
      const g = groups.get(s.user_id);
      g.stories.push(shape(s));
      if (!s.seen) g.all_seen = false;
    }
    const list = [...groups.values()];
    const mine = list.filter((g) => g.user.id === String(req.user.id));
    const others = list.filter((g) => g.user.id !== String(req.user.id)).sort((a, b) => Number(a.all_seen) - Number(b.all_seen));
    res.json([...mine, ...others]);
  } catch (err) {
    console.error('stories feed:', err.message);
    res.status(500).json({ message: 'Could not load stories' });
  }
});

// GET /api/stories/user/:id
router.get('/user/:id', async (req, res) => {
  try {
    if (!(await canView(req.user.id, req.params.id))) return res.status(403).json({ message: 'This account is private' });
    const [rows] = await pool.query(
      `SELECT s.*, EXISTS(SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.user_id = ?) AS seen
       FROM stories s WHERE s.user_id = ? AND s.expires_at > NOW() ORDER BY s.created_at ASC, s.id ASC`,
      [req.user.id, req.params.id]
    );
    res.json(rows.map(shape));
  } catch (err) {
    res.status(500).json({ message: 'Could not load stories' });
  }
});

router.post('/:id/view', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, user_id FROM stories WHERE id = ? AND expires_at > NOW()', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Story not found' });
    if (!(await canView(req.user.id, rows[0].user_id))) return res.status(403).json({ message: 'Not allowed' });
    if (rows[0].user_id !== req.user.id) {
      const [r] = await pool.query('INSERT IGNORE INTO story_views (story_id, user_id) VALUES (?, ?)', [rows[0].id, req.user.id]);
      if (r.affectedRows) rt.emitToUser(rows[0].user_id, 'story_viewed', { story_id: String(rows[0].id), user_id: String(req.user.id) });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Could not mark story as seen' });
  }
});

// owner only
router.get('/:id/viewers', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.username, u.avatar, v.viewed_at FROM story_views v
       JOIN stories s ON s.id = v.story_id JOIN users u ON u.id = v.user_id
       WHERE v.story_id = ? AND s.user_id = ? ORDER BY v.viewed_at DESC LIMIT 200`,
      [req.params.id, req.user.id]
    );
    res.json(rows.map((u) => ({ ...shapeUser(u.id, u.name, u.username, u.avatar), viewed_at: u.viewed_at })));
  } catch (err) {
    res.status(500).json({ message: 'Could not load viewers' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM stories WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Story not found' });
    res.json({ message: 'Story deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Could not delete story' });
  }
});

module.exports = router;
