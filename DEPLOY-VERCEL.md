# Deploying Dayflow on Vercel (free, no server to manage)

This hosts the **PWA + API** on Vercel's free tier and uses a **free external cron** to fire
reminders. No VM, no firewall, no Caddy, no always-on process. Your data stays in **Neon**.

**How reminders work here:** Vercel runs the API as on-demand serverless functions, so there's no
always-on loop. Instead, a free cron service calls **`POST /api/cron/run`** every minute, and that
endpoint sends any due reminders. That one indirection is what removes all the VM complexity.

```
Browser ──HTTPS──> Vercel ──> static PWA (index.html, assets…)
                         └──> /api/* serverless function ──> Neon Postgres
cron-job.org ──every 1 min──> POST /api/cron/run ──> sends due reminders
```

---

## 0. Prerequisites

- Your code in a **GitHub repo** (private is fine). Vercel deploys from Git.
- Your **Neon** project (you have it). Use Neon's **pooled** connection string for serverless —
  in the Neon dashboard, copy the URL labelled **"Pooled connection"** (its host contains
  `-pooler`). It looks like:
  `postgres://USER:PASS@ep-xxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require`
- The secrets from your local `server/.env` (you'll paste them into Vercel, not commit them).

## 1. Push the project to GitHub

From the project root (`dayflow/`):
```sh
git init
git add .
git commit -m "Dayflow"
git branch -M main
# create an empty repo on github.com first, then:
git remote add origin https://github.com/YOU/dayflow.git
git push -u origin main
```
> The repo already has a `.gitignore` that keeps `.env` and `node_modules` out. Double-check
> `git status` does **not** list `server/.env` before pushing.

## 2. Add the reminder-cron table to Neon

The serverless build needs one extra table (`auth_throttle`). Run the migration against Neon once
from your machine (it's idempotent — safe to re-run):
```sh
cd server
# point at your Neon POOLED url for this one command:
DATABASE_URL="postgres://USER:PASS@ep-xxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require" npm run migrate
```
*(PowerShell: `$env:DATABASE_URL="..."; npm run migrate`)*

## 3. Import the project into Vercel

1. [vercel.com](https://vercel.com) → **Add New → Project** → import your GitHub repo.
2. **Framework Preset: Other.** Leave Build Command and Output Directory **empty** (the frontend is
   plain static files; the API in `/api` is detected automatically). Root Directory: leave as `/`.
3. Don't deploy yet — add the environment variables first (next step), or deploy and add them, then
   redeploy.

## 4. Set Environment Variables (Vercel → Project → Settings → Environment Variables)

Add each of these (Production, and Preview if you want preview deploys to work):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Your Neon **pooled** URL (with `?sslmode=require`). |
| `VAULT_KEY` | The **same** 64-hex key from your local `.env`. |
| `APP_ACCESS_KEY` | A **strong** household key (see note). |
| `SESSION_DAYS` | `30` |
| `CRON_SECRET` | A random secret for the cron endpoint: `node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"` |
| `CORS_ORIGINS` | Your Vercel URL, e.g. `https://dayflow.vercel.app` (add your custom domain too if you set one). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | From your local `.env` (for push). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | From your local `.env` (Gmail App Password, for email reminders + login codes). |

> 🔑 **Use a strong `APP_ACCESS_KEY`.** On serverless this is your primary protection — a long
> random value makes guessing impossible. (`manafare` is too weak; generate one like the
> `CRON_SECRET` above.) There's also a DB-backed lockout (10 wrong tries → 15-min block per IP) as
> a backstop, but a strong key is what matters.

Then **Deploy** (or redeploy so the vars take effect). You'll get `https://your-app.vercel.app`.

## 5. Wire up the reminder cron (free, 1-minute)

1. Sign up at **[cron-job.org](https://cron-job.org)** (free).
2. Create a cronjob:
   - **URL:** `https://your-app.vercel.app/api/cron/run`
   - **Schedule:** every **1 minute**.
   - **Request method:** POST.
   - **Headers:** add `X-Cron-Key: <your CRON_SECRET>`  *(preferred — keeps the secret out of URLs/logs)*.
     *(Alternative: put it in the URL as `...?key=<CRON_SECRET>`.)*
3. Save and **run it once** to test — it should return `{"ok":true,"due":0,"sent":0}` (or higher if
   something's due). A wrong/missing key returns `401`.

That's it — reminders now fire within ~1 minute of their time, even with the app closed.

## 6. Use it

Open `https://your-app.vercel.app` on your tablet → **Enter access key** (your `APP_ACCESS_KEY`,
once per device) → create your real profiles (with **real emails** so the email-code unlock and
email reminders work) → browser menu → **Install app / Add to Home Screen**.

---

## Updating later

Just `git push` — Vercel auto-deploys. (Bump `CACHE = 'dayflow-shell-vN'` in `sw.js` when you change
`index.html`/`support.js`, so devices pick up the new frontend instead of the cached one.)

## Notes & troubleshooting

- **Cold starts:** after a quiet spell the first request may take ~1s while the function wakes. Normal
  for serverless; subsequent requests are fast. (The cron ping every minute also keeps it warmish.)
- **`db":"down"` or DB connection errors:** make sure `DATABASE_URL` is the **pooled** Neon URL with
  `?sslmode=require`. The non-pooled URL can exhaust connections under serverless.
- **Reminders never arrive:** check the cron-job.org execution log (is it getting `200`?), confirm
  `CRON_SECRET` matches, and that the profile/reminder uses a real email (for email) or that the
  device enabled notifications (for push). Email needs a Gmail **App Password**.
- **Every action says "session expired" / 401 loop:** `APP_ACCESS_KEY` in Vercel must match what you
  type in the app, and `CORS_ORIGINS` must list your exact `https://…` origin.
- **Vault entries blank:** `VAULT_KEY` on Vercel must equal the one that encrypted the data.

## Custom domain (optional)

Vercel → Project → **Domains** → add `dayflow.ramatechme.com`, then create the CNAME it shows at your
DNS provider. Add that HTTPS origin to `CORS_ORIGINS`. HTTPS is automatic.
