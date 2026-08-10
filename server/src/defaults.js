// The category set every new account starts with. Same keys and colours the
// client used to hardcode, so a backfilled account's existing expenses keep
// their category. 'other' is builtin: it cannot be deleted because it is the
// reassign target when any other category is removed.
const DEFAULT_CATEGORIES = [
  { key: 'food',          label: 'Food & Drink',  color: '#E8694A', position: 0,    builtin: false },
  { key: 'transport',     label: 'Transport',     color: '#E0A458', position: 1,    builtin: false },
  { key: 'shopping',      label: 'Shopping',      color: '#9B7BA8', position: 2,    builtin: false },
  { key: 'entertainment', label: 'Entertainment', color: '#6B8CAE', position: 3,    builtin: false },
  { key: 'health',        label: 'Health',        color: '#5B9A8B', position: 4,    builtin: false },
  { key: 'bills',         label: 'Bills',         color: '#8B9A6B', position: 5,    builtin: false },
  { key: 'housing',       label: 'Housing',       color: '#C97B84', position: 6,    builtin: false },
  { key: 'other',         label: 'Other',         color: '#A89E96', position: 9999, builtin: true  },
];

// Insert the starter set for one user. Safe to call twice — existing keys win.
async function seedCategories(client, userId, rows = DEFAULT_CATEGORIES) {
  for (const c of rows) {
    await client.query(
      `INSERT INTO categories (user_id, key, label, color, parent_key, position, builtin)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id, key) DO NOTHING`,
      [userId, c.key, c.label, c.color, c.parent_key || null, c.position, c.builtin]
    );
  }
}

module.exports = { DEFAULT_CATEGORIES, seedCategories };
