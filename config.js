require('dotenv').config();

const isProd = process.env.NODE_ENV === 'production';

if (!process.env.JWT_SECRET) {
  if (isProd) throw new Error('JWT_SECRET must be set in production');
  console.warn('⚠️  JWT_SECRET is not set - using an insecure development secret');
}
if (isProd && !process.env.DB_PASSWORD) {
  console.warn('⚠️  DB_PASSWORD is empty in production');
}

if (isProd && (!process.env.CLIENT_URLS && !process.env.CLIENT_URL || (process.env.CLIENT_URLS || process.env.CLIENT_URL).split(',').some((s) => s.trim() === '*'))) {
  throw new Error('CLIENT_URLS must contain explicit production origins');
}

module.exports = {
  isProd,
  PORT: Number(process.env.PORT) || 5000,
  JWT_SECRET: process.env.JWT_SECRET || 'dev-only-insecure-secret',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '30d',
  CLIENT_ORIGINS: (process.env.CLIENT_URLS || process.env.CLIENT_URL || (isProd ? '' : '*')).split(',').map((s) => s.trim()).filter(Boolean),
  REDIS_URL: process.env.REDIS_URL || '',
  // Admins are identified by phone number (international format) and/or user id
  ADMIN_PHONES: (process.env.ADMIN_PHONES || '').split(',').map((s) => '+' + s.replace(/\D/g, '')).filter((s) => s.length > 1),
  ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean),
  // When true the OTP is returned in the API response (development only, when WhatsApp is not linked)
  OTP_DEV_MODE: process.env.OTP_DEV_MODE === 'true' && !isProd,
  WHATSAPP_ENABLED: process.env.WHATSAPP_ENABLED !== 'false',
  CHROME_PATH: process.env.CHROME_PATH || undefined,
  // lets you open /api/whatsapp/setup from another device to scan the QR code
  WHATSAPP_SETUP_KEY: process.env.WHATSAPP_SETUP_KEY || '',
};
