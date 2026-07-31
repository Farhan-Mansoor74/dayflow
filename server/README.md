# Dayflow API server

A small Express + Postgres REST API for Dayflow. Single shared dataset, no auth
(profiles are just people sharing one device). The frontend still uses
`localStorage` today; this server is the backend it will talk to next.

## Setup

```sh
cd server
npm install

# 1) create the database (once), using your local Postgres superuser:
#    psql -U postgres -c "CREATE DATABASE dayflow;"

# 2) configure environment
cp .env.example .env
#    edit .env -> set DATABASE_URL with your real user/password
npm run keygen          # prints a VAULT_KEY; paste it into .env

# 3) create tables, then optionally load the demo data
npm run migrate
npm run seed            # optional, DESTRUCTIVE: replaces all rows with the demo profiles

# 4) run it
npm start               # http://localhost:3088  (health: /api/health)
npm run smoke           # in another terminal: end-to-end API check
```

## Configuration (`.env`)

| Var            | Purpose                                                        |
| -------------- | ------------------------------------------------------------- |
| `DATABASE_URL` | Postgres connection string (or use the `PG*` vars instead).   |
| `VAULT_KEY`    | 64 hex chars (32 bytes). Encrypts vault passwords at rest.    |
| `PORT`         | API port (default `3088`).                                    |
| `CORS_ORIGINS` | Comma-separated frontend origins allowed to call the API.    |

## API

Base path: `/api`

| Method   | Path                               | Notes                                  |
| -------- | ---------------------------------- | -------------------------------------- |
| GET      | `/health`                          | status + db/vault readiness            |
| GET      | `/profiles`                        | list profiles                          |
| POST     | `/profiles`                        | `{ name, color }`                      |
| GET      | `/profiles/:id`                    |                                        |
| PATCH    | `/profiles/:id`                    | partial update                         |
| DELETE   | `/profiles/:id`                    | cascades to all child rows             |
| GET      | `/profiles/:pid/tasks`             | ordered by position                    |
| POST     | `/profiles/:pid/tasks`             | `{ title, type, time?, days?, completed? }` |
| PATCH    | `/tasks/:id`                       | partial update                         |
| DELETE   | `/tasks/:id`                       |                                        |
| POST     | `/profiles/:pid/tasks/reorder`     | `{ ids: [...] }` new order             |
| GET/POST | `/profiles/:pid/reminders`         | `{ title, datetime, method, email? }`  |
| PATCH/DELETE | `/reminders/:id`               |                                        |
| GET/POST | `/profiles/:pid/expenses`          | `{ title, amount, type, category?, date }` |
| PATCH/DELETE | `/expenses/:id`                |                                        |
| GET/POST | `/profiles/:pid/vault`             | `{ label, username?, password?, notes? }` |
| PATCH/DELETE | `/vault/:id`                   | requires `VAULT_KEY`                   |
| POST     | `/profiles/:id/face`               | enroll: `{ descriptor: number[128] }` (encrypted) |
| DELETE   | `/profiles/:id/face`               | remove face enrollment                 |
| POST     | `/face/match`                      | `{ descriptor: number[128] }` → best match server-side |
| POST     | `/profiles/:id/otp/request`        | email a 6-digit login code (rate-limited) |
| POST     | `/profiles/:id/otp/verify`         | `{ code }` → `{ verified }`            |

`POST /profiles` now **requires `email`** (used for reminders + OTP). Profile responses
never include `face_descriptor` or `otp_*` columns; they expose `email` and a `faceEnrolled`
boolean. Face descriptors are encrypted at rest (AES-256-GCM, `VAULT_KEY`); matching runs
server-side. OTP codes are HMAC-hashed, 5-min expiry, single-use, 5-attempt lockout, with a
per-profile request rate limit. Reminders without their own email fall back to the profile email.

## Reminders (email + Web Push)

The server runs a **scheduler** (polling loop, `REMINDER_POLL_MS`, default 30s) that finds
reminders whose `datetime` has passed (and that aren't done or already sent) and delivers them:

- **`method: 'email'`** → sends an email via `nodemailer`. If `SMTP_*` env vars are set it uses
  that real SMTP server (e.g. Gmail App Password); otherwise it falls back to **Ethereal test mode**
  (logs a preview URL, does not actually deliver).
- **`method: 'notification'`** → sends a **Web Push** to every stored browser subscription (works
  even when the app is closed). Requires `VAPID_*` keys.

Each delivered reminder is stamped `notified_at` so it's never sent twice; a failed send leaves it
unstamped to retry next tick.

**One-time setup for push:**
```sh
npm run vapid     # prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT -> paste into .env
npm run migrate   # adds reminders.notified_at + push_subscriptions table
```

**For real email**, set `SMTP_*` in `.env`. Gmail example (needs 2FA + an App Password):
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=your-16-char-app-password
```

**Push endpoints:** `GET /api/push/public-key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`.

> Web Push and service workers require a **secure context**. `http://localhost` counts as secure, so
> local dev works. If you serve the frontend over a LAN IP or domain, it must be **HTTPS**.

## Security notes

- **Vault passwords** are encrypted with AES-256-GCM before they touch the DB and
  decrypted only when read back through `/vault`. The plaintext is never stored
  or logged. Losing/rotating `VAULT_KEY` makes existing vault passwords
  unrecoverable.
- **Validation**: every endpoint strictly validates body types/lengths/enums and
  uses parameterized queries only (no SQL string interpolation).
- **Rate limiting**: layered per-IP limits (burst + sustained); returns `429`.
- **No authorization model**: by design this is a single shared dataset. Any
  caller can read/write any profile. If this ever needs per-user isolation, add
  a `users` table + auth and scope every query by owner.
```
