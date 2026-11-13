const express = require('express');
const pool = require('../db');
const upload = require('../middleware/upload');
const rt = require('../services/realtime');
const { notify, loadNotifications } = require('../services/notify');
const { toInt } = require('../utils/format');
const { isBlockedBetween } = require('../utils/blocks');
const { findBanned } = require('../services/wordfilter');
const { notifyMentions, saveHashtags } = require('../utils/mentions');
const { POST_VISIBLE, COMMENT_SELECT, POST_SELECT, REACTIONS, summarize, formatPosts, shapeComments, shapeUser } = require('../utils/posts');
const { isAdminUser } = require('../middleware/auth');

const router = express.Router();

// --- posts ---
router.get('/posts', async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 30, 1, 100);
    const offset = toInt(req.query.offset, 0, 0, 100000);
    // cursor pagination: ?before=<last post id> is stable while new posts arrive (offset kept for old clients)
    const before = toInt(req.query.before, 0, 0, 2147483647);
    // ?sort=ranked: engagement / age score (offset paging); default is newest first
    const ranked = req.query.sort === 'ranked';
    const order = ranked
      ? `((SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) + 2 * (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.id) + 3 * (SELECT COUNT(*) FROM posts rp WHERE rp.repost_of = p.id) + 1 + IF(p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ${Number(req.user.id)}), 3, 0)) / POW(TIMESTAMPDIFF(HOUR, p.created_at, NOW()) + 2, 1.4) DESC, p.id DESC`
      : 'p.created_at DESC, p.id DESC';
    // Home feed: only posts from accounts I follow plus my own posts.
    const feedScope = ' AND (p.user_id = ? OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?))';
    const [rows] = await pool.query(`${POST_SELECT} WHERE ${POST_VISIBLE}${feedScope}${before && !ranked ? ' AND p.id < ?' : ''} ORDER BY ${order} LIMIT ? OFFSET ?`, [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, ...(before && !ranked ? [before] : []), limit, offset]);
    res.json(await formatPosts(rows, req.user.id, { withComments: true }));
  } catch (err) {
    console.error('posts:', err.message);
    res.status(500).json({ message: 'Could not load posts' });
  }
});

router.get('/posts/user/:username', async (req, res) => {
  try {
    const username = String(req.params.username).replace(/^@/, '');
    const [rows] = await pool.query(`${POST_SELECT} WHERE u.username = ? AND ${POST_VISIBLE} ORDER BY p.created_at DESC, p.id DESC LIMIT 100`, [username, req.user.id, req.user.id, req.user.id]);
    res.json(await formatPosts(rows, req.user.id, { withComments: true }));
  } catch (err) {
    res.status(500).json({ message: 'Could not load posts' });
  }
});

router.get('/posts/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(`${POST_SELECT} WHERE p.id = ? AND ${POST_VISIBLE}`, [req.params.id, req.user.id, req.user.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ message: 'Post not found' });
    res.json((await formatPosts(rows, req.user.id, { withComments: true }))[0]);
  } catch (err) {
    res.status(500).json({ message: 'Could not load post' });
  }
});

const MAX_POST_IMAGES = 4;
// accepts several files under "images" (or the older single "image" field)
const postFiles = upload.post.fields([{ name: 'images', maxCount: MAX_POST_IMAGES }, { name: 'image', maxCount: MAX_POST_IMAGES }]);

