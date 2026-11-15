// One-time upgrade of data encrypted before per-user keys existed:
//   - vault_items: label, username, notes (stored as plain text) and
//     password_enc (legacy master-key format) are rewritten as v2 ciphertext;
//   - users.face_descriptor: legacy format -> v2;
//   - reminders.email: cleared (email reminders now always go to the account's
//     own address, so stored third-party addresses serve no purpose).
// Every rewritten value is decrypted again and compared before anything is
// committed, all in one transaction. Safe to re-run: v2 values are skipped.
//
// Dry run (default):  node scripts/migrate-vault-v2.js
// Write changes:      node scripts/migrate-vault-v2.js --apply
require('dotenv').config();
const { pool } = require('../src/db');
const { encrypt, decrypt, decryptField, isV2 } = require('../src/crypto');

const apply = process.argv.includes('--apply');

(async () => {
  const client = await pool.connect();
  let vaultRows = 0, faces = 0;
  try {
    await client.query('BEGIN');

    const { rows: items } = await client.query('SELECT * FROM vault_items FOR UPDATE');
    for (const r of items) {
      const plain = {
        label: decryptField(r.label, r.user_id),
        username: decryptField(r.username, r.user_id),
        notes: decryptField(r.notes, r.user_id),
        password_enc: decrypt(r.password_enc, r.user_id),
      };
      const next = {};
      for (const col of Object.keys(plain)) {
        if (r[col] === '' || isV2(r[col])) continue;
        next[col] = encrypt(plain[col], r.user_id);
        const back = decrypt(next[col], r.user_id);
        if (back !== plain[col]) throw new Error(`round-trip mismatch on vault item ${r.id} (${col})`);
      }
      const cols = Object.keys(next);
      if (!cols.length) continue;
      vaultRows++;
      await client.query(
        `UPDATE vault_items SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`,
        [...cols.map((c) => next[c]), r.id]
      );
    }

    const { rows: users } = await client.query('SELECT id, face_descriptor FROM users WHERE face_descriptor IS NOT NULL FOR UPDATE');
    for (const u of users) {
      if (isV2(u.face_descriptor)) continue;
      const plain = decrypt(u.face_descriptor, u.id);
      const enc = encrypt(plain, u.id);
      if (decrypt(enc, u.id) !== plain) throw new Error(`round-trip mismatch on face data for user ${u.id}`);
      faces++;
      await client.query('UPDATE users SET face_descriptor = $1 WHERE id = $2', [enc, u.id]);
    }

    const { rowCount: emails } = await client.query("UPDATE reminders SET email = '' WHERE email <> ''");

    console.log(`[migrate-vault-v2] vault items to rewrite: ${vaultRows} of ${items.length}; face records: ${faces}; reminder addresses cleared: ${emails}`);
    if (apply) {
      await client.query('COMMIT');
      console.log('[migrate-vault-v2] committed');
    } else {
      await client.query('ROLLBACK');
      console.log('[migrate-vault-v2] dry run — nothing written. Re-run with --apply to commit.');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate-vault-v2] failed, nothing written:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
