'use strict';

const pool = require('../db');
const { isBlockedBetween } = require('../utils/blocks');

const safeFilename = (filename) =>
  typeof filename === 'string' && filename.length > 0 && filename.length <= 255 &&
  !filename.includes('/') && !filename.includes('\\') && filename !== '.' && filename !== '..';

async function canAccessChatMedia(filename, userId) {
  if (!safeFilename(filename) || !Number.isSafeInteger(Number(userId))) return false;
  const [rows] = await pool.query(
    `SELECT m.id FROM messages m
     JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
     WHERE m.file_url = ? AND cp.user_id = ?
       AND (m.expires_at IS NULL OR m.expires_at > NOW())
       AND (m.view_once = 0 OR m.opened_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = m.id AND d.user_id = ?)
     LIMIT 1`,
    [`/uploads/chat/${filename}`, Number(userId), Number(userId)]
  );
  return rows.length > 0;
}

async function canAccessStoryMedia(filename, viewerId) {
  if (!safeFilename(filename) || !Number.isSafeInteger(Number(viewerId))) return false;
  const [rows] = await pool.query(
    `SELECT s.user_id, u.is_private FROM stories s
     JOIN users u ON u.id = s.user_id
     WHERE s.media_url = ? AND s.expires_at > NOW() AND u.banned = 0 LIMIT 1`,
    [`/uploads/stories/${filename}`]
  );
  if (!rows.length) return false;
  const ownerId = Number(rows[0].user_id);
  const userId = Number(viewerId);
  if (ownerId === userId) return true;
  if (await isBlockedBetween(userId, ownerId)) return false;
  if (!rows[0].is_private) return true;
  const [follows] = await pool.query(
    'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ? LIMIT 1',
    [userId, ownerId]
  );
  return follows.length > 0;
}

module.exports = { safeFilename, canAccessChatMedia, canAccessStoryMedia };
