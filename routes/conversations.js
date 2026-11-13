const express = require('express');
const pool = require('../db');
const rt = require('../services/realtime');
const { isParticipant, participantIds, MESSAGE_SELECT, visible, attachReactions } = require('../services/chat');
const { isBlockedBetween } = require('../utils/blocks');
const { toInt } = require('../utils/format');

const router = express.Router();

// Builds list items (conversation + other participants + last message + unread count) for one viewer
async function loadConversations(viewerId, onlyId = null) {
  const vis = visible('m');
  const visLm = visible('lmx');
  const params = [viewerId, viewerId, viewerId, viewerId];
  let where = 'WHERE cp.user_id = ?';
  if (onlyId) { where += ' AND c.id = ?'; params.push(onlyId); }
  const [convs] = await pool.query(
    `SELECT c.id, c.name, c.avatar, c.type, c.group_id, c.created_by, c.created_at, cp.pinned, cp.archived, cp.muted_until, c.pinned_message_id, c.disappear_after,
       lm.content AS last_message, lm.type AS last_message_type, lm.created_at AS last_message_at, lm.sender_id AS last_message_sender_id,
       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> ? AND m.status <> 'read' AND ${vis}) AS unread_count
     FROM conversations c
     JOIN conversation_participants cp ON cp.conversation_id = c.id
     LEFT JOIN messages lm ON lm.id = (SELECT MAX(lmx.id) FROM messages lmx WHERE lmx.conversation_id = c.id AND ${visLm})
     ${where}
     ORDER BY cp.pinned DESC, COALESCE(lm.created_at, c.created_at) DESC, c.id DESC`,
    params
  );
  if (!convs.length) return [];

  const [ps] = await pool.query(
    `SELECT cp.conversation_id, u.id, u.name, u.username, u.avatar, IF(u.hide_presence = 1, 'offline', u.status) AS status, IF(u.hide_presence = 1, NULL, u.last_seen) AS last_seen, u.public_key
     FROM conversation_participants cp JOIN users u ON u.id = cp.user_id
     WHERE cp.conversation_id IN (?) AND cp.user_id <> ?`,
    [convs.map((c) => c.id), viewerId]
  );
  const map = {};
  for (const p of ps) (map[p.conversation_id] = map[p.conversation_id] || []).push({
    id: p.id, name: p.name, username: p.username, avatar: p.avatar, status: p.status, last_seen: p.last_seen, public_key: p.public_key,
  });
  const pinIds = convs.map((c) => c.pinned_message_id).filter(Boolean);
  const pinMap = {};
  if (pinIds.length) {
    const [pm] = await pool.query('SELECT m.id, m.content, m.type, u.name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id IN (?)', [pinIds]);
    for (const m of pm) pinMap[m.id] = { id: m.id, content: m.content, type: m.type, sender_name: m.sender_name };
  }
  return convs.map((c) => ({
    ...c,
    pinned_message: c.pinned_message_id ? pinMap[c.pinned_message_id] || null : null,
    pinned: !!c.pinned,
    archived: !!c.archived,
    muted: !!(c.muted_until && new Date(c.muted_until) > new Date()),
    unread_count: Number(c.unread_count) || 0,
    participants: map[c.id] || [],
  }));
}

// GET /api/conversations
router.get('/', async (req, res) => {
  try {
    res.json(await loadConversations(req.user.id));
  } catch (err) {
    console.error('conversations list:', err.message);
    res.status(500).json({ message: 'Could not load conversations' });
  }
});

