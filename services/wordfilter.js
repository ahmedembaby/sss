const pool = require('../db');

let cache = { at: 0, words: [] };

async function words() {
  if (Date.now() - cache.at < 60000) return cache.words;
  try {
    const [rows] = await pool.query('SELECT word FROM banned_words');
    cache = { at: Date.now(), words: rows.map((r) => r.word.toLowerCase()) };
  } catch { /* table not ready yet */ }
  return cache.words;
}

/** Returns the banned word found in the text, or null. */
async function findBanned(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  for (const w of await words()) if (w && t.includes(w)) return w;
  return null;
}

const refresh = () => { cache.at = 0; };
module.exports = { findBanned, refresh };
