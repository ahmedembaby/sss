const pool = require('../db');
const { notify } = require('../services/notify');

const MENTION_RE = /(?:^|[^\w@])@([a-zA-Z0-9_]{3,30})/g;
const HASHTAG_RE = /(?:^|[^\p{L}\p{N}_&#])#([\p{L}\p{N}_]{2,50})/gu;

const unique = (re, text) => [...new Set([...String(text || '').matchAll(re)].map((m) => m[1].toLowerCase()))];
const extractMentions = (text) => unique(MENTION_RE, text).slice(0, 10);
const extractHashtags = (text) => unique(HASHTAG_RE, text).slice(0, 15);

async function saveHashtags(postId, content) {
  const tags = extractHashtags(content);
  await pool.query('DELETE FROM post_hashtags WHERE post_id = ?', [postId]);
  if (tags.length) await pool.query('INSERT IGNORE INTO post_hashtags (post_id, tag) VALUES ?', [tags.map((t) => [postId, t])]);
}

// notifies mentioned users (skips people who already got a notification from this action)
async function notifyMentions(content, fromUser, { postId = null, commentId = null, skip = [] } = {}) {
  const names = extractMentions(content);
  if (!names.length) return;
  const [users] = await pool.query('SELECT id FROM users WHERE username IN (?) AND banned = 0', [names]);
  const skipSet = new Set(skip.map(Number));
  for (const u of users) {
    if (skipSet.has(u.id)) continue;
    await notify(u.id, 'mention', fromUser, { postId, commentId });
  }
}

module.exports = { extractMentions, extractHashtags, saveHashtags, notifyMentions };
