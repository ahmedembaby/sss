'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.MYSQL_INTEGRATION === '1';
const dbName = process.env.DB_NAME || '';
const safeTestDatabase = /^special_test_[a-z0-9_]+$/i.test(dbName) && dbName.toLowerCase() !== 'echat';

test('MySQL schema, foreign keys and private-media authorization', { skip: !enabled }, async () => {
  assert.ok(safeTestDatabase, 'DB_NAME must use the isolated special_test_* prefix');
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST || 'localhost'), 'MySQL integration tests must use a local database host');
  assert.notEqual(process.env.NODE_ENV, 'production', 'integration tests must never run in production');

  const db = require('../db');
  const { canAccessChatMedia, canAccessStoryMedia } = require('../services/mediaAccess');
  const suffix = require('crypto').randomBytes(8).toString('hex');
  const email = (label) => `${label}-${suffix}@integration.invalid`;
  const userIds = [];

  try {
    await db.initDatabase();
    const [identity] = await db.query('SELECT DATABASE() AS name');
    assert.equal(identity[0].name, dbName);

    const createUser = async (name) => {
      const [result] = await db.query(
        'INSERT INTO users (name, email, is_private) VALUES (?, ?, 0)',
        [name, email(name.toLowerCase())]
      );
      userIds.push(result.insertId);
      return result.insertId;
    };

    const ownerId = await createUser('MediaOwner');
    const memberId = await createUser('MediaMember');
    const outsiderId = await createUser('MediaOutsider');

    const [conversation] = await db.query(
      "INSERT INTO conversations (type, created_by) VALUES ('direct', ?)", [ownerId]
    );
    await db.query(
      'INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?), (?, ?)',
      [conversation.insertId, ownerId, conversation.insertId, memberId]
    );
    await assert.rejects(
      db.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)', [conversation.insertId, 2147483000]),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2'
    );

    const chatFilename = `integration-${suffix}.jpg`;
    await db.query(
      "INSERT INTO messages (conversation_id, sender_id, content, type, file_url) VALUES (?, ?, '', 'image', ?)",
      [conversation.insertId, ownerId, `/uploads/chat/${chatFilename}`]
    );
    assert.equal(await canAccessChatMedia(chatFilename, ownerId), true, 'sender can access their media');
    assert.equal(await canAccessChatMedia(chatFilename, memberId), true, 'participant can access media');
    assert.equal(await canAccessChatMedia(chatFilename, outsiderId), false, 'non-participant is denied');
    assert.equal(await canAccessChatMedia('../' + chatFilename, memberId), false, 'path traversal is denied');
    assert.equal(await canAccessChatMedia('missing-' + chatFilename, memberId), false, 'unknown media is denied');

    const onceFilename = `once-${suffix}.jpg`;
    const [onceMessage] = await db.query(
      "INSERT INTO messages (conversation_id, sender_id, content, type, file_url, view_once) VALUES (?, ?, '', 'image', ?, 1)",
      [conversation.insertId, ownerId, `/uploads/chat/${onceFilename}`]
    );
    assert.equal(await canAccessChatMedia(onceFilename, memberId), false, 'view-once media is unavailable before opening');
    await db.query('UPDATE messages SET opened_at = NOW() WHERE id = ?', [onceMessage.insertId]);
    assert.equal(await canAccessChatMedia(onceFilename, memberId), true, 'opened view-once media can be fetched');
    await db.query('INSERT INTO message_deletions (message_id, user_id) VALUES (?, ?)', [onceMessage.insertId, memberId]);
    assert.equal(await canAccessChatMedia(onceFilename, memberId), false, 'per-user deletion revokes media access');

    const storyFilename = `integration-${suffix}.jpg`;
    await db.query(
      "INSERT INTO stories (user_id, media_url, media_type, expires_at) VALUES (?, ?, 'image', DATE_ADD(NOW(), INTERVAL 1 HOUR))",
      [ownerId, `/uploads/stories/${storyFilename}`]
    );
    assert.equal(await canAccessStoryMedia(storyFilename, ownerId), true, 'owner can access story media');
    assert.equal(await canAccessStoryMedia(storyFilename, outsiderId), true, 'public story is accessible');

    await db.query('UPDATE users SET is_private = 1 WHERE id = ?', [ownerId]);
    assert.equal(await canAccessStoryMedia(storyFilename, outsiderId), false, 'private story denies non-followers');
    await db.query('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)', [outsiderId, ownerId]);
    assert.equal(await canAccessStoryMedia(storyFilename, outsiderId), true, 'follower can access private story');
    await db.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)', [ownerId, outsiderId]);
    assert.equal(await canAccessStoryMedia(storyFilename, outsiderId), false, 'blocked user is denied');
  } finally {
    if (userIds.length) await db.query('DELETE FROM users WHERE id IN (?)', [userIds]).catch(() => {});
    await db.end().catch(() => {});
  }
});
