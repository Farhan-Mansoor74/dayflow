// End-to-end API smoke test. Requires the server running and the DB migrated.
//   Terminal 1:  npm start
//   Terminal 2:  npm run smoke
//
// Sign-in itself can't be exercised over HTTP (it needs a real Google ID token),
// so the test creates two throwaway users straight in the database and mints
// their session tokens with the same code path POST /auth/google uses. That also
// gives us a second identity to prove cross-account access is refused.
require('dotenv').config();

const { pool, query } = require('../src/db');
const { issueToken } = require('../src/auth');
const { seedCategories } = require('../src/defaults');

const BASE = `http://localhost:${Number(process.env.PORT) || 3088}/api`;
let pass = 0;
let fail = 0;
let token = null; // session token for user A

function ok(cond, label) {
  if (cond) { pass++; console.log('  ok  ', label); }
  else { fail++; console.log('  FAIL', label); }
}

async function req(method, path, body, asToken = token) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (asToken) headers.Authorization = `Bearer ${asToken}`;
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
  return { id: rows[0].id, token: issueToken(rows[0].id).token };
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
      title: 'Lunch', amount: 12.5, type: 'expense', category: 'other', date: new Date().toISOString().slice(0, 10),
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
      ok(decrypt(encrypt('s3cr3t!')) === 's3cr3t!', 'vault encrypt/decrypt round-trips');
    } else {
      console.log('  skip  vault tests (VAULT_KEY not set)');
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

    // sub-categories
    const sub = await req('POST', '/categories', { label: 'Sub One', color: '#654321', parentKey: newCat.data.key });
    ok(sub.status === 201 && sub.data.parent_key === newCat.data.key, 'create sub-category');
    ok((await req('POST', '/categories', { label: 'Deep', color: '#654321', parentKey: sub.data.key })).status === 400,
      'a sub-category cannot have sub-categories (400)');
    ok((await req('POST', '/categories', { label: 'Orphan', color: '#654321', parentKey: 'no-such-parent' })).status === 400,
      'unknown parent rejected (400)');

    ok((await req('POST', '/expenses', {
      title: 'Bad cat', amount: 1, type: 'expense', category: 'no-such-category',
      date: new Date().toISOString().slice(0, 10),
    })).status === 400, 'expense with unknown category rejected (400)');

    // Deleting a parent must reassign both its own and its children's expenses.
    await req('PATCH', `/expenses/${exp.data.id}`, { category: sub.data.key });
    const exp2 = await req('POST', '/expenses', {
      title: 'On the parent', amount: 3, type: 'expense', category: newCat.data.key,
      date: new Date().toISOString().slice(0, 10),
    });
    const delCat = await req('DELETE', `/categories/${newCat.data.key}`);
    ok(delCat.status === 200 && delCat.data.reassigned === 2 && delCat.data.removedSubcategories === 1,
      'deleting a parent reassigns its own and its children\'s expenses');
    const after = await req('GET', '/expenses');
    ok(after.data.every((e) => e.category === 'other'), "reassigned expenses land in 'other'");
    ok(!(await req('GET', '/categories')).data.some((c) => c.key === sub.data.key),
      'the sub-category rows were removed too');
    ok((await req('DELETE', '/categories/other')).status === 409, 'builtin category cannot be deleted (409)');
    ok(exp2.status === 201, 'created the parent-tagged expense');

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
