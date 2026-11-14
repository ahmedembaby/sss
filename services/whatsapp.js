
/**
 * WhatsApp OTP delivery (whatsapp-web.js).
 *
 * Uses Puppeteer's managed Chrome for Testing.
 * No manually configured Chrome executable path is required.
 *
 * The WhatsApp session is stored in WHATSAPP_AUTH_PATH
 * and reused after every server restart.
 */

const fs = require('fs');
const path = require('path');
const qrcodeTerminal = require('qrcode-terminal');

const {
  WHATSAPP_ENABLED,
  WHATSAPP_AUTH_PATH,
} = require('../config');

let QRCode = null;

try {
  QRCode = require('qrcode');
} catch {
  // Optional. Terminal QR remains available.
}

const STATUS = {
  DISABLED: 'disabled',
  STARTING: 'starting',
  QR: 'qr',
  AUTHENTICATED: 'authenticated',
  READY: 'ready',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
};

let Client;
let LocalAuth;

let client = null;

let status = WHATSAPP_ENABLED
  ? STATUS.STARTING
  : STATUS.DISABLED;

let lastQr = null;

let lastError = WHATSAPP_ENABLED
  ? null
  : 'WhatsApp disabled (WHATSAPP_ENABLED=false)';

let restartTimer = null;
let starting = false;

let lifecycleQueue = Promise.resolve();

let shuttingDown = false;
let manualLogout = false;
let clearAuthOnRestart = false;


/* -------------------------------------------------------
   Lifecycle serialization
------------------------------------------------------- */

function serialize(task) {
  const operation = lifecycleQueue.then(task, task);

  lifecycleQueue = operation.catch(() => {});

  return operation;
}


/* -------------------------------------------------------
   Browser detection
------------------------------------------------------- */

/**
 * Resolve the browser installed and managed by Puppeteer.
 *
 * No hardcoded Chrome path.
 * No system Chrome or Edge lookup.
 */
function findBrowser(puppeteer) {
  let browserPath;

  try {
    browserPath = puppeteer.executablePath();
  } catch (err) {
    throw Object.assign(
      new Error(
        `Unable to resolve Puppeteer browser path: ${err.message}`
      ),
      { fatal: true }
    );
  }

  if (!browserPath) {
    throw Object.assign(
      new Error(
        'Puppeteer browser path is unavailable. Run: npm run browser:install'
      ),
      { fatal: true }
    );
  }

  console.log('Puppeteer diagnostics:', {
  platform: process.platform,
  home: process.env.HOME,
  cacheDir: process.env.PUPPETEER_CACHE_DIR,
  executablePath: browserPath,
  exists: fs.existsSync(browserPath),
});

  if (!fs.existsSync(browserPath)) {
    throw Object.assign(
      new Error(
        `Puppeteer browser is not installed at its managed location. Run: npm run browser:install`
      ),
      { fatal: true }
    );
  }

  // On Linux/macOS, verify that the browser file is executable.
  if (process.platform !== 'win32') {
    try {
      fs.accessSync(browserPath, fs.constants.X_OK);
    } catch {
      throw Object.assign(
        new Error(
          'Puppeteer browser exists but is not executable. Check browser installation permissions.'
        ),
        { fatal: true }
      );
    }
  }

  return browserPath;
}


/* -------------------------------------------------------
   Timeout helper
------------------------------------------------------- */

function withTimeout(promise, ms, message = 'WhatsApp timed out') {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;

      settled = true;
      reject(new Error(message));
    }, ms);

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;

        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;

        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}


/* -------------------------------------------------------
   Restart scheduling
------------------------------------------------------- */

function scheduleRestart(ms, reason) {
  if (
    restartTimer ||
    !WHATSAPP_ENABLED ||
    shuttingDown
  ) {
    return;
  }

  console.log(
    `WhatsApp: restarting in ${Math.round(ms / 1000)}s (${reason})`
  );

  restartTimer = setTimeout(() => {
    restartTimer = null;

    start().catch((err) => {
      console.error(
        'WhatsApp restart failed:',
        err.message
      );
    });
  }, ms);
}


/* -------------------------------------------------------
   Client destruction
------------------------------------------------------- */

async function destroyClient() {
  const oldClient = client;

  // Clear reference before destroying to ignore old events.
  client = null;

  if (oldClient) {
    try {
      await oldClient.destroy();
    } catch (err) {
      console.warn(
        'WhatsApp: client destruction warning:',
        err.message
      );
    }
  }
}


/* -------------------------------------------------------
   Main initialization
------------------------------------------------------- */