router.post('/posts', postFiles, async (req, res) => {
  try {
    const content = String(req.body.content || '').trim();
    const files = [...(req.files?.images || []), ...(req.files?.image || [])].slice(0, MAX_POST_IMAGES);
    if (await findBanned(content + ' ' + String(req.body.poll_options || ''))) return res.status(400).json({ message: 'Your post contains words that are not allowed' });
    let pollOptions = req.body.poll_options;
    if (typeof pollOptions === 'string') { try { pollOptions = JSON.parse(pollOptions); } catch { pollOptions = null; } }
    pollOptions = Array.isArray(pollOptions) ? pollOptions.map((o) => String(o).trim().slice(0, 80)).filter(Boolean).slice(0, 4) : [];
    if (pollOptions.length === 1) return res.status(400).json({ message: 'A poll needs at least 2 options' });
    let repostOf = Number(req.body.repost_of) || null;
    if (repostOf) {
      const [orig] = await pool.query(`${POST_SELECT} WHERE p.id = ? AND ${POST_VISIBLE}`, [repostOf, req.user.id, req.user.id, req.user.id]);
      if (!orig.length) return res.status(404).json({ message: 'Original post not found' });
    }
    if (!content && !files.length && !repostOf) return res.status(400).json({ message: 'Post content required' });
    if (content.length > 1000) return res.status(400).json({ message: 'Post is too long (max 1000)' });
    const urls = files.map((f) => `/uploads/posts/${f.filename}`);
    const [r] = await pool.query('INSERT INTO posts (user_id, content, image_url, repost_of) VALUES (?, ?, ?, ?)', [req.user.id, content, urls[0] || null, repostOf]);
    if (pollOptions.length >= 2) await pool.query('INSERT INTO post_poll_options (post_id, text, position) VALUES ?', [pollOptions.map((t, i) => [r.insertId, t, i])]);
    if (urls.length) await pool.query('INSERT INTO post_images (post_id, url, position) VALUES ?', [urls.map((u, i) => [r.insertId, u, i])]);
    await saveHashtags(r.insertId, content);
    notifyMentions(content, req.user, { postId: r.insertId }).catch(() => {});
    const [rows] = await pool.query(`${POST_SELECT} WHERE p.id = ?`, [r.insertId]);
    res.status(201).json((await formatPosts(rows, req.user.id, { withComments: true }))[0]);
  } catch (err) {
    console.error('create post:', err.message);
    res.status(500).json({ message: 'Could not create post' });
  }
});

// bookmarks
router.post('/posts/:id/bookmark', async (req, res) => {
  try {
    const [p] = await pool.query(`${POST_SELECT} WHERE p.id = ? AND ${POST_VISIBLE}`, [req.params.id, req.user.id, req.user.id, req.user.id]);
    if (!p.length) return res.status(404).json({ message: 'Post not found' });
    const [d] = await pool.query('DELETE FROM post_bookmarks WHERE user_id = ? AND post_id = ?', [req.user.id, req.params.id]);
    if (d.affectedRows) return res.json({ bookmarked: false });
    await pool.query('INSERT IGNORE INTO post_bookmarks (user_id, post_id) VALUES (?, ?)', [req.user.id, req.params.id]);
    res.json({ bookmarked: true });
  } catch (err) {
    res.status(500).json({ message: 'Could not update bookmark' });
  }
});

router.get('/bookmarks', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `${POST_SELECT} WHERE p.id IN (SELECT post_id FROM post_bookmarks WHERE user_id = ?) AND ${POST_VISIBLE} ORDER BY p.id DESC LIMIT 200`,
      [req.user.id, req.user.id, req.user.id, req.user.id]);
    res.json(await formatPosts(rows, req.user.id, { withComments: false }));
  } catch (err) {
    res.status(500).json({ message: 'Could not load bookmarks' });
  }
});

// POST /posts/:id/vote { option_id } - one vote per user, changeable
router.post('/posts/:id/vote', async (req, res) => {
  try {
    const optionId = Number(req.body.option_id);
    const [o] = await pool.query('SELECT id FROM post_poll_options WHERE id = ? AND post_id = ?', [optionId, req.params.id]);
    if (!o.length) return res.status(404).json({ message: 'Option not found' });
    const [vis] = await pool.query(`${POST_SELECT} WHERE p.id = ? AND ${POST_VISIBLE}`, [req.params.id, req.user.id, req.user.id, req.user.id]);
    if (!vis.length) return res.status(404).json({ message: 'Post not found' });
    await pool.query('INSERT INTO post_poll_votes (post_id, user_id, option_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE option_id = VALUES(option_id)', [req.params.id, req.user.id, optionId]);
    res.json((await formatPosts(vis, req.user.id))[0]);
  } catch (err) {
    res.status(500).json({ message: 'Could not vote' });
  }
});

// PUT /posts/:id { content } - edit your own post (shows "edited")
router.put('/posts/:id', async (req, res) => {
  try {
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ message: 'Post content required' });
    if (content.length > 500) return res.status(400).json({ message: 'Post is too long' });
    if (await findBanned(content)) return res.status(400).json({ message: 'Your post contains words that are not allowed' });
    const [r] = await pool.query('UPDATE posts SET content = ?, edited_at = NOW() WHERE id = ? AND user_id = ?', [content, req.params.id, req.user.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Post not found' });
    await saveHashtags(req.params.id, content);
    const [rows] = await pool.query(`${POST_SELECT} WHERE p.id = ?`, [req.params.id]);
    res.json((await formatPosts(rows, req.user.id, { withComments: true }))[0]);
  } catch (err) {
    res.status(500).json({ message: 'Could not edit post' });
  }
});

