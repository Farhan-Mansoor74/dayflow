const { Pool } = require('pg');

// If DATABASE_URL is set it wins; otherwise pg falls back to the standard
// PG* environment variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE, ...).
const pool = new Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}
);

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
