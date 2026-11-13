const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const upload = require('../middleware/upload');
const rt = require('../services/realtime');
const { pushToUsers } = require('../services/push');
const { notify } = require('../services/notify');
const { toInt } = require('../utils/format');

const router = express.Router();

const MANAGE = ['owner', 'admin'];
const MODERATE = ['owner', 'admin', 'moderator'];

// ---------- helpers ----------
const getMember = async (groupId, userId) => {
  const [rows] = await pool.query('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
  return rows[0] || null;
};
const getGroupRow = async (id) => {
  const [rows] = await pool.query('SELECT * FROM `groups` WHERE id = ?', [id]);
  return rows[0] || null;
};
const isActive = (m) => !!m && m.status === 'active';

const GROUP_SELECT = `
  SELECT g.*,
    (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id AND x.status = 'active') AS member_count,
    gm.role AS role, gm.status AS member_status,
    (SELECT c.id FROM conversations c WHERE c.group_id = g.id LIMIT 1) AS conversation_id
  FROM \`groups\` g
  LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?`;

const shape = (g) => g && ({
  ...g,
  member_count: Number(g.member_count) || 0,
  user_role: g.role || null, // legacy aliases
  user_status: g.member_status || null,
  is_member: g.member_status === 'active',
  // only members may open the group chat
  conversation_id: g.member_status === 'active' ? g.conversation_id : null,
});

const loadGroup = async (id, viewerId) => {
  const [rows] = await pool.query(`${GROUP_SELECT} WHERE g.id = ?`, [viewerId, id]);
  return shape(rows[0]);
};

// Group <-> chat conversation sync
async function ensureConversation(group) {
  const [rows] = await pool.query('SELECT id FROM conversations WHERE group_id = ?', [group.id]);
  if (rows.length) return rows[0].id;
  const [r] = await pool.query("INSERT INTO conversations (name, avatar, type, created_by, group_id) VALUES (?, ?, 'group', ?, ?)", [
    group.name, group.avatar, group.created_by, group.id,
  ]);
  return r.insertId;
}
async function addToChat(group, userId) {
  const convId = await ensureConversation(group);
  await pool.query('INSERT IGNORE INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)', [convId, userId]);
  const conv = require('./conversations');
  const [item] = await conv.loadConversations(userId, convId);
  if (item) rt.emitToUser(userId, 'conversation_updated', item);
  return convId;
}
async function removeFromChat(groupId, userId) {
  await pool.query(
    'DELETE cp FROM conversation_participants cp JOIN conversations c ON c.id = cp.conversation_id WHERE c.group_id = ? AND cp.user_id = ?',
    [groupId, userId]
  );
  rt.emitToUser(userId, 'conversation_removed', { group_id: Number(groupId) });
}
const notifyUsers = (ids, group, body) =>
  pushToUsers(ids, { title: group.name, body, data: { type: 'group', groupId: group.id } }).catch(() => {});

// ---------- lists (must come before /:id) ----------
// My groups (active or pending)
router.get('/', async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 100, 1, 200);
    const offset = toInt(req.query.offset, 0, 0, 100000);
    const [rows] = await pool.query(
      `${GROUP_SELECT} WHERE gm.status IN ('active','pending') ORDER BY g.updated_at DESC, g.id DESC LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );
    res.json(rows.map(shape));
  } catch (err) {
    console.error('groups list:', err.message);
    res.status(500).json({ message: 'Could not load groups' });
  }
});

// Groups I can join (public + private, never secret)
router.get('/discover', async (req, res) => {
  try {
    const limit = toInt(req.query.limit, 50, 1, 100);
    const offset = toInt(req.query.offset, 0, 0, 100000);
    const params = [req.user.id];
    let where = "g.type IN ('public','private') AND (gm.id IS NULL OR gm.status = 'left')";
    if (req.query.type === 'public' || req.query.type === 'private') { where += ' AND g.type = ?'; params.push(req.query.type); }
    if (req.query.q) { where += ' AND g.name LIKE ?'; params.push(`%${String(req.query.q).trim()}%`); }
    params.push(limit, offset);
    const [rows] = await pool.query(`${GROUP_SELECT} WHERE ${where} ORDER BY member_count DESC, g.id DESC LIMIT ? OFFSET ?`, params);
    res.json(rows.map(shape));
  } catch (err) {
    res.status(500).json({ message: 'Could not load groups' });
  }
});

// My pending invitations
router.get('/invites', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT i.*, g.name AS group_name, g.avatar AS group_avatar, g.type AS group_type, u.name AS inviter_name
       FROM group_invites i JOIN \`groups\` g ON g.id = i.group_id JOIN users u ON u.id = i.inviter_id
       WHERE i.invitee_id = ? AND i.status = 'pending' AND i.expires_at > NOW() ORDER BY i.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Could not load invitations' });
  }
});

const loadInvite = async (token) => {
  const [rows] = await pool.query(
    `SELECT i.*, g.name AS group_name, g.avatar AS group_avatar, g.type AS group_type, u.name AS inviter_name
     FROM group_invites i JOIN \`groups\` g ON g.id = i.group_id JOIN users u ON u.id = i.inviter_id WHERE i.token = ?`,
    [token]
  );
  return rows[0] || null;
};
const canUseInvite = (inv, userId) => inv && (inv.invitee_id === null || inv.invitee_id === userId);

