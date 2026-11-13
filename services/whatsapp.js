/**
 * WhatsApp OTP delivery (whatsapp-web.js).
 * The server logs in once as a normal WhatsApp account (scan the QR code, see /api/whatsapp/setup);
 * the session is stored in .wwebjs_auth and re-used on every start.
 */
const fs = require('fs');
const path = require('path');
const qrcodeTerminal = require('qrcode-terminal');
const { WHATSAPP_ENABLED, PUPPETEER_EXECUTABLE_PATH, WHATSAPP_AUTH_PATH } = require('../config');

let QRCode = null;
try { QRCode = require('qrcode'); } catch { /* optional: the terminal QR still works */ }

const STATUS = { DISABLED: 'disabled', STARTING: 'starting', QR: 'qr', AUTHENTICATED: 'authenticated', READY: 'ready', DISCONNECTED: 'disconnected', ERROR: 'error' };

let Client;
let LocalAuth;
let client = null;
let status = WHATSAPP_ENABLED ? STATUS.STARTING : STATUS.DISABLED;
let lastQr = null;
let lastError = WHATSAPP_ENABLED ? null : 'WhatsApp disabled (WHATSAPP_ENABLED=false)';
let restartTimer = null;
let starting = false;
let lifecycleQueue = Promise.resolve();
let shuttingDown = false;
let manualLogout = false;
let clearAuthOnRestart = false;

// Ensure start/restart/logout/stop cannot mutate the same Puppeteer client concurrently.
function serialize(task) {
  const operation = lifecycleQueue.then(task, task);
  lifecycleQueue = operation.catch(() => {});
  return operation;
}

/** Resolve Puppeteer's managed Chrome for Testing; never search the host for system Chrome/Edge. */
function findBrowser(puppeteer) {
  // A configured path may point to a developer's Windows machine while Render runs Linux.
  // Prefer the explicit path only when it exists; otherwise fall back to Puppeteer's managed browser.
  if (PUPPETEER_EXECUTABLE_PATH) {
    if (fs.existsSync(PUPPETEER_EXECUTABLE_PATH)) return PUPPETEER_EXECUTABLE_PATH;
    console.warn(`WhatsApp: ignoring unavailable PUPPETEER_EXECUTABLE_PATH: ${PUPPETEER_EXECUTABLE_PATH}`);
  }
  try {
    const managedPath = puppeteer.executablePath();
    return managedPath && fs.existsSync(managedPath) ? managedPath : null;
  } catch {
    return null;
  }
}

function scheduleRestart(ms, reason) {
  if (restartTimer || !WHATSAPP_ENABLED) return;
  console.log(`WhatsApp: restarting in ${Math.round(ms / 1000)}s (${reason})`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    start().catch((err) => console.error('WhatsApp restart failed:', err.message));
  }, ms);
}

async function destroyClient() {
  const c = client;
  client = null;
  if (c) { try { await c.destroy(); } catch { /* browser already gone */ } }
}

async function startInternal() {
  if (!WHATSAPP_ENABLED || shuttingDown || starting) return;
  starting = true;
  status = STATUS.STARTING;
  lastError = null;
  lastQr = null;
  try {
    const puppeteer = require('puppeteer');
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
    const browser = findBrowser(puppeteer);
    if (!browser) {
      throw Object.assign(new Error(
        PUPPETEER_EXECUTABLE_PATH
          ? `PUPPETEER_EXECUTABLE_PATH does not exist: ${PUPPETEER_EXECUTABLE_PATH}`
          : 'Puppeteer-managed browser is not installed. Run: npm run browser:install'
      ), { fatal: true });
    }
    console.log(`WhatsApp: starting with Puppeteer browser ${browser}`);

    await destroyClient();
    const authPath = path.resolve(WHATSAPP_AUTH_PATH);
    if (clearAuthOnRestart) {
      try { fs.rmSync(path.join(authPath, 'session-echat-whatsapp'), { recursive: true, force: true }); }
      catch (err) { console.warn('WhatsApp: could not clear logged-out session:', err.message); }
      clearAuthOnRestart = false;
    }
    fs.mkdirSync(authPath, { recursive: true });
    client = new Client({
      authStrategy: new LocalAuth({ clientId: 'echat-whatsapp', dataPath: authPath }),
      puppeteer: {
        headless: true,
        executablePath: browser,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      },
    });
    const instance = client;

    instance.on('qr', async (qr) => {
      if (client !== instance) return;
      status = STATUS.QR;
      lastQr = qr;
      console.log('=== WhatsApp: scan this QR with the phone that will send the codes (WhatsApp > Linked devices) ===');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('    or open http://localhost:<PORT>/api/whatsapp/setup');
    });
    instance.on('authenticated', () => {
      if (client !== instance) return;
      status = STATUS.AUTHENTICATED; lastQr = null; console.log('WhatsApp: authenticated');
    });
    instance.on('auth_failure', (msg) => {
      if (client !== instance) return;
      status = STATUS.ERROR;
      lastError = `Authentication failed: ${msg}`;
      console.error('WhatsApp:', lastError, '- check the configured WHATSAPP_AUTH_PATH and link the account again');
    });
    instance.on('ready', () => {
      if (client !== instance) return;
      status = STATUS.READY; lastQr = null; lastError = null;
      console.log('WhatsApp: ready, OTP codes will be sent from', instance.info?.wid?.user || 'the linked account');
    });
    instance.on('disconnected', (reason) => {
      if (client !== instance) return; // Ignore events from a browser that has already been replaced.
      status = STATUS.DISCONNECTED;
      lastError = `Disconnected: ${reason}`;
      console.warn('WhatsApp:', lastError);
      if (manualLogout || shuttingDown) return;
      if (String(reason).toUpperCase() === 'LOGOUT') {
        // Remove the stale profile only after the old Chromium process has been closed.
        clearAuthOnRestart = true;
      }
      scheduleRestart(10000, 'disconnected');
    });

    await instance.initialize();
  } catch (err) {
    status = STATUS.ERROR;
    lastError = String(err.message || err).split('\n')[0];
    console.error('WhatsApp initialization failed:', lastError);
    if (err.fatal) console.error('     -> or set WHATSAPP_ENABLED=false and use OTP_DEV_MODE=true for development.');
    await destroyClient();
    if (!err.fatal) scheduleRestart(30000, 'init error');
  } finally {
    starting = false;
  }
}

