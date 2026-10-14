-- The accounts db.json held, and one training document per profile (docs/adr/0001).
--
-- The API keeps every account in memory and saves it whole (store/pg.js), so these tables are a
-- lossless copy of db.json rather than the place lookups happen: columns keep the JavaScript
-- value types (ISO strings as TEXT, epoch milliseconds as BIGINT), a SQL NULL means the field was
-- absent, and every field without a column, or whose value does not fit its column, is kept in
-- `extra`. `pos` is the record's place in its db.json array: order carries meaning there (the
-- push-subscription cap drops a profile's oldest) and a migration is verified by deep equality.
-- schema_migrations belongs to the runner (store/migrate.js), not to this file.

-- Lookups happen in memory; constraints are backstops.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  pos           INTEGER NOT NULL,
  name          TEXT,
  created       TEXT,        -- ISO string
  admin         BOOLEAN,
  disabled      BOOLEAN,
  invited_by    TEXT,        -- invite code, historical: no FK
  sv            INTEGER,     -- session version
  last_pull     BIGINT,      -- epoch ms
  last_reminder TEXT,        -- YYYY-MM-DD
  last_nudge    TEXT,        -- YYYY-MM-DD
  pw            JSONB,       -- {h, set}
  pw_reset      JSONB,       -- {h, exp, by}
  email         TEXT,        -- already folded by normalizeEmail()
  extra         JSONB NOT NULL DEFAULT '{}'
);
-- No constraint on name: whether a name is taken depends on the profile's password state (holdsName).
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE email IS NOT NULL;

CREATE TABLE credentials (
  id          TEXT PRIMARY KEY,                -- WebAuthn credential id
  pos         INTEGER NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key  TEXT,                            -- base64url
  counter     BIGINT,
  transports  JSONB,                           -- string[]
  created     TEXT,                            -- ISO string
  last_used   TEXT,                            -- ISO string
  name        TEXT,
  extra       JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX credentials_user_id_idx ON credentials (user_id);

CREATE TABLE invites (
  code        TEXT PRIMARY KEY,
  pos         INTEGER NOT NULL,
  note        TEXT,
  created_by  TEXT,          -- admin uid, historical: no FK
  created     TEXT,          -- ISO string
  used_by     TEXT,          -- uid, historical: no FK
  used_at     TEXT,          -- ISO string
  extra       JSONB NOT NULL DEFAULT '{}'   -- old rows may carry `revoked`
);

CREATE TABLE push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  pos         INTEGER NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keys        JSONB,         -- {p256dh, auth}
  device_id   TEXT,
  created     TEXT,          -- ISO string
  extra       JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX push_subscriptions_user_id_idx ON push_subscriptions (user_id);

CREATE TABLE device_links (
  h           TEXT PRIMARY KEY,   -- sha256 of the link code
  pos         INTEGER NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exp         BIGINT,             -- epoch ms
  created     BIGINT,             -- epoch ms
  extra       JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX device_links_user_id_idx ON device_links (user_id);

-- Unknown top-level keys of db.json, round-tripped untouched.
CREATE TABLE db_extra (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);

-- Per-user training document (spec Phase 2 design decisions). `doc` is the whole document,
-- _rev/_wid/_wids included; rev/wid/wids mirror those, are written in the same statement, and are
-- what the compare-and-swap and GET /api/data/rev read.
CREATE TABLE user_state (
  uid         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rev         BIGINT NOT NULL,
  wid         TEXT,
  wids        JSONB NOT NULL DEFAULT '[]',
  doc         JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
