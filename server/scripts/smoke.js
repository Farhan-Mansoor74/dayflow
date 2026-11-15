// End-to-end API smoke test. Requires the server running and the DB migrated.
//   Terminal 1:  npm start
//   Terminal 2:  npm run smoke
//
// Sign-in itself can't be exercised over HTTP (it needs a real Google ID token),
// so the test creates two throwaway users straight in the database and inserts
// session rows for them the way POST /auth/google does, sending the token as
// the session cookie. That also gives us a second identity to prove
// cross-account access is refused.
require('dotenv').config();

const { pool, query } = require('../src/db');
const crypto = require('crypto');
const { hashCode } = require('../src/otp');
const { seedCategories } = require('../src/defaults');

const BASE = `http://localhost:${Number(process.env.PORT) || 3088}/api`;
let pass = 0;
let fail = 0;
let token = null; // session token for user A

function ok(cond, label) {
  if (cond) { pass++; console.log('  ok  ', label); }
  else { fail++; console.log('  FAIL', label); }
}

async function req(method, path, body, asToken = token, extra = {}) {
  const headers = { 'X-Dayflow': '1', ...extra };
  if (body) headers['Content-Type'] = 'application/json';
  if (asToken) headers.Cookie = `dayflow_sid=${asToken}`;
  const res = await fetch(BASE + path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  if (res.status !== 204) {
    try { data = await res.json(); } catch { /* ignore */ }
  }
  return { status: res.status, data };
}

async function makeUser(label) {
  const email = `smoke-${label}-${process.pid}@smoke.invalid`;
  const { rows } = await query(
    'INSERT INTO users (email, name, color) VALUES ($1,$2,$3) RETURNING id',
    [email, `Smoke ${label}`, '#6B8CAE']
  );
  const client = await pool.connect();
  try { await seedCategories(client, rows[0].id); } finally { client.release(); }
  return { id: rows[0].id, token: await newSession(rows[0].id) };
}

async function newSession(userId) {
  const t = crypto.randomBytes(32).toString('base64url');
  await query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [userId, crypto.createHash('sha256').update(t).digest('hex')]);
  return t;
}