function start() {
  if (!WHATSAPP_ENABLED || shuttingDown) return Promise.resolve();
  return serialize(startInternal);
}

async function restart() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  return serialize(async () => {
    await destroyClient();
    return startInternal();
  });
}

/** Unlink the account and wipe the saved session (a new QR is shown afterwards). */
async function logout() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  return serialize(async () => {
    manualLogout = true;
    try {
      const c = client;
      if (c) { try { await c.logout(); } catch { /* not logged in */ } }
      await destroyClient();
      try { fs.rmSync(path.join(path.resolve(WHATSAPP_AUTH_PATH), 'session-echat-whatsapp'), { recursive: true, force: true }); }
      catch (err) { console.warn('WhatsApp: could not remove saved session:', err.message); }
    } finally {
      manualLogout = false;
    }
    return startInternal();
  });
}

async function stop() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  return serialize(async () => {
    shuttingDown = true;
    await destroyClient();
    status = STATUS.DISCONNECTED;
    lastQr = null;
    lastError = 'WhatsApp stopped';
  });
}

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('WhatsApp timed out')), ms);
  Promise.resolve(promise).then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); }
  );
});

/**
 * Send the code. Returns { success, code? }:
 *  NOT_READY, NOT_ON_WHATSAPP, SEND_FAILED when it could not be delivered.
 */
async function sendOTP(phoneNumber, code) {
  if (!client || status !== STATUS.READY) {
    // Never write verification codes or full phone numbers to application logs.
    console.warn(`WhatsApp not ready (${status}); OTP delivery deferred.`);
    return { success: false, code: 'NOT_READY', message: 'WhatsApp is not connected. Open /api/whatsapp/setup and scan the QR code.' };
  }
  const digits = String(phoneNumber).replace(/\D/g, '');
  const text = `*E-Chat*\n\nرمز التحقق الخاص بك: *${code}*\nYour verification code: *${code}*\n\nصالح لمدة 5 دقائق · Valid for 5 minutes.\nلا تشاركه مع أي شخص · Do not share it with anyone.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // Resolves the real WhatsApp id (and tells us if the number has WhatsApp at all)
      const id = await withTimeout(client.getNumberId(digits), 20000);
      if (!id) return { success: false, code: 'NOT_ON_WHATSAPP', message: 'This number is not registered on WhatsApp' };
      await withTimeout(client.sendMessage(id._serialized, text), 20000);
      console.log('WhatsApp: OTP sent successfully.');
      return { success: true, message: 'OTP sent via WhatsApp' };
    } catch (err) {
      console.error(`WhatsApp send failed (attempt ${attempt}):`, String(err.message || err).replace(/\+?\d{7,}/g, '[redacted]'));
      if (attempt === 2) return { success: false, code: 'SEND_FAILED', message: err.message };
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { success: false, code: 'SEND_FAILED' };
}

async function getState() {
  let qrImage = null;
  if (lastQr && QRCode) {
    try { qrImage = await QRCode.toDataURL(lastQr, { margin: 1, width: 300 }); } catch { /* ignore */ }
  }
  return { status, ready: status === STATUS.READY, qr: lastQr, qrImage, error: lastError, account: client?.info?.wid?.user || null };
}

module.exports = { start, restart, logout, stop, sendOTP, getState, isClientReady: () => status === STATUS.READY, STATUS };
