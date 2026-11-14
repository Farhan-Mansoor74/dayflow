// The category set every new account starts with: top-level categories, each
// with sub-categories that take the parent's colour. Top-level keys match the
// ones the client used to hardcode, so a backfilled account's existing
// expenses keep their category. 'other' is builtin: it cannot be deleted, and
// its 'other-misc' sub-category is the default reassign target on delete.
const TREE = [
  ['food',          'Food & Dining',          '#E8694A', [['dining-out', 'Dining out'], ['delivery', 'Delivery']]],
  ['transport',     'Transport',              '#E0A458', [['fuel', 'Fuel'], ['car-wash', 'Car wash & service'], ['parking', 'Parking & tolls'],
                                                            ['public-transport', 'Public transport'], ['fines', 'Fines & licensing']]],
  ['bills',         'Bills & Subscriptions',  '#8B9A6B', [['mobile', 'Mobile'], ['software', 'Software & apps'], ['utilities', 'Internet & utilities']]],
  ['health',        'Health & Personal Care', '#5B9A8B', [['fitness', 'Fitness'], ['grooming', 'Grooming'], ['medical', 'Medical & pharmacy']]],
  ['shopping',      'Shopping',               '#9B7BA8', [['groceries', 'Groceries'], ['clothing', 'Clothing'], ['shopping-misc', 'Miscellaneous'],
                                                            ['electronics', 'Electronics']]],
  ['entertainment', 'Entertainment',          '#6B8CAE', [['movies', 'Movies & events'], ['sports', 'Sports & activities']]],
  ['giving',        'Gifts & Giving',         '#D98C5F', [['gifts', 'Gifts'], ['charity', 'Charity']]],
  ['family',        'Family',                 '#C97B84', [['parents', 'Parents'], ['household', 'Household']]],
  ['education',     'Education',              '#7A9EB8', [['courses', 'Courses'], ['books', 'Books']]],
  ['financial',     'Financial',              '#B08968', [['bank-fees', 'Bank fees'], ['savings', 'Savings']]],
  ['other',         'Other',                  '#A89E96', [['other-misc', 'Miscellaneous']]],
];

// Flattened, parents before children (the parent_key FK needs that order).
const DEFAULT_CATEGORIES = [
  ...TREE.map(([key, label, color], i) => ({
    key, label, color, position: key === 'other' ? 9999 : i, builtin: key === 'other',
  })),
  ...TREE.flatMap(([parent, , color, subs]) => subs.map(([key, label], i) => ({
    key, label, color, parent_key: parent, position: i, builtin: false,
  }))),
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
