const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function initDb(dbPath) {
  const absolutePath = path.resolve(dbPath || './data/oncall.sqlite');
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  const db = new Database(absolutePath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      slack_user_id TEXT UNIQUE NOT NULL,
      display_name TEXT,
      queue_position INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rotation_history (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      source TEXT NOT NULL,
      UNIQUE(week_start),
      FOREIGN KEY(member_id) REFERENCES team_members(id)
    );

    CREATE TABLE IF NOT EXISTS schedule_overrides (
      id TEXT PRIMARY KEY,
      week_start TEXT NOT NULL,
      member_id TEXT NOT NULL,
      override_type TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      details TEXT,
      FOREIGN KEY(member_id) REFERENCES team_members(id)
    );

    CREATE TABLE IF NOT EXISTS pending_swaps (
      id TEXT PRIMARY KEY,
      week_start TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_back_to_back_approvals (
      id TEXT PRIMARY KEY,
      week_start TEXT NOT NULL,
      member_id TEXT NOT NULL,
      member_slack_user_id TEXT NOT NULL,
      override_type TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL,
      user_approved_by TEXT,
      admin_approved_by TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY(member_id) REFERENCES team_members(id)
    );

    CREATE TABLE IF NOT EXISTS bot_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

module.exports = {
  initDb,
};