// POST /api/conversations  { participantIds: [], type: 'direct'|'group', name? }
router.post('/', async (req, res) => {
  try {
    const type = req.body.type === 'group' ? 'group' : 'direct';
    const ids = [...new Set((req.body.participantIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== req.user.id))];
    if (!ids.length) return res.status(400).json({ message: 'At least one other participant is required' });

    const [found] = await pool.query('SELECT id FROM users WHERE id IN (?) AND banned = 0', [ids]);
    if (found.length !== ids.length) return res.status(400).json({ message: 'One or more users do not exist' });

    if (type === 'direct') {
      if (ids.length !== 1) return res.status(400).json({ message: 'A direct conversation has exactly one other participant' });
      if (await isBlockedBetween(req.user.id, ids[0])) return res.status(403).json({ message: 'You cannot message this user' });
      {
        const [pu] = await pool.query('SELECT who_can_message FROM users WHERE id = ?', [ids[0]]);
        const rule = pu[0] && pu[0].who_can_message;
        let denied = rule === 'nobody';
        if (rule === 'followed') denied = !(await pool.query('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?', [ids[0], req.user.id]))[0].length;
        if (denied) return res.status(403).json({ message: 'This user does not accept messages from you' });
      }
      // Reuse the existing 1:1 conversation
      const [existing] = await pool.query(
        `SELECT c.id FROM conversations c
         JOIN conversation_participants a ON a.conversation_id = c.id AND a.user_id = ?
         JOIN conversation_participants b ON b.conversation_id = c.id AND b.user_id = ?
         WHERE c.type = 'direct' AND c.group_id IS NULL LIMIT 1`,
        [req.user.id, ids[0]]
      );
      if (existing.length) {
        const [conv] = await loadConversations(req.user.id, existing[0].id);
        return res.json(conv);
      }
    } else if (!String(req.body.name || '').trim()) {
      return res.status(400).json({ message: 'Group name is required' });
    }

    const conn = await pool.getConnection();
    let convId;
    try {
      await conn.beginTransaction();
      const [r] = await conn.query('INSERT INTO conversations (name, type, created_by) VALUES (?, ?, ?)', [
        type === 'group' ? String(req.body.name).trim().slice(0, 150) : null, type, req.user.id,
      ]);
      convId = r.insertId;
      await conn.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ?', [
        [req.user.id, ...ids].map((uid) => [convId, uid]),
      ]);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    const [conv] = await loadConversations(req.user.id, convId);
    // Let the other participants' chat lists update live
    for (const uid of ids) {
      const [theirs] = await loadConversations(uid, convId);
      rt.emitToUser(uid, 'conversation_updated', theirs);
    }
    res.status(201).json(conv);
  } catch (err) {
    console.error('create conversation:', err.message);
    res.status(500).json({ message: 'Could not create conversation' });
  }
});

// GET /api/conversations/:id
router.get('/:id', async (req, res) => {
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    const [conv] = await loadConversations(req.user.id, req.params.id);
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Could not load conversation' });
  }
});

