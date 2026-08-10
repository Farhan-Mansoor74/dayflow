// Seeds the demo dataset (Maya / Leo / Sofia) that the original app shipped with.
// Each becomes an unclaimed account: signing in with Google using the same email
// address adopts it, so this doubles as a fixture for the claim path.
// DESTRUCTIVE: clears all existing rows first. Run with: npm run seed
require('dotenv').config();
const { pool } = require('../src/db');
const { encrypt, vaultEnabled } = require('../src/crypto');
const { seedCategories } = require('../src/defaults');

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

const people = [
  {
    name: 'Maya', color: '#E8694A', email: 'maya@example.com', cycleStartDay: 28,
    // Two sub-categories under the built-in 'food', to exercise the nested
    // picker and the by-sub-category chart.
    subcategories: [
      { key: 'groceries', label: 'Groceries', color: '#E8694A', parent: 'food' },
      { key: 'eating-out', label: 'Eating Out', color: '#E0A458', parent: 'food' },
    ],
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
      { title: 'Groceries', amount: 280, type: 'expense', category: 'groceries', date: ago(3) },
      { title: 'Uber rides', amount: 85, type: 'expense', category: 'transport', date: ago(5) },
      { title: 'Netflix', amount: 15, type: 'expense', category: 'entertainment', date: ago(8) },
      { title: 'Gym membership', amount: 50, type: 'expense', category: 'health', date: ago(8) },
      { title: 'Electricity', amount: 120, type: 'expense', category: 'bills', date: ago(12) },
      { title: 'Amazon order', amount: 160, type: 'expense', category: 'shopping', date: ago(2) },
      { title: 'Coffee shop', amount: 65, type: 'expense', category: 'eating-out', date: ago(1) },
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
    await client.query('TRUNCATE users, tasks, reminders, expenses, vault_items, categories, push_subscriptions CASCADE');

    for (const p of people) {
      // google_sub stays NULL: the account is unclaimed until someone signs in
      // with Google using this email address.
      const { rows } = await client.query(
        'INSERT INTO users (name, color, email, cycle_start_day) VALUES ($1,$2,$3,$4) RETURNING id',
        [p.name, p.color, p.email, p.cycleStartDay || 1]
      );
      const uid = rows[0].id;

      await seedCategories(client, uid);
      for (const c of p.subcategories || []) {
        await client.query(
          'INSERT INTO categories (user_id,key,label,color,parent_key,position) VALUES ($1,$2,$3,$4,$5,$6)',
          [uid, c.key, c.label, c.color, c.parent, 0]
        );
      }

      let tPos = 0;
      for (const t of p.tasks) {
        await client.query(
          'INSERT INTO tasks (user_id,title,type,time,days,completed,position) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [uid, t.title, t.type, t.time || null, t.days || [], !!t.completed, tPos++]
        );
      }
      for (const r of p.reminders) {
        await client.query(
          'INSERT INTO reminders (user_id,title,datetime,method,email) VALUES ($1,$2,$3,$4,$5)',
          [uid, r.title, r.datetime, r.method, r.email || '']
        );
      }
      for (const e of p.expenses) {
        await client.query(
          'INSERT INTO expenses (user_id,title,amount,type,category,date) VALUES ($1,$2,$3,$4,$5,$6)',
          [uid, e.title, e.amount, e.type, e.type === 'income' ? 'income' : e.category, e.date]
        );
      }
      for (const vi of p.vault) {
        await client.query(
          'INSERT INTO vault_items (user_id,label,username,password_enc,notes) VALUES ($1,$2,$3,$4,$5)',
          [uid, vi.label, vi.username || '', encrypt(vi.password || ''), vi.notes || '']
        );
      }
    }

    await client.query('COMMIT');
    console.log(`[seed] inserted ${people.length} unclaimed accounts with categories, tasks, reminders, expenses, vault items`);
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
