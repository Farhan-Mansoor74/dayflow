const express = require('express');
const { pool, query } = require('./db');
const rateLimit = require('express-rate-limit');
const { encrypt, decrypt, vaultEnabled } = require('./crypto');
const { saveSubscription, deleteSubscription, pushEnabled } = require('./push');
const { THRESHOLD, encodeDescriptor, decodeDescriptor, distance } = require('./face');
const { TTL_MS, MAX_ATTEMPTS, generateCode, hashCode, safeEqual, maskEmail, emailCode } = require('./otp');
const { authEnabled, checkKey, issueToken, requireAuth, issueProfileToken, verifyProfileToken } = require('./auth');
const { tick, dispatchOne } = require('./scheduler');
const qstash = require('./qstash');

// Never expose face_descriptor / otp_* columns to clients.
const profileOut = (r) => ({
  id: r.id, name: r.name, color: r.color, email: r.email || '',
  position: r.position, created_at: r.created_at,
  faceEnrolled: !!r.face_descriptor, authDisabled: !!r.auth_disabled,
  emailAuthEnabled: !!r.email_auth_enabled,
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

// Cap code-verification attempts per profile (defence-in-depth on top of the
// per-code MAX_ATTEMPTS counter, which resets whenever a new code is requested).
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => 'otpv:' + (req.params.id || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again later.' },
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
    // 'disabled' here means reminders fall back to the cron poll, so their
    // precision is whatever the cron interval is.
    scheduler: qstash.enabled() ? 'qstash' : `cron only (${qstash.disabledReason()})`,
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
const cronAuthed = (req) => {
  const secret = process.env.CRON_SECRET || '';
  const provided = (req.get('x-cron-key') || (req.query && req.query.key) || '').toString();
  return !!secret && safeEqual(provided, secret);
};

['GET', 'POST'].forEach(method => {
  router[method.toLowerCase()]('/cron/run', h(async (req, res) => {
    if (!cronAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
    const result = await tick();
    res.json({ ok: true, ...(result || {}) });
  }));
});

// ===========================================================================
// QStash callback — fires ONE reminder at its exact scheduled time.
//
// QStash forwards the shared secret as x-cron-key (see Upstash-Forward-* in
// qstash.js), so this uses the same check as the cron endpoint. It must stay
// above requireAuth: QStash has no session token.
//
// A throw here returns 500 and QStash retries. The "nothing to do" cases come
// back as 200 with a status string so it stops retrying instead.
// ===========================================================================
router.post('/reminders/:id/fire', h(async (req, res) => {
  if (!cronAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
  const status = await dispatchOne(req.params.id);
  // The callback is spent either way, so drop the id rather than leave a stale
  // one that a later edit would try to cancel.
  await query('UPDATE reminders SET qstash_id = NULL WHERE id = $1', [req.params.id]);
  res.json({ ok: true, status });
}));

// ---- Everything past here is gated by a valid session token ----------------
router.use(requireAuth);

// Per-profile lock enforcement. A profile with auth_disabled = true is "open"
// and needs no extra check. A locked profile requires a valid, unexpired
// profile token (minted by a successful face match or emailed code) scoped to
// that exact profile — supplied in the X-Profile-Token header. This is what
// makes the lock real server-side instead of a client-only gate.
function guardProfile(getPid) {
  return h(async (req, res, next) => {
    const pid = await getPid(req);
    if (!pid) return next(); // unknown resource — let the handler return 404
    const { rows } = await query('SELECT auth_disabled FROM profiles WHERE id = $1', [pid]);
    if (!rows[0]) return next(); // not found — let the handler return 404
    if (rows[0].auth_disabled) return next(); // open profile — no per-profile check
    const token = (req.get('x-profile-token') || '').toString();
    if (verifyProfileToken(token, pid)) return next();
    return res.status(403).json({ error: 'profile locked — unlock required' });
  });
}
// Vault access ALWAYS requires its own unlock (face scan, or email code if
// that's enabled for the profile) — unlike guardProfile, it does NOT bypass on
// auth_disabled. auth_disabled only means "the profile itself opens without a
// prompt"; it must not also hand out the vault for free.
function requireVaultUnlock(getPid) {
  return h(async (req, res, next) => {
    const pid = await getPid(req);
    if (!pid) return next(); // unknown resource — let the handler return 404
    const token = (req.get('x-profile-token') || '').toString();
    if (verifyProfileToken(token, pid)) return next();
    return res.status(403).json({ error: 'vault locked — unlock required' });
  });
}
const pidFromParam = (name) => (req) => req.params[name];
const pidFromResource = (table) => async (req) => {
  const { rows } = await query(`SELECT profile_id FROM ${table} WHERE id = $1`, [req.params.id]);
  return rows[0] ? rows[0].profile_id : null;
};

// ===========================================================================
// Profiles
// ===========================================================================
router.get('/profiles', h(async (_req, res) => {
  const { rows } = await query('SELECT * FROM profiles ORDER BY position, created_at');
  res.json(rows.map(profileOut));
}));

// Everything the client needs to paint the first screen, in ONE round trip.
// Without this the boot path was 1 + 1 + (3 x profile count) requests across
// three blocking waves. Vault is deliberately excluded — it always needs its
// own per-profile unlock, so it stays deferred.
router.get('/bootstrap', h(async (_req, res) => {
  const [profiles, tasks, reminders, expenses, categories] = await Promise.all([
    query('SELECT * FROM profiles ORDER BY position, created_at'),
    query('SELECT * FROM tasks ORDER BY position, created_at'),
    query('SELECT * FROM reminders ORDER BY datetime'),
    query('SELECT * FROM expenses ORDER BY date DESC, created_at DESC'),
    query('SELECT * FROM categories ORDER BY position, created_at'),
  ]);
  // Bucket the children by profile_id in one pass each, preserving SQL order.
  const bucket = (rows, shape) => {
    const by = {};
    for (const r of rows) (by[r.profile_id] || (by[r.profile_id] = [])).push(shape(r));
    return by;
  };
  const byTask = bucket(tasks.rows, (r) => r);
  // qstash_id is internal bookkeeping; mirrors the reminders childRoutes `out`.
  const byRem = bucket(reminders.rows, ({ qstash_id, ...r }) => r); // eslint-disable-line no-unused-vars
  const byExp = bucket(expenses.rows, (r) => r);
  res.json({
    categories: categories.rows,
    profiles: profiles.rows.map((p) => ({
      ...profileOut(p),
      tasks: byTask[p.id] || [],
      reminders: byRem[p.id] || [],
      expenses: byExp[p.id] || [],
    })),
  });
}));

router.post('/profiles', h(async (req, res) => {
  const row = await insert('profiles', v.profileBody(req.body));
  res.status(201).json(profileOut(row));
}));

router.get('/profiles/:id', h(async (req, res) => {
  const row = await getById('profiles', req.params.id);
  return row ? res.json(profileOut(row)) : notFound(res, 'profile');
}));

router.patch('/profiles/:id', guardProfile(pidFromParam('id')), h(async (req, res) => {
  const row = await updateById('profiles', req.params.id, v.profileBody(req.body, true));
  return row ? res.json(profileOut(row)) : notFound(res, 'profile');
}));

router.delete('/profiles/:id', guardProfile(pidFromParam('id')), h(async (req, res) => {
  const ok = await deleteById('profiles', req.params.id); // cascades to children
  return ok ? res.status(204).end() : notFound(res, 'profile');
}));

// ===========================================================================
// Generic child-resource wiring (tasks / reminders / expenses)
// ===========================================================================
// `out` shapes rows on the way out; `afterWrite` / `beforeDelete` let one
// resource hook into its own writes (only reminders needs this, for QStash).
function childRoutes({ base, table, validate, listOrder, out = (r) => r, beforeWrite, afterWrite, beforeDelete }) {
  // list for a profile
  router.get(`/profiles/:pid/${base}`, h(async (req, res) => {
    if (!(await profileExists(req.params.pid))) return notFound(res, 'profile');
    const { rows } = await query(
      `SELECT * FROM ${table} WHERE profile_id = $1 ORDER BY ${listOrder}`,
      [req.params.pid]
    );
    res.json(rows.map(out));
  }));

  // create under a profile
  router.post(`/profiles/:pid/${base}`, h(async (req, res) => {
    if (!(await profileExists(req.params.pid))) return notFound(res, 'profile');
    let body = validate(req.body);
    if (beforeWrite) body = await beforeWrite(body, req);
    let row = await insert(table, { profile_id: req.params.pid, ...body });
    if (afterWrite) row = await afterWrite(row);
    res.status(201).json(out(row));
  }));

  // update by id
  router.patch(`/${base}/:id`, h(async (req, res) => {
    let body = validate(req.body, true);
    if (beforeWrite) body = await beforeWrite(body, req);
    let row = await updateById(table, req.params.id, body);
    if (!row) return notFound(res, base);
    if (afterWrite) row = await afterWrite(row);
    res.json(out(row));
  }));

  // delete by id
  router.delete(`/${base}/:id`, h(async (req, res) => {
    if (beforeDelete) await beforeDelete(req.params.id);
    const ok = await deleteById(table, req.params.id);
    return ok ? res.status(204).end() : notFound(res, base);
  }));
}

childRoutes({ base: 'tasks', table: 'tasks', validate: v.taskBody, listOrder: 'position, created_at' });

childRoutes({
  base: 'reminders',
  table: 'reminders',
  validate: v.reminderBody,
  listOrder: 'datetime',
  // qstash_id is internal bookkeeping; the client has no use for it.
  out: ({ qstash_id, ...r }) => r, // eslint-disable-line no-unused-vars
  // Any write can change when (or whether) the reminder should fire, so cancel
  // the pending callback and schedule a fresh one. Scheduling failures return
  // null and are non-fatal — the cron tick remains the backstop.
  //
  // Both hooks no-op unless QStash is configured, so this code runs unchanged
  // against a database that has not had the qstash_id column added yet.
  async afterWrite(row) {
    if (!qstash.enabled()) return row;
    const messageId = await qstash.reschedule(row);
    if (messageId === (row.qstash_id ?? null)) return row;
    const { rows } = await query(
      'UPDATE reminders SET qstash_id = $1 WHERE id = $2 RETURNING *',
      [messageId, row.id]
    );
    return rows[0] || row;
  },
  async beforeDelete(id) {
    if (!qstash.enabled()) return;
    const { rows } = await query('SELECT qstash_id FROM reminders WHERE id = $1', [id]);
    if (rows[0]) await qstash.cancel(rows[0].qstash_id);
  },
});

childRoutes({
  base: 'expenses',
  table: 'expenses',
  validate: v.expenseBody,
  listOrder: 'date DESC, created_at DESC',
  beforeWrite: normaliseExpenseCategory,
});

// ===========================================================================
// Categories (household-wide)
// ===========================================================================
const CATEGORY_LIMIT = 40; // keeps the picker usable and bounds the payload

const listCategories = async () => {
  const { rows } = await query('SELECT * FROM categories ORDER BY position, created_at');
  return rows;
};

// Derive a stable slug from the label. Collisions get a numeric suffix, so two
// categories called "Travel" become 'travel' and 'travel-2'.
async function uniqueKey(label) {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'category';
  const { rows } = await query('SELECT key FROM categories WHERE key = $1 OR key LIKE $2', [base, base + '-%']);
  const taken = new Set(rows.map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  throw new v.HttpError(409, 'too many categories with that name');
}

router.get('/categories', h(async (_req, res) => {
  res.json(await listCategories());
}));

router.post('/categories', h(async (req, res) => {
  const body = v.categoryBody(req.body);
  const { rows: [{ count }] } = await query('SELECT count(*)::int AS count FROM categories');
  if (count >= CATEGORY_LIMIT) {
    return res.status(409).json({ error: `at most ${CATEGORY_LIMIT} categories` });
  }
  // Sort new categories after the existing user ones but before builtin 'other'.
  const { rows: [{ next }] } = await query(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM categories WHERE builtin = false'
  );
  const row = await insert('categories', { key: await uniqueKey(body.label), ...body, position: next });
  res.status(201).json(row);
}));

// Rename / recolour only — `key` is immutable so existing expenses stay attached.
router.patch('/categories/:key', h(async (req, res) => {
  const body = v.categoryBody(req.body, true);
  const cols = Object.keys(body);
  const set = cols.map((c, i) => `${c} = $${i + 1}`);
  const { rows } = await query(
    `UPDATE categories SET ${set.join(', ')} WHERE key = $${cols.length + 1} RETURNING *`,
    [...cols.map((c) => body[c]), req.params.key]
  );
  return rows[0] ? res.json(rows[0]) : notFound(res, 'category');
}));

// Deleting reassigns its expenses to the builtin 'other' rather than orphaning
// them, so totals stay correct. Both statements run in one transaction.
router.delete('/categories/:key', h(async (req, res) => {
  const key = req.params.key;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT builtin FROM categories WHERE key = $1 FOR UPDATE', [key]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return notFound(res, 'category');
    }
    if (rows[0].builtin) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'this category is built in and cannot be deleted' });
    }
    const { rowCount: moved } = await client.query(
      "UPDATE expenses SET category = 'other' WHERE category = $1",
      [key]
    );
    await client.query('DELETE FROM categories WHERE key = $1', [key]);
    await client.query('COMMIT');
    res.json({ ok: true, reassigned: moved });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// An expense may only reference a category that exists. Income rows don't carry
// a real category (they're excluded from the category donut), so they're pinned
// to the reserved 'income' value instead of being validated against the table.
async function normaliseExpenseCategory(body, req) {
  const existing = req.params.id ? await getById('expenses', req.params.id) : null;
  const type = body.type !== undefined ? body.type : (existing || {}).type;
  if (type === 'income') {
    body.category = 'income';
    return body;
  }
  // The value that will actually end up stored, whether or not this write sets it.
  const cat = body.category !== undefined ? body.category : (existing ? existing.category : undefined);
  if (cat === undefined) return body; // create with no category — column defaults to 'other'
  const { rows } = await query('SELECT 1 FROM categories WHERE key = $1', [cat]);
  if (!rows[0]) {
    // Explicitly asking for a category that doesn't exist is a client error...
    if (body.category !== undefined) throw new v.HttpError(400, 'unknown category');
    // ...but an already-stored value going stale (income -> expense, or a
    // category deleted mid-edit) just falls back to 'other'.
    body.category = 'other';
  }
  return body;
}

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

router.get('/profiles/:pid/vault', requireVault, requireVaultUnlock(pidFromParam('pid')), h(async (req, res) => {
  if (!(await profileExists(req.params.pid))) return notFound(res, 'profile');
  const { rows } = await query(
    'SELECT * FROM vault_items WHERE profile_id = $1 ORDER BY created_at',
    [req.params.pid]
  );
  res.json(rows.map(vaultOut));
}));

router.post('/profiles/:pid/vault', requireVault, requireVaultUnlock(pidFromParam('pid')), h(async (req, res) => {
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

router.patch('/vault/:id', requireVault, requireVaultUnlock(pidFromResource('vault_items')), h(async (req, res) => {
  const { columns, password } = v.vaultBody(req.body, true);
  const patch = { ...columns };
  if (password !== undefined) patch.password_enc = encrypt(password);
  const row = await updateById('vault_items', req.params.id, patch);
  return row ? res.json(vaultOut(row)) : notFound(res, 'vault item');
}));

router.delete('/vault/:id', requireVault, requireVaultUnlock(pidFromResource('vault_items')), h(async (req, res) => {
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
router.post('/profiles/:id/face', guardProfile(pidFromParam('id')), h(async (req, res) => {
  if (!vaultEnabled()) return res.status(503).json({ error: 'face storage needs VAULT_KEY' });
  if (!(await profileExists(req.params.id))) return notFound(res, 'profile');
  const enc = encodeDescriptor(req.body && req.body.descriptor); // throws 400 if invalid
  const row = await updateById('profiles', req.params.id, { face_descriptor: enc });
  res.json(profileOut(row));
}));

router.delete('/profiles/:id/face', guardProfile(pidFromParam('id')), h(async (req, res) => {
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
    const { token: profileToken, expiresAt } = issueProfileToken(best.id);
    return res.json({ matched: true, profileId: best.id, name: best.name, distance: Number(bestDist.toFixed(4)), profileToken, expiresAt });
  }
  res.json({ matched: false, profileId: null, distance: best ? Number(bestDist.toFixed(4)) : null });
}));

// ===========================================================================
// Email OTP (login codes)
// ===========================================================================
router.post('/profiles/:id/otp/request', otpRequestLimiter, h(async (req, res) => {
  const { rows } = await query('SELECT id, name, email, email_auth_enabled FROM profiles WHERE id = $1', [req.params.id]);
  const p = rows[0];
  if (!p) return notFound(res, 'profile');
  if (!p.email_auth_enabled) return res.status(403).json({ error: 'email unlock is disabled for this profile — use face scan' });
  if (!p.email) return res.status(400).json({ error: 'this profile has no email on file' });
  const code = generateCode();
  await query(
    "UPDATE profiles SET otp_hash = $1, otp_expires_at = now() + ($2 || ' milliseconds')::interval, otp_attempts = 0 WHERE id = $3",
    [hashCode(code), String(TTL_MS), p.id]
  );
  // Awaited on purpose: on Vercel the function can freeze the instant res.json()
  // is sent, so a fire-and-forget send here has no guarantee of ever completing —
  // the client would see "sent: true" even when no email goes out. That silent
  // failure is what forced a resend every time.
  try {
    await emailCode(p.email, p.name, code);
  } catch (e) {
    console.error('[otp] email failed:', e.message);
    return res.status(502).json({ error: 'could not send the code — try again' });
  }
  res.json({ sent: true, email: maskEmail(p.email), expiresInSec: Math.round(TTL_MS / 1000) });
}));

router.post('/profiles/:id/otp/verify', otpVerifyLimiter, h(async (req, res) => {
  const code = ((req.body && req.body.code) || '').toString().trim();
  if (!/^\d{4,8}$/.test(code)) return res.status(400).json({ error: 'invalid code format' });
  const { rows } = await query('SELECT id, otp_hash, otp_expires_at, otp_attempts, email_auth_enabled FROM profiles WHERE id = $1', [req.params.id]);
  const p = rows[0];
  if (!p) return notFound(res, 'profile');
  if (!p.email_auth_enabled) return res.status(403).json({ error: 'email unlock is disabled for this profile — use face scan' });
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
    const { token: profileToken, expiresAt } = issueProfileToken(p.id);
    return res.json({ verified: true, profileToken, expiresAt });
  }
  await query('UPDATE profiles SET otp_attempts = otp_attempts + 1 WHERE id = $1', [p.id]);
  res.status(401).json({ verified: false, error: 'incorrect code' });
}));

module.exports = router;
