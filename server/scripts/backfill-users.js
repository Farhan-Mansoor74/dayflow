require('dotenv').config();
const { pool } = require('../src/db');
const { DEFAULT_CATEGORIES, seedCategories } = require('../src/defaults');

// ---------------------------------------------------------------------------
// One-shot migration from the old household layout to per-user accounts.
//
//   npm run migrate     <- adds users/user_id/parent_key alongside the old columns
//   npm run backfill    <- THIS: moves the data, then drops the legacy columns
//
// It runs in a single transaction and is safe to re-run: every step checks
// whether it has already been applied. On a database that never had `profiles`
// it only performs the "finalise" steps (NOT NULL + composite category key),
// which are themselves no-ops on a freshly migrated schema.
// ---------------------------------------------------------------------------

const CHILD_TABLES = ['tasks', 'reminders', 'expenses', 'vault_items'];

async function tableExists(c, name) {
  const { rows } = await c.query('SELECT to_regclass($1) AS oid', ['public.' + name]);
  return rows[0].oid !== null;
}

async function columnExists(c, table, column) {
  const { rows } = await c.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

async function main() {
  const client = await pool.connect();
  const notes = [];
  try {
    await client.query('BEGIN');

    if (!(await tableExists(client, 'users'))) {
      throw new Error('the `users` table does not exist — run `npm run migrate` first');
    }

    const hasProfiles = await tableExists(client, 'profiles');

    // -- 1. profiles -> users -------------------------------------------------
    if (hasProfiles) {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_profile_id uuid UNIQUE');

      // A shared email would violate idx_users_email_lower. Stop before writing
      // anything rather than half-migrating.
      const { rows: dupes } = await client.query(
        `SELECT lower(email) AS email, count(*)::int AS n FROM profiles
          WHERE email <> '' GROUP BY 1 HAVING count(*) > 1`
      );
      if (dupes.length) {
        throw new Error(
          'these profile emails are shared by more than one profile, so they cannot become '
          + 'separate accounts — give each one a distinct email first: '
          + dupes.map((d) => `${d.email} (x${d.n})`).join(', ')
        );
      }

      // A profile with no email cannot ever be claimed by a Google sign-in, so
      // it gets an unroutable placeholder and is reported at the end.
      const { rows: inserted } = await client.query(
        `INSERT INTO users (legacy_profile_id, email, name, color, face_descriptor,
                            otp_hash, otp_expires_at, otp_attempts, created_at)
         SELECT p.id,
                CASE WHEN p.email = '' THEN 'profile-' || p.id || '@unclaimed.invalid' ELSE p.email END,
                p.name, p.color, p.face_descriptor,
                p.otp_hash, p.otp_expires_at, p.otp_attempts, p.created_at
           FROM profiles p
          WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.legacy_profile_id = p.id)
       RETURNING id, name, email`
      );
      console.log(`[backfill] created ${inserted.length} user(s) from profiles`);
      for (const u of inserted) {
        if (u.email.endsWith('@unclaimed.invalid')) {
          notes.push(`"${u.name}" had no email — set one to let it be claimed:  `
            + `UPDATE users SET email = 'real@example.com' WHERE id = '${u.id}';`);
        }
      }

      // -- 2. child tables ----------------------------------------------------
      for (const t of CHILD_TABLES) {
        if (!(await columnExists(client, t, 'profile_id'))) continue;
        const { rowCount } = await client.query(
          `UPDATE ${t} SET user_id = u.id FROM users u
            WHERE u.legacy_profile_id = ${t}.profile_id AND ${t}.user_id IS NULL`
        );
        console.log(`[backfill] ${t}: linked ${rowCount} row(s) to a user`);
      }
    }

    // -- 3. categories: global -> per user -----------------------------------
    // Snapshot whatever the household had, drop the global rows, reshape the
    // table, then give every user their own copy.
    const { rows: legacyCats } = await client.query(
      'SELECT key, label, color, position, builtin FROM categories WHERE user_id IS NULL ORDER BY position, created_at'
    );
    if (legacyCats.length) {
      await client.query('DELETE FROM categories WHERE user_id IS NULL');
      console.log(`[backfill] categories: captured ${legacyCats.length} household categor(ies)`);
    }

    // Swap the key-only primary key for (user_id, key) + the self-referencing
    // parent FK. Guarded so a re-run, or a fresh database, skips it.
    const { rows: pk } = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'categories'::regclass AND contype = 'p'
          AND array_length(conkey, 1) = 1`
    );
    if (pk.length) {
      await client.query('ALTER TABLE categories ALTER COLUMN user_id SET NOT NULL');
      await client.query(`ALTER TABLE categories DROP CONSTRAINT ${pk[0].conname}`);
      await client.query('ALTER TABLE categories ADD PRIMARY KEY (user_id, key)');
      await client.query(
        `ALTER TABLE categories ADD CONSTRAINT categories_parent_fkey
           FOREIGN KEY (user_id, parent_key) REFERENCES categories(user_id, key) ON DELETE CASCADE`
      );
      console.log('[backfill] categories: primary key is now (user_id, key)');
    }

    // Only users with no categories at all — re-running must not resurrect
    // categories someone deliberately deleted after the first pass.
    const { rows: users } = await client.query(
      'SELECT id FROM users u WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.user_id = u.id)'
    );
    const seed = legacyCats.length ? legacyCats : DEFAULT_CATEGORIES;
    for (const u of users) await seedCategories(client, u.id, seed);
    if (users.length) console.log(`[backfill] categories: seeded ${users.length} user(s)`);

    // -- 4. push subscriptions ------------------------------------------------
    // There is no way to tell which user a pre-existing subscription belongs to,
    // and guessing would push one person's reminders to another's device.
    // Devices re-subscribe on their next visit.
    const { rowCount: dropped } = await client.query('DELETE FROM push_subscriptions WHERE user_id IS NULL');
    if (dropped) console.log(`[backfill] push: cleared ${dropped} unattributable subscription(s)`);
    await client.query('ALTER TABLE push_subscriptions ALTER COLUMN user_id SET NOT NULL');

    // -- 5. finalise ----------------------------------------------------------
    for (const t of CHILD_TABLES) {
      const { rows: orphans } = await client.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id IS NULL`);
      if (orphans[0].n) throw new Error(`${t} still has ${orphans[0].n} row(s) with no user_id`);
      await client.query(`ALTER TABLE ${t} ALTER COLUMN user_id SET NOT NULL`);
      await client.query(`ALTER TABLE ${t} DROP COLUMN IF EXISTS profile_id`);
    }

    await client.query('DROP TABLE IF EXISTS profiles CASCADE');
    await client.query('DROP TABLE IF EXISTS auth_throttle');
    await client.query('ALTER TABLE users DROP COLUMN IF EXISTS legacy_profile_id');

    await client.query('COMMIT');
    console.log('[backfill] done');
    if (notes.length) {
      console.log('\n[backfill] ACTION NEEDED:');
      for (const n of notes) console.log('  - ' + n);
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[backfill] failed (nothing was changed):', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
