const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const pool = require('../db');
const upload = require('../middleware/upload');
const rt = require('../services/realtime');
const { pushToUsers } = require('../services/push');
const { isBlockedBetween } = require('../utils/blocks');
const { isParticipant, participantIds, MESSAGE_SELECT, visible, attachReactions, getMessage } = require('../services/chat');
const { toInt } = require('../utils/format');
const { getPreview } = require('../services/linkpreview');
const { isEncrypted, requiresEncryption } = require('../utils/e2ee');

const router = express.Router();

const messageTypeFor = (mime = '', name = '') => {
  const m = mime.toLowerCase();
  const ext = path.extname(name).toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/') || ['.m4a', '.aac', '.caf', '.3gp', '.mp3', '.wav', '.ogg'].includes(ext)) return 'voice';
  return 'file';
};

const preview = (msg) => (msg.type === 'text' ? (isEncrypted(msg.content) ? '🔒 New message' : msg.content) : msg.type === 'image' ? '📷 Photo' : msg.type === 'voice' ? '🎤 Voice message' : msg.type === 'poll' ? '📊 Poll' : '📎 File');

// Saves the message, fans it out over sockets and sends push to people who are not connected
async function deliver(message, sender) {
  const ids = await participantIds(message.conversation_id);
  rt.emitToConversation(message.conversation_id, 'message_received', message);
  // Chat-list updates for every participant (even those not inside the conversation screen)
  rt.emitToUsers(ids, 'conversation_message', { conversation_id: message.conversation_id, message });
  const others = ids.filter((id) => id !== sender.id);
  // Somebody else is connected: the message has reached a device -> "delivered"
  if (others.some((id) => rt.isOnline(id))) {
    try {
      await pool.query("UPDATE messages SET status = 'delivered' WHERE id = ? AND status = 'sent'", [message.id]);
      rt.emitToConversation(message.conversation_id, 'message_delivered', { messageId: message.id, conversationId: message.conversation_id });
    } catch (e) { console.warn('delivered mark:', e.message); }
  }
  let offline = await pushAllowedIds(others.filter((id) => !rt.isOnline(id)));
  if (offline.length) {
    // people who muted this conversation get no push
    const [muted] = await pool.query(
      'SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id IN (?) AND muted_until IS NOT NULL AND muted_until > NOW()',
      [message.conversation_id, offline]
    );
    const mutedIds = new Set(muted.map((r) => r.user_id));
    offline = offline.filter((id) => !mutedIds.has(id));
  }
  if (offline.length) {
    pushToUsers(offline, {
      title: sender.name,
      body: preview(message),
      data: { type: 'message', conversationId: message.conversation_id },
    }).catch(() => {});
  }
}

const { pushAllowed } = require('../services/prefs');
const readReceiptsOn = async (userId) => { const [r] = await pool.query('SELECT read_receipts FROM users WHERE id = ?', [userId]); return !r[0] || r[0].read_receipts !== 0; };
const pushAllowedIds = (ids) => pushAllowed(ids, 'message');

// direct conversations: no messages when either side blocked the other, or the receiver limited who can write to them
async function requiresEncryptedDirect(conversationId, content) {
  const [rows] = await pool.query('SELECT type FROM conversations WHERE id = ?', [conversationId]);
  return requiresEncryption(rows[0]?.type, content);
}

async function blockedInDirect(conversationId, userId) {
  const [c] = await pool.query("SELECT type FROM conversations WHERE id = ?", [conversationId]);
  if (!c[0] || c[0].type !== 'direct') return false;
  const ids = await participantIds(conversationId);
  const other = ids.find((i) => i !== userId);
  if (!other) return false;
  if (await isBlockedBetween(userId, other)) return true;
  const [u] = await pool.query('SELECT who_can_message FROM users WHERE id = ?', [other]);
  const rule = u[0] && u[0].who_can_message;
  if (rule === 'nobody') return true;
  if (rule === 'followed') {
    // only people the receiver follows may write
    const [f] = await pool.query('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?', [other, userId]);
    return f.length === 0;
  }
  return false;
}

