// WebRTC signalling over socket.io. Media flows peer-to-peer (TURN relays when needed); the server only relays
// offers/answers/ICE candidates and keeps a call log.
const pool = require('../db');
const rt = require('./realtime');
const { pushToUsers } = require('./push');

const RING_MS = 45 * 1000;
const calls = new Map(); // callId -> { caller, callee, type, answeredAt, timer }
const busy = new Map(); // userId -> callId

const other = (c, id) => (c.caller === id ? c.callee : c.caller);

async function finish(callId, status, notifyIds = []) {
  const c = calls.get(callId);
  if (!c) return;
  clearTimeout(c.timer);
  calls.delete(callId);
  busy.delete(c.caller);
  busy.delete(c.callee);
  const duration = c.answeredAt ? Math.round((Date.now() - c.answeredAt) / 1000) : 0;
  try {
    await pool.query('UPDATE calls SET status = ?, duration = ? WHERE id = ?', [status, duration, callId]);
  } catch (e) { console.warn('call log:', e.message); }
  for (const uid of notifyIds) rt.emitToUser(uid, 'call:ended', { callId, status, duration });
}

function register(socket) {
  const me = socket.user.id;
  const ack = (cb, payload) => typeof cb === 'function' && cb(payload);

  socket.on('call:invite', async ({ to, type, offer } = {}, cb) => {
    try {
      to = Number(to);
      if (!to || to === me || !offer) return ack(cb, { error: 'Invalid call' });
      if (busy.has(me)) return ack(cb, { error: 'You are already in a call' });
      const [u] = await pool.query('SELECT id FROM users WHERE id = ? AND banned = 0', [to]);
      if (!u.length) return ack(cb, { error: 'User not found' });
      if (busy.has(to)) return ack(cb, { error: 'busy' });
      const callType = type === 'video' ? 'video' : 'audio';
      const [r] = await pool.query('INSERT INTO calls (caller_id, callee_id, type) VALUES (?, ?, ?)', [me, to, callType]);
      const callId = r.insertId;
      const timer = setTimeout(() => finish(callId, 'missed', [me, to]), RING_MS);
      calls.set(callId, { caller: me, callee: to, type: callType, answeredAt: null, timer });
      busy.set(me, callId);
      busy.set(to, callId);
      rt.emitToUser(to, 'call:incoming', {
        callId, type: callType, offer,
        from: { id: me, name: socket.user.name, avatar: socket.user.avatar || null },
      });
      if (!rt.isOnline(to)) {
        pushToUsers([to], {
          title: socket.user.name, body: callType === 'video' ? 'Incoming video call' : 'Incoming voice call',
          data: { type: 'call', callId },
        }).catch(() => {});
      }
      ack(cb, { callId });
    } catch (e) {
      console.warn('call:invite', e.message);
      ack(cb, { error: 'Could not start call' });
    }
  });

  socket.on('call:answer', async ({ callId, answer } = {}) => {
    const c = calls.get(Number(callId));
    if (!c || c.callee !== me || c.answeredAt || !answer) return;
    clearTimeout(c.timer);
    c.answeredAt = Date.now();
    c.timer = null;
    pool.query("UPDATE calls SET status = 'active', answered_at = NOW() WHERE id = ?", [callId]).catch(() => {});
    rt.emitToUser(c.caller, 'call:answered', { callId: Number(callId), answer });
    // other devices of the callee stop ringing
    rt.emitToUser(me, 'call:handled', { callId: Number(callId) });
  });

  socket.on('call:ice', ({ callId, candidate } = {}) => {
    const c = calls.get(Number(callId));
    if (!c || (c.caller !== me && c.callee !== me) || !candidate) return;
    rt.emitToUser(other(c, me), 'call:ice', { callId: Number(callId), candidate });
  });

  socket.on('call:reject', ({ callId } = {}) => {
    const c = calls.get(Number(callId));
    if (!c || c.callee !== me || c.answeredAt) return;
    finish(Number(callId), 'rejected', [c.caller, me]);
  });

  socket.on('call:end', ({ callId } = {}) => {
    const c = calls.get(Number(callId));
    if (!c || (c.caller !== me && c.callee !== me)) return;
    const status = c.answeredAt ? 'ended' : c.caller === me ? 'missed' : 'rejected';
    finish(Number(callId), status, [c.caller, c.callee]);
  });

  socket.on('disconnect', () => {
    const id = busy.get(me);
    if (id && !rt.isOnline(me)) {
      const c = calls.get(id);
      if (c) finish(id, c.answeredAt ? 'ended' : 'missed', [other(c, me)]);
    }
  });
}

module.exports = { register };
