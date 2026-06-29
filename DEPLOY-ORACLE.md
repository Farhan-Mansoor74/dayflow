# Deploying Dayflow on an Oracle Cloud "Always Free" VM

This hosts the **API + reminder scheduler** (always-on, never sleeps) and serves the
**PWA frontend** from the same box, over HTTPS, for **$0/month**. Your data stays in **Neon**.

End state: `https://dayflow.yourdomain.com` → Caddy serves the app and reverse-proxies
`/api/*` to the Node server (pm2-managed) → Neon Postgres.

---

## 0. What you need first

- An **Oracle Cloud** account (the Always Free tier — no charges).
- Your **Neon** `DATABASE_URL` (you already have this; it ends with `?sslmode=require`).
- A **domain or subdomain** you control, for the HTTPS cert. You own `ramatechme.com`, so use
  e.g. **`dayflow.ramatechme.com`**. (Caddy gets a free Let's Encrypt cert automatically, but
  it needs a real hostname — a bare IP won't work. No domain? See "DuckDNS fallback" at the end.)
- The secrets from your local `server/.env`. ⚠️ **You must reuse the same `VAULT_KEY`** — your
  Neon vault passwords are encrypted with it; a different key makes them undecryptable.

---

## 1. Create the VM

1. Oracle Cloud Console → **Compute → Instances → Create instance**.
2. **Image:** Canonical **Ubuntu 22.04**.
3. **Shape:** Click *Change shape* →
   - Prefer **Ampere (ARM) VM.Standard.A1.Flex**, 1 OCPU / 6 GB (Always Free). If you get an
     "out of capacity" error, switch to **VM.Standard.E2.1.Micro** (AMD, also Always Free) — it's
     smaller but fine for this app. (Node runs on both.)
4. **SSH keys:** upload/generate a key pair and **save the private key**.
5. Create it, then copy the instance's **Public IP address**.

## 2. Open the firewall (BOTH layers — this is the classic Oracle gotcha)

**a) Cloud network (Security List):** Instance → its **VCN → Security Lists → default** →
*Add Ingress Rules*, source `0.0.0.0/0`, two rules: **TCP 80** and **TCP 443**.

**b) The VM's own iptables** (Ubuntu on Oracle ships locked down). SSH in first:
```sh
ssh -i /path/to/your-key ubuntu@YOUR_PUBLIC_IP
```
Then:
```sh
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 3. Point DNS at the VM

At your domain's DNS provider, add an **A record**:
`dayflow` → `YOUR_PUBLIC_IP` (host `dayflow`, type A). Wait a minute, then check:
```sh
dig +short dayflow.ramatechme.com   # should print your IP
```

## 4. Install Node, pm2, and Caddy (on the VM)

```sh
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm i -g pm2

# Caddy (reverse proxy + automatic HTTPS)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## 5. Get the code onto the VM

Easiest (no GitHub) — from **your PC**, copy the project up (excluding junk):
```sh
# run on your local machine, from the dayflow folder's parent
scp -i /path/to/your-key -r ./dayflow ubuntu@YOUR_PUBLIC_IP:/home/ubuntu/dayflow
```
On the VM, remove any copied local `node_modules` so you build fresh for Linux/ARM:
```sh
rm -rf /home/ubuntu/dayflow/server/node_modules
```
*(Alternative: push the repo to a private GitHub repo and `git clone` it on the VM.)*

## 6. Configure `server/.env` on the VM

```sh
cd /home/ubuntu/dayflow/server
nano .env
```
Fill it in (reuse your real values):
```ini
DATABASE_URL=postgres://USER:PASS@ep-xxx.neon.tech/dbname?sslmode=require
VAULT_KEY=<<<the SAME 64-hex key you used locally>>>
APP_ACCESS_KEY=<<<a long random key — see note below>>>
SESSION_DAYS=30
PORT=3001
CORS_ORIGINS=https://dayflow.ramatechme.com

VAPID_PUBLIC_KEY=...     # your existing values
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:dev@ramatechme.com

SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=your-16-char-app-password
MAIL_FROM=Dayflow <you@gmail.com>
REMINDER_POLL_MS=30000
```
> 🔑 Generate a strong access key:
> `node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"`
> Save it in your password manager — you'll type it into the app on each device once.

## 7. Install deps, migrate, and start the API

```sh
cd /home/ubuntu/dayflow/server
npm install --omit=dev
npm run migrate          # safe to re-run; ensures the schema (incl. auth_disabled) exists
pm2 start src/server.js --name dayflow-api
pm2 save
pm2 startup systemd      # then run the exact `sudo env ...` command it prints
```
Check it's up locally on the box:
```sh
curl -s http://localhost:3001/api/health
# {"status":"ok","db":"up","vault":"enabled","push":"enabled","auth":"enabled"}
```
`auth":"enabled"` confirms the household key is active.

## 8. Caddy: serve the app + HTTPS

```sh
sudo nano /etc/caddy/Caddyfile
```
Replace the contents with (use your real hostname):
```caddy
dayflow.ramatechme.com {
    encode gzip
    handle /api/* {
        reverse_proxy 127.0.0.1:3001
    }
    handle {
        root * /home/ubuntu/dayflow
        try_files {path} /index.html
        file_server
    }
}
```
Reload — Caddy fetches the TLS cert automatically (needs the DNS A record from step 3):
```sh
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager   # should be active (running)
```

## 9. Done — install the PWA

Open **`https://dayflow.ramatechme.com`** on your tablet:
1. You'll see **Enter access key** → type your `APP_ACCESS_KEY` (once; valid 30 days).
2. Browser menu → **Install app / Add to Home Screen** → launches fullscreen.

---

## Updating later

```sh
# copy changed files up (or `git pull` on the VM), then:
cd /home/ubuntu/dayflow/server && npm install --omit=dev   # only if deps changed
pm2 restart dayflow-api
# frontend files are static — Caddy serves them immediately; hard-refresh to bust the SW cache,
# or bump CACHE = 'dayflow-shell-vN' in sw.js when you change index.html/support.js.
```

## Troubleshooting

- **Site won't load / cert pending:** almost always the firewall. Re-check **both** the VCN
  Security List (80+443) **and** the VM iptables (step 2). `sudo journalctl -u caddy -n 50` shows
  cert errors; the hostname must resolve to the VM (step 3) before Caddy can issue a cert.
- **`db":"down"` in health:** the Neon string is wrong or missing `?sslmode=require`. Test with
  `psql "$DATABASE_URL"`. If you get a TLS verify error, try `...&sslmode=no-verify` (Neon's cert
  is fine; this just skips local CA checks).
- **App loads but every action fails / 401 loop:** `CORS_ORIGINS` must exactly equal your HTTPS
  origin, and you must enter the same `APP_ACCESS_KEY` you set in `.env`.
- **Vault passwords show blank/garbled:** `VAULT_KEY` on the VM doesn't match the one that
  encrypted your Neon data. Use the original.
- **Reminders/email not sending:** check `pm2 logs dayflow-api`. Gmail needs an **App Password**
  (2FA on). Push needs the VAPID keys set and the user to have enabled notifications.

## No domain? DuckDNS fallback

Get a free subdomain at **duckdns.org** (e.g. `yourname.duckdns.org`), point it at the VM IP in
their dashboard, and use that hostname in the Caddyfile and `CORS_ORIGINS`. Everything else is
identical.
