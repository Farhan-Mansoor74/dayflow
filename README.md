# Dayflow

A tablet-friendly personal organizer with per-person profiles. Each profile has four tabs:

- **Tasks** — daily / weekly / one-time tasks with a progress ring, drag-to-reorder, and a daily auto-reset.
- **Reminders** — date/time reminders delivered for real by the backend scheduler: **email** (via SMTP) or **Web Push** notifications that arrive even when the app is closed. Status shown as upcoming / due soon / overdue / done. See [`server/README.md`](server/README.md#reminders-email--web-push) for setup.
- **Expenses** — income & expense logging (including **voice input** — tap the mic and say e.g. "twelve dollars on coffee" to auto-fill amount, description, category & type), monthly totals, a 30-day spending-trend chart (ApexCharts), and an interactive spending-by-category donut. Voice uses the browser Web Speech API (Chrome/Edge, needs mic permission + internet).
- **Vault** — stored credentials (label, username, password with reveal toggle, notes).

Each profile has a **required email** (used for reminders + login codes) and optional **Face Unlock**:
set it up on the Manage screen (camera + on-device face descriptor, stored encrypted server-side). A
profile with face unlock becomes **gated** — opening it requires a **face scan** (matched server-side)
or an **emailed 6-digit code** as the fallback. Face match has no liveness detection (a photo can fool
it), so the email code is the strong factor; profiles without face unlock open normally.
**Deleting a profile is always gated** — it requires the same identity check (face scan if
enrolled, otherwise the emailed code), so only the profile's owner can remove it and its data.

## Installable (PWA)

Dayflow is a Progressive Web App — open it in Chrome/Edge and use "Install app" (or Add to Home
Screen on mobile) to run it fullscreen like a native app. Provided by `manifest.webmanifest`, the
icons in `assets/`, and the `sw.js` service worker (which also caches the app shell for basic offline
use and delivers reminder push notifications). Requires a secure context — `http://localhost` works;
a LAN IP/domain needs HTTPS. The camera (face unlock) and Web Speech (voice) also require that.

Data is stored in **Postgres** via the REST API in [`server/`](server/). The
frontend loads all profiles/tasks/reminders/expenses/vault from the API on
startup and writes every change back through it (optimistic UI — changes show
instantly and sync in the background; a toast appears and the view re-syncs if a
call fails). The one thing still kept in the browser is a `localStorage` marker
(`dayflow_lastReset`) used to run the once-a-day task reset.

The API base URL defaults to `http://localhost:3001/api`; override it by setting
`window.DAYFLOW_API_BASE` before `support.js` loads, if you host the API
elsewhere.

## Running

You need **two things running**: the API server and a static server for this
frontend. The frontend must be served over HTTP (not `file://`) and from an
origin the API allows via CORS (default: `http://localhost:8000`).

```sh
# 1) start the backend (see server/README.md for first-time DB setup)
cd server && npm start            # http://localhost:3001

# 2) in another terminal, serve the frontend from this folder on port 8000
python -m http.server 8000        # or: npx serve . -l 8000
```

Then open http://localhost:8000. If the API isn't running you'll see a
"Can't reach the server" screen with a Retry button.

## Structure

- `index.html` — the entire app: the `<x-dc>` view template plus the component logic
  (`class Component extends DCLogic`), originally generated from the Claude Design source
  `Dayflow.dc.html`. The component's data layer has been rewired from `localStorage` to the
  REST API (`api()` / `loadFromServer()` / per-mutation `fetch` calls); the view/template
  layer is unchanged.
- `support.js` — the self-contained Claude Design runtime (vendored). It loads React/ReactDOM
  from unpkg, compiles the `<x-dc>` template, and mounts the component on page load.
- **ApexCharts** is loaded from a CDN (`<head>`) and mounted imperatively into a ref'd container
  for the Expenses "Spending Trend" area chart (`renderSpendChart()` in `index.html`).
- `sw.js` — service worker that displays reminder **Web Push** notifications (registered by
  `index.html` when the user enables notifications).

## Assets & branding

- `assets/bg.png` — background illustration on the profile-picker screen. A subtle top-down
  dark scrim is layered over it (in `index.html`) so the white heading stays readable.
- `assets/logo.svg` — the Dayflow logo, shown in place of the old "Dayflow" wordmark on the
  onboarding and picker screens.
- The app font is **Sora** (set as the `font` prop default and the runtime fallback in `index.html`).