async function startInternal() {
  if (
    !WHATSAPP_ENABLED ||
    shuttingDown ||
    starting
  ) {
    return;
  }

  if (
    client &&
    [
      STATUS.STARTING,
      STATUS.QR,
      STATUS.AUTHENTICATED,
      STATUS.READY,
    ].includes(status)
  ) {
    return;
  }

  starting = true;

  status = STATUS.STARTING;
  lastError = null;
  lastQr = null;

  try {
    const puppeteer = require('puppeteer');

    ({ Client, LocalAuth } = require('whatsapp-web.js'));

    // Resolve Puppeteer's own managed browser.
    const browserPath = findBrowser(puppeteer);

    console.log(
      'WhatsApp: using Puppeteer managed browser:',
      browserPath
    );

    await destroyClient();

    const authPath = path.resolve(WHATSAPP_AUTH_PATH);

    // Clear an invalid logged-out session only after
    // the previous browser has been destroyed.
    if (clearAuthOnRestart) {
      try {
        fs.rmSync(
          path.join(authPath, 'session-echat-whatsapp'),
          {
            recursive: true,
            force: true,
          }
        );
      } catch (err) {
        console.warn(
          'WhatsApp: could not clear old session:',
          err.message
        );
      }

      clearAuthOnRestart = false;
    }

    fs.mkdirSync(authPath, {
      recursive: true,
    });

    client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'echat-whatsapp',
        dataPath: authPath,
      }),

      puppeteer: {
        headless: true,

        // Use the exact path returned by Puppeteer.
        executablePath: browserPath,

        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      },
    });

    const instance = client;


    /* ---------------- QR event ---------------- */

    instance.on('qr', (qr) => {
      if (client !== instance) return;

      status = STATUS.QR;
      lastQr = qr;

      console.log(
        '=== WhatsApp: scan this QR using WhatsApp > Linked devices ==='
      );

      qrcodeTerminal.generate(qr, {
        small: true,
      });

      console.log(
        'Open /api/whatsapp/setup to view the QR code.'
      );
    });


    /* ---------------- Authenticated ---------------- */

    instance.on('authenticated', () => {
      if (client !== instance) return;

      status = STATUS.AUTHENTICATED;
      lastQr = null;

      console.log('WhatsApp: authenticated');
    });


    /* ---------------- Authentication failure ---------------- */

    instance.on('auth_failure', (msg) => {
      if (client !== instance) return;

      status = STATUS.ERROR;

      lastError = `Authentication failed: ${msg}`;

      console.error(
        'WhatsApp:',
        lastError,
        '- check WHATSAPP_AUTH_PATH and link the account again'
      );
    });


    /* ---------------- Ready ---------------- */

    instance.on('ready', () => {
      if (client !== instance) return;

      status = STATUS.READY;
      lastQr = null;
      lastError = null;

      console.log(
        'WhatsApp: ready. OTP delivery enabled for account:',
        instance.info?.wid?.user || 'unknown'
      );
    });


    /* ---------------- Disconnected ---------------- */

    instance.on('disconnected', (reason) => {
      // Ignore events from an old browser instance.
      if (client !== instance) return;

      status = STATUS.DISCONNECTED;

      lastError = `Disconnected: ${reason}`;

      console.warn('WhatsApp:', lastError);

      if (manualLogout || shuttingDown) {
        return;
      }

      if (
        String(reason).toUpperCase() === 'LOGOUT'
      ) {
        // Remove the old session after destroying Chromium.
        clearAuthOnRestart = true;
      }

      scheduleRestart(10000, 'disconnected');
    });


    /* ---------------- Initialize ---------------- */

    await withTimeout(
      instance.initialize(),
      120000,
      'WhatsApp initialization timed out'
    );

  } catch (err) {
    status = STATUS.ERROR;

    lastError = String(
      err.message || err
    ).split('\n')[0];

    console.error(
      'WhatsApp initialization failed:',
      lastError
    );

    if (err.fatal) {
      console.error(
        'WhatsApp: browser installation is required. Run npm run browser:install'
      );
    }

    await destroyClient();

    // Do not retry a missing browser every 30 seconds.
    // Retry only after recoverable initialization failures.
    if (!err.fatal) {
      scheduleRestart(30000, 'initialization error');
    }

  } finally {
    starting = false;
  }
}


/* -------------------------------------------------------
   Public start
------------------------------------------------------- */

function start() {
  if (!WHATSAPP_ENABLED || shuttingDown) {
    return Promise.resolve();
  }

  return serialize(startInternal);
}


/* -------------------------------------------------------
   Manual restart
------------------------------------------------------- */

async function restart() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  return serialize(async () => {
    if (shuttingDown) {
      return;
    }

    await destroyClient();

    status = STATUS.STARTING;

    return startInternal();
  });
}


/* -------------------------------------------------------
   Logout
------------------------------------------------------- */

/**
 * Unlink WhatsApp and delete the saved session.
 * A new QR code will be generated.
 */