router.delete('/posts/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT user_id FROM posts WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Post not found' });
    if (rows[0].user_id !== req.user.id) return res.status(403).json({ message: 'You can only delete your own posts' });
    await pool.query('DELETE FROM posts WHERE id = ?', [req.params.id]);
    res.json({ message: 'Post deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Could not delete post' });
  }
});

// ---- reactions (one per user per post / comment; same emoji again removes it) ----
async function applyReaction(table, idCol, id, userId, emoji) {
  const [cur] = await pool.query(`SELECT emoji FROM ${table} WHERE ${idCol} = ? AND user_id = ?`, [id, userId]);
  if (cur.length && cur[0].emoji === emoji) {
    await pool.query(`DELETE FROM ${table} WHERE ${idCol} = ? AND user_id = ?`, [id, userId]);
    return null;
  }
  if (cur.length) await pool.query(`UPDATE ${table} SET emoji = ? WHERE ${idCol} = ? AND user_id = ?`, [emoji, id, userId]);
  else await pool.query(`INSERT INTO ${table} (${idCol}, user_id, emoji) VALUES (?, ?, ?)`, [id, userId, emoji]);
  return emoji;
}
const reactionState = async (table, idCol, id, viewerId) => {
  const [rows] = await pool.query(`SELECT user_id, emoji FROM ${table} WHERE ${idCol} = ?`, [id]);
  const s = summarize(rows, viewerId);
  return { reaction: s.my_reaction, liked: !!s.my_reaction, likes_count: s.count, reactions: s.reactions };
};
const validEmoji = (e) => (REACTIONS.includes(e) ? e : null);

// POST /social/posts/:id/react  { emoji }
router.post('/posts/:id/react', async (req, res) => {
  try {
    const emoji = validEmoji(req.body.emoji);
    if (!emoji) return res.status(400).json({ message: 'Unsupported reaction', allowed: REACTIONS });
    const [posts] = await pool.query('SELECT id, user_id FROM posts WHERE id = ?', [req.params.id]);
    if (!posts.length) return res.status(404).json({ message: 'Post not found' });
    const now = await applyReaction('post_likes', 'post_id', posts[0].id, req.user.id, emoji);
    if (now) await notify(posts[0].user_id, 'like', req.user, { postId: posts[0].id, text: `reacted ${now} to your post` });
    res.json(await reactionState('post_likes', 'post_id', posts[0].id, req.user.id));
  } catch (err) {
    console.error('react:', err.message);
    res.status(500).json({ message: 'Could not update reaction' });
  }
});

// POST /social/comments/:id/react  { emoji }
router.post('/comments/:id/react', async (req, res) => {
  try {
    const emoji = validEmoji(req.body.emoji || '❤️');
    if (!emoji) return res.status(400).json({ message: 'Unsupported reaction', allowed: REACTIONS });
    const [cs] = await pool.query('SELECT id, user_id, post_id FROM post_comments WHERE id = ?', [req.params.id]);
    if (!cs.length) return res.status(404).json({ message: 'Comment not found' });
    const now = await applyReaction('comment_reactions', 'comment_id', cs[0].id, req.user.id, emoji);
    if (now) await notify(cs[0].user_id, 'like', req.user, { postId: cs[0].post_id, commentId: cs[0].id, text: `reacted ${now} to your comment` });
    res.json(await reactionState('comment_reactions', 'comment_id', cs[0].id, req.user.id));
  } catch (err) {
    console.error('react comment:', err.message);
    res.status(500).json({ message: 'Could not update reaction' });
  }
});

