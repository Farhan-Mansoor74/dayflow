const express = require('express');
const { pool, query } = require('./db');
const rateLimit = require('express-rate-limit');
const { encrypt, decrypt, vaultEnabled } = require('./crypto');
const { saveSubscription, deleteSubscription, pushEnabled } = require('./push');
const { THRESHOLD, encodeDescriptor, decodeDescriptor, distance } = require('./face');
const { TTL_MS, MAX_ATTEMPTS, generateCode, hashCode, safeEqual, maskEmail, emailCode } = require('./otp');
const { authEnabled, checkKey, issueToken, requireAuth } = require('./auth');
const { tick } = require('./scheduler');

// Never expose face_descriptor / otp_* columns to clients.
const profileOut = (r) => ({
  id: r.id, name: r.name, color: r.color, email: r.email || '',
  position: r.position, created_at: r.created_at,
  faceEnrolled: !!r.face_descriptor, authDisabled: !!r.auth_disabled,
});

// Brute-force protection on the household-key check.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again later.' },
});

// Per-profile limit on requesting login codes (brute-force / spam protection).
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => 'otp:' + (req.params.id || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many code requests — try again later.' },
});
const v = require('./validate');

const router = express.Router();

// Wrap async handlers so thrown errors reach the error middleware.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- tiny parameterized SQL helpers (no string interpolation of values) ----
async function insert(table, obj) {
  const cols = Object.keys(obj);
  const vals = cols.map((c) => obj[c]);
  const ph = cols.map((_, i) => `$${i + 1}`);
  const { rows } = await query(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING *`,
    vals
  );
  return rows[0];
}

async function updateById(table, id, obj) {
  const cols = Object.keys(obj);
  if (cols.length === 0) return getById(table, id);
  const set = cols.map((c, i) => `${c} = $${i + 1}`);
  const { rows } = await query(
    `UPDATE ${table} SET ${set.join(', ')} WHERE id = $${cols.length + 1} RETURNING *`,
    [...cols.map((c) => obj[c]), id]
  );
  return rows[0] || null;
}

async function getById(table, id) {
  const { rows } = await query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function deleteById(table, id) {
  const { rowCount } = await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  return rowCount > 0;
}

async function profileExists(id) {
  const { rows } = await query('SELECT 1 FROM profiles WHERE id = $1', [id]);
  return rows.length > 0;
}

const notFound = (res, what = 'resource') => res.status(404).json({ error: `${what} not found` });

// ===========================================================================
// Health
// ===========================================================================
router.get('/health', h(async (_req, res) => {
  let db = 'down';
  try {
    await query('SELECT 1');
    db = 'up';
  } catch {
    /* leave as down */
  }
  res.json({
    status: 'ok', db,
    vault: vaultEnabled() ? 'enabled' : 'disabled',
    push: pushEnabled() ? 'enabled' : 'disabled',
    auth: authEnabled() ? 'enabled' : 'disabled',
  });
}));

// ===========================================================================
// Household-key authentication. Exchange the shared key for a device session
// token; everything below this point requires that token (when auth is on).
// ===========================================================================
// DB-backed brute-force lockout, keyed by client IP. Survives serverless cold
// starts (no shared in-memory state there). 10 wrong tries -> 15-min lock.
const AUTH_MAX_FAILS = 10, AUTH_WINDOW_MS = 15 * 60 * 1000, AUTH_LOCK_MS = 15 * 60 * 1000;
async function throttleCheck(ip) {
  const { rows } = await query('SELECT fails, locked_until, updated_at FROM auth_throttle WHERE ip = $1', [ip]);
  const row = rows[0];
  if (row && row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    return { locked: true, retryMs: new Date(row.locked_until).getTime() - Date.now() };
  }
  return { locked: false, row };
}
async function throttleFail(ip, row) {
  const now = Date.now();
  const fresh = row && row.updated_at && now - new Date(row.updated_at).getTime() < AUTH_WINDOW_MS;
  const fails = fresh ? (row.fails || 0) + 1 : 1;
  const lockedUntil = fails >= AUTH_MAX_FAILS ? new Date(now + AUTH_LOCK_MS) : null;
  await query(
    `INSERT INTO auth_throttle (ip, fails, locked_until, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (ip) DO UPDATE SET fails = $2, locked_until = $3, updated_at = now()`,
    [ip, fails, lockedUntil]
  );
}
const throttleClear = (ip) => query('DELETE FROM auth_throttle WHERE ip = $1', [ip]).catch(() => {});

router.post('/auth', authLimiter, h(async (req, res) => {
  if (!authEnabled()) return res.json({ ok: true, authRequired: false });
  const ip = req.ip || 'unknown';
  const t = await throttleCheck(ip);
  if (t.locked) {
    res.set('Retry-After', String(Math.ceil(t.retryMs / 1000)));
    return res.status(429).json({ error: 'too many attempts — try again later' });
  }
  if (!checkKey(req.body && req.body.key)) {
    await throttleFail(ip, t.row);
    return res.status(401).json({ error: 'incorrect access key' });
  }
  await throttleClear(ip);
  const { token, expiresAt } = issueToken();
  res.json({ token, expiresAt });
}));

// ===========================================================================
// Reminder cron tick — called by an external scheduler (e.g. cron-job.org) on
// serverless hosts where there's no always-on process. Protected by CRON_SECRET.
// ===========================================================================
['GET', 'POST'].forEach(method => {
  router[method.toLowerCase()]('/cron/run', h(async (req, res) => {
    const secret = process.env.CRON_SECRET || '';
    const provided = (req.get('x-cron-key') || (req.query && req.query.key) || '').toString();
    if (!secret || !safeEqual(provided, secret)) return res.status(401).json({ error: 'unauthorized' });
    const result = await tick();
    res.json({ ok: true, ...(result || {}) });
  }));
});

// ---- Everything past here is gated by a valid session token ----------------
router.use(requireAuth);

// ===========================================================================
// Profiles
// ===========================================================================
router.get('/profiles', h(async (_req, res) => {
  const { rows } = await query('SELECT * FROM profiles ORDER BY position, created_at');
  res.json(rows.map(profileOut));
}));

router.post('/profiles', h(async (req, res) => {
  const row = await insert('profiles', v.profileBody(req.body));
  res.status(201).json(profileOut(row));
}));

router.get('/profiles/:id', h(async (req, res) => {
  const row = await getById('profiles', req.params.id);
  return row ? res.json(profileOut(row)) : notFound(res, 'profile');
}));

router.patch('/profiles/:id', h(async (req, res) => {
  const row = await updateById('profiles', req.params.id, v.profileBody(req.body, true));
  return row ? res.json(profileOut(row)) : notFound(res, 'profile');
}));

router.delete('/profiles/:id', h(async (req, res) => {
  const ok = await deleteById('profiles', req.params.id); // cascades to children
  return ok ? res.status(204).end() : notFound(res, 'profile');
}));

// ===========================================================================
// Generic child-resource wiring (tasks / reminders / expenses)
// ===========================================================================
function childRoutes({ base, table, validate, listOrder }) {
  // list for a profile
  router.get(`/profiles/:pid/${base}`, h(async (req, res) => {
    if (!(await profileExists(req.params.pid))) return notFound(res, 'profile');
    const { rows } = await query(
      `SELECT * FROM ${table} WHERE profile_id = $1 ORDER BY ${listOrder}`,
      [req.params.pid]
    );
    res.json(rows);
  }));

  // create under a profile
  router.post(`/profiles/:pid/${base}`, h(async (req, res) => {
    if (!(await profileExists(req.params.pid))) return notFound(res, 'profile');
    const row = await insert(table, { profile_id: req.params.pid, ...validate(req.body) });
    res.status(201).json(row);
  }));

  // update by id
  router.patch(`/${base}/:id`, h(async (req, res) => {
    const row = await updateById(table, req.params.id, validate(req.body, true));
    return row ? res.json(row) : notFound(res, base);
  }));

  // delete by id
  router.delete(`/${base}/:id`, h(async (req, res) => {
    const ok = await deleteById(table, req.params.id);
    return ok ? res.status(204).end() : notFound(res, base);
  }));
}

childRoutes({ base: 'tasks', table: 'tasks', validate: v.taskBody, listOrder: 'position, created_at' });
childRoutes({ base: 'reminders', table: 'reminders', validate: v.reminderBody, listOrder: 'datetime' });
childRoutes({ base: 'expenses', table: 'expenses', validate: v.expenseBody, listOrder: 'date DESC, created_at DESC' });

// Reorder tasks within a profile: body { ids: [...] } in the desired order.
router.post('/profiles/:pid/tasks/reorder', h(async (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
    return res.status(400).json({ error: 'ids must be an array of task id strings' });
  }
  if (!(await profileExists(req.params.pid))) return notFound(res, 'profile');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query('UPDATE tasks SET position = $1 WHERE id = $2 AND profile_id = $3', [
        i,
        ids[i],
        req.params.pid,
      ]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const { rows } = await query(
    'SELECT * FROM tasks WHERE profile_id = $1 ORDER BY position, created_at',
    [req.params.pid]
  );
  res.json(rows);
}));

// ===========================================================================
// Vault (passwords encrypted at rest; never stored or logged in plaintext)
// ===========================================================================
const requireVault = (req, res, next) => {
  if (!vaultEnabled()) {
    return res.status(503).json({ error: 'Vault disabled: set VAULT_KEY (run `npm run keygen`).' });
  }
  next();
};

const vaultOut = (row) => ({
  id: row.id,
  profile_id: row.profile_id,
  label: row.label,
  username: row.username,
  password: decrypt(row.password_enc),
  notes: row.notes,
  created_at: row.created_at,
});

router.get('/profiles/:pid/vault', requireVault, h(async (req, res) => {
  if (!(await profileExists(req.params.pid))) return notFound(res, 'profile');
  const { rows } = await query(
    'SELECT * FROM vault_items WHERE profile_id = $1 ORDER BY created_at',
    [req.params.pid]
  );
  res.json(rows.map(vaultOut));
}));

router.post('/profiles/:pid/vault', requireVault, h(async (req, res) => {
  if (!(await profileExists(req.params.pid))) return notFound(res, 'profile');
  const { columns, password } = v.vaultBody(req.body);
  const row = await insert('vault_items', {
    profile_id: req.params.pid,
    label: columns.label,
    username: columns.username || '',
    notes: columns.notes || '',
    password_enc: encrypt(password || ''),
  });
  res.status(201).json(vaultOut(row));
}));

router.patch('/vault/:id', requireVault, h(async (req, res) => {
  const { columns, password } = v.vaultBody(req.body, true);
  const patch = { ...columns };
  if (password !== undefined) patch.password_enc = encrypt(password);
  const row = await updateById('vault_items', req.params.id, patch);
  return row ? res.json(vaultOut(row)) : notFound(res, 'vault item');
}));

router.delete('/vault/:id', requireVault, h(async (req, res) => {
  const ok = await deleteById('vault_items', req.params.id);
  return ok ? res.status(204).end() : notFound(res, 'vault item');
}));

// ===========================================================================
// Web Push (reminders)
// ===========================================================================
router.get('/push/public-key', (_req, res) => {
  res.json({ enabled: pushEnabled(), key: process.env.VAPID_PUBLIC_KEY || null });
});

router.post('/push/subscribe', h(async (req, res) => {
  if (!pushEnabled()) return res.status(503).json({ error: 'push not configured (set VAPID keys)' });
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'invalid push subscription' });
  }
  await saveSubscription(sub);
  res.status(201).json({ ok: true });
}));

router.post('/push/unsubscribe', h(async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  await deleteSubscription(endpoint);
  res.status(204).end();
}));

// ===========================================================================
// Face unlock (descriptors stored encrypted; matching happens server-side)
// ===========================================================================
router.post('/profiles/:id/face', h(async (req, res) => {
  if (!vaultEnabled()) return res.status(503).json({ error: 'face storage needs VAULT_KEY' });
  if (!(await profileExists(req.params.id))) return notFound(res, 'profile');
  const enc = encodeDescriptor(req.body && req.body.descriptor); // throws 400 if invalid
  const row = await updateById('profiles', req.params.id, { face_descriptor: enc });
  res.json(profileOut(row));
}));

router.delete('/profiles/:id/face', h(async (req, res) => {
  const row = await updateById('profiles', req.params.id, { face_descriptor: null });
  return row ? res.json(profileOut(row)) : notFound(res, 'profile');
}));

// Compare a live descriptor against all enrolled profiles; return the best match.
router.post('/face/match', h(async (req, res) => {
  if (!vaultEnabled()) return res.status(503).json({ error: 'face matching needs VAULT_KEY' });
  const desc = req.body && req.body.descriptor;
  if (!Array.isArray(desc) || desc.length !== 128) {
    return res.status(400).json({ error: 'descriptor must be an array of 128 numbers' });
  }
  const { rows } = await query('SELECT id, name, face_descriptor FROM profiles WHERE face_descriptor IS NOT NULL');
  let best = null, bestDist = Infinity;
  for (const r of rows) {
    const stored = decodeDescriptor(r.face_descriptor);
    if (!stored) continue;
    const d = distance(desc, stored);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  if (best && bestDist <= THRESHOLD) {
    return res.json({ matched: true, profileId: best.id, name: best.name, distance: Number(bestDist.toFixed(4)) });
  }
  res.json({ matched: false, profileId: null, distance: best ? Number(bestDist.toFixed(4)) : null });
}));

// ===========================================================================
// Email OTP (login codes)
// ===========================================================================
router.post('/profiles/:id/otp/request', otpRequestLimiter, h(async (req, res) => {
  const { rows } = await query('SELECT id, name, email FROM profiles WHERE id = $1', [req.params.id]);
  const p = rows[0];
  if (!p) return notFound(res, 'profile');
  if (!p.email) return res.status(400).json({ error: 'this profile has no email on file' });
  const code = generateCode();
  await query(
    "UPDATE profiles SET otp_hash = $1, otp_expires_at = now() + ($2 || ' milliseconds')::interval, otp_attempts = 0 WHERE id = $3",
    [hashCode(code), String(TTL_MS), p.id]
  );
  emailCode(p.email, p.name, code).catch((e) => console.error('[otp] email failed:', e.message));
  res.json({ sent: true, email: maskEmail(p.email), expiresInSec: Math.round(TTL_MS / 1000) });
}));

router.post('/profiles/:id/otp/verify', h(async (req, res) => {
  const code = ((req.body && req.body.code) || '').toString().trim();
  if (!/^\d{4,8}$/.test(code)) return res.status(400).json({ error: 'invalid code format' });
  const { rows } = await query('SELECT id, otp_hash, otp_expires_at, otp_attempts FROM profiles WHERE id = $1', [req.params.id]);
  const p = rows[0];
  if (!p) return notFound(res, 'profile');
  if (!p.otp_hash || !p.otp_expires_at) return res.status(400).json({ error: 'no active code — request one first' });
  if (new Date(p.otp_expires_at).getTime() < Date.now()) {
    await query('UPDATE profiles SET otp_hash = NULL WHERE id = $1', [p.id]);
    return res.status(400).json({ error: 'code expired — request a new one' });
  }
  if (p.otp_attempts >= MAX_ATTEMPTS) {
    await query('UPDATE profiles SET otp_hash = NULL WHERE id = $1', [p.id]);
    return res.status(429).json({ error: 'too many attempts — request a new code' });
  }
  if (safeEqual(hashCode(code), p.otp_hash)) {
    await query('UPDATE profiles SET otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0 WHERE id = $1', [p.id]);
    return res.json({ verified: true });
  }
  await query('UPDATE profiles SET otp_attempts = otp_attempts + 1 WHERE id = $1', [p.id]);
  res.status(401).json({ verified: false, error: 'incorrect code' });
}));

module.exports = router;
