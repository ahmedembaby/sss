const pool = require('../db');

// SQL fragment (one placeholder: viewer id) that is true when `col` (a user id column) is NOT blocked by / blocking the viewer.
// A row {blocker, blocked} that contains `col` and whose ids sum to col + viewer means the other id is the viewer.
const notBlocked = (col) =>
  `NOT EXISTS (SELECT 1 FROM user_blocks nb WHERE nb.blocker_id + nb.blocked_id = ${col} + ? AND (nb.blocker_id = ${col} OR nb.blocked_id = ${col}))`;

async function isBlockedBetween(a, b) {
  const [r] = await pool.query(
    'SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1',
    [a, b, b, a]
  );
  return r.length > 0;
}

module.exports = { notBlocked, isBlockedBetween };
