# Special server

1. `cp .env.example .env` and fill in JWT_SECRET (long random), CLIENT_URL, and any optional service settings.
2. `npm ci` to install the locked dependencies.
3. `npm run browser:install` to download Puppeteer's managed Chrome for Testing browser; no system Chrome or ChromeDriver installation is required.
4. `npm start` — the SQLite database and tables are created/migrated automatically.
3. Dev OTP: set `OTP_DEV_MODE=true` (not in production) to get the code in the API response when WhatsApp is not linked.
4. `ADMIN_IDS=1,2` — user ids allowed on /api/admin and the WhatsApp QR endpoints.
5. Optional: `REDIS_URL` for multi-instance sockets / OTP storage. WhatsApp OTP uses Puppeteer's managed browser when `WHATSAPP_ENABLED=true`. Set `PUPPETEER_EXECUTABLE_PATH` only if you need to override the managed browser path; the legacy `CHROME_PATH` variable is still accepted.
Health check: GET /api/health


## Browser checks

- `npm run test:browser` launches the Puppeteer-managed browser and checks a local page.
- `npm test` includes the browser smoke test with the rest of the server tests.
- In restricted Linux containers, the browser is launched with `--no-sandbox`; install the system libraries required by Chrome for Testing if the host image is minimal.
