const express = require('express');
const { pool, query } = require('./db');
const rateLimit = require('express-rate-limit');
const { encrypt, decrypt, vaultEnabled } = require('./crypto');
const { saveSubscription, deleteSubscription, pushEnabled } = require('./push');
const { THRESHOLD, encodeDescriptor, decodeDescriptor, distance } = require('./face');
const { TTL_MS, MAX_ATTEMPTS, generateCode, hashCode, safeEqual, maskEmail, emailCode } = require('./otp');
const {
  googleClientId, googleEnabled, verifyGoogleCredential,
  issueToken, requireAuth, issueStepUpToken, verifyStepUpToken,
} = require('./auth');
const { seedCategories } = require('./defaults');
const { tick, dispatchOne } = require('./scheduler');
const { digestTick } = require('./digest');
const qstash = require('./qstash');

// Never expose face_descriptor / otp_* / google_sub columns to clients.
const userOut = (r) => ({
  id: r.id, name: r.name, email: r.email, picture: r.picture || '', color: r.color,
  cycleStartDay: r.cycle_start_day, faceEnrolled: !!r.face_descriptor, created_at: r.created_at,
  timezone: r.timezone || 'UTC', digestHour: r.digest_hour, wrapupHour: r.wrapup_hour,
  notifyDigest: !!r.notify_digest, notifyHeadsUp: !!r.notify_headsup, notifyWrapup: !!r.notify_wrapup,
});

// Brute-force protection on sign-in. Google does the real work of validating
// the credential; this just stops the endpoint being used as a grinder.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts — try again later.' },
});

// Per-user limit on requesting vault step-up codes (brute-force / spam protection).
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => 'otp:' + (req.userId || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many code requests — try again later.' },
});

// Cap code-verification attempts per user (defence-in-depth on top of the
// per-code MAX_ATTEMPTS counter, which resets whenever a new code is requested).
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => 'otpv:' + (req.userId || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again later.' },
});
const v = require('./validate');

const router = express.Router();

// Wrap async handlers so thrown errors reach the error middleware.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- tiny parameterized SQL helpers (no string interpolation of values) ----
// Every read and write is scoped to the signed-in user. `id` alone is never
// enough: an id belonging to someone else simply does not exist for this caller.
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

async function getOwned(table, id, userId) {
  const { rows } = await query(`SELECT * FROM ${table} WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rows[0] || null;
}

async function updateOwned(table, id, userId, obj) {
  const cols = Object.keys(obj);
  if (cols.length === 0) return getOwned(table, id, userId);
  const set = cols.map((c, i) => `${c} = $${i + 1}`);
  const { rows } = await query(
    `UPDATE ${table} SET ${set.join(', ')} WHERE id = $${cols.length + 1} AND user_id = $${cols.length + 2} RETURNING *`,
    [...cols.map((c) => obj[c]), id, userId]
  );
  return rows[0] || null;
}

async function deleteOwned(table, id, userId) {
  const { rowCount } = await query(`DELETE FROM ${table} WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rowCount > 0;
}

const notFound = (res, what = 'resource') => res.status(404).json({ error: `${what} not found` });

// ===========================================================================
// Public endpoints (no session token)
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
    auth: googleEnabled() ? 'google' : 'misconfigured (set GOOGLE_CLIENT_ID)',
    // 'disabled' here means reminders fall back to the cron poll, so their
    // precision is whatever the cron interval is.
    scheduler: qstash.enabled() ? 'qstash' : `cron only (${qstash.disabledReason()})`,
  });
}));

// The OAuth client id is public by design — it ends up in the sign-in button.
// Serving it here keeps it out of index.html so one deployment's build can
// point at a different Google project without editing the client.
router.get('/config', (_req, res) => {
  res.json({ googleClientId: googleClientId() });
});