router.get('/invites/:token', async (req, res) => {
  try {
    const inv = await loadInvite(req.params.token);
    if (!canUseInvite(inv, req.user.id)) return res.status(404).json({ message: 'Invitation not found' });
    if (inv.status === 'pending' && new Date(inv.expires_at) < new Date()) inv.status = 'expired';
    res.json(inv);
  } catch (err) {
    res.status(500).json({ message: 'Could not load invitation' });
  }
});

router.post('/invites/:token/accept', async (req, res) => {
  try {
    const inv = await loadInvite(req.params.token);
    if (!canUseInvite(inv, req.user.id)) return res.status(404).json({ message: 'Invitation not found' });
    if (inv.status !== 'pending' || new Date(inv.expires_at) < new Date()) return res.status(410).json({ message: 'Invitation is no longer valid' });
    const existing = await getMember(inv.group_id, req.user.id);
    if (existing && existing.status === 'banned') return res.status(403).json({ message: 'You are banned from this group' });
    await pool.query(
      `INSERT INTO group_members (group_id, user_id, role, status, invited_by) VALUES (?, ?, 'member', 'active', ?)
       ON DUPLICATE KEY UPDATE status = 'active', role = IF(role IN ('owner','admin','moderator'), role, 'member')`,
      [inv.group_id, req.user.id, inv.inviter_id]
    );
    await pool.query("UPDATE group_invites SET status = 'accepted', invitee_id = ? WHERE id = ?", [req.user.id, inv.id]);
    await pool.query('UPDATE group_join_requests SET status = "approved" WHERE group_id = ? AND user_id = ? AND status = "pending"', [inv.group_id, req.user.id]);
    await addToChat(await getGroupRow(inv.group_id), req.user.id);
    res.json(await loadGroup(inv.group_id, req.user.id));
  } catch (err) {
    console.error('accept invite:', err.message);
    res.status(500).json({ message: 'Could not accept invitation' });
  }
});

router.post('/invites/:token/decline', async (req, res) => {
  try {
    const inv = await loadInvite(req.params.token);
    if (!canUseInvite(inv, req.user.id)) return res.status(404).json({ message: 'Invitation not found' });
    await pool.query("UPDATE group_invites SET status = 'declined' WHERE id = ? AND status = 'pending'", [inv.id]);
    res.json({ message: 'Invitation declined' });
  } catch (err) {
    res.status(500).json({ message: 'Could not decline invitation' });
  }
});

// ---------- create ----------
router.post('/', upload.group.single('avatar'), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Group name is required' });
    const type = ['public', 'private', 'secret'].includes(req.body.type) ? req.body.type : 'private';
    const avatar = req.file ? `/uploads/groups/${req.file.filename}` : null;
    const description = req.body.description ? String(req.body.description).slice(0, 500) : null;

    const [r] = await pool.query(
      'INSERT INTO `groups` (name, description, type, avatar, created_by, settings) VALUES (?, ?, ?, ?, ?, ?)',
      [name.slice(0, 150), description, type, avatar, req.user.id, JSON.stringify({})]
    );
    await pool.query("INSERT INTO group_members (group_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')", [r.insertId, req.user.id]);
    await addToChat(await getGroupRow(r.insertId), req.user.id);
    res.status(201).json(await loadGroup(r.insertId, req.user.id));
  } catch (err) {
    console.error('create group:', err.message);
    res.status(500).json({ message: 'Could not create group' });
  }
});

// ---------- single group ----------
router.get('/:id', async (req, res) => {
  try {
    const g = await loadGroup(req.params.id, req.user.id);
    if (!g) return res.status(404).json({ message: 'Group not found' });
    if (g.type === 'secret' && !g.member_status) return res.status(404).json({ message: 'Group not found' });
    res.json(g);
  } catch (err) {
    res.status(500).json({ message: 'Could not load group' });
  }
});

