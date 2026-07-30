// Upstash QStash: schedules ONE HTTP callback per reminder, at its exact time.
//
// Why: the polling cron had to wake the database every minute just to discover
// that nothing was due. On Neon's free plan that keeps the compute from ever
// suspending, which is what exhausted the 100 CU-hour monthly quota. Scheduling
// per reminder means the database is touched only when something actually
// happens, and reminders fire on time instead of up to an interval late.
//
// Every function here is a no-op when QSTASH_TOKEN is unset, so the app keeps
// working on the cron alone.

const QSTASH_API = 'https://qstash.upstash.io/v2';

function token() {
  return process.env.QSTASH_TOKEN || '';
}

function enabled() {
  return !!(token() && process.env.PUBLIC_BASE_URL && process.env.CRON_SECRET);
}

// Reason QStash is not usable, for /health and startup logging.
function disabledReason() {
  if (!token()) return 'QSTASH_TOKEN not set';
  if (!process.env.PUBLIC_BASE_URL) return 'PUBLIC_BASE_URL not set';
  if (!process.env.CRON_SECRET) return 'CRON_SECRET not set';
  return null;
}

// Schedule a callback for one reminder. Returns the QStash message id, or null
// if scheduling is unavailable or failed — callers must treat null as "the cron
// will catch this" rather than as fatal.
async function schedule(reminder) {
  if (!enabled()) return null;

  const base = process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const target = `${base}/api/reminders/${reminder.id}/fire`;
  const at = Math.floor(new Date(reminder.datetime).getTime() / 1000);

  try {
    const res = await fetch(`${QSTASH_API}/publish/${encodeURIComponent(target)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        // Absolute delivery time. A time in the past means "deliver now", which
        // is what we want for a reminder created for a moment already gone.
        'Upstash-Not-Before': String(at),
        // QStash forwards this to us as `x-cron-key`, so the callback is
        // authenticated by the same shared secret the cron endpoint uses.
        'Upstash-Forward-x-cron-key': process.env.CRON_SECRET,
        // Retry a failed delivery a few times before giving up; the hourly cron
        // is the final backstop.
        'Upstash-Retries': '3',
      },
    });

    if (!res.ok) {
      console.error('[qstash] publish failed:', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const body = await res.json();
    return body.messageId || null;
  } catch (e) {
    console.error('[qstash] publish error:', e.message);
    return null;
  }
}

// Cancel a previously scheduled callback. Safe to call with a stale id — a 404
// just means it already fired or was already removed.
async function cancel(messageId) {
  if (!messageId || !token()) return;
  try {
    const res = await fetch(`${QSTASH_API}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (!res.ok && res.status !== 404) {
      console.error('[qstash] cancel failed:', res.status);
    }
  } catch (e) {
    console.error('[qstash] cancel error:', e.message);
  }
}

// True when this reminder should have a callback pending.
function shouldSchedule(row) {
  return !!row && row.done === false && row.notified_at == null;
}

// Cancel whatever was scheduled for a reminder and, if it still needs one,
// schedule a fresh callback. Used on both create and update, because an edited
// time means the old callback is wrong.
async function reschedule(row) {
  await cancel(row.qstash_id);
  if (!shouldSchedule(row)) return null;
  return schedule(row);
}

module.exports = { enabled, disabledReason, schedule, cancel, reschedule, shouldSchedule };
