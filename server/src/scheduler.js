const { pool, query } = require('./db');
const { sendMail } = require('./mail');
const { broadcast, pushEnabled } = require('./push');

// One pass: find reminders that are due, not done, and not yet dispatched,
// then deliver each (email or push) and stamp notified_at so it never repeats.
// Returns { due, sent } so the cron endpoint can report what it did.
async function tick() {
  let rows;
  try {
    ({ rows } = await query(
      `SELECT r.*, p.name AS profile_name, p.email AS profile_email
         FROM reminders r JOIN profiles p ON p.id = r.profile_id
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
      if (r.method === 'email') {
        await sendMail({
          to: r.email || r.profile_email,
          subject: 'Reminder: ' + r.title,
          text: `Hi ${r.profile_name},\n\nThis is your Dayflow reminder: ${r.title}\n\nDue: ${new Date(r.datetime).toLocaleString()}\n`,
          html: `<p>Hi ${escapeHtml(r.profile_name)},</p><p>This is your Dayflow reminder:</p>`
            + `<p style="font-size:18px;font-weight:700">${escapeHtml(r.title)}</p>`
            + `<p style="color:#666">Due: ${new Date(r.datetime).toLocaleString()}</p>`,
        });
        console.log('[scheduler] emailed reminder', r.id, '->', r.email);
      } else {
        const n = await broadcast({
          title: 'Dayflow reminder',
          body: r.title,
          tag: 'reminder-' + r.id,
          reminderId: r.id,
          profile: r.profile_name,
        });
        console.log('[scheduler] pushed reminder', r.id, '->', n, 'device(s)');
      }
      await query('UPDATE reminders SET notified_at = now() WHERE id = $1', [r.id]);
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
  tick().catch(() => {});
  const timer = setInterval(() => tick().catch(() => {}), ms);
  timer.unref?.();
  return timer;
}

module.exports = { startScheduler, tick };
