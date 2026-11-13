const pool = require('../db');

const slug = (name) => {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 15);
  return s || 'user';
};

// Returns a unique username for a user (derived from the name, suffixed with the id when taken)
async function generateUsername(name, id) {
  const base = slug(name);
  const [rows] = await pool.query('SELECT id FROM users WHERE username = ? AND id <> ?', [base, id || 0]);
  return rows.length ? `${base}${id}` : base;
}

async function backfillUsernames() {
  const [rows] = await pool.query("SELECT id, name FROM users WHERE username IS NULL OR username = ''");
  for (const u of rows) {
    const username = await generateUsername(u.name, u.id);
    await pool.query('UPDATE users SET username = ? WHERE id = ?', [username, u.id]);
  }
}

module.exports = { generateUsername, backfillUsernames };
