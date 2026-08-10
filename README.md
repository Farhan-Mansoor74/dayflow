# Dayflow

A personal organizer you sign into with Google. Your tasks, reminders, expenses
and passwords live in one private workspace — nobody else can see or touch them.

It runs in any modern browser and can be **installed like a real app** on your
phone, tablet, or computer.

## What you can do

- **📋 Tasks** — plan your day with daily, weekly, or one-off tasks. Tick them off
  to fill your progress ring, drag to reorder, and everything recurring resets
  automatically each morning.
- **⏰ Reminders** — pick a date and time and choose how you're reminded: an
  **email**, or a **push notification** that still arrives when the app is closed.
  You also get a **morning list** of what's due, a **heads-up the day before** a
  reminder, and an **evening nudge** if anything is still open — each switchable,
  at times you choose, and silent on days with nothing to say.
- **💸 Expenses** — track income and spending against your own **spending cycle**
  (start it on any day of the month, not just the 1st). Type a transaction in, or
  just **say it** — tap the mic and speak *"twelve dollars on coffee"*. Filter by
  category, organise categories into sub-categories, and see three charts: the
  spending trend, the split by category, and the split by sub-category. Filter
  the list by any combination of categories — ticking a category includes its
  sub-categories.
- **🔒 Vault** — keep passwords and notes safe. They're encrypted at rest, and
  opening the vault needs a second check even when you're already signed in.

## Getting started (using the app)

1. **Open the app** in your browser (Chrome or Edge work best) and, if you like,
   choose **Install app** / **Add to Home Screen** to run it fullscreen.
2. **Continue with Google.** That's the whole sign-up — your name, email and
   picture come from Google, and a starter set of expense categories is created
   for you.
3. **Pick a module** from the dashboard — Tasks, Reminders, Expenses or Vault —
   and use the **+** button to add your first entry.
4. **Set your spending cycle** in **Settings** if your month doesn't start on the
   1st (payday on the 28th, say). Every total and chart follows it.
5. **(Optional) Set up Face Unlock** in Settings for a quicker way into the vault.

That's it — everything you add is saved automatically.

## Good to know

- **The vault lock is real.** Being signed in is not enough to read your stored
  passwords: you verify again with a face scan or an emailed code, and closing
  the tab re-locks it. Enrolling or removing a face needs that same check.
- **Face unlock isn't foolproof** — it has no "liveness" check, so a photo could
  fool it. The emailed code always works and is the strong fallback.
- **Notifications & camera** need permission the first time, and require a secure
  connection (`https://`, or `http://localhost` during development).

---

## Running it yourself (technical)

Dayflow has two parts: a small **REST API** (Node/Express + Postgres) in
[`server/`](server/), and this **static web app** at the project root. You need
both running. The web app must be served over HTTP (not opened as a `file://`).

```sh
# 1) Backend — one-time database setup, then start it
cd server
npm install
npm run migrate         # creates/updates the Postgres tables (safe to re-run)
npm run backfill        # ONCE, only when upgrading a pre-accounts database
npm start               # → http://localhost:3088

# 2) Frontend — in another terminal, from the project root
python -m http.server 8088    # or: npx serve . -l 8088
```

Then open **http://localhost:8088**. See [`server/README.md`](server/README.md)
for database, email (SMTP), and Web Push setup.

### Configuration

Secrets live in `server/.env` (never committed). Key ones:

- `DATABASE_URL` — Postgres connection string.
- `GOOGLE_CLIENT_ID` — **required.** OAuth 2.0 Web-application client ID from the
  Google Cloud console. Without it every sign-in returns 503 and `/api/health`
  reports `auth: misconfigured`. There is no client *secret*: the browser posts
  the Google ID token and the server verifies its signature. On Vercel, add the
  same value under Settings → Environment Variables.
- `VAULT_KEY` — 32-byte key that encrypts vault passwords at rest (`npm run keygen`).
  Also doubles as the session-signing secret unless `AUTH_SECRET` is set.
- `CRON_SECRET`, `VAPID_*`, `SMTP_*` — for reminders (cron, Web Push, email).
  `SMTP_*` is not optional in practice: the emailed code is the fallback way into
  the vault when no face is enrolled.

#### Setting up the Google client ID

1. Google Cloud console → **APIs & Services → Credentials → Create credentials →
   OAuth client ID**, application type **Web application**.
2. Under **Authorised JavaScript origins** add every origin the app is served
   from — `http://localhost:8088` for local development, plus your production
   domain. (No redirect URIs are needed; Google Identity Services posts the
   credential straight back to the page.)
3. Copy the client ID into `server/.env` as `GOOGLE_CLIENT_ID`.

### Upgrading a database from the old household layout

Earlier versions had no accounts: one shared `APP_ACCESS_KEY` gated everything
and a `profiles` table stood in for people. To move an existing database over:

```sh
cd server
npm run migrate    # additive only — adds users/user_id/parent_key alongside the old columns
npm run backfill   # ONE-SHOT: copies profiles into users, then drops the legacy tables
```

`backfill` runs in a single transaction and rolls back completely on any error.
Each profile becomes an **unclaimed** account, adopted the first time someone
signs in with Google using the matching email address. Two things to know:

- A profile with a blank email can never be claimed. The script prints those,
  with the `UPDATE` needed to give them a real address.
- Existing push subscriptions are deleted — there is no way to tell which person
  a browser endpoint belonged to, and guessing would deliver one account's
  reminders to another's device. Devices re-subscribe on their next visit.

`APP_ACCESS_KEY` is no longer read by anything and can be removed from `.env`.

The web app calls the API at `http://localhost:3088/api` by default; override it
by setting `window.DAYFLOW_API_BASE` before `support.js` loads (e.g. when the API
is hosted elsewhere, such as a Vercel deployment where it lives at `/api`).

### How it fits together

- **`index.html`** — the whole web app: a view template plus the component logic
  (`class Component extends DCLogic`). Its data layer talks to the REST API.
- **`support.js`** — the vendored runtime that compiles the template and mounts
  the app (loads React with Subresource-Integrity pinning).
- **`sw.js`** — service worker: installable/offline app shell and reminder push
  notifications. (It never caches API calls, so your data is always fresh.)
- **Charts** use ApexCharts and **face matching** uses face-api, both loaded from
  a CDN with integrity hashes. The Google Identity Services script is the one
  exception — Google rotates it, so it cannot carry an SRI hash.
- **Data** lives in Postgres; the browser only keeps a tiny marker for the
  once-a-day task reset.

### Security notes

- **Every row is scoped to the signed-in account.** Reads *and* writes constrain
  on `user_id`, so another account's id in a URL is simply a 404 — never a
  successful edit. `npm run smoke` asserts this against two live accounts.
- **The vault lock is enforced server-side.** Reading or writing vault items
  requires a short-lived step-up token minted only by a successful face match or
  emailed code, and it is never persisted to storage. `auth_disabled`-style
  bypasses no longer exist.
- Passwords are encrypted with AES-256-GCM; login codes are stored hashed;
  sign-in and the code endpoints are rate-limited and return `429` with
  `Retry-After`.
- Google ID tokens are verified with `google-auth-library` (signature, issuer,
  audience, expiry) and an unverified Google email can never claim an account.

### Assets

- `assets/bg.png` — welcome-screen background. `assets/logo.svg` — the Dayflow
  logo. The app font is **Sora**.
</content>
