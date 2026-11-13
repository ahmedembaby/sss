const express = require('express');
const crypto = require('crypto');
const kv = require('../services/kv');

const router = express.Router();

// GET /api/translate?text=...&to=ar
// Uses the free MyMemory API (no key). Anonymous quota is ~5,000 chars/day per server IP; set MYMEMORY_EMAIL in .env
// (just any email address you own, still free) to raise it to ~50,000 chars/day. Results are cached for a week.
router.get('/', async (req, res) => {
  try {
    const text = String(req.query.text || '').trim().slice(0, 450);
    const to = String(req.query.to || 'en').toLowerCase().slice(0, 5).replace(/[^a-z-]/g, '');
    if (!text) return res.status(400).json({ message: 'text is required' });
    const key = `tr:${to}:${crypto.createHash('sha1').update(text).digest('hex')}`;
    const cached = await kv.get(key);
    if (cached) return res.json({ translation: cached, cached: true });

    const url = new URL('https://api.mymemory.translated.net/get');
    url.searchParams.set('q', text);
    url.searchParams.set('langpair', `Autodetect|${to}`);
    if (process.env.MYMEMORY_EMAIL) url.searchParams.set('de', process.env.MYMEMORY_EMAIL);
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const out = j && j.responseData && j.responseData.translatedText;
    if (!out || j.responseStatus === 403 || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) {
      return res.status(429).json({ message: 'Free translation quota reached, try again later' });
    }
    await kv.set(key, out, 7 * 86400);
    res.json({ translation: out });
  } catch (err) {
    res.status(502).json({ message: 'Translation service unavailable' });
  }
});

module.exports = router;
