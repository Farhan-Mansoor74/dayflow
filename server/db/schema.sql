-- Dayflow schema — one account per person, signed in with Google.
-- gen_random_uuid() is built into Postgres core (>= 13), so no extension needed.
--
-- This file is idempotent and is applied wholesale by `npm run migrate`.
--
-- Upgrading a database that still has the old household `profiles` layout?
-- Run `npm run migrate` first (it adds the new tables/columns alongside the old
-- ones), then `npm run backfill` ONCE — that copies profiles into users, fills
-- user_id everywhere, and drops the legacy tables. See scripts/backfill-users.js.

CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub      text UNIQUE,                 -- Google 'sub' claim; NULL until the account is claimed
  email           text        NOT NULL,
  name            text        NOT NULL,
  picture         text        NOT NULL DEFAULT '',
  color           text        NOT NULL DEFAULT '#6B8CAE',
  -- Day of the month a spending cycle starts. 28 => 28 Aug .. 27 Sep. Values
  -- past the end of a short month clamp to its last day (see cycleRange()).
  cycle_start_day smallint    NOT NULL DEFAULT 1 CHECK (cycle_start_day BETWEEN 1 AND 31),
  -- Smart notifications. Times are hours 0..23 in the user's own timezone; the
  -- cron converts with Intl, so a single pass serves every timezone correctly.
  -- *_sent_on hold the local date each digest last went out, which is what makes
  -- the pass idempotent however often the cron runs.
  timezone        text        NOT NULL DEFAULT 'UTC',    -- IANA name, sent by the browser
  digest_hour     smallint    NOT NULL DEFAULT 8  CHECK (digest_hour  BETWEEN 0 AND 23),
  wrapup_hour     smallint    NOT NULL DEFAULT 20 CHECK (wrapup_hour BETWEEN 0 AND 23),
  notify_digest   boolean     NOT NULL DEFAULT true,     -- morning "tasks for today"
  notify_headsup  boolean     NOT NULL DEFAULT true,     -- "tomorrow: <reminder>"
  notify_wrapup   boolean     NOT NULL DEFAULT true,     -- evening "still open"
  digest_sent_on  date,
  wrapup_sent_on  date,
  -- Vault step-up credentials (moved here from profiles).
  face_descriptor text,                        -- encrypted JSON array of 128 floats (AES-256-GCM), NULL if not enrolled
  otp_hash        text,                        -- HMAC of the current step-up code, or NULL
  otp_expires_at  timestamptz,
  otp_attempts    integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- One account per email address, case-insensitively. Also the lookup index for
-- the "claim a backfilled account on first sign-in" path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text        NOT NULL,
  type        text        NOT NULL CHECK (type IN ('daily','weekly','onetime')),
  time        text,                                   -- 'HH:MM' or NULL
  days        smallint[]  NOT NULL DEFAULT '{}',       -- weekdays 0..6 (Sun..Sat), used when type='weekly'
  completed   boolean     NOT NULL DEFAULT false,
  position    integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reminders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text        NOT NULL,
  datetime    timestamptz NOT NULL,
  method      text        NOT NULL CHECK (method IN ('notification','email')),
  email       text        NOT NULL DEFAULT '',
  done        boolean     NOT NULL DEFAULT false,
  notified_at timestamptz,                            -- set when the scheduler has dispatched it (prevents duplicates)
  qstash_id   text,                                   -- pending QStash callback, so an edit/delete can cancel it
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Browser push subscriptions. Owned by the user who granted permission, so a
-- reminder only ever goes to that person's devices.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text        NOT NULL UNIQUE,
  p256dh      text        NOT NULL,
  auth        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Per-user expense categories, two levels deep. A row with parent_key set is a