router.put('/:id', upload.group.single('avatar'), async (req, res) => {
  try {
    const member = await getMember(req.params.id, req.user.id);
    if (!isActive(member) || !MANAGE.includes(member.role)) return res.status(403).json({ message: 'Only owners and admins can edit the group' });
    const fields = [];
    const params = [];
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ message: 'Group name cannot be empty' });
      fields.push('name = ?'); params.push(name.slice(0, 150));
    }
    if (req.body.description !== undefined) { fields.push('description = ?'); params.push(String(req.body.description).slice(0, 500) || null); }
    if (['public', 'private', 'secret'].includes(req.body.type)) { fields.push('type = ?'); params.push(req.body.type); }
    if (req.body.settings) {
      try { JSON.parse(req.body.settings); fields.push('settings = ?'); params.push(req.body.settings); } catch { return res.status(400).json({ message: 'Invalid settings' }); }
    }
    if (req.file) { fields.push('avatar = ?'); params.push(`/uploads/groups/${req.file.filename}`); }
    if (!fields.length) return res.status(400).json({ message: 'Nothing to update' });
    await pool.query(`UPDATE \`groups\` SET ${fields.join(', ')} WHERE id = ?`, [...params, req.params.id]);
    const g = await getGroupRow(req.params.id);
    await pool.query('UPDATE conversations SET name = ?, avatar = ? WHERE group_id = ?', [g.name, g.avatar, g.id]);
    res.json(await loadGroup(req.params.id, req.user.id));
  } catch (err) {
    console.error('update group:', err.message);
    res.status(500).json({ message: 'Could not update group' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const member = await getMember(req.params.id, req.user.id);
    if (!isActive(member) || member.role !== 'owner') return res.status(403).json({ message: 'Only the owner can delete the group' });
    await pool.query('DELETE FROM conversations WHERE group_id = ?', [req.params.id]);
    await pool.query('DELETE FROM `groups` WHERE id = ?', [req.params.id]);
    res.json({ message: 'Group deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Could not delete group' });
  }
});

// ---------- members ----------
router.get('/:id/members', async (req, res) => {
  try {
    const group = await getGroupRow(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    const me = await getMember(group.id, req.user.id);
    if (group.type !== 'public' && !isActive(me)) return res.status(403).json({ message: 'Members only' });
    const params = [group.id];
    let where = 'gm.group_id = ?';
    // pending / banned members are only visible to moderators
    const status = req.query.status && isActive(me) && MODERATE.includes(me.role) ? req.query.status : 'active';
    where += ' AND gm.status = ?'; params.push(status);
    if (req.query.role) { where += ' AND gm.role = ?'; params.push(req.query.role); }
    params.push(toInt(req.query.limit, 200, 1, 500), toInt(req.query.offset, 0, 0, 100000));
    const [rows] = await pool.query(
      `SELECT gm.id, gm.group_id, gm.user_id, gm.role, gm.status, gm.joined_at, gm.invited_by, u.name, u.avatar, u.username
       FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE ${where}
       ORDER BY FIELD(gm.role, 'owner','admin','moderator','member'), u.name LIMIT ? OFFSET ?`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Could not load members' });
  }
});

router.put('/:id/members/:userId', async (req, res) => {
  try {
    const role = req.body.role;
    if (!['admin', 'moderator', 'member'].includes(role)) return res.status(400).json({ message: 'Invalid role' });
    const me = await getMember(req.params.id, req.user.id);
    if (!isActive(me) || me.role !== 'owner') return res.status(403).json({ message: 'Only the owner can change roles' });
    const target = await getMember(req.params.id, req.params.userId);
    if (!isActive(target)) return res.status(404).json({ message: 'Member not found' });
    if (target.role === 'owner') return res.status(400).json({ message: 'Transfer ownership instead' });
    await pool.query('UPDATE group_members SET role = ? WHERE id = ?', [role, target.id]);
    res.json({ message: 'Role updated' });
  } catch (err) {
    res.status(500).json({ message: 'Could not update member' });
  }
});

router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const me = await getMember(req.params.id, req.user.id);
    if (!isActive(me) || !MODERATE.includes(me.role)) return res.status(403).json({ message: 'Not allowed' });
    const target = await getMember(req.params.id, req.params.userId);
    if (!target || target.status !== 'active') return res.status(404).json({ message: 'Member not found' });
    if (target.role === 'owner' || (target.role !== 'member' && me.role !== 'owner') || (target.role === 'moderator' && me.role === 'moderator')) {
      return res.status(403).json({ message: 'You cannot remove this member' });
    }
    await pool.query("UPDATE group_members SET status = 'left' WHERE id = ?", [target.id]);
    await removeFromChat(req.params.id, target.user_id);
    res.json({ message: 'Member removed' });
  } catch (err) {
    res.status(500).json({ message: 'Could not remove member' });
  }
});