async function logout() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  return serialize(async () => {
    manualLogout = true;

    try {
      const currentClient = client;

      if (currentClient) {
        try {
          await currentClient.logout();
        } catch {
          // The account may already be logged out.
        }
      }

      await destroyClient();

      try {
        fs.rmSync(
          path.join(
            path.resolve(WHATSAPP_AUTH_PATH),
            'session-echat-whatsapp'
          ),
          {
            recursive: true,
            force: true,
          }
        );
      } catch (err) {
        console.warn(
          'WhatsApp: could not remove saved session:',
          err.message
        );
      }

    } finally {
      manualLogout = false;
    }

    clearAuthOnRestart = false;

    return startInternal();
  });
}


/* -------------------------------------------------------
   Stop
------------------------------------------------------- */

async function stop() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  return serialize(async () => {
    shuttingDown = true;

    await destroyClient();

    status = STATUS.DISCONNECTED;

    lastQr = null;
    lastError = 'WhatsApp stopped';
  });
}


/* -------------------------------------------------------
   Send OTP
------------------------------------------------------- */

/**
 * Send an OTP through WhatsApp.
 *
 * Possible error codes:
 * NOT_READY
 * NOT_ON_WHATSAPP
 * SEND_FAILED
 */
async function sendOTP(phoneNumber, code) {
  const activeClient = client;

  if (
    !activeClient ||
    status !== STATUS.READY
  ) {
    // Never log the full phone number or OTP.
    console.warn(
      `WhatsApp not ready (${status}); OTP delivery deferred.`
    );

    return {
      success: false,
      code: 'NOT_READY',
      message:
        'WhatsApp is not connected. Open /api/whatsapp/setup and scan the QR code.',
    };
  }

  const digits = String(phoneNumber).replace(/\D/g, '');

  if (!digits) {
    return {
      success: false,
      code: 'SEND_FAILED',
      message: 'Invalid phone number',
    };
  }

  const message =
    `*E-Chat*\n\n` +
    `رمز التحقق الخاص بك: *${code}*\n` +
    `Your verification code: *${code}*\n\n` +
    `صالح لمدة 5 دقائق · Valid for 5 minutes.\n` +
    `لا تشاركه مع أي شخص · Do not share it with anyone.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // Check whether the destination number uses WhatsApp.
      const id = await withTimeout(
        activeClient.getNumberId(digits),
        20000,
        'WhatsApp number lookup timed out'
      );

      if (!id) {
        return {
          success: false,
          code: 'NOT_ON_WHATSAPP',
          message:
            'This number is not registered on WhatsApp',
        };
      }

      // Prevent sending through an old or replaced client.
      if (
        client !== activeClient ||
        status !== STATUS.READY
      ) {
        return {
          success: false,
          code: 'NOT_READY',
          message:
            'WhatsApp connection changed. Please retry.',
        };
      }

      await withTimeout(
        activeClient.sendMessage(
          id._serialized,
          message
        ),
        20000,
        'WhatsApp message sending timed out'
      );

      console.log(
        'WhatsApp: OTP sent successfully.'
      );

      return {
        success: true,
        message: 'OTP sent via WhatsApp',
      };

    } catch (err) {
      const errorMessage = String(
        err.message || err
      );

      // Redact phone numbers from logs.
      console.error(
        `WhatsApp send failed (attempt ${attempt}):`,
        errorMessage.replace(/\+?\d{7,}/g, '[redacted]')
      );

      // Browser or Puppeteer page was unexpectedly closed.
      if (
        /detached frame|target closed|session closed|execution context was destroyed/i.test(
          errorMessage
        )
      ) {
        if (client === activeClient) {
          status = STATUS.DISCONNECTED;

          lastError =
            'WhatsApp browser page was closed unexpectedly';

          scheduleRestart(
            10000,
            'browser page closed during OTP send'
          );
        }

        return {
          success: false,
          code: 'SEND_FAILED',
          message:
            'WhatsApp connection interrupted. Please retry.',
        };
      }

      if (attempt === 2) {
        return {
          success: false,
          code: 'SEND_FAILED',
          message: 'Could not send WhatsApp message',
        };
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 1500);
      });
    }
  }

  return {
    success: false,
    code: 'SEND_FAILED',
  };
}


/* -------------------------------------------------------
   Get WhatsApp state
------------------------------------------------------- */

async function getState() {
  let qrImage = null;

  if (lastQr && QRCode) {
    try {
      qrImage = await QRCode.toDataURL(lastQr, {
        margin: 1,
        width: 300,
      });
    } catch {
      // QR image generation is optional.
    }
  }

  return {
    status,

    ready: status === STATUS.READY,

    qr: lastQr,

    qrImage,

    error: lastError,

    account:
      client?.info?.wid?.user || null,
  };
}


/* -------------------------------------------------------
   Exports
------------------------------------------------------- */

module.exports = {
  start,
  restart,
  logout,
  stop,
  sendOTP,
  getState,

  isClientReady: () => {
    return status === STATUS.READY;
  },

  STATUS,
};