// who reacted (with what): used by the "likes" sheet
const reactorsHandler = (table, idCol) => async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.emoji, u.id, u.name, u.username, u.avatar,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = u.id) AS i_follow
       FROM ${table} r JOIN users u ON u.id = r.user_id
       WHERE r.${idCol} = ? AND u.banned = 0 ORDER BY r.id DESC LIMIT 500`,
      [req.user.id, req.params.id]
    );
    res.json(rows.map((r) => ({ emoji: r.emoji, user: { ...shapeUser(r.id, r.name, r.username, r.avatar), is_following: !!r.i_follow } })));
  } catch (err) {
    res.status(500).json({ message: 'Could not load reactions' });
  }
};
router.get('/posts/:id/reactions', reactorsHandler('post_likes', 'post_id'));
router.get('/comments/:id/reactions', reactorsHandler('comment_reactions', 'comment_id'));

// Toggle like (plain heart; kept for older clients)
router.post('/posts/:id/like', async (req, res) => {
  try {
    const [posts] = await pool.query('SELECT id, user_id FROM posts WHERE id = ?', [req.params.id]);
    if (!posts.length) return res.status(404).json({ message: 'Post not found' });
    const [r] = await pool.query('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', [req.params.id, req.user.id]);
    let liked = false;
    if (!r.affectedRows) {
      await pool.query('INSERT IGNORE INTO post_likes (post_id, user_id) VALUES (?, ?)', [req.params.id, req.user.id]);
      liked = true;
      await notify(posts[0].user_id, 'like', req.user, { postId: posts[0].id });
    }
    const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM post_likes WHERE post_id = ?', [req.params.id]);
    res.json({ liked, likes_count: c });
  } catch (err) {
    console.error('like:', err.message);
    res.status(500).json({ message: 'Could not update like' });
  }
});

router.get('/posts/:id/comments', async (req, res) => {
  try {
    const [cs] = await pool.query(`${COMMENT_SELECT} WHERE c.post_id = ? ORDER BY c.created_at ASC, c.id ASC`, [req.params.id]);
    res.json(await shapeComments(cs, req.user.id));
  } catch (err) {
    res.status(500).json({ message: 'Could not load comments' });
  }
});

// POST /social/comments/post/:id  { content, parent_id? }  -- parent_id = the comment being answered
router.post('/comments/post/:id', async (req, res) => {
  try {
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ message: 'Comment content required' });
    if (content.length > 500) return res.status(400).json({ message: 'Comment is too long' });
    if (await findBanned(content)) return res.status(400).json({ message: 'Your comment contains words that are not allowed' });
    const [posts] = await pool.query('SELECT id, user_id FROM posts WHERE id = ?', [req.params.id]);
    if (!posts.length) return res.status(404).json({ message: 'Post not found' });

    let rootId = null;
    let replyToUser = null;
    const target = Number(req.body.parent_id) || null;
    if (target) {
      const [pc] = await pool.query('SELECT id, user_id, parent_id FROM post_comments WHERE id = ? AND post_id = ?', [target, posts[0].id]);
      if (!pc.length) return res.status(404).json({ message: 'Comment to reply to was not found' });
      rootId = pc[0].parent_id || pc[0].id; // answering a reply attaches to the same thread
      replyToUser = pc[0].user_id;
    }
    const [r] = await pool.query(
      'INSERT INTO post_comments (post_id, user_id, content, parent_id, reply_to_user_id) VALUES (?, ?, ?, ?, ?)',
      [posts[0].id, req.user.id, content, rootId, replyToUser]
    );
    const opts = { postId: posts[0].id, commentId: r.insertId };
    if (replyToUser) {
      await notify(replyToUser, 'comment', req.user, { ...opts, text: 'replied to your comment' });
      if (Number(posts[0].user_id) !== Number(replyToUser)) await notify(posts[0].user_id, 'comment', req.user, opts);
    } else {
      await notify(posts[0].user_id, 'comment', req.user, opts);
    }
    notifyMentions(content, req.user, { ...opts, skip: [replyToUser, posts[0].user_id] }).catch(() => {});
    const [cs] = await pool.query(`${COMMENT_SELECT} WHERE c.id = ?`, [r.insertId]);
    res.status(201).json((await shapeComments(cs, req.user.id))[0]);
  } catch (err) {
    console.error('comment:', err.message);
    res.status(500).json({ message: 'Could not add comment' });
  }
});

// Author of the comment, owner of the post or an admin; the replies of a top-level comment go with it
router.delete('/comments/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query(
      'SELECT c.id, c.user_id, p.user_id AS post_owner FROM post_comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?', [id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Comment not found' });
    const allowed = [rows[0].user_id, rows[0].post_owner].map(Number).includes(Number(req.user.id)) || isAdminUser(req.user);
    if (!allowed) return res.status(403).json({ message: 'Not allowed' });
    await pool.query('DELETE FROM post_comments WHERE id = ? OR parent_id = ?', [id, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Could not delete comment' });
  }
});

// --- notifications ---
router.get('/notifications', async (req, res) => {
  try {
    const [items] = await loadNotifications(req.user.id);
    res.json(items);
  } catch (err) {
    console.error('notifications:', err.message);
    res.status(500).json({ message: 'Could not load notifications' });
  }
});

router.get('/notifications/unread-count', async (req, res) => {
  try {
    const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
    res.json({ count: c });
  } catch (err) {
    res.status(500).json({ message: 'Could not load count' });
  }
});

router.put('/notifications/read-all', async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
    res.json({ message: 'ok' });
  } catch (err) {
    res.status(500).json({ message: 'Could not update notifications' });
  }
});

router.delete('/notifications/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM notifications WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Notification deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Could not delete notification' });
  }
});

// --- follows ---
// ids of everyone I follow
router.get('/following', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT following_id FROM follows WHERE follower_id = ?', [req.user.id]);
    res.json(rows.map((r) => String(r.following_id)));
  } catch (err) {
    res.status(500).json({ message: 'Could not load following' });
  }
});

// Toggle: follow / unfollow, or (private account) send / cancel a follow request
router.post('/users/:id/follow', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId === req.user.id) return res.status(400).json({ message: 'Invalid user' });
    const [u] = await pool.query('SELECT id, is_private FROM users WHERE id = ? AND banned = 0', [targetId]);
    if (!u.length) return res.status(404).json({ message: 'User not found' });
    if (await isBlockedBetween(req.user.id, targetId)) return res.status(403).json({ message: 'You cannot follow this user' });
    const [r] = await pool.query('DELETE FROM follows WHERE follower_id = ? AND following_id = ?', [req.user.id, targetId]);
    if (r.affectedRows) return res.json({ following: false, requested: false });
    const [cancel] = await pool.query('DELETE FROM follow_requests WHERE follower_id = ? AND target_id = ?', [req.user.id, targetId]);
    if (cancel.affectedRows) return res.json({ following: false, requested: false });
    if (u[0].is_private) {
      await pool.query('INSERT IGNORE INTO follow_requests (follower_id, target_id) VALUES (?, ?)', [req.user.id, targetId]);
      await notify(targetId, 'follow_request', req.user);
      return res.json({ following: false, requested: true });
    }
    await pool.query('INSERT IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)', [req.user.id, targetId]);
    await notify(targetId, 'follow', req.user);
    res.json({ following: true, requested: false });
  } catch (err) {
    console.error('follow:', err.message);
    res.status(500).json({ message: 'Could not update follow' });
  }
});

// incoming follow requests for my private account
router.get('/follow-requests', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.username, u.avatar, u.bio FROM follow_requests fr JOIN users u ON u.id = fr.follower_id
       WHERE fr.target_id = ? AND u.banned = 0 ORDER BY fr.created_at DESC LIMIT 200`, [req.user.id]);
    res.json(rows.map((u) => ({ ...shapeUser(u.id, u.name, u.username, u.avatar), bio: u.bio || undefined })));
  } catch (err) {
    res.status(500).json({ message: 'Could not load requests' });
  }
});

