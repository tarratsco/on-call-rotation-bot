const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initDb } = require('./db');
const { RotationService } = require('./rotationService');

function createService(initialAdminIds = []) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oncall-rotation-test-'));
  const dbPath = path.join(tempDir, 'oncall.sqlite');
  const db = initDb(dbPath);
  const service = new RotationService(db, { initialAdminIds });

  return {
    db,
    service,
    cleanup() {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test('addMember/listMembers maintains queue and admin bootstrap behavior', () => {
  const { service, cleanup } = createService(['UADMIN']);

  service.addMember({ slackUserId: 'UADMIN', displayName: 'Admin' });
  service.addMember({ slackUserId: 'U2', displayName: 'User Two' });

  const members = service.listMembers();
  assert.equal(members.length, 2);
  assert.equal(members[0].slack_user_id, 'UADMIN');
  assert.equal(members[0].is_admin, 1);
  assert.equal(members[1].queue_position, 2);

  cleanup();
});

test('removeMember deactivates and reindexes queue', () => {
  const { service, cleanup } = createService();
  service.addMember({ slackUserId: 'U1', displayName: 'One' });
  service.addMember({ slackUserId: 'U2', displayName: 'Two' });
  service.addMember({ slackUserId: 'U3', displayName: 'Three' });

  const result = service.removeMember('U2');
  assert.equal(result.removed, true);

  const members = service.listMembers();
  assert.equal(members.length, 2);
  assert.equal(members.some((m) => m.slack_user_id === 'U2'), false);
  assert.deepEqual(
    members
      .map((m) => m.queue_position)
      .sort((a, b) => a - b),
    [1, 2]
  );

  cleanup();
});

test('getUpcomingSchedule creates fair round-robin assignments', () => {
  const { service, cleanup } = createService();
  service.addMember({ slackUserId: 'U1', displayName: 'One' });
  service.addMember({ slackUserId: 'U2', displayName: 'Two' });

  const schedule = service.getUpcomingSchedule('2026-02-16', 4);
  const assigned = schedule.map((entry) => entry.member && entry.member.slack_user_id);

  assert.deepEqual(assigned, ['U1', 'U2', 'U1', 'U2']);
  cleanup();
});

test('setSkip assigns fallback for skipped user', () => {
  const { service, cleanup } = createService();
  const u1 = service.addMember({ slackUserId: 'U1', displayName: 'One' });
  service.addMember({ slackUserId: 'U2', displayName: 'Two' });

  const fallback = service.setSkip({ weekStart: '2026-02-16', memberId: u1.id, createdBy: 'U1' });
  assert.equal(fallback.slack_user_id, 'U2');

  cleanup();
});

test('setOverride and pending swaps are persisted', () => {
  const { service, cleanup } = createService();
  const u1 = service.addMember({ slackUserId: 'U1', displayName: 'One' });
  const u2 = service.addMember({ slackUserId: 'U2', displayName: 'Two' });

  service.setOverride({ weekStart: '2026-02-16', memberId: u2.id, createdBy: 'U1', type: 'swap' });
  const assigned = service.getFinalAssignmentForWeek('2026-02-16');
  assert.equal(assigned.slack_user_id, 'U2');

  const pendingId = service.createPendingSwap({
    weekStart: '2026-02-23',
    requesterUserId: 'U1',
    targetUserId: 'U2',
  });
  const pending = service.getPendingSwap({
    weekStart: '2026-02-23',
    requesterUserId: 'U1',
    targetUserId: 'U2',
  });
  assert.equal(pending.id, pendingId);

  service.resolvePendingSwap(pendingId, 'accepted');
  const resolved = service.getPendingSwap({
    weekStart: '2026-02-23',
    requesterUserId: 'U1',
    targetUserId: 'U2',
  });
  assert.equal(resolved, undefined);
  assert.ok(u1);

  cleanup();
});

test('single-member team always gets assigned', () => {
  const { service, cleanup } = createService();
  service.addMember({ slackUserId: 'USOLO', displayName: 'Solo' });

  const schedule = service.getUpcomingSchedule('2026-02-16', 3);
  assert.deepEqual(
    schedule.map((entry) => entry.member?.slack_user_id),
    ['USOLO', 'USOLO', 'USOLO']
  );

  cleanup();
});

test('all skipped in a week returns no assignment', () => {
  const { service, cleanup } = createService();
  const u1 = service.addMember({ slackUserId: 'U1', displayName: 'One' });
  const u2 = service.addMember({ slackUserId: 'U2', displayName: 'Two' });

  service.setSkip({ weekStart: '2026-02-16', memberId: u1.id, createdBy: 'U1' });
  const fallback = service.setSkip({ weekStart: '2026-02-16', memberId: u2.id, createdBy: 'U2' });
  assert.equal(fallback, null);
  assert.equal(service.getFinalAssignmentForWeek('2026-02-16'), null);

  cleanup();
});

test('new member is appended at back of queue', () => {
  const { service, cleanup } = createService();
  service.addMember({ slackUserId: 'U1', displayName: 'One' });
  service.addMember({ slackUserId: 'U2', displayName: 'Two' });
  service.addMember({ slackUserId: 'U3', displayName: 'Three' });

  const members = service.listMembers();
  assert.deepEqual(members.map((m) => m.slack_user_id), ['U1', 'U2', 'U3']);
  assert.deepEqual(members.map((m) => m.queue_position), [1, 2, 3]);

  cleanup();
});

test('removeMember returns false when member is absent', () => {
  const { service, cleanup } = createService();
  service.addMember({ slackUserId: 'U1', displayName: 'One' });
  const result = service.removeMember('UNOTFOUND');
  assert.deepEqual(result, { removed: false });
  cleanup();
});

test('bootstrapConfig does not overwrite existing values', () => {
  const { service, cleanup } = createService();
  service.setConfig('reminder_day', 'Friday');
  service.bootstrapConfig({ reminder_day: 'Monday', reminder_time: '09:00' });
  const config = service.getConfig();

  assert.equal(config.reminder_day, 'Friday');
  assert.equal(config.reminder_time, '09:00');
  cleanup();
});

test('bootstrapAdmins marks matching active users as admin', () => {
  const { service, cleanup } = createService();
  service.addMember({ slackUserId: 'U1', displayName: 'One' });
  service.addMember({ slackUserId: 'U2', displayName: 'Two' });
  service.bootstrapAdmins(['U2']);

  assert.equal(service.isAdmin('U1'), false);
  assert.equal(service.isAdmin('U2'), true);
  cleanup();
});

test('explicit override selection wins over auto history', () => {
  const { service, cleanup } = createService();
  const u1 = service.addMember({ slackUserId: 'U1', displayName: 'One' });
  const u2 = service.addMember({ slackUserId: 'U2', displayName: 'Two' });

  service.getFinalAssignmentForWeek('2026-02-16');
  service.setOverride({ weekStart: '2026-02-16', memberId: u2.id, createdBy: 'U1' });

  const final = service.getFinalAssignmentForWeek('2026-02-16');
  assert.equal(final.slack_user_id, 'U2');
  assert.ok(u1);
  cleanup();
});

test('no back-to-back assignment when previous week has explicit override', () => {
  const { service, cleanup } = createService();
  const u1 = service.addMember({ slackUserId: 'U1', displayName: 'One' });
  const u2 = service.addMember({ slackUserId: 'U2', displayName: 'Two' });

  service.setOverride({ weekStart: '2026-02-16', memberId: u1.id, createdBy: 'U1' });
  const next = service.getFinalAssignmentForWeek('2026-02-23');
  assert.equal(next.slack_user_id, 'U2');
  assert.ok(u2);
  cleanup();
});

test('getAdmins returns only active admins', () => {
  const { service, cleanup } = createService();
  service.addMember({ slackUserId: 'U1', displayName: 'One', isAdmin: true });
  service.addMember({ slackUserId: 'U2', displayName: 'Two', isAdmin: true });
  service.removeMember('U2');

  const admins = service.getAdmins();
  assert.deepEqual(admins.map((a) => a.slack_user_id), ['U1']);

  cleanup();
});
