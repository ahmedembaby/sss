# Special server

1. `cp .env.example .env` and fill in DB_*, JWT_SECRET (long random), CLIENT_URL.
2. `npm install && npm start` — tables/columns are created/migrated automatically (database.sql is only a reference).
3. Dev OTP: set `OTP_DEV_MODE=true` (not in production) to get the code in the API response when WhatsApp is not linked.
4. `ADMIN_IDS=1,2` — user ids allowed on /api/admin and the WhatsApp QR endpoints.
5. Optional: `REDIS_URL` for multi-instance sockets / OTP storage; `WHATSAPP_ENABLED=true` + `CHROME_PATH`.
Health check: GET /api/health
