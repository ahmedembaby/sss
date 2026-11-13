// Expo push notifications (https://docs.expo.dev/push-notifications/sending-notifications/)
const pool = require('../db');

const isExpoToken = (t) => typeof t === 'string' && /^(Exponent|Expo)PushToken\[.+\]$/.test(t);

async function sendPush(tokens, { title, body, data }) {
  const valid = [...new Set((tokens || []).filter(isExpoToken))];
  if (!valid.length) return;
  const isCall = data && data.type === 'call';
  const messages = valid.map((to) => ({
    to, sound: 'default', title, body, data: data || {}, priority: 'high',
    ...(isCall ? { channelId: 'calls', ttl: 45 } : {}),
  }));
  for (let i = 0; i < messages.length; i += 100) {
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(messages.slice(i, i + 100)),
      });
      const json = await res.json().catch(() => null);
      // Drop tokens Expo reports as unregistered
      const tickets = json && json.data;
      if (Array.isArray(tickets)) {
        const chunk = messages.slice(i, i + 100);
        for (let k = 0; k < tickets.length; k++) {
          if (tickets[k].status === 'error' && tickets[k].details && tickets[k].details.error === 'DeviceNotRegistered') {
            await pool.query('UPDATE users SET push_token = NULL WHERE push_token = ?', [chunk[k].to]);
          }
        }
      }
    } catch (err) {
      console.warn('Push send failed:', err.message);
    }
  }
}

async function pushToUsers(userIds, payload) {
  if (!userIds || !userIds.length) return;
  const [rows] = await pool.query('SELECT push_token FROM users WHERE id IN (?) AND push_token IS NOT NULL AND banned = 0', [userIds]);
  await sendPush(rows.map((r) => r.push_token), payload);
}

module.exports = { sendPush, pushToUsers, isExpoToken };
