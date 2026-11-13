const redis = require('./redis');
const mem = new Map();

const sweep = () => {
  const now = Date.now();
  for (const [key, entry] of mem) if (entry.exp <= now) mem.delete(key);
};
setInterval(sweep, 60 * 1000).unref();

async function set(key, value, ttlSec) {
  const ttl = Math.max(1, Number(ttlSec) || 1);
  if (redis.isReady()) {
    try { await redis.client.set(key, String(value), 'EX', ttl); mem.delete(key); return; } catch { /* fallback */ }
  }
  mem.set(key, { value: String(value), exp: Date.now() + ttl * 1000 });
}
async function get(key) {
  if (redis.isReady()) {
    try { const value = await redis.client.get(key); if (value !== null) return value; } catch { /* fallback */ }
  }
  const entry = mem.get(key);
  if (!entry) return null;
  if (entry.exp <= Date.now()) { mem.delete(key); return null; }
  return entry.value;
}
async function del(key) {
  if (redis.isReady()) { try { await redis.client.del(key); } catch { /* best effort */ } }
  mem.delete(key);
}
async function incr(key, ttlSec) {
  const ttl = Math.max(1, Number(ttlSec) || 1);
  if (redis.isReady()) {
    try {
      const count = await redis.client.eval(
        "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return n",
        1, key, ttl
      );
      mem.delete(key);
      return count;
    } catch { /* fallback */ }
  }
  const now = Date.now();
  const current = mem.get(key);
  const valid = current && current.exp > now;
  const count = valid ? (Number(current.value) || 0) + 1 : 1;
  mem.set(key, { value: String(count), exp: valid ? current.exp : now + ttl * 1000 });
  return count;
}
module.exports = { set, get, del, incr };
