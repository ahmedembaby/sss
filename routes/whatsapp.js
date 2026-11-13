const express = require('express');
const crypto = require('crypto');
const wa = require('../services/whatsapp');
const { authenticateToken, getToken, isAdminUser } = require('../middleware/auth');
const { WHATSAPP_SETUP_KEY } = require('../config');

const router = express.Router();

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * The QR code controls the linked WhatsApp account, so access is limited to:
 * an admin's token, the WHATSAPP_SETUP_KEY (?key= or x-setup-key), or a request from this very machine.
 * (The first admin can only log in once WhatsApp works, hence the key / localhost options.)
 */
async function guard(req, res, next) {
  try {
    const key = req.query.key || req.get('x-setup-key');
    if (WHATSAPP_SETUP_KEY && key && safeEqual(key, WHATSAPP_SETUP_KEY)) return next();
    const ip = req.socket.remoteAddress || '';
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) && !req.get('x-forwarded-for');
    if (local) return next();
    const token = getToken(req);
    if (token) {
      const user = await authenticateToken(token);
      if (user && isAdminUser(user)) return next();
    }
    return res.status(403).json({ message: 'Not allowed' });
  } catch {
    return res.status(403).json({ message: 'Not allowed' });
  }
}

router.get('/status', guard, async (req, res) => res.json(await wa.getState()));
router.post('/restart', guard, async (req, res) => {
  try { await wa.restart(); res.json({ success: true, status: (await wa.getState()).status }); }
  catch (err) { res.status(500).json({ success: false, message: 'WhatsApp restart failed' }); }
});
router.post('/logout', guard, async (req, res) => {
  try { await wa.logout(); res.json({ success: true, status: (await wa.getState()).status }); }
  catch (err) { res.status(500).json({ success: false, message: 'WhatsApp logout failed' }); }
});

// Simple page to link the account: open http://<server>:5000/api/whatsapp/setup
router.get('/setup', guard, async (req, res) => {
  const s = await wa.getState();
  const key = req.query.key ? `?key=${encodeURIComponent(req.query.key)}` : '';
  const esc = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const body = s.ready
    ? `<p class="ok">✅ Connected${s.account ? ` as +${esc(s.account)}` : ''}. Verification codes are sent from this account.</p>`
    : s.qrImage
      ? `<img src="${s.qrImage}" width="300" height="300" alt="QR"><p>WhatsApp → Settings → <b>Linked devices</b> → Link a device → scan this code.</p>`
      : `<p>${s.status === 'error' ? '❌' : '⏳'} ${esc(s.error || s.status)}</p>`;
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>E-Chat WhatsApp</title>${s.ready ? '' : '<meta http-equiv="refresh" content="4">'}
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;text-align:center;color:#111}
.ok{color:#0a7d33;font-weight:600}button{margin:6px;padding:8px 14px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer}</style></head>
<body><h2>E-Chat · WhatsApp</h2><p>Status: <b>${esc(s.status)}</b></p>${body}
<div><button onclick="act('restart')">Restart</button><button onclick="if(confirm('Unlink this WhatsApp account?'))act('logout')">Unlink</button></div>
<script>function act(a){fetch('/api/whatsapp/'+a+'${key}',{method:'POST'}).then(()=>setTimeout(()=>location.reload(),1500))}</script></body></html>`);
});

module.exports = router;
