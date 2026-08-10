const { pool, query } = require('./db');
const { sendMail } = require('./mail');
const { sendToUser, pushEnabled } = require('./push');

const SELECT_DUE = `SELECT r.*, u.name AS user_name, u.email AS user_email
                      FROM reminders r JOIN users u ON u.id = r.user_id`;

// Deliver one reminder (email or push) and stamp notified_at so it never
// repeats. Throws on failure, leaving notified_at NULL so the caller — or the
// next cron tick — can retry.
async function deliver(r) {
  if (r.method === 'email') {
    await sendMail({
      to: r.email || r.user_email,
      subject: 'Reminder: ' + r.title,
      text: `Hi ${r.user_name},\n\nThis is your Dayflow reminder: ${r.title}\n\nDue: ${new Date(r.datetime).toLocaleString()}\n`,
      html: `<p>Hi ${escapeHtml(r.user_name)},</p><p>This is your Dayflow reminder:</p>`
        + `<p style="font-size:18px;font-weight:700">${escapeHtml(r.title)}</p>`
        + `<p style="color:#666">Due: ${new Date(r.datetime).toLocaleString()}</p>`,
    });
    console.log('[scheduler] emailed reminder', r.id, '->', r.email || r.user_email);
  } else {
    const n = await sendToUser(r.user_id, {
      title: 'Dayflow reminder',
      body: r.title,
      tag: 'reminder-' + r.id,
      reminderId: r.id,
    });
    console.log('[scheduler] pushed reminder', r.id, '->', n, 'device(s)');
  }
  await query('UPDATE reminders SET notified_at = now() WHERE id = $1', [r.id]);
}

// Deliver a single reminder by id — the QStash callback path. Returns a short
// status string rather than throwing for the "nothing to do" cases, so an
// already-handled callback is a 200 and QStash stops retrying it.
async function dispatchOne(id) {
  const { rows } = await query(`${SELECT_DUE} WHERE r.id = $1`, [id]);
  if (!rows.length) return 'not found';
  const r = rows[0];
  if (r.done) return 'already done';
  if (r.notified_at) return 'already notified';
  await deliver(r);
  return 'sent';
}

// One pass: find reminders that are due, not done, and not yet dispatched, then
// deliver each. Still the backstop when a QStash callback never arrives, and the
// only mechanism when QSTASH_TOKEN is unset.
// Returns { due, sent } so the cron endpoint can report what it did.
async function tick() {
  let rows;
  try {
    ({ rows } = await query(
      `${SELECT_DUE}
        WHERE r.done = false AND r.notified_at IS NULL AND r.datetime <= now()
        ORDER BY r.datetime
        LIMIT 50`
    ));
  } catch (e) {
    console.error('[scheduler] query failed:', e.message);
    return { due: 0, sent: 0, error: e.message };
  }

  let sent = 0;
  for (const r of rows) {
    try {
      await deliver(r);
      sent++;
    } catch (e) {
      // Leave notified_at NULL so it retries on the next tick.
      console.error('[scheduler] failed to dispatch reminder', r.id, '-', e.message);
    }
  }
  return { due: rows.length, sent };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function startScheduler() {
  const ms = Number(process.env.REMINDER_POLL_MS) || 30000;
  console.log(`[scheduler] started — checking due reminders every ${ms}ms (push: ${pushEnabled() ? 'on' : 'off'})`);
  const both = () => Promise.all([
    tick().catch(() => {}),
    // Required lazily: digest.js pulls in push.js, which this module also uses.
    require('./digest').digestTick().catch(() => {}),
  ]);
  both();
  const timer = setInterval(both, ms);
  timer.unref?.();
  return timer;
}

module.exports = { startScheduler, tick, dispatchOne };