// ===========================================================================
// Sign in with Google. Exchange a Google ID token for a Dayflow session token.
// ===========================================================================
router.post('/auth/google', authLimiter, h(async (req, res) => {
  if (!googleEnabled()) {
    return res.status(503).json({ error: 'sign-in is not configured (set GOOGLE_CLIENT_ID)' });
  }
  const claims = await verifyGoogleCredential(req.body && req.body.credential);

  const client = await pool.connect();
  let user;
  try {
    await client.query('BEGIN');
    // 1. Already signed in here before.
    let { rows } = await client.query('SELECT * FROM users WHERE google_sub = $1 FOR UPDATE', [claims.sub]);
    if (rows[0]) {
      // Keep the display fields in step with the Google profile.
      ({ rows } = await client.query(
        'UPDATE users SET email = $1, name = $2, picture = $3 WHERE id = $4 RETURNING *',
        [claims.email, claims.name, claims.picture, rows[0].id]
      ));
      user = rows[0];
    } else {
      // 2. Claim an account created by the profiles backfill, matched on the
      //    Google-verified email. Only ever claims an unclaimed row.
      ({ rows } = await client.query(
        'SELECT * FROM users WHERE lower(email) = lower($1) AND google_sub IS NULL FOR UPDATE',
        [claims.email]
      ));
      if (rows[0]) {
        ({ rows } = await client.query(
          'UPDATE users SET google_sub = $1, name = $2, picture = $3 WHERE id = $4 RETURNING *',
          [claims.sub, claims.name, claims.picture, rows[0].id]
        ));
        user = rows[0];
      } else {
        // 3. Brand new account.
        ({ rows } = await client.query(
          'INSERT INTO users (google_sub, email, name, picture) VALUES ($1,$2,$3,$4) RETURNING *',
          [claims.sub, claims.email, claims.name, claims.picture]
        ));
        user = rows[0];
        await seedCategories(client, user.id);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const { token, expiresAt } = issueToken(user.id);
  res.json({ token, expiresAt, user: userOut(user) });
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
    // Reminders fire at an exact time; digests are the once-a-day nudges. A
    // failing digest must not stop reminders going out, so they're independent.
    const result = await tick();
    const digest = await digestTick().catch((e) => ({ error: e.message }));
    res.json({ ok: true, ...(result || {}), digest });
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
// requireAuth sets req.userId; no handler below may read an id from the URL
// without also constraining the query to that user.
router.use(requireAuth);

// Vault access ALWAYS requires its own step-up (face scan or emailed code) on
// top of being signed in, and the step-up token lives only in the browser's
// memory — so closing the tab re-locks the vault.
const requireStepUp = h(async (req, res, next) => {
  const token = (req.get('x-stepup-token') || '').toString();
  if (verifyStepUpToken(token, req.userId)) return next();
  return res.status(403).json({ error: 'vault locked — unlock required' });
});

// ===========================================================================
// The signed-in user
// ===========================================================================
const loadUser = async (id) => {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
};

router.get('/me', h(async (req, res) => {
  const row = await loadUser(req.userId);
  return row ? res.json(userOut(row)) : notFound(res, 'account');
}));

router.patch('/me', h(async (req, res) => {
  const patch = v.userBody(req.body, true);
  const cols = Object.keys(patch);
  const set = cols.map((c, i) => `${c} = $${i + 1}`);
  const { rows } = await query(
    `UPDATE users SET ${set.join(', ')} WHERE id = $${cols.length + 1} RETURNING *`,
    [...cols.map((c) => patch[c]), req.userId]
  );
  return rows[0] ? res.json(userOut(rows[0])) : notFound(res, 'account');
}));

router.delete('/me', h(async (req, res) => {
  // Cascades to tasks, reminders, expenses, vault_items, categories, push subs.
  await query('DELETE FROM users WHERE id = $1', [req.userId]);
  res.status(204).end();
}));

// Everything the client needs to paint the first screen, in ONE round trip.
// Vault is deliberately excluded — it always needs its own step-up unlock, so
// it stays deferred until the user opens it.
router.get('/bootstrap', h(async (req, res) => {
  const uid = req.userId;
  const [user, tasks, reminders, expenses, categories] = await Promise.all([
    loadUser(uid),
    query('SELECT * FROM tasks WHERE user_id = $1 ORDER BY position, created_at', [uid]),
    query('SELECT * FROM reminders WHERE user_id = $1 ORDER BY datetime', [uid]),
    query('SELECT * FROM expenses WHERE user_id = $1 ORDER BY date DESC, created_at DESC', [uid]),
    query('SELECT * FROM categories WHERE user_id = $1 ORDER BY position, created_at', [uid]),
  ]);
  if (!user) return notFound(res, 'account');
  res.json({
    user: userOut(user),
    categories: categories.rows,
    tasks: tasks.rows,
    // qstash_id is internal bookkeeping; mirrors the reminders childRoutes `out`.
    reminders: reminders.rows.map(({ qstash_id, ...r }) => r), // eslint-disable-line no-unused-vars
    expenses: expenses.rows,
  });
}));

// ===========================================================================
// Generic child-resource wiring (tasks / reminders / expenses)
// ===========================================================================
// `out` shapes rows on the way out; `afterWrite` / `beforeDelete` let one
// resource hook into its own writes (only reminders needs this, for QStash).
function childRoutes({ base, table, validate, listOrder, out = (r) => r, beforeWrite, afterWrite, beforeDelete }) {
  router.get(`/${base}`, h(async (req, res) => {
    const { rows } = await query(
      `SELECT * FROM ${table} WHERE user_id = $1 ORDER BY ${listOrder}`,
      [req.userId]
    );
    res.json(rows.map(out));
  }));

  router.post(`/${base}`, h(async (req, res) => {
    let body = validate(req.body);
    if (beforeWrite) body = await beforeWrite(body, req);
    let row = await insert(table, { user_id: req.userId, ...body });
    if (afterWrite) row = await afterWrite(row);
    res.status(201).json(out(row));
  }));

  router.patch(`/${base}/:id`, h(async (req, res) => {
    let body = validate(req.body, true);
    if (beforeWrite) body = await beforeWrite(body, req);
    let row = await updateOwned(table, req.params.id, req.userId, body);
    if (!row) return notFound(res, base);
    if (afterWrite) row = await afterWrite(row);
    res.json(out(row));
  }));

  router.delete(`/${base}/:id`, h(async (req, res) => {
    if (beforeDelete) await beforeDelete(req.params.id, req.userId);
    const ok = await deleteOwned(table, req.params.id, req.userId);
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
  async beforeDelete(id, userId) {
    if (!qstash.enabled()) return;
    const { rows } = await query('SELECT qstash_id FROM reminders WHERE id = $1 AND user_id = $2', [id, userId]);
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

// Reorder tasks: body { ids: [...] } in the desired order.
router.post('/tasks/reorder', h(async (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
    return res.status(400).json({ error: 'ids must be an array of task id strings' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query('UPDATE tasks SET position = $1 WHERE id = $2 AND user_id = $3', [i, ids[i], req.userId]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const { rows } = await query(
    'SELECT * FROM tasks WHERE user_id = $1 ORDER BY position, created_at',
    [req.userId]
  );
  res.json(rows);
}));

// ===========================================================================
// Expense categories (per user, two levels deep)
// ===========================================================================
const CATEGORY_LIMIT = 80; // keeps the picker usable and bounds the payload

// Derive a stable slug from the label. Collisions within this user's set get a
// numeric suffix, so two categories called "Travel" become 'travel' and 'travel-2'.
async function uniqueKey(userId, label) {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'category';
  const { rows } = await query(
    'SELECT key FROM categories WHERE user_id = $1 AND (key = $2 OR key LIKE $3)',
    [userId, base, base + '-%']
  );
  const taken = new Set(rows.map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  throw new v.HttpError(409, 'too many categories with that name');
}

router.get('/categories', h(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM categories WHERE user_id = $1 ORDER BY position, created_at',
    [req.userId]
  );
  res.json(rows);
}));

router.post('/categories', h(async (req, res) => {
  const body = v.categoryBody(req.body);
  const parentKey = body.parent_key || null;
  delete body.parent_key;

  const { rows: [{ count }] } = await query(
    'SELECT count(*)::int AS count FROM categories WHERE user_id = $1', [req.userId]
  );
  if (count >= CATEGORY_LIMIT) {
    return res.status(409).json({ error: `at most ${CATEGORY_LIMIT} categories` });
  }

  let position;
  if (parentKey) {
    // Only two levels: a sub-category's parent must itself be top-level.
    const { rows } = await query(
      'SELECT parent_key FROM categories WHERE user_id = $1 AND key = $2', [req.userId, parentKey]
    );
    if (!rows[0]) return res.status(400).json({ error: 'unknown parent category' });
    if (rows[0].parent_key) return res.status(400).json({ error: 'a sub-category cannot have sub-categories' });
    const { rows: [{ next }] } = await query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM categories WHERE user_id = $1 AND parent_key = $2',
      [req.userId, parentKey]
    );
    position = next;
  } else {
    // Sort new top-level categories after the existing ones but before 'other'.
    const { rows: [{ next }] } = await query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM categories WHERE user_id = $1 AND parent_key IS NULL AND builtin = false',
      [req.userId]
    );
    position = next;
  }

  const row = await insert('categories', {
    user_id: req.userId,
    key: await uniqueKey(req.userId, body.label),
    ...body,
    parent_key: parentKey,
    position,
  });
  res.status(201).json(row);
}));

// Rename / recolour only — `key` and `parent_key` are immutable so existing
// expenses stay attached and the tree cannot be reshaped underneath them.
router.patch('/categories/:key', h(async (req, res) => {
  const body = v.categoryBody(req.body, true);
  delete body.parent_key;
  const cols = Object.keys(body);
  if (!cols.length) return res.status(400).json({ error: 'no updatable fields provided' });
  const set = cols.map((c, i) => `${c} = $${i + 1}`);
  const { rows } = await query(
    `UPDATE categories SET ${set.join(', ')} WHERE user_id = $${cols.length + 1} AND key = $${cols.length + 2} RETURNING *`,
    [...cols.map((c) => body[c]), req.userId, req.params.key]
  );
  return rows[0] ? res.json(rows[0]) : notFound(res, 'category');
}));

// Deleting reassigns its expenses — and its sub-categories' expenses — to the
// builtin 'other' rather than orphaning them, so totals stay correct. The
// sub-category rows themselves go via ON DELETE CASCADE. One transaction.
router.delete('/categories/:key', h(async (req, res) => {
  const key = req.params.key;
  const uid = req.userId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT builtin FROM categories WHERE user_id = $1 AND key = $2 FOR UPDATE', [uid, key]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return notFound(res, 'category');
    }
    if (rows[0].builtin) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'this category is built in and cannot be deleted' });
    }
    const { rows: kids } = await client.query(
      'SELECT key FROM categories WHERE user_id = $1 AND parent_key = $2', [uid, key]
    );
    const affected = [key, ...kids.map((k) => k.key)];
    const { rowCount: moved } = await client.query(
      "UPDATE expenses SET category = 'other' WHERE user_id = $1 AND category = ANY($2::text[])",
      [uid, affected]
    );
    await client.query('DELETE FROM categories WHERE user_id = $1 AND key = $2', [uid, key]);
    await client.query('COMMIT');
    res.json({ ok: true, reassigned: moved, removedSubcategories: kids.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// An expense may only reference a category this user owns. Income rows don't
// carry a real category (they're excluded from the charts), so they're pinned to
// the reserved 'income' value instead of being validated against the table.
async function normaliseExpenseCategory(body, req) {
  const existing = req.params.id ? await getOwned('expenses', req.params.id, req.userId) : null;
  const type = body.type !== undefined ? body.type : (existing || {}).type;
  if (type === 'income') {
    body.category = 'income';
    return body;
  }
  // The value that will actually end up stored, whether or not this write sets it.
  const cat = body.category !== undefined ? body.category : (existing ? existing.category : undefined);
  if (cat === undefined) return body; // create with no category — column defaults to 'other'
  const { rows } = await query('SELECT 1 FROM categories WHERE user_id = $1 AND key = $2', [req.userId, cat]);
  if (!rows[0]) {
    // Explicitly asking for a category that doesn't exist is a client error...
    if (body.category !== undefined) throw new v.HttpError(400, 'unknown category');
    // ...but an already-stored value going stale (income -> expense, or a
    // category deleted mid-edit) just falls back to 'other'.
    body.category = 'other';
  }
  return body;
}

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
  label: row.label,
  username: row.username,
  password: decrypt(row.password_enc),
  notes: row.notes,
  created_at: row.created_at,
});

router.get('/vault', requireVault, requireStepUp, h(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM vault_items WHERE user_id = $1 ORDER BY created_at', [req.userId]
  );
  res.json(rows.map(vaultOut));
}));

router.post('/vault', requireVault, requireStepUp, h(async (req, res) => {
  const { columns, password } = v.vaultBody(req.body);
  const row = await insert('vault_items', {
    user_id: req.userId,
    label: columns.label,
    username: columns.username || '',
    notes: columns.notes || '',
    password_enc: encrypt(password || ''),
  });
  res.status(201).json(vaultOut(row));
}));

router.patch('/vault/:id', requireVault, requireStepUp, h(async (req, res) => {
  const { columns, password } = v.vaultBody(req.body, true);
  const patch = { ...columns };
  if (password !== undefined) patch.password_enc = encrypt(password);
  const row = await updateOwned('vault_items', req.params.id, req.userId, patch);
  return row ? res.json(vaultOut(row)) : notFound(res, 'vault item');
}));

router.delete('/vault/:id', requireVault, requireStepUp, h(async (req, res) => {
  const ok = await deleteOwned('vault_items', req.params.id, req.userId);
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
  await saveSubscription(req.userId, sub);
  res.status(201).json({ ok: true });
}));

router.post('/push/unsubscribe', h(async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  await deleteSubscription(req.userId, endpoint);
  res.status(204).end();
}));

// ===========================================================================
// Vault step-up: face unlock (descriptors stored encrypted, matched server-side)
// ===========================================================================
// Enrolling a face grants a faster route into the vault, so changing it is
// itself a step-up action — otherwise being signed in would be enough to mint a
// new "key" and the vault lock would collapse into the session. With no face on
// file yet, the emailed code is the way in.
router.post('/me/face', requireStepUp, h(async (req, res) => {
  if (!vaultEnabled()) return res.status(503).json({ error: 'face storage needs VAULT_KEY' });
  const enc = encodeDescriptor(req.body && req.body.descriptor); // throws 400 if invalid
  const { rows } = await query('UPDATE users SET face_descriptor = $1 WHERE id = $2 RETURNING *', [enc, req.userId]);
  return rows[0] ? res.json(userOut(rows[0])) : notFound(res, 'account');
}));

router.delete('/me/face', requireStepUp, h(async (req, res) => {
  const { rows } = await query('UPDATE users SET face_descriptor = NULL WHERE id = $1 RETURNING *', [req.userId]);
  return rows[0] ? res.json(userOut(rows[0])) : notFound(res, 'account');
}));

// Compare a live descriptor against THIS user's enrolled face only — a match
// mints the step-up token the vault routes require.
router.post('/me/face/match', h(async (req, res) => {
  if (!vaultEnabled()) return res.status(503).json({ error: 'face matching needs VAULT_KEY' });
  const desc = req.body && req.body.descriptor;
  if (!Array.isArray(desc) || desc.length !== 128) {
    return res.status(400).json({ error: 'descriptor must be an array of 128 numbers' });
  }
  const { rows } = await query('SELECT face_descriptor FROM users WHERE id = $1', [req.userId]);
  const stored = rows[0] && decodeDescriptor(rows[0].face_descriptor);
  if (!stored) return res.status(400).json({ error: 'no face enrolled — use an emailed code' });
  const d = distance(desc, stored);
  if (d <= THRESHOLD) {
    const { token: stepUpToken, expiresAt } = issueStepUpToken(req.userId);
    return res.json({ matched: true, distance: Number(d.toFixed(4)), stepUpToken, expiresAt });
  }
  res.json({ matched: false, distance: Number(d.toFixed(4)) });
}));

// ===========================================================================
// Vault step-up: emailed code. Always available — the account's email address
// came from Google and is verified, so it is a reliable fallback when no face
// is enrolled (which is the case for every brand-new account).
// ===========================================================================
router.post('/me/otp/request', otpRequestLimiter, h(async (req, res) => {
  const u = await loadUser(req.userId);
  if (!u) return notFound(res, 'account');
  const code = generateCode();
  await query(
    "UPDATE users SET otp_hash = $1, otp_expires_at = now() + ($2 || ' milliseconds')::interval, otp_attempts = 0 WHERE id = $3",
    [hashCode(code), String(TTL_MS), u.id]
  );
  // Awaited on purpose: on Vercel the function can freeze the instant res.json()
  // is sent, so a fire-and-forget send here has no guarantee of ever completing —
  // the client would see "sent: true" even when no email goes out.
  try {
    await emailCode(u.email, u.name, code);
  } catch (e) {
    console.error('[otp] email failed:', e.message);
    return res.status(502).json({ error: 'could not send the code — try again' });
  }
  res.json({ sent: true, email: maskEmail(u.email), expiresInSec: Math.round(TTL_MS / 1000) });
}));

router.post('/me/otp/verify', otpVerifyLimiter, h(async (req, res) => {
  const code = ((req.body && req.body.code) || '').toString().trim();
  if (!/^\d{4,8}$/.test(code)) return res.status(400).json({ error: 'invalid code format' });
  const { rows } = await query(
    'SELECT id, otp_hash, otp_expires_at, otp_attempts FROM users WHERE id = $1', [req.userId]
  );
  const u = rows[0];
  if (!u) return notFound(res, 'account');
  if (!u.otp_hash || !u.otp_expires_at) return res.status(400).json({ error: 'no active code — request one first' });
  if (new Date(u.otp_expires_at).getTime() < Date.now()) {
    await query('UPDATE users SET otp_hash = NULL WHERE id = $1', [u.id]);
    return res.status(400).json({ error: 'code expired — request a new one' });
  }
  if (u.otp_attempts >= MAX_ATTEMPTS) {
    await query('UPDATE users SET otp_hash = NULL WHERE id = $1', [u.id]);
    return res.status(429).json({ error: 'too many attempts — request a new code' });
  }
  if (safeEqual(hashCode(code), u.otp_hash)) {
    await query('UPDATE users SET otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0 WHERE id = $1', [u.id]);
    const { token: stepUpToken, expiresAt } = issueStepUpToken(u.id);
    return res.json({ verified: true, stepUpToken, expiresAt });
  }
  await query('UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = $1', [u.id]);
  res.status(401).json({ verified: false, error: 'incorrect code' });
}));

module.exports = router;
