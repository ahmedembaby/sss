const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const root = path.join(__dirname, '..', 'uploads');

// folder: uploads/<folder>; filter: regex tested on the mimetype or the extension
const make = (folder, { maxMB = 10, allow } = {}) => {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dir),
      filename: (_req, file, cb) => {
        const ext = (path.extname(file.originalname || '') || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
        cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
      },
    }),
    limits: { fileSize: maxMB * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      // SVG/HTML can carry scripts: never accept them even though they claim to be images
      if (/svg|html|javascript|xml/i.test(file.mimetype || '') || /\.(svg|html?|js|xml|php|exe|sh|bat)$/i.test(file.originalname || '')) {
        return cb(Object.assign(new Error('File type not allowed'), { status: 400 }), false);
      }
      if (!allow) return cb(null, true);
      const ok = allow.test((file.mimetype || '').toLowerCase()) || allow.test(path.extname(file.originalname || '').toLowerCase());
      cb(ok ? null : Object.assign(new Error('File type not allowed'), { status: 400 }), ok);
    },
  });
};

const IMAGE = /image\/|\.(jpe?g|png|gif|webp|heic|heif)$/;
const CHAT_FILES = /image\/|audio\/|video\/|pdf|msword|officedocument|text\/plain|\.(jpe?g|png|gif|webp|heic|heif|mp4|mov|m4a|aac|caf|3gp|webm|mp3|wav|ogg|pdf|docx?|xlsx?|pptx?|txt)$/;

module.exports = {
  avatar: make('avatars', { maxMB: 5, allow: IMAGE }),
  post: make('posts', { maxMB: 10, allow: IMAGE }),
  group: make('groups', { maxMB: 5, allow: IMAGE }),
  story: make('stories', { maxMB: 40, allow: /image\/|video\/|\.(jpe?g|png|gif|webp|heic|heif|mp4|mov|3gp|webm)$/ }),
  chat: make('chat', { maxMB: 25, allow: CHAT_FILES }),
};