(async () => {
  console.log('smoke test ->', BASE);
  let userA = null;
  let userB = null;

  try {
    const health = await req('GET', '/health');
    ok(health.status === 200 && health.data.status === 'ok', 'health responds');
    ok(health.data && health.data.db === 'up', 'database is reachable');
    if (health.data && health.data.db !== 'up') {
      console.log('\nDatabase is not reachable — check DATABASE_URL / run `npm run migrate`. Aborting.');
      process.exit(1);
    }

    ok((await req('GET', '/config', null, null)).status === 200, 'config is public');

    // ---- authentication -----------------------------------------------------
    ok((await req('GET', '/tasks', null, null)).status === 401, 'no token -> 401');
    ok((await req('GET', '/tasks', null, 'garbage.token')).status === 401, 'forged token -> 401');

    userA = await makeUser('a');
    userB = await makeUser('b');
    token = userA.token;

    ok((await req('GET', '/me')).data.id === userA.id, 'GET /me returns the signed-in account');
    ok((await req('GET', '/me')).data.google_sub === undefined
      && (await req('GET', '/me')).data.face_descriptor === undefined,
      'GET /me leaks neither google_sub nor face descriptor');

    // ---- tasks --------------------------------------------------------------
    ok((await req('POST', '/tasks', { title: '', type: 'nope' })).status === 400, 'invalid task rejected (400)');

    const t1 = await req('POST', '/tasks', { title: 'First', type: 'daily', time: '07:00' });
    const t2 = await req('POST', '/tasks', { title: 'Second', type: 'weekly', days: [1, 3] });
    ok(t1.status === 201 && t2.status === 201, 'create two tasks');

    const upd = await req('PATCH', `/tasks/${t1.data.id}`, { completed: true });
    ok(upd.status === 200 && upd.data.completed === true, 'patch task completed');

    const ro = await req('POST', '/tasks/reorder', { ids: [t2.data.id, t1.data.id] });
    ok(ro.status === 200 && ro.data[0].id === t2.data.id, 'reorder tasks');

    ok((await req('GET', '/tasks')).data.length === 2, 'list tasks');

    // ---- cross-account isolation (IDOR) -------------------------------------
    ok((await req('GET', '/tasks', null, userB.token)).data.length === 0, "B cannot see A's tasks");
    ok((await req('PATCH', `/tasks/${t1.data.id}`, { title: 'Hijacked' }, userB.token)).status === 404,
      "B cannot patch A's task (404)");
    ok((await req('DELETE', `/tasks/${t1.data.id}`, null, userB.token)).status === 404,
      "B cannot delete A's task (404)");
    ok((await req('GET', `/tasks`)).data.find((t) => t.id === t1.data.id).title === 'First',
      "A's task survived B's attempts");

    // ---- reminders + expenses -----------------------------------------------
    const rem = await req('POST', '/reminders', {
      title: 'Test reminder', datetime: new Date(Date.now() + 3600e3).toISOString(), method: 'notification',
    });
    ok(rem.status === 201, 'create reminder');
    ok(rem.data.qstash_id === undefined, 'reminder response hides qstash_id');

    const exp = await req('POST', '/expenses', {
      title: 'Lunch', amount: 12.5, type: 'expense', category: 'other-misc', date: new Date().toISOString().slice(0, 10),
    });
    ok(exp.status === 201 && exp.data.amount === '12.50', 'create expense');

    // ---- vault --------------------------------------------------------------
    if (health.data.vault === 'enabled') {
      ok((await req('GET', '/vault')).status === 403, 'vault read refused without step-up (403)');
      ok((await req('POST', '/vault', { label: 'x', password: 'y' })).status === 403,
        'vault write refused without step-up (403)');
      // Enrolling a face would mint a new way into the vault, so it needs the
      // same step-up the vault itself does.
      const descriptor = Array.from({ length: 128 }, () => 0.1);
      ok((await req('POST', '/me/face', { descriptor })).status === 403,
        'face enrollment refused without step-up (403)');
      ok((await req('DELETE', '/me/face')).status === 403,
        'face removal refused without step-up (403)');
      ok((await req('POST', '/me/face/match', { descriptor })).status === 400,
        'face match with nothing enrolled -> 400, not a token');
      const { encrypt, decrypt } = require('../src/crypto');
      ok(decrypt(encrypt('s3cr3t!', 'u1'), 'u1') === 's3cr3t!', 'vault encrypt/decrypt round-trips');
    } else {
      console.log('  skip  vault tests (VAULT_KEY not set)');
    }

    // ---- security hardening -------------------------------------------------
    ok((await req('POST', '/tasks', { title: 'x', type: 'daily' }, token, { 'X-Dayflow': '' })).status === 403,
      'write without the X-Dayflow header refused (403)');
    ok((await req('GET', '/cron/run?key=' + encodeURIComponent(process.env.CRON_SECRET || 'x'), null, null)).status === 401,
      'cron secret in the query string is not accepted');
    ok((await req('POST', '/push/subscribe', { subscription: { endpoint: 'http://169.254.169.254/x', keys: { p256dh: 'abc', auth: 'abc' } } })).status
      === (health.data.push === 'enabled' ? 400 : 503), 'push endpoint outside the push services rejected');
    const remE = await req('POST', '/reminders', {
      title: 'Mail me', datetime: new Date(Date.now() + 7200e3).toISOString(), method: 'email', email: 'someone@else.test',
    });
    ok(remE.status === 201 && remE.data.email === '', 'email reminders ignore a supplied address');
    await req('DELETE', `/reminders/${remE.data.id}`);

    if (health.data.vault === 'enabled') {
      // Emailed code: parallel wrong guesses can't exceed the per-code attempt cap.
      const setCode = (c) => query("UPDATE users SET otp_hash = $1, otp_expires_at = now() + interval '5 minutes', otp_attempts = 0 WHERE id = $2", [hashCode(c), userA.id]);
      await setCode('123456');
      const guesses = await Promise.all(Array.from({ length: 10 }, (_, i) => req('POST', '/me/otp/verify', { code: String(100000 + i) })));
      ok(guesses.filter((g) => g.status === 401).length <= 5, 'parallel OTP guesses capped at 5 checks');
      ok((await req('POST', '/me/otp/verify', { code: '123456' })).status !== 200, 'right code refused once attempts are spent');
      await setCode('654321');
      const good = await req('POST', '/me/otp/verify', { code: '654321' });
      ok(good.status === 200 && !!good.data.stepUpToken, 'right code unlocks');
      ok((await req('POST', '/me/otp/verify', { code: '654321' })).status === 400, 'a code works only once');
      const su = { 'X-StepUp-Token': good.data.stepUpToken };

      // Vault: every field stored encrypted with the owner's key.
      const item = await req('POST', '/vault', { label: 'Bank', username: 'me@bank', password: 'pw-123', notes: 'pin 4821' }, token, su);
      ok(item.status === 201 && item.data.label === 'Bank' && item.data.notes === 'pin 4821', 'vault item round-trips');
      const raw = (await query('SELECT label, username, notes, password_enc FROM vault_items WHERE id = $1', [item.data.id])).rows[0];
      ok(['label', 'username', 'notes', 'password_enc'].every((c) => raw[c].startsWith('v2:')), 'vault label/username/notes/password stored as v2 ciphertext');
      ok((await req('GET', '/vault', null, userB.token, su)).status === 403, "A's unlock token doesn't work for B");

      // Face: no distance oracle, and few attempts.
      const descriptor = Array.from({ length: 128 }, () => 0.1);
      ok((await req('POST', '/me/face', { descriptor }, token, su)).status === 200, 'enroll face with step-up');
      const miss = await req('POST', '/me/face/match', { descriptor: descriptor.map((n) => n + 0.2) });
      ok(miss.status === 200 && miss.data.matched === false && miss.data.distance === undefined, 'face match reveals no distance');
      for (let i = 0; i < 4; i++) await req('POST', '/me/face/match', { descriptor: descriptor.map((n) => n + 0.2) });
      ok((await req('POST', '/me/face/match', { descriptor })).status === 429, 'sixth face attempt within 15 min -> 429');

      // Account deletion needs the step-up too.
      ok((await req('DELETE', '/me', null, userB.token)).status === 403, 'delete account refused without step-up (403)');

      // Sign-out ends the session (and its unlock token) server-side.
      const second = await newSession(userA.id);
      ok((await req('POST', '/auth/logout', null, second)).status === 204, 'logout');
      ok((await req('GET', '/me', null, second)).status === 401, 'logged-out session is dead');
      const third = await newSession(userA.id);
      ok((await req('GET', '/vault', null, third, su)).status === 403, 'unlock token is bound to its session');
      ok((await req('POST', '/auth/logout-all', null, third)).status === 204, 'logout everywhere');
      ok((await req('GET', '/me', null, token)).status === 401, 'logout everywhere kills the other sessions too');
      token = await newSession(userA.id);
      userA.token = token;
    }

    // ---- bootstrap ----------------------------------------------------------
    const boot = await req('GET', '/bootstrap');
    ok(boot.status === 200 && boot.data.user.id === userA.id, 'bootstrap returns the signed-in user');
    ok(boot.data.tasks.length === 2 && boot.data.reminders.length === 1 && boot.data.expenses.length === 1
      && Array.isArray(boot.data.categories), 'bootstrap inlines tasks/reminders/expenses/categories');
    ok(boot.data.vault === undefined, 'bootstrap does not include the vault');
    ok((await req('GET', '/bootstrap', null, userB.token)).data.tasks.length === 0,
      "bootstrap is scoped to the caller");

    // ---- categories ---------------------------------------------------------
    const cats = await req('GET', '/categories');
    ok(cats.status === 200 && cats.data.some((c) => c.key === 'other' && c.builtin),
      'categories list includes builtin other');

    const newCat = await req('POST', '/categories', { label: 'Smoke Cat', color: '#123456' });
    ok(newCat.status === 201 && newCat.data.key === 'smoke-cat', 'create category slugifies its key');
    ok((await req('POST', '/categories', { label: 'Bad', color: 'red;x:1' })).status === 400,
      'non-hex category colour rejected (400)');
    ok((await req('PATCH', `/categories/${newCat.data.key}`, { label: 'Renamed' })).data.key === newCat.data.key,
      'renaming a category keeps its key');
    ok((await req('PATCH', `/categories/${newCat.data.key}`, { label: 'Nope' }, userB.token)).status === 404,
      "B cannot rename A's category (404)");

    // sub-categories (strict: an expense on a category with sub-categories is refused)
    const exp2 = await req('POST', '/expenses', {
      title: 'On the parent', amount: 3, type: 'expense', category: newCat.data.key, date: new Date().toISOString().slice(0, 10),
    });
    ok(exp2.status === 201, 'a category without sub-categories takes expenses directly');
    const sub = await req('POST', '/categories', { label: 'Sub One', color: '#654321', parentKey: newCat.data.key });
    ok(sub.status === 201 && sub.data.parent_key === newCat.data.key, 'create sub-category');
    const expOf = async (id) => (await req('GET', '/expenses')).data.find((e) => e.id === id);
    ok((await expOf(exp2.data.id)).category === sub.data.key,
      "a parent's first sub-category adopts the expenses filed on the parent");
    ok((await req('POST', '/expenses', {
      title: 'Parent again', amount: 1, type: 'expense', category: newCat.data.key, date: new Date().toISOString().slice(0, 10),
    })).status === 400, 'expense on a category with sub-categories rejected (400)');
    ok((await req('POST', '/expenses', { title: 'No cat', amount: 1, type: 'expense', date: new Date().toISOString().slice(0, 10) })).data.category === 'other-misc',
      "an expense sent without a category lands in Other's sub-category");
    ok((await req('POST', '/categories', { label: 'Deep', color: '#654321', parentKey: sub.data.key })).status === 400,
      'a sub-category cannot have sub-categories (400)');
    ok((await req('POST', '/categories', { label: 'Orphan', color: '#654321', parentKey: 'no-such-parent' })).status === 400,
      'unknown parent rejected (400)');

    ok((await req('POST', '/expenses', {
      title: 'Bad cat', amount: 1, type: 'expense', category: 'no-such-category', date: new Date().toISOString().slice(0, 10),
    })).status === 400, 'expense with unknown category rejected (400)');

    // moving a sub-category to another parent
    const two = await req('POST', '/categories', { label: 'Smoke Two', color: '#123456' });
    const exp3 = await req('POST', '/expenses', { title: 'On two', amount: 2, type: 'expense', category: two.data.key, date: new Date().toISOString().slice(0, 10) });
    const sub2 = await req('POST', '/categories', { label: 'Sub Two', color: '#654321', parentKey: newCat.data.key });
    ok((await req('PATCH', `/categories/${sub2.data.key}`, { parentKey: two.data.key }, userB.token)).status === 404,
      "B cannot move A's sub-category (404)");
    const moved = await req('PATCH', `/categories/${sub2.data.key}`, { parentKey: two.data.key });
    ok(moved.status === 200 && moved.data.parent_key === two.data.key, 'move a sub-category to another parent');
    ok((await expOf(exp3.data.id)).category === sub2.data.key,
      "moving in a first sub-category adopts the new parent's expenses");
    ok((await req('PATCH', `/categories/${two.data.key}`, { parentKey: newCat.data.key })).status === 400,
      'a top-level category cannot be moved under another (400)');
    ok((await req('PATCH', `/categories/${sub.data.key}`, { parentKey: sub2.data.key })).status === 400,
      'cannot move a sub-category under a sub-category (400)');

    // deleting picks where the expenses go
    await req('PATCH', `/expenses/${exp.data.id}`, { category: sub.data.key });
    const del = (k, to) => req('DELETE', `/categories/${k}${to ? '?moveTo=' + to : ''}`);
    ok((await del(newCat.data.key, two.data.key)).status === 400, 'moveTo a category with sub-categories rejected (400)');
    ok((await del(newCat.data.key, sub.data.key)).status === 400, 'moveTo a category being deleted rejected (400)');
    ok((await del(newCat.data.key, 'no-such-category')).status === 400, 'moveTo an unknown category rejected (400)');
    const delCat = await del(newCat.data.key, sub2.data.key);
    ok(delCat.status === 200 && delCat.data.reassigned === 2 && delCat.data.removedSubcategories === 1
      && delCat.data.movedTo === sub2.data.key,
      "deleting a parent moves its own and its children's expenses to moveTo");
    ok((await expOf(exp.data.id)).category === sub2.data.key && (await expOf(exp2.data.id)).category === sub2.data.key,
      'reassigned expenses land in the chosen category');
    ok(!(await req('GET', '/categories')).data.some((c) => c.key === sub.data.key),
      'the sub-category rows were removed too');
    const delTwo = await del(two.data.key);
    ok(delTwo.status === 200 && delTwo.data.movedTo === 'other-misc' && (await expOf(exp3.data.id)).category === 'other-misc',
      "without moveTo, expenses go to Other's sub-category");
    ok((await req('DELETE', '/categories/other')).status === 409, 'builtin category cannot be deleted (409)');

    // income is pinned to the reserved category regardless of what was sent
    const inc = await req('POST', '/expenses', {
      title: 'Payday', amount: 100, type: 'income', category: 'other', date: new Date().toISOString().slice(0, 10),
    });
    ok(inc.data.category === 'income', "income rows are pinned to the 'income' category");

    // ---- account settings ---------------------------------------------------
    ok((await req('PATCH', '/me', { cycleStartDay: 28 })).data.cycleStartDay === 28, 'set spending cycle start day');
    ok((await req('PATCH', '/me', { cycleStartDay: 0 })).status === 400, 'cycleStartDay 0 rejected (400)');
    ok((await req('PATCH', '/me', { cycleStartDay: 32 })).status === 400, 'cycleStartDay 32 rejected (400)');
    ok((await req('PATCH', '/me', { email: 'attacker@evil.test' })).status === 400,
      'email is not client-writable (400)');

    // notification settings
    const tz = await req('PATCH', '/me', { timezone: 'Asia/Dubai', digestHour: 7, wrapupHour: 21, notifyWrapup: false });
    ok(tz.data.timezone === 'Asia/Dubai' && tz.data.digestHour === 7 && tz.data.wrapupHour === 21
      && tz.data.notifyWrapup === false, 'notification settings round-trip');
    ok((await req('PATCH', '/me', { timezone: 'Middle/Earth' })).status === 400,
      'unresolvable timezone rejected (400)');
    ok((await req('PATCH', '/me', { digestHour: 24 })).status === 400, 'digestHour 24 rejected (400)');
    ok((await req('PATCH', '/me', { wrapupHour: -1 })).status === 400, 'wrapupHour -1 rejected (400)');

    ok((await req('GET', '/tasks/does-not-exist')).status === 404, 'unknown path -> 404');
  } finally {
    // cleanup — cascades to every child row
    for (const u of [userA, userB]) {
      if (u) await query('DELETE FROM users WHERE id = $1', [u.id]).catch(() => {});
    }
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('smoke crashed:', e.message);
  process.exit(1);
});
