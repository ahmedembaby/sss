const toUser = (u) => u && ({
  id: u.id,
  name: u.name,
  username: u.username || null,
  email: u.email || null,
  phone: u.phone || null,
  avatar: u.avatar || null,
  bio: u.bio || null,
  gender: u.gender || null,
  birthday: u.birthday || null,
  status: u.status || 'offline',
  last_seen: u.last_seen || null,
  is_admin: !!u.is_admin,
  is_private: !!u.is_private,
  public_key: u.public_key || null,
});

const publicUser = (u) => u && ({
  id: u.id,
  name: u.name,
  username: u.username || null,
  avatar: u.avatar || null,
  bio: u.bio || null,
  status: u.status || 'offline',
  last_seen: u.last_seen || null,
  is_private: u.is_private === undefined ? undefined : !!u.is_private,
});

const toInt = (v, def, min = 0, max = 1000) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
};

const normalizePhone = (raw) => {
  if (!raw) return '';
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, '');
  return digits ? `+${digits}` : '';
};

module.exports = { toUser, publicUser, toInt, normalizePhone };
