
'use strict';

const mysql = require('mysql2/promise');
require('dotenv').config();

const DB_NAME = process.env.DB_NAME || 'echat';

const baseConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  port: Number(process.env.DB_PORT) || 3306,
  charset: 'utf8mb4',
  connectTimeout: 15000,
};

let pool = null;
let initPromise = null;

const TABLES = [

  // USERS
  `CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE DEFAULT NULL,
    username VARCHAR(50) UNIQUE DEFAULT NULL,
    password VARCHAR(255) DEFAULT NULL,
    avatar VARCHAR(255) DEFAULT NULL,
    phone VARCHAR(50) DEFAULT NULL,
    bio TEXT DEFAULT NULL,
    gender VARCHAR(20) DEFAULT NULL,
    birthday DATE DEFAULT NULL,
    push_token VARCHAR(255) DEFAULT NULL,
    banned TINYINT(1) NOT NULL DEFAULT 0,
    status ENUM('online','offline','away') DEFAULT 'offline',
    last_seen TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // GROUPS
  `CREATE TABLE IF NOT EXISTS \`groups\` (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    description TEXT DEFAULT NULL,
    avatar VARCHAR(255) DEFAULT NULL,
    cover_image VARCHAR(255) DEFAULT NULL,
    type ENUM('public','private','secret') DEFAULT 'private',
    created_by INT NOT NULL,
    member_count INT DEFAULT 1,
    settings JSON DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // CONVERSATIONS
  `CREATE TABLE IF NOT EXISTS conversations (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) DEFAULT NULL,
    avatar VARCHAR(255) DEFAULT NULL,
    type ENUM('direct','group') DEFAULT 'direct',
    created_by INT,
    pinned TINYINT(1) DEFAULT 0,
    group_id INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // CONVERSATION PARTICIPANTS
  `CREATE TABLE IF NOT EXISTS conversation_participants (
    id INT PRIMARY KEY AUTO_INCREMENT,
    conversation_id INT NOT NULL,
    user_id INT NOT NULL,
    pinned TINYINT(1) NOT NULL DEFAULT 0,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_participant (conversation_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // MESSAGES
  `CREATE TABLE IF NOT EXISTS messages (
    id INT PRIMARY KEY AUTO_INCREMENT,
    conversation_id INT NOT NULL,
    sender_id INT NOT NULL,
    content TEXT NOT NULL,
    type ENUM('text','image','file','voice','poll') DEFAULT 'text',
    file_url VARCHAR(500) DEFAULT NULL,
    file_name VARCHAR(255) DEFAULT NULL,
    file_size INT DEFAULT NULL,
    voice_duration VARCHAR(10) DEFAULT NULL,
    reply_to INT DEFAULT NULL,
    status ENUM('sending','sent','delivered','read') DEFAULT 'sent',
    edited_at TIMESTAMP NULL DEFAULT NULL,
    read_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (reply_to) REFERENCES messages(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // MESSAGE REACTIONS
  `CREATE TABLE IF NOT EXISTS message_reactions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    message_id INT NOT NULL,
    user_id INT NOT NULL,
    emoji VARCHAR(16) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_reaction (message_id, user_id, emoji)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // POSTS
  `CREATE TABLE IF NOT EXISTS posts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    content TEXT NOT NULL,
    image_url VARCHAR(500) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // POST LIKES
  `CREATE TABLE IF NOT EXISTS post_likes (
    id INT PRIMARY KEY AUTO_INCREMENT,
    post_id INT NOT NULL,
    user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_like (post_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // POST IMAGES
  `CREATE TABLE IF NOT EXISTS post_images (
    id INT AUTO_INCREMENT PRIMARY KEY,
    post_id INT NOT NULL,
    url VARCHAR(255) NOT NULL,
    position TINYINT NOT NULL DEFAULT 0,
    INDEX idx_post_images_post (post_id),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // POST COMMENTS
  `CREATE TABLE IF NOT EXISTS post_comments (
    id INT PRIMARY KEY AUTO_INCREMENT,
    post_id INT NOT NULL,
    user_id INT NOT NULL,
    content TEXT NOT NULL,
    parent_id INT DEFAULT NULL,
    reply_to_user_id INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // MESSAGE DELETIONS
  `CREATE TABLE IF NOT EXISTS message_deletions (
    message_id INT NOT NULL,
    user_id INT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // COMMENT REACTIONS
  `CREATE TABLE IF NOT EXISTS comment_reactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    comment_id INT NOT NULL,
    user_id INT NOT NULL,
    emoji VARCHAR(16) CHARACTER SET utf8mb4 NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_comment_reaction (comment_id, user_id),
    FOREIGN KEY (comment_id) REFERENCES post_comments(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // FOLLOWS
  `CREATE TABLE IF NOT EXISTS follows (
    id INT PRIMARY KEY AUTO_INCREMENT,
    follower_id INT NOT NULL,
    following_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_follow (follower_id, following_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // NOTIFICATIONS
  `CREATE TABLE IF NOT EXISTS notifications (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    type ENUM(
      'like','comment','follow','group_invite',
      'group_request','group_approved','mention',
      'follow_request','follow_accepted'
    ) NOT NULL,
    group_id INT DEFAULT NULL,
    from_user_id INT NOT NULL,
    post_id INT DEFAULT NULL,
    comment_id INT DEFAULT NULL,
    read_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (comment_id) REFERENCES post_comments(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // BANNED WORDS
  `CREATE TABLE IF NOT EXISTS banned_words (
    word VARCHAR(60) CHARACTER SET utf8mb4 NOT NULL PRIMARY KEY,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ADMIN AUDIT
  `CREATE TABLE IF NOT EXISTS admin_audit (
    id INT PRIMARY KEY AUTO_INCREMENT,
    admin_id INT NOT NULL,
    method VARCHAR(8) NOT NULL,
    path VARCHAR(200) NOT NULL,
    details VARCHAR(500) CHARACTER SET utf8mb4 DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // SCHEDULED MESSAGES
  `CREATE TABLE IF NOT EXISTS scheduled_messages (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    conversation_id INT NOT NULL,
    content TEXT CHARACTER SET utf8mb4 NOT NULL,
    send_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // POST BOOKMARKS
  `CREATE TABLE IF NOT EXISTS post_bookmarks (
    user_id INT NOT NULL,
    post_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, post_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // POST POLL OPTIONS
  `CREATE TABLE IF NOT EXISTS post_poll_options (
    id INT PRIMARY KEY AUTO_INCREMENT,
    post_id INT NOT NULL,
    text VARCHAR(80) CHARACTER SET utf8mb4 NOT NULL,
    position TINYINT NOT NULL DEFAULT 0,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // POST POLL VOTES
  `CREATE TABLE IF NOT EXISTS post_poll_votes (
    post_id INT NOT NULL,
    user_id INT NOT NULL,
    option_id INT NOT NULL,
    PRIMARY KEY (post_id, user_id),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (option_id) REFERENCES post_poll_options(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // USER BLOCKS
  `CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id INT NOT NULL,
    blocked_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (blocker_id, blocked_id),
    FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // REPORTS
  `CREATE TABLE IF NOT EXISTS reports (
    id INT PRIMARY KEY AUTO_INCREMENT,
    reporter_id INT NOT NULL,
    target_type ENUM('user','post','comment','message','story') NOT NULL,
    target_id INT NOT NULL,
    reason VARCHAR(60) NOT NULL,
    details VARCHAR(500) CHARACTER SET utf8mb4 DEFAULT NULL,
    status ENUM('open','resolved','dismissed') NOT NULL DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // POST HASHTAGS
  `CREATE TABLE IF NOT EXISTS post_hashtags (
    post_id INT NOT NULL,
    tag VARCHAR(60) CHARACTER SET utf8mb4 NOT NULL,
    PRIMARY KEY (post_id, tag),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // FOLLOW REQUESTS
  `CREATE TABLE IF NOT EXISTS follow_requests (
    follower_id INT NOT NULL,
    target_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (follower_id, target_id),
    FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // STORIES
  `CREATE TABLE IF NOT EXISTS stories (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    media_url VARCHAR(255) NOT NULL,
    media_type ENUM('image','video') NOT NULL DEFAULT 'image',
    caption VARCHAR(300) CHARACTER SET utf8mb4 DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // STORY VIEWS
  `CREATE TABLE IF NOT EXISTS story_views (
    story_id INT NOT NULL,
    user_id INT NOT NULL,
    viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (story_id, user_id),
    FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // CALLS
  `CREATE TABLE IF NOT EXISTS calls (
    id INT PRIMARY KEY AUTO_INCREMENT,
    caller_id INT NOT NULL,
    callee_id INT NOT NULL,
    type ENUM('audio','video') NOT NULL DEFAULT 'audio',
    status ENUM('ringing','active','ended','missed','rejected') NOT NULL DEFAULT 'ringing',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    answered_at DATETIME NULL DEFAULT NULL,
    duration INT NOT NULL DEFAULT 0,
    FOREIGN KEY (caller_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (callee_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // GROUP MEMBERS
  `CREATE TABLE IF NOT EXISTS group_members (
    id INT PRIMARY KEY AUTO_INCREMENT,
    group_id INT NOT NULL,
    user_id INT NOT NULL,
    role ENUM('owner','admin','moderator','member') DEFAULT 'member',
    status ENUM('active','pending','banned','left') DEFAULT 'active',
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    invited_by INT DEFAULT NULL,
    FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE KEY unique_member (group_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // GROUP INVITES
  `CREATE TABLE IF NOT EXISTS group_invites (
    id INT PRIMARY KEY AUTO_INCREMENT,
    group_id INT NOT NULL,
    inviter_id INT NOT NULL,
    invitee_id INT DEFAULT NULL,
    invitee_email VARCHAR(150) DEFAULT NULL,
    invitee_phone VARCHAR(50) DEFAULT NULL,
    token VARCHAR(64) NOT NULL UNIQUE,
    status ENUM('pending','accepted','declined','expired','revoked') DEFAULT 'pending',
    expires_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE CASCADE,
    FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (invitee_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // GROUP JOIN REQUESTS
  `CREATE TABLE IF NOT EXISTS group_join_requests (
    id INT PRIMARY KEY AUTO_INCREMENT,
    group_id INT NOT NULL,
    user_id INT NOT NULL,
    message TEXT DEFAULT NULL,
    status ENUM('pending','approved','rejected') DEFAULT 'pending',
    reviewed_by INT DEFAULT NULL,
    reviewed_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE KEY unique_request (group_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // MESSAGE STARS
  `CREATE TABLE IF NOT EXISTS message_stars (
    user_id INT NOT NULL,
    message_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, message_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // MESSAGE READS
  `CREATE TABLE IF NOT EXISTS message_reads (
    message_id INT NOT NULL,
    user_id INT NOT NULL,
    read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // CHAT POLL OPTIONS
  `CREATE TABLE IF NOT EXISTS chat_poll_options (
    id INT PRIMARY KEY AUTO_INCREMENT,
    message_id INT NOT NULL,
    text VARCHAR(120) NOT NULL,
    position TINYINT NOT NULL DEFAULT 0,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // CHAT POLL VOTES
  `CREATE TABLE IF NOT EXISTS chat_poll_votes (
    option_id INT NOT NULL,
    message_id INT NOT NULL,
    user_id INT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (option_id) REFERENCES chat_poll_options(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS device_sessions (id CHAR(36) PRIMARY KEY, token_hash CHAR(64) DEFAULT NULL, user_id INT NOT NULL, device_name VARCHAR(120) NOT NULL DEFAULT 'Unknown device', platform VARCHAR(20) NOT NULL DEFAULT 'unknown', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, last_active_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL, revoked_at DATETIME DEFAULT NULL, INDEX idx_device_sessions_user (user_id, revoked_at, last_active_at), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

// Columns added after the first release.
// [table, column, definition]

const COLUMNS = [
  ['users', 'username', 'VARCHAR(50) DEFAULT NULL'],
  ['users', 'phone', 'VARCHAR(50) DEFAULT NULL'],
  ['users', 'bio', 'TEXT DEFAULT NULL'],
  ['users', 'gender', 'VARCHAR(20) DEFAULT NULL'],
  ['users', 'birthday', 'DATE DEFAULT NULL'],
  ['users', 'push_token', 'VARCHAR(255) DEFAULT NULL'],
  ['users', 'banned', 'TINYINT(1) NOT NULL DEFAULT 0'],

  ['conversations', 'group_id', 'INT DEFAULT NULL'],
  ['conversation_participants', 'pinned', 'TINYINT(1) NOT NULL DEFAULT 0'],

  ['post_likes', 'emoji', "VARCHAR(16) CHARACTER SET utf8mb4 NOT NULL DEFAULT '❤️'"],

  ['notifications', 'group_id', 'INT DEFAULT NULL'],

  ['users', 'hide_presence', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['users', 'read_receipts', 'TINYINT(1) NOT NULL DEFAULT 1'],
  ['users', 'who_can_message', "VARCHAR(12) NOT NULL DEFAULT 'everyone'"],
  ['users', 'settings', 'TEXT NULL'],

  ['posts', 'edited_at', 'DATETIME NULL DEFAULT NULL'],

  ['messages', 'view_once', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['messages', 'opened_at', 'DATETIME NULL DEFAULT NULL'],

  ['users', 'key_backup', 'TEXT NULL'],
  ['posts', 'repost_of', 'INT NULL DEFAULT NULL'],

  ['conversation_participants', 'archived', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['conversations', 'pinned_message_id', 'INT NULL DEFAULT NULL'],

  ['messages', 'expires_at', 'DATETIME NULL DEFAULT NULL'],
  ['messages', 'forwarded', 'TINYINT(1) NOT NULL DEFAULT 0'],

  ['conversations', 'disappear_after', 'INT NULL DEFAULT NULL'],
  ['conversation_participants', 'muted_until', 'DATETIME NULL DEFAULT NULL'],

  ['users', 'public_key', 'VARCHAR(100) DEFAULT NULL'],
  ['users', 'is_private', 'TINYINT(1) NOT NULL DEFAULT 0'],

  ['post_comments', 'parent_id', 'INT DEFAULT NULL'],
  ['post_comments', 'reply_to_user_id', 'INT DEFAULT NULL'],

  ['conversations', 'avatar', 'VARCHAR(255) DEFAULT NULL'],
  ['conversations', 'created_by', 'INT DEFAULT NULL'],

  ['users', 'avatar', 'VARCHAR(255) DEFAULT NULL'],
  ['users', 'status', "VARCHAR(20) DEFAULT 'offline'"],
  ['users', 'last_seen', 'TIMESTAMP NULL DEFAULT NULL'],

  ['messages', 'type', "ENUM('text','image','file','voice','poll') DEFAULT 'text'"],
  ['messages', 'client_id', 'VARCHAR(64) NULL DEFAULT NULL'],
  ['messages', 'file_url', 'VARCHAR(500) DEFAULT NULL'],
  ['messages', 'file_name', 'VARCHAR(255) DEFAULT NULL'],
  ['messages', 'file_size', 'INT DEFAULT NULL'],
  ['messages', 'voice_duration', 'VARCHAR(10) DEFAULT NULL'],
  ['messages', 'voice_waveform', 'VARCHAR(64) DEFAULT NULL'],
  ['messages', 'reply_to', 'INT DEFAULT NULL'],
  ['messages', 'status', "ENUM('sending','sent','delivered','read') DEFAULT 'sent'"],
  ['messages', 'edited_at', 'TIMESTAMP NULL DEFAULT NULL'],
  ['messages', 'read_at', 'TIMESTAMP NULL DEFAULT NULL'],

  // Additive migration for deployments where device_sessions already exists.
  ['device_sessions', 'token_hash', 'CHAR(64) DEFAULT NULL'],
  ['device_sessions', 'device_name', "VARCHAR(120) NOT NULL DEFAULT 'Unknown device'"],
  ['device_sessions', 'platform', "VARCHAR(20) NOT NULL DEFAULT 'unknown'"],
  ['device_sessions', 'last_active_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'],
  ['device_sessions', 'expires_at', 'DATETIME NULL DEFAULT NULL'],
  ['device_sessions', 'revoked_at', 'DATETIME DEFAULT NULL'],
];

// Modifications for older database schemas
const MODIFY = [
  "ALTER TABLE notifications MODIFY type ENUM('like','comment','follow','group_invite','group_request','group_approved','mention','follow_request','follow_accepted') NOT NULL",

  'ALTER TABLE users MODIFY email VARCHAR(150) NULL',
  'ALTER TABLE users MODIFY password VARCHAR(255) NULL',

  "ALTER TABLE messages MODIFY type ENUM('text','image','file','voice','poll') DEFAULT 'text'",
  "ALTER TABLE messages MODIFY status ENUM('sending','sent','delivered','read') DEFAULT 'sent'",

  'ALTER TABLE message_reactions MODIFY emoji VARCHAR(16) CHARACTER SET utf8mb4 NOT NULL',

  "ALTER TABLE post_likes MODIFY emoji VARCHAR(16) CHARACTER SET utf8mb4 NOT NULL DEFAULT '❤️'",

  'ALTER TABLE group_invites MODIFY expires_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
];

// Indexes
// [table, index name, columns, unique]

const INDEXES = [
  ['users', 'uniq_users_phone', '(phone)', true],
  ['messages', 'uniq_messages_client', '(sender_id, client_id)', true],
  ['device_sessions', 'uniq_device_sessions_token_hash', '(token_hash)', true],

  ['message_stars', 'idx_stars_user', '(user_id, created_at)', false],
  ['message_reads', 'idx_reads_user', '(user_id)', false],
  ['chat_poll_options', 'idx_poll_opts_msg', '(message_id)', false],

  ['messages', 'idx_messages_conv_created', '(conversation_id, created_at)', false],
  ['messages', 'idx_messages_conv_status', '(conversation_id, status)', false],

  ['conversation_participants', 'idx_cp_user', '(user_id)', false],
  ['scheduled_messages', 'idx_sched_due', '(send_at)', false],

  ['reports', 'idx_reports_status', '(status, created_at)', false],
  ['post_hashtags', 'idx_hashtag_tag', '(tag)', false],
  ['stories', 'idx_stories_user', '(user_id, expires_at)', false],
  ['calls', 'idx_calls_users', '(caller_id, callee_id)', false],

  ['posts', 'idx_posts_user', '(user_id, created_at)', false],
  ['posts', 'idx_posts_created', '(created_at)', false],

  ['post_likes', 'idx_likes_post', '(post_id)', false],
  ['messages', 'idx_messages_expires', '(expires_at)', false],

  ['post_comments', 'idx_comments_post', '(post_id, created_at)', false],

  ['follows', 'idx_follows_follower', '(follower_id)', false],
  ['follows', 'idx_follows_following', '(following_id)', false],

  ['notifications', 'idx_notifications_user', '(user_id, created_at)', false],

  ['groups', 'idx_groups_type', '(type)', false],

  ['group_members', 'idx_group_members_group', '(group_id, status)', false],
  ['group_members', 'idx_group_members_user', '(user_id, status)', false],

  ['group_invites', 'idx_group_invites_invitee', '(invitee_id, status)', false],

  ['conversations', 'idx_conversations_group', '(group_id)', false],
];

// Validate identifiers used in SQL
function validateIdentifier(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9_]+$/.test(value)
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

// Check whether a column exists
async function columnExists(connection, table, column) {
  const [rows] = await connection.query(
    `SELECT 1
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
     AND TABLE_NAME = ?
     AND COLUMN_NAME = ?
     LIMIT 1`,
    [DB_NAME, table, column]
  );

  return rows.length > 0;
}

// Check whether an index exists
async function indexExists(connection, table, indexName) {
  const [rows] = await connection.query(
    `SELECT 1
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ?
     AND TABLE_NAME = ?
     AND INDEX_NAME = ?
     LIMIT 1`,
    [DB_NAME, table, indexName]
  );

  return rows.length > 0;
}

// Initialize database
async function initDatabase() {
  if (pool) return pool;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    let boot = null;
    let newPool = null;

    try {
      validateIdentifier(DB_NAME, 'database name');

      // Create database if it does not exist
      boot = await mysql.createConnection(baseConfig);

      await boot.query(
        `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
         CHARACTER SET utf8mb4
         COLLATE utf8mb4_unicode_ci`
      );

      await boot.end();
      boot = null;

      // Create connection pool
      newPool = mysql.createPool({
        ...baseConfig,
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: 10,
        maxIdle: 5,
        idleTimeout: 60000,
        queueLimit: 0,
        dateStrings: false,
      });

      // Validate table definitions
      for (let i = 0; i < TABLES.length; i++) {
        const sql = TABLES[i];

        if (typeof sql !== 'string' || !sql.trim()) {
          throw new Error(`Invalid TABLES entry at index ${i}`);
        }

        try {
          await newPool.query(sql);
        } catch (err) {
          const name =
            (sql.match(/EXISTS\s+`?(\w+)/i) || [])[1] || 'unknown';

          console.error(`Failed creating table "${name}":`, {
            code: err.code,
            message: err.sqlMessage || err.message,
          });

          throw err;
        }
      }

      console.log(`Created/verified ${TABLES.length} tables`);

      // Add missing columns
      for (const [table, column, definition] of COLUMNS) {
        validateIdentifier(table, 'table name');
        validateIdentifier(column, 'column name');

        if (!(await columnExists(newPool, table, column))) {
          await newPool.query(
            `ALTER TABLE \`${table}\`
             ADD COLUMN \`${column}\` ${definition}`
          );

          console.log(`Added column: ${table}.${column}`);
        }
      }

      // Modify old schema
      for (const sql of MODIFY) {
        try {
          await newPool.query(sql);
        } catch (err) {
          console.warn(
            'Schema modification skipped:',
            err.code,
            err.sqlMessage || err.message
          );
        }
      }

      // Normalize empty values
      await newPool.query(
        "UPDATE users SET phone = NULL WHERE phone = ''"
      );

      await newPool.query(
        "UPDATE users SET email = NULL WHERE email = ''"
      );

      // Create missing indexes
      for (const [table, name, cols, unique] of INDEXES) {
        validateIdentifier(table, 'index table');
        validateIdentifier(name, 'index name');

        if (await indexExists(newPool, table, name)) {
          continue;
        }

        try {
          await newPool.query(
            `CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\`
             ON \`${table}\` ${cols}`
          );

          console.log(`Created index: ${table}.${name}`);
        } catch (err) {
          console.warn(
            `Index skipped: ${table}.${name}`,
            err.code,
            err.sqlMessage || err.message
          );
        }
      }

      // Verify connection
      const [result] = await newPool.query(
        'SELECT VERSION() AS version, DATABASE() AS database_name'
      );

      pool = newPool;

      console.log('================================');
      console.log('MySQL Database Ready');
      console.log('Database:', result[0].database_name);
      console.log('MySQL:', result[0].version);
      console.log('Tables:', TABLES.length);
      console.log('================================');

      return pool;

    } catch (err) {
      if (newPool) {
        await newPool.end().catch(() => {});
      }

      console.error('Database initialization failed:', {
        code: err.code,
        message: err.sqlMessage || err.message,
      });

      throw err;

    } finally {
      if (boot) {
        await boot.end().catch(() => {});
      }
    }
  })();

  try {
    return await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

// Database proxy
const proxy = {

  query: (...args) => {
    if (!pool) {
      throw new Error('Database not initialized. Call initDatabase() first.');
    }

    return pool.query(...args);
  },

  execute: (...args) => {
    if (!pool) {
      throw new Error('Database not initialized. Call initDatabase() first.');
    }

    return pool.execute(...args);
  },

  getConnection: () => {
    if (!pool) {
      throw new Error('Database not initialized. Call initDatabase() first.');
    }

    return pool.getConnection();
  },

  end: async () => {
    if (pool) {
      const currentPool = pool;

      pool = null;
      initPromise = null;

      await currentPool.end();
    }
  },

  isReady: () => Boolean(pool),

  initDatabase,

};

module.exports = proxy;
