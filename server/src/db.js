const { Pool } = require('pg');

// If DATABASE_URL is set it wins; otherwise pg falls back to the standard
// PG* environment variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE, ...).
// Bounded so a paused/unreachable database fails fast with a real error
// instead of leaving requests (like face match) hanging indefinitely.
const timeouts = { connectionTimeoutMillis: 5000, statement_timeout: 10000 };
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ...timeouts }
    : timeouts
);

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
