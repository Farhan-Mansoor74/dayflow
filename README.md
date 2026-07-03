# Dayflow

A simple, shared organizer for a household or small team. Everyone gets their own
profile on the same device — and each person's tasks, reminders, expenses and
passwords stay separate.

It runs in any modern browser and can be **installed like a real app** on your
phone, tablet, or computer.

## What you can do

- **📋 Tasks** — plan your day with daily, weekly, or one-off tasks. Tick them off
  to fill your progress ring, drag to reorder, and everything recurring resets
  automatically each morning.
- **⏰ Reminders** — pick a date and time and choose how you're reminded: an
  **email**, or a **push notification** that still arrives when the app is closed.
- **💸 Expenses** — track income and spending. Type it in, or just **say it** —
  tap the mic and speak *"twelve dollars on coffee"* and it fills in the rest.
  See monthly totals, a spending trend, and a breakdown by category.
- **🔒 Vault** — keep passwords and notes safe. They're encrypted, with a tap to
  reveal.
- **👤 Profiles** — one per person, each with its own colour and data. Lock a
  profile with **Face Unlock** or an **emailed code** so only its owner can open
  or delete it.

## Getting started (using the app)

1. **Open the app** in your browser (Chrome or Edge work best) and, if you like,
   choose **Install app** / **Add to Home Screen** to run it fullscreen.
2. **Create a profile** — enter a name, pick a colour, and add an email. The email
   is used for reminders and login codes, so use a real one.
3. **Add your first task** with the **+** button, then explore the Reminders,
   Expenses, and Vault tabs along the top.
4. **(Optional) Lock your profile** from the **Manage** screen if you want a
   face scan or emailed code required to open it. Profiles without a lock open
   straight away.

That's it — everything you add is saved automatically.

## Good to know

- **Locking a profile is real.** A locked profile's passwords can't be opened,
  and the profile can't be edited or deleted, until you unlock it with a face
  scan or an emailed code. If you close and reopen the app, you'll be asked to
  unlock again.
- **Face unlock isn't foolproof** — it has no "liveness" check, so a photo could
  fool it. The emailed code is the strong fallback and is always available.
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
npm start               # → http://localhost:3001

# 2) Frontend — in another terminal, from the project root
python -m http.server 8000     # or: npx serve . -l 8000
```

Then open **http://localhost:8000**. See [`server/README.md`](server/README.md)
for database, email (SMTP), and Web Push setup.

### Configuration

Secrets live in `server/.env` (never committed). Key ones:

- `DATABASE_URL` — Postgres connection string.
- `APP_ACCESS_KEY` — shared key that gates the whole API. When set, a device
  unlocks once and gets a 30-day session.
- `VAULT_KEY` — 32-byte key that encrypts vault passwords at rest (`npm run keygen`).
- `CRON_SECRET`, `VAPID_*`, `SMTP_*` — for reminders (cron, Web Push, email).

The web app calls the API at `http://localhost:3001/api` by default; override it
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
  a CDN with integrity hashes.
- **Data** lives in Postgres; the browser only keeps a tiny marker for the
  once-a-day task reset.

### Security notes

- The per-profile lock is enforced **server-side**: opening a locked profile's
  vault, or editing/deleting it, requires a short-lived token minted only by a
  successful face match or emailed code.
- Passwords are encrypted with AES-256-GCM; login codes are stored hashed; the
  access-key check and code endpoints are rate-limited.

### Assets

- `assets/bg.png` — profile-picker background. `assets/logo.svg` — the Dayflow
  logo. The app font is **Sora**.
</content>
