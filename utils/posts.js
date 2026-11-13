const pool = require('../db');

const POST_SELECT = `
  SELECT p.id, p.user_id, p.content, p.image_url, p.created_at, p.repost_of, p.edited_at,
         (SELECT COUNT(*) FROM posts rp WHERE rp.repost_of = p.id) AS reposts_count,
         u.name AS user_name, u.username AS user_username, u.avatar AS user_avatar,
         (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comments_count
  FROM posts p JOIN users u ON u.id = p.user_id`;

// Posts of private accounts are visible to the owner and their followers only (params: viewerId, viewerId)
// (params: viewerId x3). Also hides posts of people blocked by / blocking the viewer.
// block check: a row {blocker, blocked} whose ids sum to p.user_id + viewer and that contains p.user_id => the other id is the viewer
const POST_VISIBLE = `(NOT EXISTS (SELECT 1 FROM user_blocks vb WHERE vb.blocker_id + vb.blocked_id = p.user_id + ? AND (vb.blocker_id = p.user_id OR vb.blocked_id = p.user_id))
  AND (u.is_private = 0 OR p.user_id = ? OR EXISTS (SELECT 1 FROM follows vf WHERE vf.follower_id = ? AND vf.following_id = p.user_id)))`;

const shapeUser = (id, name, username, avatar) => ({ id: String(id), name, username: username || `user${id}`, avatar: avatar || undefined });

// Replies are one level deep: parentId is always the top-level comment, replyTo is who was answered
const COMMENT_SELECT = `SELECT c.id, c.post_id, c.user_id, c.content, c.created_at, c.parent_id, c.reply_to_user_id,
       u.name, u.username, u.avatar, ru.name AS reply_name, ru.username AS reply_username
  FROM post_comments c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN users ru ON ru.id = c.reply_to_user_id`;

const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '😡'];

// [{emoji, user_id}] -> { reactions: [{emoji,count}] (most used first), my_reaction, count }
const summarize = (rows, viewerId) => {
  const counts = new Map();
  let mine = null;
  for (const r of rows) {
    counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1);
    if (String(r.user_id) === String(viewerId)) mine = r.emoji;
  }
  const reactions = [...counts.entries()].map(([emoji, count]) => ({ emoji, count })).sort((a, b) => b.count - a.count);
  return { reactions, my_reaction: mine, count: rows.length };
};

const shapeCommentRow = (c, rx) => ({
  id: String(c.id),
  user: shapeUser(c.user_id, c.name, c.username, c.avatar),
  content: c.content,
  createdAt: c.created_at,
  parentId: c.parent_id ? String(c.parent_id) : null,
  replyTo: c.reply_to_user_id ? { id: String(c.reply_to_user_id), name: c.reply_name, username: c.reply_username || `user${c.reply_to_user_id}` } : null,
  reactions: rx.reactions,
  my_reaction: rx.my_reaction,
  likes_count: rx.count,
});

// comment rows -> API shape, with their reactions
async function shapeComments(rows, viewerId) {
  if (!rows.length) return [];
  const [rx] = await pool.query('SELECT comment_id, user_id, emoji FROM comment_reactions WHERE comment_id IN (?)', [rows.map((r) => r.id)]);
  const by = {};
  for (const r of rx) (by[r.comment_id] = by[r.comment_id] || []).push(r);
  return rows.map((c) => shapeCommentRow(c, summarize(by[c.id] || [], viewerId)));
}

async function formatPosts(rows, viewerId, { withComments = false } = {}) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [likes] = await pool.query('SELECT post_id, user_id, emoji FROM post_likes WHERE post_id IN (?)', [ids]);
  const likeMap = {};
  const likeRows = {};
  for (const l of likes) {
    (likeMap[l.post_id] = likeMap[l.post_id] || []).push(String(l.user_id));
    (likeRows[l.post_id] = likeRows[l.post_id] || []).push(l);
  }

  const [imgs] = await pool.query('SELECT post_id, url FROM post_images WHERE post_id IN (?) ORDER BY post_id, position, id', [ids]);
  const imageMap = {};
  for (const i of imgs) (imageMap[i.post_id] = imageMap[i.post_id] || []).push(i.url);

  // bookmarks, polls and reposted originals
  const [bm] = await pool.query('SELECT post_id FROM post_bookmarks WHERE user_id = ? AND post_id IN (?)', [viewerId, ids]);
  const bookmarked = new Set(bm.map((b) => b.post_id));
  const [opts] = await pool.query(
    `SELECT o.id, o.post_id, o.text, (SELECT COUNT(*) FROM post_poll_votes v WHERE v.option_id = o.id) AS votes
     FROM post_poll_options o WHERE o.post_id IN (?) ORDER BY o.post_id, o.position, o.id`, [ids]);
  const [myVotes] = await pool.query('SELECT post_id, option_id FROM post_poll_votes WHERE user_id = ? AND post_id IN (?)', [viewerId, ids]);
  const myVote = Object.fromEntries(myVotes.map((v) => [v.post_id, v.option_id]));
  const pollMap = {};
  for (const o of opts) (pollMap[o.post_id] = pollMap[o.post_id] || []).push({ id: String(o.id), text: o.text, votes: Number(o.votes) });
  const repostIds = [...new Set(rows.map((r) => r.repost_of).filter(Boolean))];
  const originals = {};
  if (repostIds.length) {
    const [os] = await pool.query(
      `SELECT p.id, p.content, p.image_url, p.user_id, u.name, u.username, u.avatar FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id IN (?)`, [repostIds]);
    for (const o of os) originals[o.id] = { id: String(o.id), content: o.content, image: o.image_url || undefined, user: shapeUser(o.user_id, o.name, o.username, o.avatar) };
  }

  let commentMap = {};
  if (withComments) {
    const [cs] = await pool.query(`${COMMENT_SELECT} WHERE c.post_id IN (?) ORDER BY c.created_at ASC, c.id ASC`, [ids]);
    const shaped = await shapeComments(cs, viewerId);
    cs.forEach((c, i) => (commentMap[c.post_id] = commentMap[c.post_id] || []).push(shaped[i]));
  }

  return rows.map((r) => {
    const likeIds = likeMap[r.id] || [];
    // older posts only have image_url
    const images = imageMap[r.id] || (r.image_url ? [r.image_url] : []);
    return {
      id: String(r.id),
      user: shapeUser(r.user_id, r.user_name, r.user_username, r.user_avatar),
      content: r.content,
      image: images[0] || undefined,
      images,
      createdAt: r.created_at,
      likes: likeIds,
      likes_count: likeIds.length,
      reactions: summarize(likeRows[r.id] || [], viewerId).reactions,
      my_reaction: summarize(likeRows[r.id] || [], viewerId).my_reaction,
      liked: likeIds.includes(String(viewerId)),
      comments: withComments ? commentMap[r.id] || [] : [],
      comments_count: Number(r.comments_count) || 0,
      edited: !!r.edited_at,
      bookmarked: bookmarked.has(r.id),
      reposts_count: Number(r.reposts_count) || 0,
      repost_of: r.repost_of ? originals[r.repost_of] || { id: String(r.repost_of), deleted: true } : undefined,
      poll: pollMap[r.id] ? { options: pollMap[r.id], total: pollMap[r.id].reduce((a, o) => a + o.votes, 0), my_vote: myVote[r.id] ? String(myVote[r.id]) : null } : undefined,
      reposts: Number(r.reposts_count) || 0,
    };
  });
}

module.exports = { POST_VISIBLE, COMMENT_SELECT, POST_SELECT, REACTIONS, summarize, formatPosts, shapeComments, shapeUser };
