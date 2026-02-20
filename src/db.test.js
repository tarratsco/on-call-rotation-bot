const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initDb } = require('./db');

test('initDb creates schema and writable database', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oncall-db-test-'));
  const dbPath = path.join(tempDir, 'oncall.sqlite');
  const db = initDb(dbPath);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('team_members','rotation_history','schedule_overrides','pending_swaps','bot_config') ORDER BY name")
    .all()
    .map((row) => row.name);

  assert.deepEqual(tables, ['bot_config', 'pending_swaps', 'rotation_history', 'schedule_overrides', 'team_members']);

  db.prepare('INSERT INTO bot_config(key, value) VALUES (?, ?)').run('test_key', 'value');
  const row = db.prepare('SELECT value FROM bot_config WHERE key = ?').get('test_key');
  assert.equal(row.value, 'value');

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