// Disappearing messages: stamp the expiry when the conversation has a timer
async function applyExpiry(messageId, conversationId) {
  const [c] = await pool.query('SELECT disappear_after FROM conversations WHERE id = ?', [conversationId]);
  if (c[0] && c[0].disappear_after) {
    await pool.query('UPDATE messages SET expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?', [c[0].disappear_after, messageId]);
  }
}

// reply_to must be a message of the same conversation
async function validReplyTo(replyTo, conversationId) {
  const id = Number(replyTo);
  if (!id) return null;
  const [r] = await pool.query('SELECT id FROM messages WHERE id = ? AND conversation_id = ?', [id, conversationId]);
  return r.length ? id : null;
}

const loadSender = async (id) => {
  const [rows] = await pool.query('SELECT id, name FROM users WHERE id = ?', [id]);
  return rows[0];
};

const cleanClientId = (v) => { const s = String(v || '').trim().slice(0, 64); return /^[A-Za-z0-9_.-]+$/.test(s) ? s : null; };
async function existingByClient(userId, clientId) {
  const [rows] = await pool.query('SELECT id FROM messages WHERE sender_id = ? AND client_id = ?', [userId, clientId]);
  return rows.length ? getMessage(rows[0].id, userId) : null;
}

// POST /api/messages  { conversation_id, content, reply_to?, client_id? }
router.post('/', async (req, res) => {
  try {
    const conversationId = Number(req.body.conversation_id);
    const content = String(req.body.content || '').trim();
    if (!conversationId || !content) return res.status(400).json({ message: 'conversation_id and content are required' });
    if (content.length > 5000) return res.status(400).json({ message: 'Message is too long' });
    if (!(await isParticipant(conversationId, req.user.id))) return res.status(403).json({ message: 'Not a participant of this conversation' });
    if (await blockedInDirect(conversationId, req.user.id)) return res.status(403).json({ message: 'You cannot message this user' });
    if (await requiresEncryptedDirect(conversationId, content)) return res.status(409).json({ message: 'Direct text messages require end-to-end encryption. Configure keys on both accounts first.' });

    // retried sends (offline queue) carry a client_id: the same message is never stored twice
    const clientId = cleanClientId(req.body.client_id);
    if (clientId) {
      const dup = await existingByClient(req.user.id, clientId);
      if (dup) { await fs.unlink(req.file.path).catch(() => {}); return res.status(200).json(dup); }
    }
    let r;
    try {
      [r] = await pool.query(
        "INSERT INTO messages (conversation_id, sender_id, content, type, status, reply_to, client_id) VALUES (?, ?, ?, 'text', 'sent', ?, ?)",
        [conversationId, req.user.id, content, await validReplyTo(req.body.reply_to, conversationId), clientId]
      );
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY' && clientId) return res.status(200).json(await existingByClient(req.user.id, clientId));
      throw e;
    }
    await applyExpiry(r.insertId, conversationId);
    const message = await getMessage(r.insertId, req.user.id);
    deliver(message, await loadSender(req.user.id)).catch((e) => console.warn('deliver:', e.message));
    res.status(201).json(message);
  } catch (err) {
    console.error('send message:', err.message);
    res.status(500).json({ message: 'Could not send message' });
  }
});