// GET /api/conversations/:id/messages?limit=50&offset=0
// offset counts from the newest message; the page is returned oldest -> newest.
router.get('/:id/messages', async (req, res) => {
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    const limit = toInt(req.query.limit, 50, 1, 100);
    const offset = toInt(req.query.offset, 0, 0, 1000000);
    const before = toInt(req.query.before, 0, 0, 2147483647); // cursor: id of the oldest message already loaded
    const [rows] = await pool.query(
      `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND ${visible('m')}${before ? ' AND m.id < ?' : ''} ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
      [req.params.id, req.user.id, ...(before ? [before] : []), limit + 1, offset]
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    res.json({ messages: await attachReactions(page, req.user.id), hasMore });
  } catch (err) {
    console.error('messages list:', err.message);
    res.status(500).json({ message: 'Could not load messages' });
  }
});

// PUT /api/conversations/:id/archive  (toggle, per user)
router.put('/:id/archive', async (req, res) => {
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    await pool.query('UPDATE conversation_participants SET archived = IF(archived = 1, 0, 1) WHERE conversation_id = ? AND user_id = ?', [req.params.id, req.user.id]);
    const [conv] = await loadConversations(req.user.id, req.params.id);
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Could not update conversation' });
  }
});

// DELETE /api/conversations/:id - remove this conversation from the current user's inbox only
router.delete('/:id', async (req, res) => {
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    // Remove only the requesting user's membership; messages and other participants remain intact.
    const [result] = await pool.query(
      'DELETE FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Conversation not found' });
    rt.emitToUser(req.user.id, 'conversation_removed', { conversation_id: Number(req.params.id) });
    res.json({ removed: true });
  } catch (err) {
    console.error('delete conversation:', err.message);
    res.status(500).json({ message: 'Could not delete conversation' });
  }
});

// PUT /api/conversations/:id/pin-message { message_id | null }  - one pinned message per conversation, visible to everyone
router.put('/:id/pin-message', async (req, res) => {
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    const mid = Number(req.body.message_id) || null;
    if (mid) {
      const [m] = await pool.query('SELECT id FROM messages WHERE id = ? AND conversation_id = ?', [mid, req.params.id]);
      if (!m.length) return res.status(404).json({ message: 'Message not found' });
    }
    await pool.query('UPDATE conversations SET pinned_message_id = ? WHERE id = ?', [mid, req.params.id]);
    let pinned = null;
    if (mid) {
      const [rows] = await pool.query(`${MESSAGE_SELECT} WHERE m.id = ?`, [mid]);
      pinned = rows[0] ? { id: rows[0].id, content: rows[0].content, type: rows[0].type, sender_name: rows[0].sender_name } : null;
    }
    const payload = { conversation_id: Number(req.params.id), pinned_message: pinned };
    for (const uid of await participantIds(req.params.id)) rt.emitToUser(uid, 'conversation_pinned_message', payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ message: 'Could not pin message' });
  }
});

// PUT /api/conversations/:id/pin  (per user)
router.put('/:id/pin', async (req, res) => {
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    await pool.query(
      'UPDATE conversation_participants SET pinned = IF(pinned = 1, 0, 1) WHERE conversation_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    const [conv] = await loadConversations(req.user.id, req.params.id);
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Could not update conversation' });
  }
});

// GET /api/conversations/:id/search?q=
// (end-to-end encrypted messages can't be searched on the server - the client searches those locally)
router.get('/:id/search', async (req, res) => {
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) return res.json({ messages: [] });
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    const [rows] = await pool.query(
      `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.type = 'text' AND m.content LIKE ? AND m.content NOT LIKE 'e2ee:%'
         AND ${visible('m')} ORDER BY m.id DESC LIMIT 50`,
      [req.params.id, like, req.user.id]
    );
    res.json({ messages: await attachReactions(rows, req.user.id) });
  } catch (err) {
    res.status(500).json({ message: 'Search failed' });
  }
});

// PUT /api/conversations/:id/mute  { hours: number | null }  (-1 = until turned off, null/0 = unmute)
router.put('/:id/mute', async (req, res) => {
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    const h = Number(req.body.hours);
    let sql = 'NULL'; const p = [];
    if (h === -1) sql = "'2099-01-01 00:00:00'";
    else if (h > 0) { sql = 'DATE_ADD(NOW(), INTERVAL ? HOUR)'; p.push(Math.min(h, 24 * 365)); }
    await pool.query(`UPDATE conversation_participants SET muted_until = ${sql} WHERE conversation_id = ? AND user_id = ?`, [...p, req.params.id, req.user.id]);
    const [conv] = await loadConversations(req.user.id, req.params.id);
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Could not update conversation' });
  }
});

// PUT /api/conversations/:id/disappearing  { seconds: number | null }  - applies to new messages for everyone
router.put('/:id/disappearing', async (req, res) => {
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    const allowed = [0, 3600, 86400, 604800, 7776000];
    const s = Number(req.body.seconds) || 0;
    if (!allowed.includes(s)) return res.status(400).json({ message: 'Invalid duration' });
    await pool.query('UPDATE conversations SET disappear_after = ? WHERE id = ?', [s || null, req.params.id]);
    for (const uid of await participantIds(req.params.id)) {
      const [c] = await loadConversations(uid, req.params.id);
      if (c) rt.emitToUser(uid, 'conversation_updated', c);
    }
    const [conv] = await loadConversations(req.user.id, req.params.id);
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Could not update conversation' });
  }
});

module.exports = router;
module.exports.loadConversations = loadConversations;