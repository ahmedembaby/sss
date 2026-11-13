const express = require('express');
const pool = require('../db');
const rt = require('../services/realtime');
const { pushToUsers } = require('../services/push');
const { adminMiddleware, isAdminId, isAdminUser } = require('../middleware/auth');
const { participantIds } = require('../services/chat');

const router = express.Router();
router.use(adminMiddleware); // mounted behind authMiddleware in index.js

// audit log: every successful change made from the dashboard is recorded
router.use((req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const body = { ...req.body };
      for (const key of ['password', 'body', 'token', 'otp', 'secret', 'authorization']) delete body[key];
      const details = Object.keys(body).length ? JSON.stringify(body).slice(0, 500) : null;
      pool.query('INSERT INTO admin_audit (admin_id, method, path, details) VALUES (?, ?, ?, ?)',
        [req.user.id, req.method, req.originalUrl.slice(0, 200), details]).catch(() => {});
    });
  }
  next();
});

router.get('/audit', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT a.*, u.name AS admin_name FROM admin_audit a JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT 200');
    res.json(rows);
  } catch { res.status(500).json({ message: 'Could not load the audit log' }); }
});

// banned words (rejected in posts and comments)
router.get('/banned-words', async (req, res) => {
  try { res.json((await pool.query('SELECT word FROM banned_words ORDER BY word'))[0].map((r) => r.word)); }
  catch { res.status(500).json({ message: 'Could not load words' }); }
});
router.post('/banned-words', async (req, res) => {
  try {
    const word = String(req.body.word || '').trim().toLowerCase().slice(0, 60);
    if (word.length < 2) return res.status(400).json({ message: 'Word is too short' });
    await pool.query('INSERT IGNORE INTO banned_words (word) VALUES (?)', [word]);
    require('../services/wordfilter').refresh();
    res.status(201).json({ word });
  } catch { res.status(500).json({ message: 'Could not add word' }); }
});
router.delete('/banned-words/:word', async (req, res) => {
  try {
    await pool.query('DELETE FROM banned_words WHERE word = ?', [req.params.word]);
    require('../services/wordfilter').refresh();
    res.json({ ok: true });
  } catch { res.status(500).json({ message: 'Could not remove word' }); }
});

