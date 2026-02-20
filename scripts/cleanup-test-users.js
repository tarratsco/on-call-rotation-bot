require('dotenv').config();

const { initDb } = require('../src/db');
const { RotationService } = require('../src/rotationService');

const dbPath = process.env.DB_PATH || './data/oncall.sqlite';
const prefix = (process.env.TEST_USER_PREFIX || 'UTEST').toUpperCase();

const db = initDb(dbPath);
const service = new RotationService(db);

const users = db
  .prepare('SELECT id, slack_user_id FROM team_members WHERE slack_user_id LIKE ?')
  .all(`${prefix}%`);

if (!users.length) {
  console.log(`No users found for prefix ${prefix} in ${dbPath}`);
  db.close();
  process.exit(0);
}

const ids = users.map((user) => user.id);
const placeholders = ids.map(() => '?').join(',');

if (ids.length) {
  db.prepare(`DELETE FROM rotation_history WHERE member_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM schedule_overrides WHERE member_id IN (${placeholders})`).run(...ids);
}

db.prepare('DELETE FROM pending_swaps WHERE requester_user_id LIKE ? OR target_user_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
db.prepare('DELETE FROM team_members WHERE slack_user_id LIKE ?').run(`${prefix}%`);

service.reindexQueue();

console.log(`Removed ${users.length} test users with prefix ${prefix} from ${dbPath}`);
for (const user of users) {
  console.log(`- ${user.slack_user_id}`);
}

db.close();
