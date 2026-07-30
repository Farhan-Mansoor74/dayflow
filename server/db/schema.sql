-- Dayflow schema — single shared dataset (no auth/users).
-- gen_random_uuid() is built into Postgres core (>= 13), so no extension needed.

CREATE TABLE IF NOT EXISTS profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  color           text        NOT NULL,
  email           text        NOT NULL DEFAULT '',
  position        integer     NOT NULL DEFAULT 0,
  face_descriptor text,                       -- encrypted JSON array of 128 floats (AES-256-GCM), or NULL if not enrolled
  otp_hash        text,                       -- HMAC of the current login code, or NULL
  otp_expires_at  timestamptz,
  otp_attempts    integer     NOT NULL DEFAULT 0,
  auth_disabled   boolean     NOT NULL DEFAULT false, -- true = profile opens without face/OTP
  email_auth_enabled boolean  NOT NULL DEFAULT false, -- false = email/OTP unlock unavailable; face scan only
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- for databases created before these columns existed:
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email           text NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS face_descriptor text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS otp_hash        text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS otp_expires_at  timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS otp_attempts    integer NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS auth_disabled   boolean NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email_auth_enabled boolean NOT NULL DEFAULT false;

-- Brute-force throttle for the household access key, keyed by client IP. Lives in
-- the DB so it works on serverless hosts where there is no shared in-memory state.
CREATE TABLE IF NOT EXISTS auth_throttle (
  ip           text PRIMARY KEY,
  fails        integer     NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title       text        NOT NULL,
  type        text        NOT NULL CHECK (type IN ('daily','weekly','onetime')),
  time        text,                                   -- 'HH:MM' or NULL
  days        smallint[]  NOT NULL DEFAULT '{}',       -- weekdays 0..6 (Sun..Sat), used when type='weekly'
  completed   boolean     NOT NULL DEFAULT false,
  position    integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_profile ON tasks(profile_id);

CREATE TABLE IF NOT EXISTS reminders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title       text        NOT NULL,
  datetime    timestamptz NOT NULL,
  method      text        NOT NULL CHECK (method IN ('notification','email')),
  email       text        NOT NULL DEFAULT '',
  done        boolean     NOT NULL DEFAULT false,
  notified_at timestamptz,                            -- set when the scheduler has dispatched it (prevents duplicates)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reminders_profile ON reminders(profile_id);
-- for existing databases created before these columns were added:
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS notified_at timestamptz;
-- QStash message id for this reminder's scheduled callback, so an edit or
-- delete can cancel the pending one. NULL when nothing is scheduled.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS qstash_id text;

-- Browser push subscriptions (per device/browser; shared across profiles on a device).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint    text        NOT NULL UNIQUE,
  p256dh      text        NOT NULL,
  auth        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expenses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid          NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title       text          NOT NULL,
  amount      numeric(12,2) NOT NULL CHECK (amount >= 0),
  type        text          NOT NULL CHECK (type IN ('income','expense')),
  category    text          NOT NULL DEFAULT 'other',
  date        date          NOT NULL,
  note        text          NOT NULL DEFAULT '',
  created_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expenses_profile ON expenses(profile_id);

-- Passwords are stored encrypted (AES-256-GCM) in password_enc, never in plaintext.
CREATE TABLE IF NOT EXISTS vault_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  label         text        NOT NULL,
  username      text        NOT NULL DEFAULT '',
  password_enc  text        NOT NULL DEFAULT '',   -- format: ivB64:tagB64:ciphertextB64
  notes         text        NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vault_profile ON vault_items(profile_id);
