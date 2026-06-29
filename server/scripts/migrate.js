require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('[migrate] schema applied successfully');
  } catch (e) {
    console.error('[migrate] failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
