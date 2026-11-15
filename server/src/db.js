const { Pool } = require('pg');

// If DATABASE_URL is set it wins; otherwise pg falls back to the standard
// PG* environment variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE, ...).
// Bounded so a paused/unreachable database fails fast with a real error
// instead of leaving requests (like face match) hanging indefinitely.
const timeouts = { connectionTimeoutMillis: 5000, statement_timeout: 10000 };

// PG_CA (the provider's CA certificate, PEM; "\n" escapes allowed) turns on
// full certificate verification, so nobody in between can pose as the
// database. URL ssl parameters would override the `ssl` option, so they are
// dropped when it is set.
function config() {
  if (!process.env.DATABASE_URL) return timeouts;
  const ca = (process.env.PG_CA || '').replace(/\\n/g, '\n').trim();
  if (!ca) {
    console.warn('[db] PG_CA is not set: the connection is encrypted but the server certificate is not verified');
    return { connectionString: process.env.DATABASE_URL, ...timeouts };
  }
  const url = new URL(process.env.DATABASE_URL);
  for (const k of ['sslmode', 'uselibpqcompat', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(k);
  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true }, ...timeouts };
}

const pool = new Pool(config());

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
