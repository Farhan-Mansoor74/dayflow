// End-to-end API smoke test. Requires the server running and the DB migrated.
//   Terminal 1:  npm start
//   Terminal 2:  npm run smoke
require('dotenv').config();

const BASE = `http://localhost:${Number(process.env.PORT) || 3001}/api`;
let pass = 0;
let fail = 0;

function ok(cond, label) {
  if (cond) { pass++; console.log('  ok  ', label); }
  else { fail++; console.log('  FAIL', label); }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
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

  // create profile
  const cp = await req('POST', '/profiles', { name: 'SmokeTester', color: '#6B8CAE' });
  ok(cp.status === 201 && cp.data.id, 'create profile');
  const pid = cp.data.id;

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
  const exp = await req('POST', `/profiles/${pid}/expenses`, {
    title: 'Lunch', amount: 12.5, type: 'expense', category: 'food', date: new Date().toISOString().slice(0, 10),
  });
  ok(exp.status === 201 && exp.data.amount === '12.50', 'create expense');

  // vault (only if enabled) — confirms encrypt/decrypt round-trips
  if (health.data.vault === 'enabled') {
    const vlt = await req('POST', `/profiles/${pid}/vault`, {
      label: 'Test login', username: 'u@e.com', password: 's3cr3t!', notes: 'note',
    });
    ok(vlt.status === 201 && vlt.data.password === 's3cr3t!', 'vault round-trips decrypted password');
  } else {
    console.log('  skip  vault test (VAULT_KEY not set)');
  }

  // list reflects creates
  const list = await req('GET', `/profiles/${pid}/tasks`);
  ok(list.status === 200 && list.data.length === 2, 'list tasks');

  // 404 for unknown id
  const nf = await req('GET', '/profiles/00000000-0000-0000-0000-000000000000');
  ok(nf.status === 404, 'unknown profile -> 404');

  // cleanup
  const del = await req('DELETE', `/profiles/${pid}`);
  ok(del.status === 204, 'delete profile (cascades)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('smoke crashed:', e.message);
  process.exit(1);
});