router.get('/stats', async (req, res) => {
  try {
    const [[u]] = await pool.query('SELECT COUNT(*) AS c FROM users');
    const [[c]] = await pool.query('SELECT COUNT(*) AS c FROM conversations');
    const [[m]] = await pool.query('SELECT COUNT(*) AS c FROM messages');
    const [[p]] = await pool.query('SELECT COUNT(*) AS c FROM posts');
    const [[g]] = await pool.query('SELECT COUNT(*) AS c FROM `groups`');
    const [[bn]] = await pool.query('SELECT COUNT(*) AS c FROM users WHERE banned = 1');
    const [[nt]] = await pool.query('SELECT COUNT(*) AS c FROM users WHERE created_at >= CURDATE()');
    const [[mt]] = await pool.query('SELECT COUNT(*) AS c FROM messages WHERE created_at >= CURDATE()');
    const [[or]] = await pool.query("SELECT COUNT(*) AS c FROM reports WHERE status = 'open'");
    const series = async (table) => {
      const [rows] = await pool.query(
        `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS d, COUNT(*) AS c FROM ${table}
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) GROUP BY d`
      );
      const map = new Map(rows.map((r) => [r.d, Number(r.c)]));
      const out = [];
      for (let i = 6; i >= 0; i--) {
        const dt = new Date(Date.now() - i * 86400000);
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        out.push({ date: key, count: map.get(key) || 0 });
      }
      return out;
    };
    res.json({
      bannedUsers: bn.c,
      newUsersToday: nt.c,
      messagesToday: mt.c,
      openReports: or.c,
      activity: { users: await series('users'), messages: await series('messages'), posts: await series('posts') },
      totalUsers: u.c,
      totalConversations: c.c,
      totalMessages: m.c,
      totalPosts: p.c,
      totalGroups: g.c,
      onlineUsers: [...rt.online.values()].filter((n) => n > 0).length,
    });
  } catch (err) {
    res.status(500).json({ message: 'Could not load stats' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const filter = String(req.query.filter || 'all');
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const where = [];
    const args = [];
    if (q) {
      where.push('(name LIKE ? OR username LIKE ? OR email LIKE ? OR phone LIKE ?)');
      args.push(...Array(4).fill(`%${q}%`));
    }
    if (filter === 'banned') where.push('banned = 1');
    if (filter === 'online') where.push("status = 'online'");
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[t]] = await pool.query(`SELECT COUNT(*) AS c FROM users ${w}`, args);
    const [users] = await pool.query(
      `SELECT id, name, username, email, phone, avatar, status, banned, last_seen, created_at FROM users ${w}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...args, limit, offset]
    );
    res.json({ total: t.c, users: users.map((u) => ({ ...u, banned: !!u.banned, is_admin: isAdminUser(u) })) });
  } catch (err) {
    res.status(500).json({ message: 'Could not load users' });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query(
      'SELECT id, name, username, email, phone, avatar, bio, status, banned, last_seen, created_at FROM users WHERE id = ?', [id]
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    const one = async (sql) => (await pool.query(sql, [id]))[0][0].c;
    res.json({
      ...rows[0],
      banned: !!rows[0].banned,
      is_admin: isAdminUser(rows[0]),
      stats: {
        posts: await one('SELECT COUNT(*) AS c FROM posts WHERE user_id = ?'),
        messages: await one('SELECT COUNT(*) AS c FROM messages WHERE sender_id = ?'),
        followers: await one('SELECT COUNT(*) AS c FROM follows WHERE following_id = ?'),
        following: await one('SELECT COUNT(*) AS c FROM follows WHERE follower_id = ?'),
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Could not load user' });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (await isAdminId(id)) return res.status(400).json({ message: 'Admins cannot be deleted' });
    rt.disconnectUser(id);
    const [r] = await pool.query('DELETE FROM users WHERE id = ?', [id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('admin delete user:', err.message);
    res.status(500).json({ message: 'Could not delete user' });
  }
});

router.get('/posts', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const w = q ? 'WHERE p.content LIKE ? OR u.name LIKE ? OR u.username LIKE ?' : '';
    const args = q ? Array(3).fill(`%${q}%`) : [];
    const [rows] = await pool.query(
      `SELECT p.id, p.content, p.image_url AS image, (SELECT COUNT(*) FROM post_images pi WHERE pi.post_id = p.id) AS image_count, p.created_at, u.id AS user_id, u.name AS user_name, u.username,
              (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes_count,
              (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comments_count
       FROM posts p JOIN users u ON u.id = p.user_id ${w}
       ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
      [...args, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Could not load posts' });
  }
});

router.delete('/posts/:id', async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM posts WHERE id = ?', [Number(req.params.id)]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Post not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Could not delete post' });
  }
});

router.get('/groups', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT g.id, g.name, g.type, g.created_at, u.name AS owner_name,
              (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'active') AS member_count
       FROM \`groups\` g LEFT JOIN users u ON u.id = g.created_by ORDER BY g.created_at DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Could not load groups' });
  }
});

router.delete('/groups/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [convs] = await pool.query('SELECT id FROM conversations WHERE group_id = ?', [id]);
    for (const c of convs) rt.emitToUsers(await participantIds(c.id), 'conversation_removed', { group_id: id, conversation_id: c.id });
    await pool.query('DELETE FROM conversations WHERE group_id = ?', [id]);
    const [r] = await pool.query('DELETE FROM `groups` WHERE id = ?', [id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Group not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('admin delete group:', err.message);
    res.status(500).json({ message: 'Could not delete group' });
  }
});

router.get('/conversations', async (req, res) => {
  try {
    const [convs] = await pool.query(
      `SELECT c.id, c.name, c.type, c.created_at, COUNT(cp.user_id) AS participant_count,
              (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_message_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c LEFT JOIN conversation_participants cp ON c.id = cp.conversation_id
       GROUP BY c.id ORDER BY c.created_at DESC LIMIT 500`
    );
    res.json(convs);
  } catch (err) {
    res.status(500).json({ message: 'Could not load conversations' });
  }
});

router.delete('/conversations/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [found] = await pool.query('SELECT group_id FROM conversations WHERE id = ?', [id]);
    if (found[0] && found[0].group_id) return res.status(400).json({ message: 'Delete the group instead' });
    rt.emitToUsers(await participantIds(id), 'conversation_removed', { conversation_id: id });
    const [r] = await pool.query('DELETE FROM conversations WHERE id = ?', [id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Conversation not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Could not delete conversation' });
  }
});

router.post('/broadcast', async (req, res) => {
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();
  if (!title || !body) return res.status(400).json({ message: 'Title and body are required' });
  try {
    const [users] = await pool.query('SELECT id FROM users WHERE banned = 0');
    const ids = users.map((u) => u.id);
    rt.emitToUsers(ids, 'broadcast', { title, body });
    await pushToUsers(ids, { title, body, data: { type: 'broadcast' } });
    res.json({ success: true, message: `Broadcast sent to ${ids.length} users`, count: ids.length });
  } catch (err) {
    res.status(500).json({ message: 'Broadcast failed' });
  }
});

// --- reports from users ---
router.get('/reports', async (req, res) => {
  try {
    const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
    const [rows] = await pool.query(
      `SELECT r.*, u.name AS reporter_name, u.username AS reporter_username FROM reports r JOIN users u ON u.id = r.reporter_id
       WHERE r.status = ? ORDER BY r.id DESC LIMIT 200`, [status]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Could not load reports' });
  }
});

// { status: 'resolved' | 'dismissed', delete_content?: true }
router.post('/reports/:id/resolve', async (req, res) => {
  try {
    const reportId = Number(req.params.id);
    if (!Number.isSafeInteger(reportId) || reportId < 1) return res.status(400).json({ message: 'Invalid report id' });
    const [rows] = await pool.query('SELECT * FROM reports WHERE id = ?', [reportId]);
    if (!rows.length) return res.status(404).json({ message: 'Report not found' });
    const r = rows[0];
    if (req.body.delete_content === true) {
      const t = { post: 'posts', message: 'messages', story: 'stories' }[r.target_type];
      if (r.target_type === 'comment') {
        // Replies have no parent_id foreign key; remove them explicitly with the parent.
        await pool.query('DELETE FROM post_comments WHERE id = ? OR parent_id = ?', [r.target_id, r.target_id]);
      } else if (t) {
        await pool.query(`DELETE FROM ${t} WHERE id = ?`, [r.target_id]);
      }
    }
    await pool.query('UPDATE reports SET status = ? WHERE id = ?', [req.body.status === 'dismissed' ? 'dismissed' : 'resolved', r.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Could not update report' });
  }
});

// Toggles the ban state (or sets it with { banned: true|false })
router.post('/users/:id/ban', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (await isAdminId(id)) return res.status(400).json({ message: 'Admins cannot be banned' });
    const [rows] = await pool.query('SELECT banned FROM users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    const banned = typeof req.body.banned === 'boolean' ? req.body.banned : !rows[0].banned;
    await pool.query('UPDATE users SET banned = ?, push_token = IF(?, NULL, push_token) WHERE id = ?', [banned ? 1 : 0, banned ? 1 : 0, id]);
    if (banned) rt.disconnectUser(id);
    res.json({ success: true, banned });
  } catch (err) {
    res.status(500).json({ message: 'Could not update user' });
  }
});

module.exports = router;