// POST /api/messages/upload  multipart: conversation_id, file
router.post('/upload', async (req, res, next) => {
  try {
    const conversationId = Number(req.get('x-conversation-id'));
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return res.status(400).json({ message: 'x-conversation-id header is required' });
    if (!(await isParticipant(conversationId, req.user.id))) return res.status(403).json({ message: 'Not a participant of this conversation' });
    req.authorizedConversationId = conversationId;
    upload.chat.single('file')(req, res, (err) => err ? next(err) : next());
  } catch (err) { next(err); }
}, async (req, res) => {
  try {
    const conversationId = Number(req.body.conversation_id);
    if (!conversationId || conversationId !== req.authorizedConversationId || !req.file) {
      if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ message: 'conversation_id and file are required and must match the authorized conversation' });
    }

    const type = messageTypeFor(req.file.mimetype, req.file.originalname);
    const url = `/uploads/chat/${req.file.filename}`;
    const clientId = cleanClientId(req.body.client_id);
    if (clientId) {
      const dup = await existingByClient(req.user.id, clientId);
      if (dup) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(200).json(dup);
      }
    }
    let r;
    try {
      [r] = await pool.query(
        `INSERT INTO messages (conversation_id, sender_id, content, type, file_url, file_name, file_size, voice_duration, voice_waveform, status, client_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?)`,
        [conversationId, req.user.id, '', type, url, req.file.originalname, req.file.size, req.body.voice_duration || null,
          type === 'voice' && /^[0-9]{10,64}$/.test(String(req.body.voice_waveform || '')) ? String(req.body.voice_waveform) : null, clientId]
      );
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY' && clientId) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(200).json(await existingByClient(req.user.id, clientId));
      }
      throw e;
    }
    if (type === 'image' && String(req.body.view_once) === '1') await pool.query('UPDATE messages SET view_once = 1 WHERE id = ?', [r.insertId]);
    const replyTo = await validReplyTo(req.body.reply_to, conversationId);
    if (replyTo) await pool.query('UPDATE messages SET reply_to = ? WHERE id = ?', [replyTo, r.insertId]);
    await applyExpiry(r.insertId, conversationId);
    const message = await getMessage(r.insertId, req.user.id);
    deliver(message, await loadSender(req.user.id)).catch((e) => console.warn('deliver:', e.message));
    res.status(201).json(message);
  } catch (err) {
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    console.error('upload message:', err.message);
    res.status(500).json({ message: 'Could not send file' });
  }
});

// Loads a message the caller may access (is a participant of its conversation)
async function accessibleMessage(messageId, userId) {
  const [rows] = await pool.query('SELECT id, conversation_id, sender_id, type, status FROM messages WHERE id = ?', [messageId]);
  const m = rows[0];
  if (!m) return { error: 404 };
  if (!(await isParticipant(m.conversation_id, userId))) return { error: 403 };
  return { message: m };
}

const fail = (res, e) => res.status(e === 404 ? 404 : 403).json({ message: e === 404 ? 'Message not found' : 'Forbidden' });

router.put('/:id/delivered', async (req, res) => {
  try {
    const { message, error } = await accessibleMessage(req.params.id, req.user.id);
    if (error) return fail(res, error);
    if (message.sender_id !== req.user.id && message.status === 'sent') {
      await pool.query("UPDATE messages SET status = 'delivered' WHERE id = ? AND status = 'sent'", [message.id]);
      rt.emitToConversation(message.conversation_id, 'message_delivered', { messageId: message.id, conversationId: message.conversation_id, userId: req.user.id });
    }
    res.json({ message: 'ok' });
  } catch (err) {
    res.status(500).json({ message: 'Could not update message' });
  }
});

router.put('/:id/read', async (req, res) => {
  try {
    const { message, error } = await accessibleMessage(req.params.id, req.user.id);
    if (error) return fail(res, error);
    if (message.sender_id !== req.user.id) {
      if (await readReceiptsOn(req.user.id)) await pool.query('INSERT IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)', [message.id, req.user.id]);
    }
    if (message.sender_id !== req.user.id && message.status !== 'read') {
      await pool.query("UPDATE messages SET status = 'read', read_at = NOW() WHERE id = ?", [message.id]);
      if (await readReceiptsOn(req.user.id)) rt.emitToConversation(message.conversation_id, 'message_read', { messageId: message.id, conversationId: message.conversation_id, userId: req.user.id });
    }
    res.json({ message: 'ok' });
  } catch (err) {
    res.status(500).json({ message: 'Could not update message' });
  }
});

// PUT /api/messages/conversation/:conversationId/read-all
router.put('/conversation/:conversationId/read-all', async (req, res) => {
  try {
    const convId = Number(req.params.conversationId);
    if (!(await isParticipant(convId, req.user.id))) return res.status(403).json({ message: 'Forbidden' });
    // groups: remember who read what ("seen by" list)
    const [ct] = await pool.query('SELECT type FROM conversations WHERE id = ?', [convId]);
    if (ct[0] && ct[0].type === 'group' && (await readReceiptsOn(req.user.id))) {
      await pool.query(
        `INSERT IGNORE INTO message_reads (message_id, user_id)
         SELECT m.id, ? FROM messages m LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
         WHERE m.conversation_id = ? AND m.sender_id <> ? AND r.message_id IS NULL ORDER BY m.id DESC LIMIT 200`,
        [req.user.id, req.user.id, convId, req.user.id]
      );
    }
    const [r] = await pool.query(
      "UPDATE messages SET status = 'read', read_at = NOW() WHERE conversation_id = ? AND sender_id <> ? AND status <> 'read'",
      [convId, req.user.id]
    );
    if (r.affectedRows && (await readReceiptsOn(req.user.id))) rt.emitToConversation(convId, 'messages_read', { conversationId: convId, userId: req.user.id });
    rt.emitToUser(req.user.id, 'conversation_read', { conversationId: convId });
    res.json({ updated: r.affectedRows });
  } catch (err) {
    res.status(500).json({ message: 'Could not mark messages as read' });
  }
});

