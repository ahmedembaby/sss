const pool = require('../db');

const isParticipant = async (conversationId, userId) => {
  const [rows] = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1',
    [conversationId, userId]
  );
  return rows.length > 0;
};

const participantIds = async (conversationId) => {
  const [rows] = await pool.query('SELECT user_id FROM conversation_participants WHERE conversation_id = ?', [conversationId]);
  return rows.map((r) => r.user_id);
};

const MESSAGE_SELECT = `
  SELECT m.*, (SELECT MIN(ru2.read_receipts) FROM conversation_participants cp2 JOIN users ru2 ON ru2.id = cp2.user_id WHERE cp2.conversation_id = m.conversation_id AND cp2.user_id <> m.sender_id) AS rcpt_on,
            u.name AS sender_name, u.avatar AS sender_avatar,
         rm.id AS reply_id, rm.content AS reply_content, rm.type AS reply_type, rm.sender_id AS reply_sender_id, ru.name AS reply_sender_name
  FROM messages m
  JOIN users u ON u.id = m.sender_id
  LEFT JOIN messages rm ON rm.id = m.reply_to
  LEFT JOIN users ru ON ru.id = rm.sender_id`;

// SQL fragment (needs the viewer id as one parameter): not expired and not deleted "for me"
const visible = (alias = 'm') =>
  `(${alias}.expires_at IS NULL OR ${alias}.expires_at > NOW()) AND NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = ${alias}.id AND d.user_id = ?)`;

// Raw join columns -> { reply: {...} | null, forwarded }
const shapeMessage = (m) => {
  const { reply_id, reply_content, reply_type, reply_sender_id, reply_sender_name, ...rest } = m;
  if (rest.status === 'read' && rest.rcpt_on === 0) rest.status = 'delivered'; // the reader turned read receipts off
  delete rest.rcpt_on;
  if (rest.view_once) { rest.file_url = null; rest.view_once = true; rest.opened = !!rest.opened_at; }
  delete rest.opened_at;
  return {
    ...rest,
    forwarded: !!m.forwarded,
    reply: m.reply_to
      ? (reply_id
        ? { id: reply_id, content: reply_content, type: reply_type, sender_id: reply_sender_id, sender_name: reply_sender_name }
        : { id: m.reply_to, deleted: true })
      : null,
  };
};

// Aggregated reactions per message for the given viewer: { [messageId]: [{emoji,count,users,my_reaction}] }
async function reactionsFor(messageIds, viewerId) {
  const out = {};
  if (!messageIds.length) return out;
  const [rows] = await pool.query(
    `SELECT r.message_id, r.emoji, r.user_id, u.name, u.avatar
     FROM message_reactions r JOIN users u ON u.id = r.user_id
     WHERE r.message_id IN (?) ORDER BY r.created_at`,
    [messageIds]
  );
  for (const r of rows) {
    const list = (out[r.message_id] = out[r.message_id] || []);
    let g = list.find((x) => x.emoji === r.emoji);
    if (!g) { g = { emoji: r.emoji, count: 0, users: [], my_reaction: false }; list.push(g); }
    g.count += 1;
    g.users.push({ id: r.user_id, name: r.name, avatar: r.avatar });
    if (Number(r.user_id) === Number(viewerId)) g.my_reaction = true;
  }
  return out;
}

// Polls of the given messages for a viewer: { [messageId]: { options:[{id,text,votes,my}], total, my_option } }
async function pollsFor(messageIds, viewerId) {
  const out = {};
  if (!messageIds.length) return out;
  const [opts] = await pool.query('SELECT id, message_id, text FROM chat_poll_options WHERE message_id IN (?) ORDER BY position, id', [messageIds]);
  if (!opts.length) return out;
  const [votes] = await pool.query('SELECT option_id, message_id, user_id FROM chat_poll_votes WHERE message_id IN (?)', [messageIds]);
  for (const o of opts) {
    const p = (out[o.message_id] = out[o.message_id] || { options: [], total: 0, my_option: null });
    p.options.push({ id: o.id, text: o.text, votes: 0, my: false });
  }
  for (const v of votes) {
    const p = out[v.message_id];
    if (!p) continue;
    const o = p.options.find((x) => x.id === v.option_id);
    if (!o) continue;
    o.votes += 1; p.total += 1;
    if (Number(v.user_id) === Number(viewerId)) { o.my = true; p.my_option = o.id; }
  }
  return out;
}

async function starredSet(messageIds, viewerId) {
  if (!messageIds.length) return new Set();
  const [rows] = await pool.query('SELECT message_id FROM message_stars WHERE user_id = ? AND message_id IN (?)', [viewerId, messageIds]);
  return new Set(rows.map((r) => r.message_id));
}

async function attachReactions(messages, viewerId) {
  const ids = messages.map((m) => m.id);
  const [map, polls, stars] = await Promise.all([
    reactionsFor(ids, viewerId),
    pollsFor(messages.filter((m) => m.type === 'poll').map((m) => m.id), viewerId),
    starredSet(ids, viewerId),
  ]);
  return messages.map((m) => {
    const shaped = { ...shapeMessage(m), reactions: map[m.id] || [], starred: stars.has(m.id) };
    delete shaped.client_id;
    if (m.type === 'poll') shaped.poll = polls[m.id] || { options: [], total: 0, my_option: null };
    return shaped;
  });
}

async function getMessage(id, viewerId) {
  const [rows] = await pool.query(`${MESSAGE_SELECT} WHERE m.id = ?`, [id]);
  if (!rows.length) return null;
  return (await attachReactions(rows, viewerId))[0];
}

module.exports = { isParticipant, participantIds, MESSAGE_SELECT, visible, reactionsFor, pollsFor, attachReactions, getMessage };