router.post('/:id/ban/:userId', async (req, res) => {
  try {
    const me = await getMember(req.params.id, req.user.id);
    if (!isActive(me) || !MANAGE.includes(me.role)) return res.status(403).json({ message: 'Only owners and admins can ban members' });
    const target = await getMember(req.params.id, req.params.userId);
    if (!target) return res.status(404).json({ message: 'Member not found' });
    if (target.role === 'owner' || (target.role === 'admin' && me.role !== 'owner')) return res.status(403).json({ message: 'You cannot ban this member' });
    await pool.query("UPDATE group_members SET status = 'banned' WHERE id = ?", [target.id]);
    await removeFromChat(req.params.id, target.user_id);
    res.json({ message: 'Member banned' });
  } catch (err) {
    res.status(500).json({ message: 'Could not ban member' });
  }
});

router.post('/:id/transfer-ownership', async (req, res) => {
  try {
    const me = await getMember(req.params.id, req.user.id);
    if (!isActive(me) || me.role !== 'owner') return res.status(403).json({ message: 'Only the owner can transfer ownership' });
    const target = await getMember(req.params.id, req.body.user_id);
    if (!isActive(target) || target.user_id === req.user.id) return res.status(400).json({ message: 'Choose another active member' });
    await pool.query("UPDATE group_members SET role = 'owner' WHERE id = ?", [target.id]);
    await pool.query("UPDATE group_members SET role = 'admin' WHERE id = ?", [me.id]);
    await pool.query('UPDATE `groups` SET created_by = ? WHERE id = ?', [target.user_id, req.params.id]);
    res.json({ message: 'Ownership transferred' });
  } catch (err) {
    res.status(500).json({ message: 'Could not transfer ownership' });
  }
});

// ---------- joining / leaving ----------
async function joinHandler(req, res) {
  try {
    const group = await getGroupRow(req.params.id);
    if (!group || group.type === 'secret') return res.status(404).json({ message: 'Group not found' });
    const existing = await getMember(group.id, req.user.id);
    if (existing && existing.status === 'banned') return res.status(403).json({ message: 'You are banned from this group' });
    if (existing && existing.status === 'active') return res.status(409).json({ message: 'Already a member' });
    if (existing && existing.status === 'pending') return res.json({ status: 'pending', message: 'Join request already sent' });

    if (group.type === 'public') {
      await pool.query(
        `INSERT INTO group_members (group_id, user_id, role, status) VALUES (?, ?, 'member', 'active')
         ON DUPLICATE KEY UPDATE status = 'active', role = 'member'`,
        [group.id, req.user.id]
      );
      await addToChat(group, req.user.id);
      return res.json({ status: 'active', message: 'Joined group' });
    }
    // private: needs approval
    await pool.query(
      `INSERT INTO group_members (group_id, user_id, role, status) VALUES (?, ?, 'member', 'pending')
       ON DUPLICATE KEY UPDATE status = 'pending', role = 'member'`,
      [group.id, req.user.id]
    );
    await pool.query(
      `INSERT INTO group_join_requests (group_id, user_id, message, status) VALUES (?, ?, ?, 'pending')
       ON DUPLICATE KEY UPDATE status = 'pending', message = VALUES(message), reviewed_by = NULL, reviewed_at = NULL, created_at = NOW()`,
      [group.id, req.user.id, req.body.message ? String(req.body.message).slice(0, 300) : null]
    );
    const [mods] = await pool.query("SELECT user_id FROM group_members WHERE group_id = ? AND status = 'active' AND role IN ('owner','admin','moderator')", [group.id]);
    for (const m of mods) await notify(m.user_id, 'group_request', req.user, { groupId: group.id, text: `asked to join ${group.name}` });
    mods.forEach((m) => rt.emitToUser(m.user_id, 'group_join_request', { group_id: group.id }));
    res.json({ status: 'pending', message: 'Join request sent' });
  } catch (err) {
    console.error('join group:', err.message);
    res.status(500).json({ message: 'Could not join group' });
  }
}
router.post('/:id/join', joinHandler);
router.post('/:id/join-request', joinHandler);