// ---- New: link preview, global search, stars, "seen by", polls ----
const likeOf = (q) => '%' + q.replace(/[\\%_]/g, '\\$&') + '%';

// GET /api/messages/link-preview?url=
router.get('/link-preview', async (req, res) => {
  const url = String(req.query.url || '').slice(0, 2000);
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ message: 'A valid http(s) url is required' });
  res.json({ preview: await getPreview(url) });
});

// GET /api/messages/search?q=   - plain-text messages of all my conversations (end-to-end encrypted text cannot be searched on the server)
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) return res.json({ results: [] });
    const [rows] = await pool.query(
      `SELECT m.id, m.conversation_id, m.content, m.created_at, m.sender_id, u.name AS sender_name,
              c.type AS conv_type, c.name AS conv_name, c.avatar AS conv_avatar,
              (SELECT o.name FROM conversation_participants p2 JOIN users o ON o.id = p2.user_id WHERE p2.conversation_id = c.id AND p2.user_id <> ? LIMIT 1) AS other_name,
              (SELECT o.avatar FROM conversation_participants p2 JOIN users o ON o.id = p2.user_id WHERE p2.conversation_id = c.id AND p2.user_id <> ? LIMIT 1) AS other_avatar
       FROM messages m
       JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = ?
       JOIN conversations c ON c.id = m.conversation_id
       JOIN users u ON u.id = m.sender_id
       WHERE m.type = 'text' AND m.content LIKE ? AND m.content NOT LIKE 'e2ee:%' AND ${visible('m')}
       ORDER BY m.id DESC LIMIT 40`,
      [req.user.id, req.user.id, req.user.id, likeOf(q), req.user.id]
    );
    res.json({
      results: rows.map((r) => ({
        id: r.id, conversation_id: r.conversation_id, content: r.content, created_at: r.created_at,
        sender_id: r.sender_id, sender_name: r.sender_name,
        conversation_name: r.conv_type === 'group' ? r.conv_name : r.other_name,
        conversation_avatar: r.conv_type === 'group' ? r.conv_avatar : r.other_avatar,
      })),
    });
  } catch (err) {
    console.error('message search:', err.message);
    res.status(500).json({ message: 'Search failed' });
  }
});

