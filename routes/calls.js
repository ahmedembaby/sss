const express = require('express');
const pool = require('../db');
const { shapeUser } = require('../utils/posts');

const router = express.Router();

// ICE servers for WebRTC. Add your own TURN server in .env for calls across strict NATs / mobile data:
//   TURN_URL=turn:turn.example.com:3478  TURN_USERNAME=...  TURN_PASSWORD=...
router.get('/ice', (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    iceServers.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_PASSWORD || '' });
  }
  res.json({ iceServers });
});

// call history
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.type, c.status, c.created_at, c.duration, c.caller_id,
              u.id AS uid, u.name, u.username, u.avatar
       FROM calls c JOIN users u ON u.id = IF(c.caller_id = ?, c.callee_id, c.caller_id)
       WHERE c.caller_id = ? OR c.callee_id = ? ORDER BY c.id DESC LIMIT 100`,
      [req.user.id, req.user.id, req.user.id]
    );
    res.json(rows.map((r) => ({
      id: String(r.id), type: r.type, status: r.status, created_at: r.created_at, duration: r.duration,
      direction: r.caller_id === req.user.id ? 'outgoing' : 'incoming',
      user: shapeUser(r.uid, r.name, r.username, r.avatar),
    })));
  } catch (err) {
    res.status(500).json({ message: 'Could not load calls' });
  }
});

module.exports = router;
