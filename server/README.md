# Dayflow API server

A small Express + Postgres REST API for Dayflow. One account per person, signed
in with Google; every row is owned by a user and every query is scoped to the
caller. There is no shared dataset and no shared key.

## Setup

```sh
cd server
npm install

# 1) create the database (once), using your local Postgres superuser:
#    psql -U postgres -c "CREATE DATABASE dayflow;"

# 2) configure environment
cp .env.example .env
#    edit .env -> set DATABASE_URL, and GOOGLE_CLIENT_ID (see the root README)
npm run keygen          # prints a VAULT_KEY; paste it into .env

# 3) create tables, then optionally load the demo data
npm run migrate
npm run backfill        # ONLY when upgrading a pre-accounts database (one-shot)
npm run seed            # optional, DESTRUCTIVE: replaces all rows with demo accounts

# 4) run it
npm start               # http://localhost:3088  (health: /api/health)
npm run smoke           # in another terminal: end-to-end API check
```

## Configuration (`.env`)

| Var                | Purpose                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `DATABASE_URL`     | Postgres connection string (or use the `PG*` vars instead).          |
| `GOOGLE_CLIENT_ID` | **Required.** OAuth 2.0 Web-application client ID. No secret needed. |
| `VAULT_KEY`        | 64 hex chars (32 bytes). Encrypts vault passwords and face data.     |
| `AUTH_SECRET`      | Signs session + step-up tokens. Falls back to `VAULT_KEY`.           |
| `SESSION_DAYS`     | Session lifetime in days, default 30.                                |
| `STEPUP_TOKEN_MIN` | Vault step-up lifetime in minutes, default 30.                       |
| `PORT`             | API port (default `3088`).                                           |
| `CORS_ORIGINS`     | Comma-separated frontend origins allowed to call the API.            |

## API

Base path: `/api`. Everything except the five public endpoints requires
`Authorization: Bearer <session token>`, and acts **only on the caller's own
rows** — another account's id in a path is a 404, never a successful read or
write.

| Method       | Path                  | Notes                                                      |
| ------------ | --------------------- | ---------------------------------------------------------- |
| GET          | `/health`             | public: status + db/vault/auth readiness                   |
| GET          | `/config`             | public: `{ googleClientId }` for the sign-in button        |
| POST         | `/auth/google`        | public: `{ credential }` → `{ token, expiresAt, user }`    |
| GET/POST     | `/cron/run`           | public, `CRON_SECRET`: deliver due reminders               |
| POST         | `/reminders/:id/fire` | public, `CRON_SECRET`: QStash callback for one reminder    |
| GET          | `/bootstrap`          | user + categories + tasks + reminders + expenses, one trip |
| GET          | `/me`                 | the signed-in account                                      |
| PATCH        | `/me`                 | `{ name?, color?, cycleStartDay? }`                        |
| DELETE       | `/me`                 | deletes the account and every row it owns                  |
| GET/POST     | `/tasks`              | `{ title, type, time?, days?, completed? }`                |
| PATCH/DELETE | `/tasks/:id`          |                                                            |
| POST         | `/tasks/reorder`      | `{ ids: [...] }` new order                                 |
| GET/POST     | `/reminders`          | `{ title, datetime, method, email? }`                      |
| PATCH/DELETE | `/reminders/:id`      |                                                            |
| GET/POST     | `/expenses`           | `{ title, amount, type, category?, date, note? }`          |
| PATCH/DELETE | `/expenses/:id`       |                                                            |
| GET/POST     | `/categories`         | `{ label, color, parentKey? }` — two levels deep           |
| PATCH        | `/categories/:key`    | label/colour only; `key` and `parent_key` are immutable    |
| DELETE       | `/categories/:key`    | reassigns its own and its children's expenses to `other`   |
| GET/POST     | `/vault`              | needs `VAULT_KEY` **and** `X-StepUp-Token`                 |
| PATCH/DELETE | `/vault/:id`          | same                                                       |
| POST/DELETE  | `/me/face`            | enroll/remove `{ descriptor: number[128] }`; needs step-up |
| POST         | `/me/face/match`      | `{ descriptor }` vs your own face → `{ stepUpToken }`      |
| POST         | `/me/otp/request`     | email a 6-digit step-up code (rate-limited)                |
| POST         | `/me/otp/verify`      | `{ code }` → `{ verified, stepUpToken }`                   |