// GET /api/messages/starred
router.get('/starred', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.id, m.conversation_id, m.content, m.type, m.file_url, m.voice_duration, m.created_at, m.sender_id,
              u.name AS sender_name, u.avatar AS sender_avatar, c.type AS conv_type, c.name AS conv_name,
              (SELECT o.name FROM conversation_participants p2 JOIN users o ON o.id = p2.user_id WHERE p2.conversation_id = c.id AND p2.user_id <> ? LIMIT 1) AS other_name,
              s.created_at AS starred_at
       FROM message_stars s
       JOIN messages m ON m.id = s.message_id
       JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = s.user_id
       JOIN conversations c ON c.id = m.conversation_id
       JOIN users u ON u.id = m.sender_id
       WHERE s.user_id = ? AND ${visible('m')}
       ORDER BY s.created_at DESC LIMIT 200`,
      [req.user.id, req.user.id, req.user.id]
    );
    res.json({
      messages: rows.map((r) => ({
        id: r.id, conversation_id: r.conversation_id, content: r.content, type: r.type, file_url: r.file_url,
        voice_duration: r.voice_duration, created_at: r.created_at, starred_at: r.starred_at,
        sender_id: r.sender_id, sender_name: r.sender_name, sender_avatar: r.sender_avatar,
        conversation_name: r.conv_type === 'group' ? r.conv_name : r.other_name,
      })),
    });
  } catch (err) {
    console.error('starred:', err.message);
    res.status(500).json({ message: 'Could not load starred messages' });
  }
});

router.put('/:id(\\d+)/star', async (req, res) => {
  try {
    const { message, error } = await accessibleMessage(req.params.id, req.user.id);
    if (error) return fail(res, error);
    await pool.query('INSERT IGNORE INTO message_stars (user_id, message_id) VALUES (?, ?)', [req.user.id, message.id]);
    res.json({ starred: true });
  } catch (err) { res.status(500).json({ message: 'Could not star message' }); }
});

router.delete('/:id(\\d+)/star', async (req, res) => {
  try {
    await pool.query('DELETE FROM message_stars WHERE user_id = ? AND message_id = ?', [req.user.id, req.params.id]);
    res.json({ starred: false });
  } catch (err) { res.status(500).json({ message: 'Could not remove star' }); }
});

// GET /api/messages/:id/readers - who has read my message in a group
router.get('/:id(\\d+)/readers', async (req, res) => {
  try {
    const { message, error } = await accessibleMessage(req.params.id, req.user.id);
    if (error) return fail(res, error);
    if (message.sender_id !== req.user.id) return res.status(403).json({ message: 'Only the sender can see who read a message' });
    const [rows] = await pool.query(
      'SELECT u.id, u.name, u.username, u.avatar, r.read_at FROM message_reads r JOIN users u ON u.id = r.user_id WHERE r.message_id = ? AND r.user_id <> ? ORDER BY r.read_at',
      [message.id, req.user.id]
    );
    const ids = await participantIds(message.conversation_id);
    res.json({ readers: rows, total: Math.max(0, ids.length - 1) });
  } catch (err) { res.status(500).json({ message: 'Could not load readers' }); }
});

// POST /api/messages/poll  { conversation_id, question, options: [2..6 strings] }
router.post('/poll', async (req, res) => {
  try {
    const conversationId = Number(req.body.conversation_id);
    const question = String(req.body.question || '').trim().slice(0, 200);
    const options = (Array.isArray(req.body.options) ? req.body.options : []).map((o) => String(o || '').trim().slice(0, 120)).filter(Boolean).slice(0, 6);
    if (!conversationId || !question || options.length < 2) return res.status(400).json({ message: 'A question and at least 2 options are required' });
    if (!(await isParticipant(conversationId, req.user.id))) return res.status(403).json({ message: 'Not a participant of this conversation' });
    if (await blockedInDirect(conversationId, req.user.id)) return res.status(403).json({ message: 'You cannot message this user' });
    if (await requiresEncryptedDirect(conversationId, question)) return res.status(409).json({ message: 'Polls are disabled in direct conversations until structured-message encryption is supported.' });
    const [r] = await pool.query("INSERT INTO messages (conversation_id, sender_id, content, type, status) VALUES (?, ?, ?, 'poll', 'sent')", [conversationId, req.user.id, question]);
    for (let i = 0; i < options.length; i++) await pool.query('INSERT INTO chat_poll_options (message_id, text, position) VALUES (?, ?, ?)', [r.insertId, options[i], i]);
    await applyExpiry(r.insertId, conversationId);
    const message = await getMessage(r.insertId, req.user.id);
    deliver(message, await loadSender(req.user.id)).catch((e) => console.warn('deliver:', e.message));
    res.status(201).json(message);
  } catch (err) {
    console.error('poll:', err.message);
    res.status(500).json({ message: 'Could not create poll' });
  }
});

// POST /api/messages/:id/vote  { option_id }  - voting for the same option again removes the vote
router.post('/:id(\\d+)/vote', async (req, res) => {
  try {
    const { message, error } = await accessibleMessage(req.params.id, req.user.id);
    if (error) return fail(res, error);
    if (message.type !== 'poll') return res.status(400).json({ message: 'Not a poll' });
    const optionId = Number(req.body.option_id);
    const [o] = await pool.query('SELECT id FROM chat_poll_options WHERE id = ? AND message_id = ?', [optionId, message.id]);
    if (!o.length) return res.status(400).json({ message: 'Invalid option' });
    const [cur] = await pool.query('SELECT option_id FROM chat_poll_votes WHERE message_id = ? AND user_id = ?', [message.id, req.user.id]);
    if (cur.length && cur[0].option_id === optionId) await pool.query('DELETE FROM chat_poll_votes WHERE message_id = ? AND user_id = ?', [message.id, req.user.id]);
    else await pool.query('INSERT INTO chat_poll_votes (option_id, message_id, user_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE option_id = VALUES(option_id)', [optionId, message.id, req.user.id]);
    const { pollsFor } = require('../services/chat');
    const mine = (await pollsFor([message.id], req.user.id))[message.id];
    const shared = (await pollsFor([message.id], 0))[message.id];
    rt.emitToConversation(message.conversation_id, 'poll_updated', { message_id: message.id, conversation_id: message.conversation_id, poll: shared, by: req.user.id });
    res.json({ poll: mine });
  } catch (err) {
    console.error('vote:', err.message);
    res.status(500).json({ message: 'Could not vote' });
  }
});

// Alias kept for older clients: same as GET /api/conversations/:id/messages
router.get('/:conversationId(\\d+)', async (req, res) => {
  try {
    if (!(await isParticipant(req.params.conversationId, req.user.id))) return res.status(403).json({ message: 'Forbidden' });
    const limit = toInt(req.query.limit, 50, 1, 100);
    const offset = toInt(req.query.offset, 0, 0, 1000000);
    const [rows] = await pool.query(
      `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND ${visible('m')} ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
      [req.params.conversationId, req.user.id, limit + 1, offset]
    );
    res.json({ messages: await attachReactions(rows.slice(0, limit).reverse(), req.user.id), hasMore: rows.length > limit });
  } catch (err) {
    res.status(500).json({ message: 'Could not load messages' });
  }
});

