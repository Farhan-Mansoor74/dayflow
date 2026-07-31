// End-to-end API smoke test. Requires the server running and the DB migrated.
//   Terminal 1:  npm start
//   Terminal 2:  npm run smoke
require('dotenv').config();

const BASE = `http://localhost:${Number(process.env.PORT) || 3088}/api`;
let pass = 0;
let fail = 0;
let token = null; // household session token, set by authenticate() when auth is on

function ok(cond, label) {
  if (cond) { pass++; console.log('  ok  ', label); }
  else { fail++; console.log('  FAIL', label); }
}

async function req(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
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

(async () => {
  console.log('smoke test ->', BASE);

  const health = await req('GET', '/health');
  ok(health.status === 200 && health.data.status === 'ok', 'health responds');
  ok(health.data && health.data.db === 'up', 'database is reachable');
  if (health.data && health.data.db !== 'up') {
    console.log('\nDatabase is not reachable — check DATABASE_URL / run `npm run migrate`. Aborting.');
    process.exit(1);
  }

  // Everything below /auth needs a session token when APP_ACCESS_KEY is set.
  if (health.data.auth === 'enabled') {
    const key = process.env.APP_ACCESS_KEY;
    if (!key) {
      console.log('\nAPI requires a key but APP_ACCESS_KEY is not in this env. Aborting.');
      process.exit(1);
    }
    const auth = await req('POST', '/auth', { key });
    if (auth.status === 429) {
      console.log('\nRate-limited on /auth (10 tries per 15 min). Wait, then re-run. Aborting.');
      process.exit(1);
    }
    ok(auth.status === 200 && auth.data.token, 'exchange access key for session token');
    if (!auth.data || !auth.data.token) {
      console.log('\nCould not authenticate — check APP_ACCESS_KEY. Aborting.');
      process.exit(1);
    }
    token = auth.data.token;
  } else {
    console.log('  skip  auth (APP_ACCESS_KEY not set)');
  }

  // create profile. authDisabled:true makes it an "open" profile, so the
  // profile-scoped guard lets us patch and delete it without a face/OTP unlock.
  const cp = await req('POST', '/profiles', {
    name: 'SmokeTester', color: '#6B8CAE', email: 'smoke@example.com', authDisabled: true,
  });
  ok(cp.status === 201 && cp.data.id, 'create profile');
  if (!cp.data || !cp.data.id) {
    console.log('\nCould not create a profile — nothing downstream can run. Aborting.');
    process.exit(1);
  }
  const pid = cp.data.id;

  // email is required on create and validated on the way in
  ok((await req('POST', '/profiles', { name: 'NoEmail', color: '#6B8CAE' })).status === 400,
    'profile without email rejected (400)');
  ok((await req('POST', '/profiles', { name: 'BadEmail', color: '#6B8CAE', email: 'not-an-email' })).status === 400,
    'profile with malformed email rejected (400)');

  // validation rejects bad input
  const badTask = await req('POST', `/profiles/${pid}/tasks`, { title: '', type: 'nope' });
  ok(badTask.status === 400, 'invalid task rejected (400)');

  // create tasks
  const t1 = await req('POST', `/profiles/${pid}/tasks`, { title: 'First', type: 'daily', time: '07:00' });
  const t2 = await req('POST', `/profiles/${pid}/tasks`, { title: 'Second', type: 'weekly', days: [1, 3] });
  ok(t1.status === 201 && t2.status === 201, 'create two tasks');

  // toggle completion via PATCH
  const upd = await req('PATCH', `/tasks/${t1.data.id}`, { completed: true });
  ok(upd.status === 200 && upd.data.completed === true, 'patch task completed');

  // reorder
  const ro = await req('POST', `/profiles/${pid}/tasks/reorder`, { ids: [t2.data.id, t1.data.id] });
  ok(ro.status === 200 && ro.data[0].id === t2.data.id, 'reorder tasks');

  // reminder + expense
  const rem = await req('POST', `/profiles/${pid}/reminders`, {
    title: 'Test reminder', datetime: new Date(Date.now() + 3600e3).toISOString(), method: 'notification',
  });
  ok(rem.status === 201, 'create reminder');
  // 'other' is builtin, so this can't break when categories are edited
  const exp = await req('POST', `/profiles/${pid}/expenses`, {
    title: 'Lunch', amount: 12.5, type: 'expense', category: 'other', date: new Date().toISOString().slice(0, 10),
  });
  ok(exp.status === 201 && exp.data.amount === '12.50', 'create expense');

  // Vault access ALWAYS needs a per-profile unlock (face or emailed code), even
  // on an "open" profile — so over HTTP the only thing a smoke test can assert
  // is that it stays shut. The encrypt/decrypt round-trip is checked directly
  // against the crypto module below instead.
  if (health.data.vault === 'enabled') {
    ok((await req('GET', `/profiles/${pid}/vault`)).status === 403, 'vault read refused without unlock (403)');
    ok((await req('POST', `/profiles/${pid}/vault`, { label: 'x', password: 'y' })).status === 403,
      'vault write refused without unlock (403)');
    const { encrypt, decrypt } = require('../src/crypto');
    ok(decrypt(encrypt('s3cr3t!')) === 's3cr3t!', 'vault encrypt/decrypt round-trips');
  } else {
    console.log('  skip  vault tests (VAULT_KEY not set)');
  }

  // list reflects creates
  const list = await req('GET', `/profiles/${pid}/tasks`);
  ok(list.status === 200 && list.data.length === 2, 'list tasks');

  // bootstrap: the single request the web app boots from
  const boot = await req('GET', '/bootstrap');
  const bp = boot.data && boot.data.profiles && boot.data.profiles.find((p) => p.id === pid);
  ok(boot.status === 200 && Array.isArray(boot.data.categories) && Array.isArray(boot.data.profiles),
    'bootstrap returns categories + profiles');
  ok(!!bp && bp.tasks.length === 2 && bp.reminders.length === 1 && bp.expenses.length === 1,
    'bootstrap inlines each profile\'s children');
  ok(!!bp && bp.vault === undefined && bp.face_descriptor === undefined,
    'bootstrap leaks neither vault nor face descriptor');

  // categories
  const cats = await req('GET', '/categories');
  ok(cats.status === 200 && cats.data.some((c) => c.key === 'other' && c.builtin), 'categories list includes builtin other');
  const newCat = await req('POST', '/categories', { label: 'Smoke Cat', color: '#123456' });
  ok(newCat.status === 201 && newCat.data.key === 'smoke-cat', 'create category slugifies its key');
  ok((await req('POST', '/categories', { label: 'Bad', color: 'red;x:1' })).status === 400,
    'non-hex category colour rejected (400)');
  ok((await req('PATCH', `/categories/${newCat.data.key}`, { label: 'Renamed' })).data.key === newCat.data.key,
    'renaming a category keeps its key');
  ok((await req('POST', `/profiles/${pid}/expenses`, {
    title: 'Bad cat', amount: 1, type: 'expense', category: 'no-such-category',
    date: new Date().toISOString().slice(0, 10),
  })).status === 400, 'expense with unknown category rejected (400)');
  // deleting a category moves its expenses to 'other' rather than orphaning them
  await req('PATCH', `/expenses/${exp.data.id}`, { category: newCat.data.key });
  const delCat = await req('DELETE', `/categories/${newCat.data.key}`);
  ok(delCat.status === 200 && delCat.data.reassigned === 1, 'deleting a category reassigns its expenses');
  ok((await req('GET', `/profiles/${pid}/expenses`)).data[0].category === 'other', "reassigned expense lands in 'other'");
  ok((await req('DELETE', '/categories/other')).status === 409, 'builtin category cannot be deleted (409)');

  // 404 for unknown id
  const nf = await req('GET', '/profiles/00000000-0000-0000-0000-000000000000');
  ok(nf.status === 404, 'unknown profile -> 404');

  // A locked profile must refuse profile-scoped writes without an unlock token.
  // The flag is flipped in the DB rather than over HTTP because PATCH /profiles
  // is itself guarded — a locked profile can only be reopened by a real unlock,
  // so doing this over the API would strand an undeletable row.
  const { query } = require('../src/db');
  await query('UPDATE profiles SET auth_disabled = false WHERE id = $1', [pid]);
  ok((await req('DELETE', `/profiles/${pid}`)).status === 403, 'locked profile refuses delete (403)');
  ok((await req('PATCH', `/profiles/${pid}`, { name: 'Nope' })).status === 403, 'locked profile refuses patch (403)');
  await query('UPDATE profiles SET auth_disabled = true WHERE id = $1', [pid]);

  // cleanup
  const del = await req('DELETE', `/profiles/${pid}`);
  ok(del.status === 204, 'delete profile (cascades)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('smoke crashed:', e.message);
  process.exit(1);
});