### Two-tier authentication

**Session token** — issued by `POST /auth/google` once `google-auth-library` has
verified the ID token's signature, issuer, audience and expiry. The payload is
`{ uid, exp }`, HMAC-signed; the browser keeps it in `localStorage`. An account
is matched on `google_sub`, then on a Google-**verified** email whose
`google_sub IS NULL` (this is how a backfilled profile is claimed), and
otherwise created fresh with a starter set of categories.

**Step-up token** — issued only by a successful face match or emailed code,
scoped to one user, valid `STEPUP_TOKEN_MIN` minutes, sent as `X-StepUp-Token`.
Required by every vault route *and* by face enroll/remove — otherwise a
signed-in session could quietly enroll a new face and walk into the vault with
it. The client holds it in memory only, so closing the tab re-locks the vault.

Face descriptors are encrypted at rest (AES-256-GCM, `VAULT_KEY`) and matched
server-side against that user's own descriptor only. OTP codes are HMAC-hashed,
5-minute expiry, single-use, 5-attempt lockout, with a per-user request limit.
Reminders without their own email fall back to the account email.

### Expense categories

Per user, at most two levels deep: a row with `parent_key` set is a
sub-category. `expenses.category` always stores a **leaf** key (the sub-category
when one was chosen, otherwise the top-level one) and the parent is derived by
join, so nothing has to be rewritten when a sub-category is introduced. Deleting
a category reassigns its own **and its children's** expenses to the builtin
`other` in one transaction, then lets `ON DELETE CASCADE` remove the child rows.

## Reminders (email + Web Push)

The server runs a **scheduler** (polling loop, `REMINDER_POLL_MS`, default 30s) that finds
reminders whose `datetime` has passed (and that aren't done or already sent) and delivers them:

- **`method: 'email'`** → sends an email via `nodemailer`. If `SMTP_*` env vars are set it uses
  that real SMTP server (e.g. Gmail App Password); otherwise it falls back to **Ethereal test mode**
  (logs a preview URL, does not actually deliver).
- **`method: 'notification'`** → sends a **Web Push** to that user's own browser subscriptions
  (works even when the app is closed). Requires `VAPID_*` keys.

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

SMTP is not really optional: the emailed code is the only way into the vault for
an account that has not enrolled a face.

**Push endpoints:** `GET /api/push/public-key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`.

## Smart notifications (`src/digest.js`)

Separate from reminders, which fire at an exact instant. These are the daily
nudges, and they run in the same pass as the reminder tick — `/api/cron/run` and
the polling scheduler both call `digestTick()`:

| When | Notification | Sent only if |
| ---- | ------------ | ------------ |
| `digest_hour` | "3 tasks for today" | at least one task is due today and not done |
| `digest_hour` | "Tomorrow: Dentist" | a reminder falls on the user's local tomorrow |
| `wrapup_hour` | "2 tasks still open" | tasks are still open at the end of the day |

Each is individually switchable (`notify_digest`, `notify_headsup`,
`notify_wrapup`) and **nothing is sent when there is nothing to say** — an empty
digest is the fastest way to teach someone to turn notifications off.

Times are hours `0..23` in the user's own `timezone` (an IANA name the browser
reports on boot and the API validates against `Intl`). One pass converts per
user, so a single cron serves every timezone. Idempotency comes from
`digest_sent_on` / `wrapup_sent_on` holding the local date the digest last went
out, and `reminders.headsup_sent_at` for the day-before nudge: the pass can run
every 30 seconds or once an hour and still send exactly once. The hour check is
`>=`, so a cron that misses a tick delivers late rather than not at all.

A user with no subscribed device is skipped before any work happens, and one
user's bad data can't stop everyone else's digest.
