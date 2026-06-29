# Deploying Dayflow

Dayflow is two pieces:

1. **Static frontend** — `index.html`, `support.js`, `sw.js`, `manifest.webmanifest`, `assets/`.
2. **API + database** — the Node/Express server in [`server/`](server/) backed by Postgres.

> 🔒 **The API is protected by a household access key.** Set `APP_ACCESS_KEY` and every
> route (except `/health`) requires it: a device exchanges the key for a signed 30-day
> session token via `POST /api/auth`, and the app prompts for it once per device. This is
> the layer that makes public hosting safe — without the key, the whole internet is locked
> out. **On top of that**, each profile has its own face / email-code gate (toggleable per
> profile in Manage → "Turn off authentication"), which keeps people on the shared device
> out of each other's profiles. See "Security model" at the bottom for exactly what each
> layer does and doesn't protect.

---

## Two hard requirements

- **HTTPS is mandatory** anywhere other than `http://localhost`. Service workers (PWA install
  + push), the camera (face unlock), and the Web Speech mic all refuse to run on insecure
  origins — and without TLS, vault passwords travel in clear text.
- **Postgres must be reachable** from the API process, and the secrets in `server/.env` must be
  present in the deployment environment (never committed — the new root `.gitignore` blocks it).

---

## Option A — Home network (recommended; matches the design)

Run the API + Postgres on one always-on machine on your LAN (an old PC, a NUC, a Raspberry Pi),
and open the app on the tablet over Wi-Fi.

1. **Install Postgres** on the host, create the DB, and run the migration/seed:
   ```sh
   cd server
   cp .env.example .env        # then fill in the values (see checklist below)
   npm install
   npm run migrate
   npm run seed                # optional demo data
   ```
2. **Serve the frontend** from the project root (any static server works):
   ```sh
   npx serve . -l 8000
   ```
3. **Put HTTPS in front** with [Caddy](https://caddyserver.com) — it gives you a trusted local
   cert with almost no config. Example `Caddyfile` (replace the host/IP):
   ```
   dayflow.home {            # a name you add to your router/hosts, or use the LAN IP
     handle /api/* {
       reverse_proxy localhost:3001
     }
     handle {
       reverse_proxy localhost:8000   # or: root * /path/to/dayflow ; file_server
     }
   }
   ```
   Caddy's local CA cert must be trusted on the tablet (install the root cert once), or use a
   real domain pointed at the host for a public Let's Encrypt cert.
4. On the tablet, open `https://dayflow.home`, then **Install app / Add to Home Screen**.
5. Set `CORS_ORIGINS` in `.env` to the exact origin you load the app from
   (e.g. `https://dayflow.home`).

Because everything stays on your LAN, the "no login" model is acceptable — only devices on your
Wi-Fi can reach it. For extra safety, keep the host's firewall closed to the internet.

---

## Option B — Cloud (public)

**Recommended: [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md)** — host the PWA + API on **Vercel's free tier**
(no server to manage, no card) with **Neon** Postgres, and fire reminders with a free 1-minute cron
(cron-job.org) hitting `POST /api/cron/run`. This is the simplest path.

**Alternative: [DEPLOY-ORACLE.md](DEPLOY-ORACLE.md)** — an **Oracle Cloud Always Free** VM ($0,
always-on) running the app unchanged with HTTPS via Caddy. More setup, but a single always-on box
with no external cron needed (the built-in scheduler runs).

General principles for any cloud host:
- Reminders need *something* to run on a schedule: either an **always-on process** (the built-in
  scheduler, on a VM/non-sleeping container) **or** an **external cron** calling `/api/cron/run`
  (for serverless/sleeping hosts).
- Serve the frontend from the **same origin** as the API (the app auto-targets `<origin>/api` when
  it isn't on `localhost`), or set `window.DAYFLOW_API_BASE` before `support.js` loads if you split
  them; then set `CORS_ORIGINS` to the frontend's HTTPS origin.
- **Set `APP_ACCESS_KEY`** (see checklist) — this is what makes public hosting safe. The app
  prompts each device for it once and stays signed in for `SESSION_DAYS` (default 30).

---

## `server/.env` checklist

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | `postgres://user:pass@host:5432/dayflow` — URL-encode special chars (`#` → `%23`). |
| `VAULT_KEY` | ✅ | 64 hex chars. `npm run keygen`. **If lost/changed, stored vault passwords can't be decrypted.** |
| `APP_ACCESS_KEY` | ✅ (public) | The household key. Long random value: `node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"`. Enter the **same value** in the app on each device. **Empty = gate OFF (open API)** — only acceptable on a trusted LAN. |
| `SESSION_DAYS` | — | How long a device stays signed in after entering the key. Default 30. |
| `CORS_ORIGINS` | ✅ (prod) | Comma-separated exact origins. Leaving it empty allows *any* origin — don't, in production. |
| `PORT` | — | Defaults to 3001. |
| `CRON_SECRET` | serverless | Protects `POST /api/cron/run`. Required on Vercel (where an external cron drives reminders); unused if you run an always-on server. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | for push | `npm run vapid`. Needed for closed-app reminders. |
| `SMTP_HOST/PORT/USER/PASS` | for email | e.g. Gmail App Password. Without it, email runs in Ethereal test mode (no real delivery). |
| `MAIL_FROM` | — | From header on reminder/OTP emails. |
| `OTP_TTL_MIN`, `FACE_MATCH_THRESHOLD` | — | Tunables (defaults 5 min, 0.5). |

Run the API in production with a process manager so it restarts on crash/reboot:
```sh
npm i -g pm2
pm2 start src/server.js --name dayflow-api
pm2 save && pm2 startup
```

---

## Security model — what protects what

Two independent layers:

1. **Household access key (server-enforced).** Every route except `/health` requires a valid
   session token. A device gets one by sending the key to `POST /api/auth`; the token is
   HMAC-signed and expires after `SESSION_DAYS`. This is the layer that keeps the public
   internet out — without the key, an attacker gets `401` on everything and never sees a
   profile, a task, or a vault entry. Brute-forcing the key is rate-limited (10 tries / 15 min)
   and the comparison is constant-time.

2. **Per-profile face / email-code gate (on the device).** Once past the household key, opening
   a profile that has authentication on requires a face scan (if enrolled) or an emailed 6-digit
   code. Toggle it per profile in **Manage → "Turn off authentication."** Turning it *off* for a
   protected profile itself requires passing that profile's check first. This separates people
   who share the same tablet; it is enforced in the app, not the API, so treat it as
   "keeps the family honest," not a barrier against someone who already has the household key and
   crafts raw API calls.

**What this means in practice:** with `APP_ACCESS_KEY` set and HTTPS on, an outsider cannot reach
your data at all. Within the household (everyone has the key), the per-profile gate keeps profiles
private from each other. If you ever want true cryptographic isolation *between* profiles over the
API, that's the one thing not built — it would mean per-profile tokens scoping every data route;
say the word and it can be added.

Everything else is already in place: TLS (required above), tight `CORS_ORIGINS`, layered rate
limiting, strict input validation, AES-256-GCM-encrypted vault + face data, HMAC-hashed single-use
OTP, and `helmet` security headers.