-- sub-category of (user_id, parent_key); a row with parent_key NULL is
-- top-level. `key` is the stable slug stored on expenses.category — renaming a
-- category changes `label` only, so existing expenses keep pointing at it.
-- expenses.category always holds a LEAF key (the sub-category when one was
-- chosen, else the top-level one); the parent is derived by join.
CREATE TABLE IF NOT EXISTS categories (
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        text        NOT NULL,
  label      text        NOT NULL,
  color      text        NOT NULL,
  parent_key text,
  position   integer     NOT NULL DEFAULT 0,
  builtin    boolean     NOT NULL DEFAULT false,  -- true = cannot be deleted ('other', the reassign target)
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key),
  FOREIGN KEY (user_id, parent_key) REFERENCES categories(user_id, key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS expenses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text          NOT NULL,
  amount      numeric(12,2) NOT NULL CHECK (amount >= 0),
  type        text          NOT NULL CHECK (type IN ('income','expense')),
  -- Leaf category key, or the reserved value 'income' for income rows. No FK:
  -- deleting a category reassigns its expenses in a transaction instead.
  category    text          NOT NULL DEFAULT 'other',
  date        date          NOT NULL,
  note        text          NOT NULL DEFAULT '',
  created_at  timestamptz   NOT NULL DEFAULT now()
);

-- Passwords are stored encrypted (AES-256-GCM) in password_enc, never in plaintext.
CREATE TABLE IF NOT EXISTS vault_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         text        NOT NULL,
  username      text        NOT NULL DEFAULT '',
  password_enc  text        NOT NULL DEFAULT '',   -- format: ivB64:tagB64:ciphertextB64
  notes         text        NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Upgrade path for databases created under the old household schema.
--
-- These add the new columns as NULLable alongside the old profile_id. The
-- backfill script fills them in, enforces NOT NULL, and drops the legacy
-- columns and tables. On a fresh database every statement here is a no-op.
-- ---------------------------------------------------------------------------
ALTER TABLE tasks              ADD COLUMN IF NOT EXISTS user_id    uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE reminders          ADD COLUMN IF NOT EXISTS user_id    uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE reminders          ADD COLUMN IF NOT EXISTS notified_at timestamptz;
ALTER TABLE reminders          ADD COLUMN IF NOT EXISTS qstash_id  text;
ALTER TABLE expenses           ADD COLUMN IF NOT EXISTS user_id    uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE vault_items        ADD COLUMN IF NOT EXISTS user_id    uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_id    uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE categories         ADD COLUMN IF NOT EXISTS user_id    uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE categories         ADD COLUMN IF NOT EXISTS parent_key text;

-- Smart-notification columns, for databases created before they existed.
ALTER TABLE users     ADD COLUMN IF NOT EXISTS timezone       text     NOT NULL DEFAULT 'UTC';
ALTER TABLE users     ADD COLUMN IF NOT EXISTS digest_hour    smallint NOT NULL DEFAULT 8;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS wrapup_hour    smallint NOT NULL DEFAULT 20;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS notify_digest  boolean  NOT NULL DEFAULT true;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS notify_headsup boolean  NOT NULL DEFAULT true;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS notify_wrapup  boolean  NOT NULL DEFAULT true;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS digest_sent_on date;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS wrapup_sent_on date;
-- Set once the day-before heads-up has gone out, so it never repeats.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS headsup_sent_at timestamptz;

-- Between migrate and backfill the old profile_id is still NOT NULL while the
-- new user_id is empty, so every INSERT would fail. Relax the old column so the
-- window between the two commands (or a backfill that aborts on bad data) can't
-- take writes down. DROP COLUMN in the backfill removes it for good.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','reminders','expenses','vault_items'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = t AND column_name = 'profile_id') THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN profile_id DROP NOT NULL', t);
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_user     ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id);
CREATE INDEX IF NOT EXISTS idx_expenses_user  ON expenses(user_id);
CREATE INDEX IF NOT EXISTS idx_vault_user     ON vault_items(user_id);
CREATE INDEX IF NOT EXISTS idx_push_user      ON push_subscriptions(user_id);
-- Cycle windows are always "this user's expenses between two dates".
CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date);
