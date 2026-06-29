// Seeds the demo dataset (Maya / Leo / Sofia) that the original app shipped with.
// DESTRUCTIVE: clears all existing rows first. Run with: npm run seed
require('dotenv').config();
const { pool } = require('../src/db');
const { encrypt, vaultEnabled } = require('../src/crypto');

const now = new Date();
const dt = (daysAhead, h, m = 0) => {
  const d = new Date(now);
  d.setDate(d.getDate() + daysAhead);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const ago = (days) => {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};

const profiles = [
  {
    name: 'Maya', color: '#E8694A', email: 'maya@example.com',
    tasks: [
      { title: 'Morning stretch', type: 'daily', time: '07:00', completed: true },
      { title: 'Make breakfast', type: 'daily', time: '08:00', completed: true },
      { title: 'Team standup', type: 'weekly', time: '09:30', days: [1, 3, 5] },
      { title: 'Read 20 pages', type: 'daily', time: '20:00' },
      { title: 'Water the plants', type: 'onetime' },
    ],
    reminders: [
      { title: 'Team standup', datetime: dt(1, 9), method: 'notification', email: '' },
      { title: 'Pay electricity bill', datetime: dt(5, 10), method: 'email', email: 'maya@email.com' },
    ],
    expenses: [
      { title: 'Salary', amount: 3500, type: 'income', category: 'other', date: ago(15) },
      { title: 'Freelance work', amount: 800, type: 'income', category: 'other', date: ago(10) },
      { title: 'Groceries', amount: 280, type: 'expense', category: 'food', date: ago(3) },
      { title: 'Uber rides', amount: 85, type: 'expense', category: 'transport', date: ago(5) },
      { title: 'Netflix', amount: 15, type: 'expense', category: 'entertainment', date: ago(8) },
      { title: 'Gym membership', amount: 50, type: 'expense', category: 'health', date: ago(8) },
      { title: 'Electricity', amount: 120, type: 'expense', category: 'bills', date: ago(12) },
      { title: 'Amazon order', amount: 160, type: 'expense', category: 'shopping', date: ago(2) },
      { title: 'Coffee shop', amount: 65, type: 'expense', category: 'food', date: ago(1) },
    ],
    vault: [
      { label: 'Netflix', username: 'maya@email.com', password: 'Sunshine2024!', notes: 'Family plan' },
      { label: 'Home WiFi', username: '', password: 'RouterPass#99', notes: '' },
    ],
  },
  {
    name: 'Leo', color: '#5B9A8B', email: 'leo@example.com',
    tasks: [
      { title: 'Make the bed', type: 'daily', completed: true },
      { title: 'Practice guitar', type: 'daily', time: '17:00' },
      { title: 'Soccer practice', type: 'weekly', time: '16:00', days: [2, 4] },
      { title: 'Finish math homework', type: 'onetime' },
    ],
    reminders: [
      { title: 'Soccer practice', datetime: dt(2, 16), method: 'notification', email: '' },
    ],
    expenses: [
      { title: 'Allowance', amount: 200, type: 'income', category: 'other', date: ago(1) },
      { title: 'School lunch', amount: 45, type: 'expense', category: 'food', date: ago(4) },
      { title: 'Bus pass', amount: 30, type: 'expense', category: 'transport', date: ago(7) },
      { title: 'Video game', amount: 60, type: 'expense', category: 'entertainment', date: ago(14) },
    ],
    vault: [{ label: 'School Portal', username: 'leo.smith', password: 'Lego2024', notes: '' }],
  },
  {
    name: 'Sofia', color: '#C97B84', email: 'sofia@example.com',
    tasks: [
      { title: 'Feed the cat', type: 'daily', time: '08:00', completed: true },
      { title: 'Walk the dog', type: 'daily', time: '18:00' },
      { title: 'Piano lesson', type: 'weekly', time: '11:00', days: [6, 0] },
    ],
    reminders: [
      { title: 'Piano recital', datetime: dt(6, 14), method: 'notification', email: '' },
    ],
    expenses: [
      { title: 'Pocket money', amount: 100, type: 'income', category: 'other', date: ago(1) },
      { title: 'Art supplies', amount: 35, type: 'expense', category: 'shopping', date: ago(5) },
      { title: 'Snacks', amount: 25, type: 'expense', category: 'food', date: ago(2) },
    ],
    vault: [{ label: 'Piano App', username: 'sofia@mail.com', password: 'Piano123', notes: 'Practice log' }],
  },
];

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE profiles, tasks, reminders, expenses, vault_items RESTART IDENTITY CASCADE');

    let pPos = 0;
    for (const p of profiles) {
      // Demo profiles use @example.com addresses that can't receive a real OTP,
      // so ship them with auth turned off (openable). Real profiles created in
      // the app default to auth ON.
      const { rows } = await client.query(
        'INSERT INTO profiles (name, color, email, position, auth_disabled) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [p.name, p.color, p.email || '', pPos++, true]
      );
      const pid = rows[0].id;

      let tPos = 0;
      for (const t of p.tasks) {
        await client.query(
          'INSERT INTO tasks (profile_id,title,type,time,days,completed,position) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [pid, t.title, t.type, t.time || null, t.days || [], !!t.completed, tPos++]
        );
      }
      for (const r of p.reminders) {
        await client.query(
          'INSERT INTO reminders (profile_id,title,datetime,method,email) VALUES ($1,$2,$3,$4,$5)',
          [pid, r.title, r.datetime, r.method, r.email || '']
        );
      }
      for (const e of p.expenses) {
        await client.query(
          'INSERT INTO expenses (profile_id,title,amount,type,category,date) VALUES ($1,$2,$3,$4,$5,$6)',
          [pid, e.title, e.amount, e.type, e.category, e.date]
        );
      }
      for (const vi of p.vault) {
        await client.query(
          'INSERT INTO vault_items (profile_id,label,username,password_enc,notes) VALUES ($1,$2,$3,$4,$5)',
          [pid, vi.label, vi.username || '', encrypt(vi.password || ''), vi.notes || '']
        );
      }
    }

    await client.query('COMMIT');
    console.log(`[seed] inserted ${profiles.length} profiles with tasks, reminders, expenses, vault items`);
    if (!vaultEnabled()) {
      console.log('[seed] NOTE: VAULT_KEY not set — vault passwords were stored as empty. Set it and re-seed to include them.');
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[seed] failed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
