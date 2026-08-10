const { query } = require('./db');
const { sendToUser, pushEnabled } = require('./push');

// ---------------------------------------------------------------------------
// Smart notifications — the daily nudges, as opposed to reminders (which fire at
// an exact instant and are handled by scheduler.js).
//
//   morning (digest_hour)  →  "3 tasks for today"      + "Tomorrow: <reminder>"
//   evening (wrapup_hour)  →  "2 tasks still open"
//
// Everything is computed in the USER's timezone, so one pass over all users
// serves every zone correctly. Idempotency comes from digest_sent_on /
// wrapup_sent_on holding the local date the digest last went out: the pass can
// run every minute or once an hour and still send exactly once a day.
//
// Nothing is ever sent when there is nothing to say — an empty digest is the
// fastest way to teach someone to disable notifications.
// ---------------------------------------------------------------------------

// Local date (YYYY-MM-DD), hour (0-23) and weekday (0=Sun) for a timezone.
// en-CA gives ISO-ordered dates, which is what makes the string comparable.
function localNow(tz, now = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(now);
  } catch {
    // A timezone that no longer resolves must not take the whole pass down.
    return localNow('UTC', now);
  }
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // 'hour' can come back as '24' at midnight in some ICU versions.
  const hour = Number(get('hour')) % 24;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour, weekday: WD[get('weekday')] ?? 0 };
}

const addDays = (ymd, n) => {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// A task counts for "today" if it repeats daily, is a one-off, or is a weekly
// task scheduled for today's weekday. Mirrors visibleTasks() in the client.
async function openTasksToday(userId, weekday) {
  const { rows } = await query(
    `SELECT title FROM tasks
      WHERE user_id = $1 AND completed = false
        AND (type <> 'weekly' OR $2 = ANY(days))
      ORDER BY position, created_at`,
    [userId, weekday]
  );
  return rows.map((r) => r.title);
}

// Reminders whose local calendar date is tomorrow and that haven't been
// flagged yet. The window is computed in UTC from the user's local day.
async function remindersTomorrow(userId, tz, localDate) {
  const { rows } = await query(
    `SELECT id, title, datetime FROM reminders
      WHERE user_id = $1 AND done = false AND notified_at IS NULL AND headsup_sent_at IS NULL
        AND datetime > now()
        AND (datetime AT TIME ZONE $2)::date = $3::date
      ORDER BY datetime`,
    [userId, tz || 'UTC', addDays(localDate, 1)]
  );
  return rows;
}

const list = (titles, max = 3) => {
  const head = titles.slice(0, max).join(', ');
  const rest = titles.length - max;
  return rest > 0 ? `${head} +${rest} more` : head;
};

async function sendMorning(u, local) {
  let sent = 0;
  if (u.notify_digest) {
    const titles = await openTasksToday(u.id, local.weekday);
    if (titles.length) {
      sent += await sendToUser(u.id, {
        title: titles.length === 1 ? '1 task for today' : `${titles.length} tasks for today`,
        body: list(titles),
        tag: 'digest-' + local.date,
      });
    }
  }
  if (u.notify_headsup) {
    const rows = await remindersTomorrow(u.id, u.timezone, local.date);
    if (rows.length) {
      sent += await sendToUser(u.id, {
        title: rows.length === 1 ? 'Tomorrow: ' + rows[0].title : `${rows.length} reminders tomorrow`,
        body: rows.length === 1 ? 'A heads-up a day early.' : list(rows.map((r) => r.title)),
        tag: 'headsup-' + local.date,
      });
      await query('UPDATE reminders SET headsup_sent_at = now() WHERE id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
    }
  }
  return sent;
}

async function sendEvening(u, local) {
  if (!u.notify_wrapup) return 0;
  const titles = await openTasksToday(u.id, local.weekday);
  if (!titles.length) return 0; // all done — say nothing
  return sendToUser(u.id, {
    title: titles.length === 1 ? '1 task still open' : `${titles.length} tasks still open`,
    body: list(titles),
    tag: 'wrapup-' + local.date,
  });
}

// One pass over every user who has at least one device subscribed. Returns
// { considered, sent } for the cron endpoint to report.
async function digestTick(now = new Date()) {
  if (!pushEnabled()) return { considered: 0, sent: 0, skipped: 'push not configured' };
  let users;
  try {
    // The two dates come back as text: node-postgres maps a DATE column to a JS
    // Date at the SERVER's midnight, so comparing it to a user-local YYYY-MM-DD
    // would be off by a day for half the world.
    ({ rows: users } = await query(
      `SELECT u.*, to_char(u.digest_sent_on, 'YYYY-MM-DD') AS digest_on,
                   to_char(u.wrapup_sent_on, 'YYYY-MM-DD') AS wrapup_on
         FROM users u
        WHERE EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id)
          AND (u.notify_digest OR u.notify_headsup OR u.notify_wrapup)`
    ));
  } catch (e) {
    console.error('[digest] query failed:', e.message);
    return { considered: 0, sent: 0, error: e.message };
  }

  let sent = 0;
  for (const u of users) {
    const local = localNow(u.timezone, now);
    try {
      // >= rather than == so a cron that runs hourly (or misses a tick) still
      // delivers, just later in the day. The sent_on guard stops repeats.
      if (local.hour >= u.digest_hour && u.digest_on !== local.date) {
        sent += await sendMorning(u, local);
        await query('UPDATE users SET digest_sent_on = $1 WHERE id = $2', [local.date, u.id]);
      }

      if (local.hour >= u.wrapup_hour && u.wrapup_on !== local.date) {
        sent += await sendEvening(u, local);
        await query('UPDATE users SET wrapup_sent_on = $1 WHERE id = $2', [local.date, u.id]);
      }
    } catch (e) {
      // One user's bad data must not stop everyone else's digest.
      console.error('[digest] user', u.id, 'failed:', e.message);
    }
  }
  return { considered: users.length, sent };
}

module.exports = { digestTick, localNow, openTasksToday, remindersTomorrow };
