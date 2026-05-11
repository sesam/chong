PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cls (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  repo        TEXT NOT NULL,
  branch      TEXT NOT NULL,
  author      TEXT NOT NULL,
  status      TEXT NOT NULL,
  sha         TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cls_author ON cls(author);
CREATE INDEX IF NOT EXISTS idx_cls_status ON cls(status);
CREATE INDEX IF NOT EXISTS idx_cls_repo ON cls(repo);
CREATE INDEX IF NOT EXISTS idx_cls_sha ON cls(sha);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS coaching (
  sha          TEXT PRIMARY KEY,
  repo         TEXT NOT NULL,
  content      TEXT NOT NULL,
  generated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  token       TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  email       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