router.post('/follow-requests/:userId/:action(accept|decline)', async (req, res) => {
  try {
    const followerId = Number(req.params.userId);
    const [del] = await pool.query('DELETE FROM follow_requests WHERE follower_id = ? AND target_id = ?', [followerId, req.user.id]);
    if (!del.affectedRows) return res.status(404).json({ message: 'Request not found' });
    if (req.params.action === 'accept') {
      await pool.query('INSERT IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)', [followerId, req.user.id]);
      await notify(followerId, 'follow_accepted', req.user);
    }
    // the request notification is no longer actionable
    await pool.query("DELETE FROM notifications WHERE user_id = ? AND type = 'follow_request' AND from_user_id = ?", [req.user.id, followerId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Could not update request' });
  }
});

// --- hashtags ---
router.get('/hashtags/trending', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT h.tag, COUNT(*) AS posts FROM post_hashtags h JOIN posts p ON p.id = h.post_id JOIN users u ON u.id = p.user_id
       WHERE p.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) AND ${POST_VISIBLE}
       GROUP BY h.tag ORDER BY posts DESC, h.tag LIMIT 15`, [req.user.id, req.user.id, req.user.id]);
    res.json(rows.map((r) => ({ tag: r.tag, posts: Number(r.posts) })));
  } catch (err) {
    res.status(500).json({ message: 'Could not load hashtags' });
  }
});

router.get('/hashtags/:tag/posts', async (req, res) => {
  try {
    const tag = String(req.params.tag).replace(/^#/, '').toLowerCase().slice(0, 60);
    const [rows] = await pool.query(
      `${POST_SELECT} WHERE p.id IN (SELECT post_id FROM post_hashtags WHERE tag = ?) AND ${POST_VISIBLE}
       ORDER BY p.created_at DESC, p.id DESC LIMIT 100`, [tag, req.user.id, req.user.id, req.user.id]);
    res.json(await formatPosts(rows, req.user.id, { withComments: true }));
  } catch (err) {
    res.status(500).json({ message: 'Could not load posts' });
  }
});

// profile of any user: public fields + counters + my relation to them
router.get('/users/:id/profile', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query('SELECT id, name, username, avatar, bio, IF(hide_presence = 1, \'offline\', status) AS status, IF(hide_presence = 1, NULL, last_seen) AS last_seen, created_at, is_private FROM users WHERE id = ? AND banned = 0', [id]);
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    const [bl] = await pool.query('SELECT blocker_id FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)', [req.user.id, id, id, req.user.id]);
    if (bl.some((b) => b.blocker_id === id)) return res.status(404).json({ message: 'User not found' });
    const blockedByMe = bl.length > 0;
    const one = async (sql, args) => (await pool.query(sql, args))[0][0].c;
    const [followers, following, posts, iFollow, followsMe, requested] = await Promise.all([
      one('SELECT COUNT(*) AS c FROM follows WHERE following_id = ?', [id]),
      one('SELECT COUNT(*) AS c FROM follows WHERE follower_id = ?', [id]),
      one('SELECT COUNT(*) AS c FROM posts WHERE user_id = ?', [id]),
      one('SELECT COUNT(*) AS c FROM follows WHERE follower_id = ? AND following_id = ?', [req.user.id, id]),
      one('SELECT COUNT(*) AS c FROM follows WHERE follower_id = ? AND following_id = ?', [id, req.user.id]),
      one('SELECT COUNT(*) AS c FROM follow_requests WHERE follower_id = ? AND target_id = ?', [req.user.id, id]),
    ]);
    const u = rows[0];
    res.json({
      ...shapeUser(u.id, u.name, u.username, u.avatar),
      bio: u.bio || '',
      status: u.status,
      last_seen: u.last_seen,
      joined: u.created_at,
      followers_count: followers,
      following_count: following,
      posts_count: posts,
      is_following: iFollow > 0,
      follows_me: followsMe > 0,
      blocked_by_me: blockedByMe,
      is_private: !!u.is_private,
      requested: requested > 0,
      can_view: !u.is_private || iFollow > 0 || id === req.user.id,
    });
  } catch (err) {
    res.status(500).json({ message: 'Could not load profile' });
  }
});

router.get('/users/:id/follow-status', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?', [req.user.id, req.params.id]);
    const [rq] = await pool.query('SELECT 1 FROM follow_requests WHERE follower_id = ? AND target_id = ?', [req.user.id, req.params.id]);
    res.json({ following: rows.length > 0, requested: rq.length > 0 });
  } catch (err) {
    res.status(500).json({ message: 'Could not load follow status' });
  }
});

const listFollow = (col, other) => async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.username, u.avatar, u.bio FROM follows f JOIN users u ON u.id = f.${other}
       WHERE f.${col} = ? AND u.banned = 0 ORDER BY f.created_at DESC LIMIT 200`,
      [req.params.id]
    );
    res.json(rows.map((u) => ({ ...shapeUser(u.id, u.name, u.username, u.avatar), bio: u.bio || undefined })));
  } catch (err) {
    res.status(500).json({ message: 'Could not load users' });
  }
};
router.get('/users/:id/followers', listFollow('following_id', 'follower_id'));
router.get('/users/:id/following', listFollow('follower_id', 'following_id'));

router.get('/suggested-users', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.username, u.avatar, u.bio FROM users u
       WHERE u.id <> ? AND u.banned = 0 AND u.id NOT IN (SELECT following_id FROM follows WHERE follower_id = ?)
       ORDER BY (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) DESC, u.created_at DESC LIMIT 20`,
      [req.user.id, req.user.id]
    );
    res.json(rows.map((u) => ({ ...shapeUser(u.id, u.name, u.username, u.avatar), bio: u.bio || undefined })));
  } catch (err) {
    res.status(500).json({ message: 'Could not load suggestions' });
  }
});

module.exports = router;
