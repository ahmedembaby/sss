const pool = require('../db');
const rt = require('./realtime');
const { pushToUsers } = require('./push');
const { shapeUser } = require('../utils/posts');
const { pushAllowed } = require('./prefs');

const DEFAULT_TEXT = {
  like: 'reacted to your post',
  comment: 'replied to your post',
  follow: 'started following you',
  group_invite: 'invited you to join a group',
  group_request: 'asked to join your group',
  group_approved: 'approved your request to join',
  mention: 'mentioned you',
  follow_request: 'requested to follow you',
  follow_accepted: 'accepted your follow request',
};

/** Notifications of one user (or a single one, with onlyId). Returns [items] / [item]. */
async function loadNotifications(userId, onlyId = null) {
  const params = [userId, userId];
  let where = 'n.user_id = ?';
  if (onlyId) { where += ' AND n.id = ?'; params.push(onlyId); }
  const [rows] = await pool.query(
    `SELECT n.id, n.type, n.created_at, n.read_at, n.post_id, n.comment_id, n.group_id,
            f.id AS from_id, f.name AS from_name, f.username AS from_username, f.avatar AS from_avatar,
            p.content AS post_content, p.image_url AS post_image, c.content AS comment_content,
            g.name AS group_name, g.avatar AS group_avatar,
            EXISTS(SELECT 1 FROM follows fo WHERE fo.follower_id = ? AND fo.following_id = f.id) AS i_follow
     FROM notifications n
     JOIN users f ON f.id = n.from_user_id
     LEFT JOIN posts p ON p.id = n.post_id
     LEFT JOIN post_comments c ON c.id = n.comment_id
     LEFT JOIN \`groups\` g ON g.id = n.group_id
     WHERE ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT 100`,
    params
  );
  const items = rows.map((r) => ({
    id: String(r.id),
    type: r.type,
    from: { ...shapeUser(r.from_id, r.from_name, r.from_username, r.from_avatar), is_following: !!r.i_follow },
    createdAt: r.created_at,
    read: !!r.read_at,
    post: r.post_id ? { id: String(r.post_id), content: r.post_content, image: r.post_image || undefined } : undefined,
    comment: r.comment_id ? { id: String(r.comment_id), content: r.comment_content } : undefined,
    group: r.group_id ? { id: String(r.group_id), name: r.group_name, avatar: r.group_avatar || undefined } : undefined,
  }));
  return [onlyId ? items[0] : items];
}

/** Stores the notification, pushes it over the socket and as a mobile push. Never notifies yourself. */
async function notify(userId, type, fromUser, { postId = null, commentId = null, groupId = null, text = null } = {}) {
  userId = Number(userId);
  if (!userId || userId === Number(fromUser.id)) return;
  try {
    const [r] = await pool.query(
      'INSERT INTO notifications (user_id, type, from_user_id, post_id, comment_id, group_id) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, type, fromUser.id, postId, commentId, groupId]
    );
    const [item] = await loadNotifications(userId, r.insertId);
    if (item) rt.emitToUser(userId, 'notification', item);
    pushAllowed([userId], type).then((ids) => ids.length && pushToUsers(ids, {
      title: fromUser.name,
      body: text || DEFAULT_TEXT[type] || 'sent you a notification',
      data: { type: 'notification', notificationType: type, postId, groupId },
    })).catch(() => {});
  } catch (err) {
    console.error('notify:', err.message); // a notification must never break the action itself
  }
}

module.exports = { notify, loadNotifications };