router.post('/:id/leave', async (req, res) => {
  try {
    const me = await getMember(req.params.id, req.user.id);
    if (!me || !['active', 'pending'].includes(me.status)) return res.status(404).json({ message: 'You are not a member of this group' });
    if (me.role === 'owner') {
      const [others] = await pool.query("SELECT COUNT(*) AS c FROM group_members WHERE group_id = ? AND status = 'active' AND user_id <> ?", [req.params.id, req.user.id]);
      if (others[0].c > 0) return res.status(400).json({ message: 'Transfer ownership before leaving the group' });
      // last member: remove the group completely
      await pool.query('DELETE FROM conversations WHERE group_id = ?', [req.params.id]);
      await pool.query('DELETE FROM `groups` WHERE id = ?', [req.params.id]);
      return res.json({ message: 'Group deleted' });
    }
    await pool.query("UPDATE group_members SET status = 'left' WHERE id = ?", [me.id]);
    await pool.query("UPDATE group_join_requests SET status = 'rejected' WHERE group_id = ? AND user_id = ? AND status = 'pending'", [req.params.id, req.user.id]);
    await removeFromChat(req.params.id, req.user.id);
    res.json({ message: 'You left the group' });
  } catch (err) {
    res.status(500).json({ message: 'Could not leave group' });
  }
});

// ---------- invites ----------
router.post('/:id/invite', async (req, res) => {
  try {
    const me = await getMember(req.params.id, req.user.id);
    if (!isActive(me) || !MODERATE.includes(me.role)) return res.status(403).json({ message: 'Not allowed to invite' });
    const group = await getGroupRow(req.params.id);
    const ids = [...new Set((req.body.user_ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== req.user.id))];
    const invites = [];
    for (const uid of ids) {
      const [u] = await pool.query('SELECT id FROM users WHERE id = ? AND banned = 0', [uid]);
      if (!u.length) continue;
      const m = await getMember(group.id, uid);
      if (m && (m.status === 'active' || m.status === 'banned')) continue;
      const token = crypto.randomBytes(24).toString('hex');
      await pool.query(
        "INSERT INTO group_invites (group_id, inviter_id, invitee_id, token, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))",
        [group.id, req.user.id, uid, token]
      );
      invites.push({ user_id: uid, token });
      rt.emitToUser(uid, 'group_invite', { group_id: group.id, token });
    }
    for (const i of invites) await notify(i.user_id, 'group_invite', req.user, { groupId: group.id, text: `invited you to join ${group.name}` });
    res.status(201).json({ invites });
  } catch (err) {
    console.error('invite:', err.message);
    res.status(500).json({ message: 'Could not send invitations' });
  }
});

// ---------- join requests ----------
router.get('/:id/join-requests', async (req, res) => {
  try {
    const me = await getMember(req.params.id, req.user.id);
    if (!isActive(me) || !MODERATE.includes(me.role)) return res.status(403).json({ message: 'Not allowed' });
    const [rows] = await pool.query(
      `SELECT r.*, u.name, u.avatar, u.username FROM group_join_requests r JOIN users u ON u.id = r.user_id
       WHERE r.group_id = ? AND r.status = 'pending' ORDER BY r.created_at`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Could not load requests' });
  }
});

router.post('/:id/join-requests/:requestId', async (req, res) => {
  try {
    const action = req.body.action;
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ message: 'action must be approve or reject' });
    const me = await getMember(req.params.id, req.user.id);
    if (!isActive(me) || !MODERATE.includes(me.role)) return res.status(403).json({ message: 'Not allowed' });
    const [rows] = await pool.query("SELECT * FROM group_join_requests WHERE id = ? AND group_id = ? AND status = 'pending'", [req.params.requestId, req.params.id]);
    const request = rows[0];
    if (!request) return res.status(404).json({ message: 'Request not found' });
    const group = await getGroupRow(req.params.id);

    await pool.query('UPDATE group_join_requests SET status = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?', [
      action === 'approve' ? 'approved' : 'rejected', req.user.id, request.id,
    ]);
    if (action === 'approve') {
      await pool.query("UPDATE group_members SET status = 'active' WHERE group_id = ? AND user_id = ? AND status = 'pending'", [group.id, request.user_id]);
      await addToChat(group, request.user_id);
      await notify(request.user_id, 'group_approved', req.user, { groupId: group.id, text: `approved your request to join ${group.name}` });
    } else {
      await pool.query("UPDATE group_members SET status = 'left' WHERE group_id = ? AND user_id = ? AND status = 'pending'", [group.id, request.user_id]);
    }
    res.json({ message: action === 'approve' ? 'Request approved' : 'Request rejected' });
  } catch (err) {
    console.error('join request:', err.message);
    res.status(500).json({ message: 'Could not process request' });
  }
});

module.exports = router;