// --- Reactions ---
router.get('/:messageId/reactions', async (req, res) => {
  try {
    const { message, error } = await accessibleMessage(req.params.messageId, req.user.id);
    if (error) return fail(res, error);
    const { reactionsFor } = require('../services/chat');
    const map = await reactionsFor([message.id], req.user.id);
    res.json(map[message.id] || []);
  } catch (err) {
    res.status(500).json({ message: 'Could not load reactions' });
  }
});

router.post('/:messageId/reactions', async (req, res) => {
  try {
    const emoji = String(req.body.emoji || '').trim();
    if (!emoji || emoji.length > 16) return res.status(400).json({ message: 'emoji required' });
    const { message, error } = await accessibleMessage(req.params.messageId, req.user.id);
    if (error) return fail(res, error);
    await pool.query('INSERT IGNORE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [message.id, req.user.id, emoji]);
    const [u] = await pool.query('SELECT name, avatar FROM users WHERE id = ?', [req.user.id]);
    rt.emitToConversation(message.conversation_id, 'reaction_added', {
      message_id: message.id,
      conversation_id: message.conversation_id,
      reaction: { emoji, user_id: req.user.id, user_name: u[0].name, user_avatar: u[0].avatar },
    });
    res.status(201).json({ message: 'Reaction added' });
  } catch (err) {
    res.status(500).json({ message: 'Could not add reaction' });
  }
});

router.delete('/:messageId/reactions/:emoji', async (req, res) => {
  try {
    const { message, error } = await accessibleMessage(req.params.messageId, req.user.id);
    if (error) return fail(res, error);
    const emoji = req.params.emoji;
    const [r] = await pool.query('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [message.id, req.user.id, emoji]);
    if (r.affectedRows) {
      rt.emitToConversation(message.conversation_id, 'reaction_removed', {
        message_id: message.id, conversation_id: message.conversation_id, user_id: req.user.id, emoji,
      });
    }
    res.json({ message: 'Reaction removed' });
  } catch (err) {
    res.status(500).json({ message: 'Could not remove reaction' });
  }
});

// --- Edit / delete (own messages only) ---
router.put('/:id', async (req, res) => {
  try {
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ message: 'content required' });
    if (content.length > 5000) return res.status(400).json({ message: 'Message is too long' });
    const { message, error } = await accessibleMessage(req.params.id, req.user.id);
    if (error) return fail(res, error);
    if (message.sender_id !== req.user.id) return res.status(403).json({ message: 'You can only edit your own messages' });
    if (message.type !== 'text') return res.status(400).json({ message: 'Only text messages can be edited' });
    if (await requiresEncryptedDirect(message.conversation_id, content)) return res.status(409).json({ message: 'Direct text messages require end-to-end encryption.' });
    await pool.query('UPDATE messages SET content = ?, edited_at = NOW() WHERE id = ?', [content, message.id]);
    const updated = await getMessage(message.id, req.user.id);
    rt.emitToConversation(message.conversation_id, 'message_edited', { message_id: message.id, conversation_id: message.conversation_id, message: updated });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: 'Could not edit message' });
  }
});

