require('dotenv').config();

const { initDb } = require('../src/db');
const { RotationService } = require('../src/rotationService');

const dbPath = process.env.DB_PATH || './data/oncall.sqlite';
const prefix = (process.env.TEST_USER_PREFIX || 'UTEST').toUpperCase();
const count = Number.parseInt(process.env.TEST_USER_COUNT || '4', 10);
const adminId = (process.env.TEST_USER_ADMIN_ID || '').trim().toUpperCase();

if (!Number.isInteger(count) || count < 1) {
  throw new Error('TEST_USER_COUNT must be a positive integer');
}

const db = initDb(dbPath);
const service = new RotationService(db);

const seeded = [];
for (let index = 1; index <= count; index += 1) {
  const slackUserId = `${prefix}${String(index).padStart(4, '0')}`;
  const displayName = `Test User ${index}`;
  const member = service.addMember({
    slackUserId,
    displayName,
    isAdmin: adminId === slackUserId,
  });
  seeded.push(member.slack_user_id);
}

if (adminId) {
  const exists = service.getMemberBySlackId(adminId);
  if (exists) {
    db.prepare('UPDATE team_members SET is_admin = 1 WHERE slack_user_id = ?').run(adminId);
  }
}

const activeTestUsers = db
  .prepare('SELECT slack_user_id, queue_position, is_admin FROM team_members WHERE is_active = 1 AND slack_user_id LIKE ? ORDER BY queue_position ASC')
  .all(`${prefix}%`);

console.log(`Seeded/updated ${seeded.length} test users in ${dbPath}`);
for (const user of activeTestUsers) {
  console.log(`- ${user.slack_user_id} (position ${user.queue_position}${user.is_admin ? ', admin' : ''})`);
}

db.close();
