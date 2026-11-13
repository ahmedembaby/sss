const fs = require('fs');
const path = require('path');
const pool = require('../db');

// Removes expired disappearing messages (reads already hide them via visible()) and expired stories.
async function run() {
  try {
    await pool.query('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < NOW()');
    const [t] = await pool.query("SHOW TABLES LIKE 'stories'");
    if (t.length) await pool.query('DELETE FROM stories WHERE expires_at < NOW()');
    // view-once photos: remove the file 5 minutes after it was opened
    const [vo] = await pool.query('SELECT id, file_url FROM messages WHERE view_once = 1 AND opened_at IS NOT NULL AND opened_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE) AND file_url IS NOT NULL LIMIT 100');
    for (const m of vo) {
      const file = path.join(__dirname, '..', 'uploads', 'chat', path.basename(m.file_url));
      fs.unlink(file, () => {});
      await pool.query('UPDATE messages SET file_url = NULL WHERE id = ?', [m.id]);
    }
  } catch (e) {
    console.warn('cleanup:', e.message);
  }
}

function start() {
  setTimeout(run, 15 * 1000);
  const t = setInterval(run, 10 * 60 * 1000);
  if (t.unref) t.unref();
  const sch = setInterval(() => require('../routes/messages').processScheduled().catch((e) => console.warn('scheduler:', e.message)), 30 * 1000);
  if (sch.unref) sch.unref();
}

module.exports = { start, run };
