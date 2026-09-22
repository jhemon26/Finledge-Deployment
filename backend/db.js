const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS members (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  pin_hash      TEXT NOT NULL,
  is_host       INTEGER NOT NULL DEFAULT 0,
  avatar        TEXT NOT NULL DEFAULT 'ocean-wave',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(room_id, name COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY,
  member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id     INTEGER NOT NULL REFERENCES members(id),
  description   TEXT NOT NULL,
  amount        REAL NOT NULL,
  category      TEXT NOT NULL,
  date          TEXT NOT NULL,
  location      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id     INTEGER REFERENCES members(id),
  action        TEXT NOT NULL,
  message       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  group_name    TEXT NOT NULL,
  name          TEXT NOT NULL,
  icon          TEXT NOT NULL,
  color         TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(room_id, name COLLATE NOCASE)
);

-- A settle-up agreement for one room-month. The month's debts are worked out
-- from the expenses every time, so nothing here duplicates money — this table
-- only records that the people involved say the payments have been made.
--
-- total_spend is a snapshot of the month total at the moment the request was
-- raised. It is not used in any calculation; it exists so the app can tell that
-- spending changed afterwards and the agreement no longer covers the month.
CREATE TABLE IF NOT EXISTS settlements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  month         TEXT NOT NULL,
  requested_by  INTEGER NOT NULL REFERENCES members(id),
  status        TEXT NOT NULL DEFAULT 'pending',
  total_spend   REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at    TEXT
);

-- Who has to agree, snapshotted when the request is raised. Fixing the list at
-- request time is deliberate: deriving it live would let a member joining
-- mid-agreement flip an already-settled month back to pending.
CREATE TABLE IF NOT EXISTS settlement_participants (
  settlement_id INTEGER NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  approved_at   TEXT,
  PRIMARY KEY (settlement_id, member_id)
);

-- Who is sharing the bill, and from when.
--
-- Only *changes* are stored. No row for a member means they have always
-- shared, so this table is empty for every room that never uses the feature
-- and the default costs nothing.
--
-- A change is effective from a *day*, not a month, and that is the whole
-- point: someone stops eating with the house on the 15th, and the month's
-- split has to follow them. The month is then made of segments — 1st to 14th
-- split four ways, 15th to the 30th split three ways — and each person's
-- share is the sum of their segments. Splitting per segment is what keeps the
-- balances netting to zero without anyone being billed for food they were not
-- there to eat.
CREATE TABLE IF NOT EXISTS participation_changes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id      INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL,                      -- YYYY-MM-DD, first day it applies
  status         TEXT NOT NULL,                      -- 'in' | 'out'
  set_by         INTEGER REFERENCES members(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(room_id, member_id, effective_from)
);

-- A member asking the host to pause or resume them. The host decides; only an
-- approval writes a participation_changes row. Asking rather than acting is
-- what stops someone quietly opting out of a bill they are already part of.
CREATE TABLE IF NOT EXISTS participation_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id      INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL,
  status         TEXT NOT NULL,                      -- what they want: 'in' | 'out'
  state          TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | declined | cancelled
  decided_by     INTEGER REFERENCES members(id),
  decided_at     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_members_room    ON members(room_id);
CREATE INDEX IF NOT EXISTS idx_expenses_room   ON expenses(room_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date   ON expenses(room_id, date);
CREATE INDEX IF NOT EXISTS idx_activity_room   ON activity_logs(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_room   ON sessions(room_id);
CREATE INDEX IF NOT EXISTS idx_categories_room ON categories(room_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_settlements_room ON settlements(room_id, month);
CREATE INDEX IF NOT EXISTS idx_settlement_participants_member ON settlement_participants(member_id);
CREATE INDEX IF NOT EXISTS idx_participation_changes_room ON participation_changes(room_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_participation_requests_room ON participation_requests(room_id, state);
`);

// Idempotent migration for databases created before the avatar column existed.
try {
  db.exec(`ALTER TABLE members ADD COLUMN avatar TEXT NOT NULL DEFAULT 'ocean-wave'`);
} catch (err) {
  if (!/duplicate column/i.test(err.message)) throw err;
}

// Idempotent migration for databases created before the expenses.location column existed.
try {
  db.exec(`ALTER TABLE expenses ADD COLUMN location TEXT`);
} catch (err) {
  if (!/duplicate column/i.test(err.message)) throw err;
}

module.exports = db;
