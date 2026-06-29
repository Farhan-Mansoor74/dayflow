const webpush = require('web-push');
const { pool, query } = require('./db');

let configured = false;

function pushEnabled() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function ensureConfigured() {
  if (configured) return true;
  if (!pushEnabled()) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@dayflow.local',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  configured = true;
  return true;
}

async function saveSubscription(sub) {
  if (!sub || !sub.endpoint || !sub.keys) throw new Error('invalid subscription');
  await query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ($1,$2,$3)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth]
  );
}

async function deleteSubscription(endpoint) {
  await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

// Send a payload to every stored subscription. Prunes subscriptions the push
// service reports as gone (404/410). Returns the number of successful sends.
async function broadcast(payload) {
  if (!ensureConfigured()) return 0;
  const { rows } = await query('SELECT endpoint, p256dh, auth FROM push_subscriptions');
  let ok = 0;
  const data = JSON.stringify(payload);
  await Promise.all(
    rows.map(async (r) => {
      const sub = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
      try {
        await webpush.sendNotification(sub, data);
        ok++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await deleteSubscription(r.endpoint).catch(() => {});
        } else {
          console.error('[push] send failed:', e.statusCode || e.message);
        }
      }
    })
  );
  return ok;
}

module.exports = { pushEnabled, saveSubscription, deleteSubscription, broadcast };
