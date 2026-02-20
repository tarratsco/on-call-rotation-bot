const { v4: uuidv4 } = require('uuid');
const { addWeeks, weekStartISO } = require('./dateUtils');

class RotationService {
  constructor(db, options = {}) {
    this.db = db;
    this.initialAdminIds = new Set(options.initialAdminIds || []);
  }

  bootstrapConfig(defaults) {
    const upsert = this.db.prepare('INSERT INTO bot_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    Object.entries(defaults).forEach(([key, value]) => {
      const row = this.db.prepare('SELECT key FROM bot_config WHERE key = ?').get(key);
      if (!row) {
        upsert.run(key, String(value));
      }
    });
  }

  bootstrapAdmins(adminSlackIds = []) {
    if (!adminSlackIds.length) {
      return;
    }
    const markAdmin = this.db.prepare('UPDATE team_members SET is_admin = 1 WHERE slack_user_id = ?');
    adminSlackIds.forEach((id) => markAdmin.run(id));
  }

  getConfig() {
    const rows = this.db.prepare('SELECT key, value FROM bot_config').all();
    return rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
  }

  setConfig(key, value) {
    this.db.prepare('INSERT INTO bot_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  isAdmin(slackUserId) {
    if (this.initialAdminIds.has(slackUserId)) {
      return true;
    }
    const member = this.db.prepare('SELECT is_admin FROM team_members WHERE slack_user_id = ? AND is_active = 1').get(slackUserId);
    return Boolean(member && member.is_admin);
  }

  getMemberBySlackId(slackUserId) {
    return this.db.prepare('SELECT * FROM team_members WHERE slack_user_id = ?').get(slackUserId);
  }

  addMember({ slackUserId, displayName, isAdmin = false }) {
    const existing = this.getMemberBySlackId(slackUserId);
    const now = new Date().toISOString();
    const shouldBeAdmin = Boolean(isAdmin || this.initialAdminIds.has(slackUserId));

    if (existing) {
      this.db
        .prepare('UPDATE team_members SET display_name = ?, is_active = 1, is_admin = ? WHERE slack_user_id = ?')
        .run(displayName, shouldBeAdmin ? 1 : existing.is_admin, slackUserId);
      return this.getMemberBySlackId(slackUserId);
    }

    const max = this.db.prepare('SELECT COALESCE(MAX(queue_position), 0) AS max_position FROM team_members WHERE is_active = 1').get();
    const queuePosition = max.max_position + 1;

    this.db.prepare('INSERT INTO team_members(id, slack_user_id, display_name, queue_position, is_active, is_admin, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(
      uuidv4(),
      slackUserId,
      displayName,
      queuePosition,
      shouldBeAdmin ? 1 : 0,
      now
    );

    return this.getMemberBySlackId(slackUserId);
  }

  removeMember(slackUserId) {
    const member = this.getMemberBySlackId(slackUserId);
    if (!member || !member.is_active) {
      return { removed: false };
    }

    this.db.prepare('UPDATE team_members SET is_active = 0 WHERE slack_user_id = ?').run(slackUserId);
    this.reindexQueue();

    const currentWeek = weekStartISO(new Date());
    const current = this.getFinalAssignmentForWeek(currentWeek);
    if (current && current.slack_user_id === slackUserId) {
      this.db.prepare('DELETE FROM rotation_history WHERE week_start = ?').run(currentWeek);
      this.ensureAutoAssignment(currentWeek);
    }

    return { removed: true };
  }

  listMembers() {
    return this.db
      .prepare('SELECT * FROM team_members WHERE is_active = 1 ORDER BY queue_position ASC')
      .all();
  }

  reindexQueue() {
    const members = this.listMembers();
    const update = this.db.prepare('UPDATE team_members SET queue_position = ? WHERE id = ?');
    members.forEach((member, index) => {
      update.run(index + 1, member.id);
    });
  }

  moveToBack(memberId) {
    const members = this.listMembers();
    const current = members.find((m) => m.id === memberId);
    if (!current) {
      return;
    }

    const filtered = members.filter((m) => m.id !== memberId);
    filtered.push(current);
    const update = this.db.prepare('UPDATE team_members SET queue_position = ? WHERE id = ?');
    filtered.forEach((member, index) => {
      update.run(index + 1, member.id);
    });
  }

  getOverridesForWeek(weekStart) {
    return this.db.prepare('SELECT * FROM schedule_overrides WHERE week_start = ? ORDER BY created_at DESC').all(weekStart);
  }

  isMemberSkipped(weekStart, memberId) {
    const row = this.db
      .prepare("SELECT id FROM schedule_overrides WHERE week_start = ? AND member_id = ? AND override_type = 'skip' ORDER BY created_at DESC LIMIT 1")
      .get(weekStart, memberId);
    return Boolean(row);
  }

  getExplicitAssignedMemberId(weekStart) {
    const row = this.db
      .prepare("SELECT member_id FROM schedule_overrides WHERE week_start = ? AND override_type IN ('swap', 'override') ORDER BY created_at DESC LIMIT 1")
      .get(weekStart);
    return row ? row.member_id : null;
  }

  getHistory(weekStart) {
    return this.db.prepare('SELECT * FROM rotation_history WHERE week_start = ?').get(weekStart);
  }

  ensureAutoAssignment(weekStart) {
    const existing = this.getHistory(weekStart);
    if (existing) {
      return existing;
    }

    const members = this.listMembers();
    if (!members.length) {
      return null;
    }

    const previousWeek = addWeeks(weekStart, -1);
    const previousExplicitMemberId = this.getExplicitAssignedMemberId(previousWeek);
    const previousHistory = this.getHistory(previousWeek);
    const previousMemberId = previousExplicitMemberId || (previousHistory ? previousHistory.member_id : null);

    let selected = null;
    for (const member of members) {
      const skipped = this.isMemberSkipped(weekStart, member.id);
      if (skipped) {
        continue;
      }
      if (members.length > 1 && previousMemberId && member.id === previousMemberId) {
        continue;
      }
      selected = member;
      break;
    }

    if (!selected) {
      return null;
    }

    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO rotation_history(id, member_id, week_start, assigned_at, source) VALUES (?, ?, ?, ?, ?)')
      .run(uuidv4(), selected.id, weekStart, now, 'auto');

    this.moveToBack(selected.id);
    return this.getHistory(weekStart);
  }

  getFinalAssignmentForWeek(weekStart) {
    this.ensureAutoAssignment(weekStart);
    const explicitMemberId = this.getExplicitAssignedMemberId(weekStart);
    const history = this.getHistory(weekStart);
    const memberId = explicitMemberId || (history && history.member_id);
    if (!memberId) {
      return null;
    }

    return this.db.prepare('SELECT * FROM team_members WHERE id = ?').get(memberId);
  }

  getUpcomingSchedule(startWeek, weeks = 6) {
    const result = [];
    for (let offset = 0; offset < weeks; offset += 1) {
      const weekStart = addWeeks(startWeek, offset);
      const assigned = this.getFinalAssignmentForWeek(weekStart);
      result.push({ weekStart, member: assigned });
    }
    return result;
  }

  setSkip({ weekStart, memberId, createdBy }) {
    this.db
      .prepare('INSERT INTO schedule_overrides(id, week_start, member_id, override_type, created_by, created_at, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), weekStart, memberId, 'skip', createdBy, new Date().toISOString(), null);

    this.db.prepare('DELETE FROM rotation_history WHERE week_start = ?').run(weekStart);
    return this.getFinalAssignmentForWeek(weekStart);
  }

  setOverride({ weekStart, memberId, createdBy, type = 'override' }) {
    this.db
      .prepare('INSERT INTO schedule_overrides(id, week_start, member_id, override_type, created_by, created_at, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), weekStart, memberId, type, createdBy, new Date().toISOString(), null);

    return this.getFinalAssignmentForWeek(weekStart);
  }

  createPendingSwap({ weekStart, requesterUserId, targetUserId }) {
    const now = new Date();
    const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const id = uuidv4();
    this.db
      .prepare('INSERT INTO pending_swaps(id, week_start, requester_user_id, target_user_id, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, weekStart, requesterUserId, targetUserId, 'pending', expires.toISOString(), now.toISOString());
    return id;
  }

  getPendingSwap({ weekStart, requesterUserId, targetUserId }) {
    return this.db
      .prepare(
        "SELECT * FROM pending_swaps WHERE week_start = ? AND requester_user_id = ? AND target_user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
      )
      .get(weekStart, requesterUserId, targetUserId);
  }

  resolvePendingSwap(id, status) {
    this.db.prepare('UPDATE pending_swaps SET status = ? WHERE id = ?').run(status, id);
  }

  getAdmins() {
    return this.db.prepare('SELECT * FROM team_members WHERE is_active = 1 AND is_admin = 1').all();
  }

  wouldCauseBackToBack({ weekStart, memberId }) {
    const previousWeek = addWeeks(weekStart, -1);
    const nextWeek = addWeeks(weekStart, 1);

    const previous = this.getFinalAssignmentForWeek(previousWeek);
    const next = this.getFinalAssignmentForWeek(nextWeek);

    return Boolean((previous && previous.id === memberId) || (next && next.id === memberId));
  }

  createBackToBackApproval({ weekStart, memberId, memberSlackUserId, overrideType, requestedBy }) {
    const existing = this.db
      .prepare("SELECT * FROM pending_back_to_back_approvals WHERE week_start = ? AND member_id = ? AND override_type = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
      .get(weekStart, memberId, overrideType);

    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const id = uuidv4();
    this.db
      .prepare(
        'INSERT INTO pending_back_to_back_approvals(id, week_start, member_id, member_slack_user_id, override_type, requested_by, status, user_approved_by, admin_approved_by, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, weekStart, memberId, memberSlackUserId, overrideType, requestedBy, 'pending', null, null, now, null);

    return this.getBackToBackApproval(id);
  }

  getBackToBackApproval(id) {
    return this.db.prepare('SELECT * FROM pending_back_to_back_approvals WHERE id = ?').get(id);
  }

  approveBackToBack({ id, approverUserId, isAdmin, isTargetUser }) {
    const approval = this.getBackToBackApproval(id);
    if (!approval || approval.status !== 'pending') {
      return approval;
    }

    if (isTargetUser) {
      this.db.prepare('UPDATE pending_back_to_back_approvals SET user_approved_by = ? WHERE id = ?').run(approverUserId, id);
    }
    if (isAdmin) {
      this.db.prepare('UPDATE pending_back_to_back_approvals SET admin_approved_by = ? WHERE id = ?').run(approverUserId, id);
    }

    return this.getBackToBackApproval(id);
  }

  markBackToBackApproved(id) {
    this.db
      .prepare("UPDATE pending_back_to_back_approvals SET status = 'approved', resolved_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  rejectBackToBack({ id, rejectedBy }) {
    this.db
      .prepare("UPDATE pending_back_to_back_approvals SET status = 'rejected', resolved_at = ?, user_approved_by = COALESCE(user_approved_by, ?), admin_approved_by = COALESCE(admin_approved_by, ?) WHERE id = ?")
      .run(new Date().toISOString(), rejectedBy, rejectedBy, id);
    return this.getBackToBackApproval(id);
  }
}

module.exports = {
  RotationService,
};