// POST /api/messages/:id/open - recipient opens a view-once photo (works once)
router.post('/:id/open', async (req, res) => {
  try {
    const { message, error } = await accessibleMessage(req.params.id, req.user.id);
    if (error) return fail(res, error);
    const [rows] = await pool.query('SELECT sender_id, view_once, opened_at, file_url FROM messages WHERE id = ?', [message.id]);
    const m = rows[0];
    if (!m || !m.view_once) return res.status(400).json({ message: 'Not a view-once message' });
    if (m.sender_id === req.user.id) return res.status(403).json({ message: 'You cannot open your own view-once photo' });
    if (m.opened_at || !m.file_url) return res.status(410).json({ message: 'Already opened' });
    await pool.query('UPDATE messages SET opened_at = NOW() WHERE id = ? AND opened_at IS NULL', [message.id]);
    rt.emitToConversation(message.conversation_id, 'message_edited', await getMessage(message.id, req.user.id));
    res.json({ file_url: m.file_url });
  } catch (err) {
    res.status(500).json({ message: 'Could not open' });
  }
});

// --- scheduled messages ---
// POST /api/messages/schedule { conversation_id, content, send_at (ISO) }
router.post('/schedule', async (req, res) => {
  try {
    const conversationId = Number(req.body.conversation_id);
    const content = String(req.body.content || '').trim();
    const when = new Date(req.body.send_at);
    if (!conversationId || !content || isNaN(when.getTime())) return res.status(400).json({ message: 'conversation_id, content and send_at are required' });
    if (when.getTime() < Date.now() + 20 * 1000) return res.status(400).json({ message: 'Choose a time in the future' });
    if (when.getTime() > Date.now() + 365 * 86400 * 1000) return res.status(400).json({ message: 'Too far in the future' });
    if (!(await isParticipant(conversationId, req.user.id))) return res.status(403).json({ message: 'Not a participant of this conversation' });
    if (await requiresEncryptedDirect(conversationId, content)) return res.status(409).json({ message: 'Direct scheduled text messages require end-to-end encryption.' });
    const [[cnt]] = await pool.query('SELECT COUNT(*) AS c FROM scheduled_messages WHERE user_id = ?', [req.user.id]);
    if (cnt.c >= 50) return res.status(400).json({ message: 'Too many scheduled messages' });
    const [r] = await pool.query('INSERT INTO scheduled_messages (user_id, conversation_id, content, send_at) VALUES (?, ?, ?, ?)', [req.user.id, conversationId, content, when]);
    res.status(201).json({ id: r.insertId, conversation_id: conversationId, content, send_at: when.toISOString() });
  } catch (err) {
    res.status(500).json({ message: 'Could not schedule message' });
  }
});

router.get('/scheduled', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, conversation_id, content, send_at FROM scheduled_messages WHERE user_id = ? AND conversation_id = ? ORDER BY send_at', [req.user.id, Number(req.query.conversation_id) || 0]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Could not load scheduled messages' });
  }
});

router.delete('/scheduled/:id', async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM scheduled_messages WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Removed' });
  } catch (err) {
    res.status(500).json({ message: 'Could not remove' });
  }
});

// Sends every due scheduled message (called every 30s by services/cleanup.js)
async function processScheduled() {
  const [due] = await pool.query('SELECT * FROM scheduled_messages WHERE send_at <= NOW() ORDER BY send_at LIMIT 50');
  for (const s of due) {
    const [del] = await pool.query('DELETE FROM scheduled_messages WHERE id = ?', [s.id]);
    if (!del.affectedRows) continue; // another instance took it
    try {
      if (!(await isParticipant(s.conversation_id, s.user_id)) || (await blockedInDirect(s.conversation_id, s.user_id))) continue;
      if (await requiresEncryptedDirect(s.conversation_id, s.content)) { console.warn('scheduled send: dropped plaintext direct message', s.id); continue; }
      const [r] = await pool.query("INSERT INTO messages (conversation_id, sender_id, content, type, status) VALUES (?, ?, ?, 'text', 'sent')", [s.conversation_id, s.user_id, s.content]);
      await applyExpiry(r.insertId, s.conversation_id);
      const sender = await loadSender(s.user_id);
      const message = await getMessage(r.insertId, s.user_id);
      await deliver(message, sender);
    } catch (e) {
      console.warn('scheduled send:', e.message);
    }
  }
}

// DELETE /api/messages/:id?scope=me|all
//  me  - hides the message for the caller only (any message in a conversation they belong to)
//  all - removes it for everybody (own messages only)
router.delete('/:id', async (req, res) => {
  try {
    const { message, error } = await accessibleMessage(req.params.id, req.user.id);
    if (error) return fail(res, error);
    const scope = req.query.scope === 'me' ? 'me' : 'all';
    const payload = { message_id: message.id, conversation_id: message.conversation_id };
    if (scope === 'me') {
      await pool.query('INSERT IGNORE INTO message_deletions (message_id, user_id) VALUES (?, ?)', [message.id, req.user.id]);
      rt.emitToUser(req.user.id, 'message_deleted', payload);
      return res.json({ message: 'Message deleted for you' });
    }
    if (message.sender_id !== req.user.id) return res.status(403).json({ message: 'You can only delete your own messages for everyone' });
    await pool.query('DELETE FROM messages WHERE id = ?', [message.id]);
    rt.emitToConversation(message.conversation_id, 'message_deleted', payload);
    res.json({ message: 'Message deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Could not delete message' });
  }
});

// POST /api/messages/:id/forward  { targets: [{ conversation_id, content? }] }
// Media is copied as-is. Text is re-sent with the `content` the client supplies (needed for end-to-end
// encrypted chats, where only the client can re-encrypt for the other conversation).
router.post('/:id/forward', async (req, res) => {
  try {
    const { message, error } = await accessibleMessage(req.params.id, req.user.id);
    if (error) return fail(res, error);
    const [rows] = await pool.query('SELECT content, type, file_url, file_name, file_size, voice_duration, voice_waveform FROM messages WHERE id = ?', [message.id]);
    const src = rows[0];
    const targets = (Array.isArray(req.body.targets) ? req.body.targets : []).slice(0, 10);
    if (!targets.length) return res.status(400).json({ message: 'No target conversations' });
    const prepared = [];
    for (const t of targets) {
      const convId = Number(t.conversation_id);
      if (!convId || !(await isParticipant(convId, req.user.id))) continue;
      let content = src.content;
      if (src.type === 'text') {
        content = String(t.content || '').trim() || (isEncrypted(src.content) ? '' : src.content);
        if (!content) continue; // encrypted text needs client-side re-encryption
        if (await requiresEncryptedDirect(convId, content)) {
          return res.status(409).json({ message: 'Text forwarded to a direct conversation must be encrypted for that recipient.' });
        }
      }
      prepared.push({ conversationId: convId, content });
    }
    const sender = await loadSender(req.user.id);
    const sent = [];
    for (const target of prepared) {
      const [r] = await pool.query(
        `INSERT INTO messages (conversation_id, sender_id, content, type, file_url, file_name, file_size, voice_duration, voice_waveform, status, forwarded)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', 1)`,
        [target.conversationId, req.user.id, target.content, src.type, src.file_url, src.file_name, src.file_size, src.voice_duration, src.voice_waveform]
      );
      await applyExpiry(r.insertId, target.conversationId);
      const m = await getMessage(r.insertId, req.user.id);
      deliver(m, sender).catch((e) => console.warn('deliver:', e.message));
      sent.push(m);
    }
    res.status(201).json({ messages: sent });
  } catch (err) {
    console.error('forward:', err.message);
    res.status(500).json({ message: 'Could not forward message' });
  }
});

module.exports = router;
module.exports.processScheduled = processScheduled;
