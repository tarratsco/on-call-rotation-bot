const { addWeeks, normalizeWeekInput, weekStartISO } = require('./dateUtils');

function normalizeHandle(value) {
  return (value || '').trim().toLowerCase();
}

async function buildSlackHandleMap(client) {
  const handleToId = new Map();
  let cursor;

  do {
    const response = await client.users.list({ cursor, limit: 200 });
    for (const user of response.members || []) {
      if (!user?.id || user.deleted || user.is_bot) {
        continue;
      }

      const candidates = [
        user.name,
        user.profile?.display_name,
        user.profile?.display_name_normalized,
        user.profile?.real_name,
        user.profile?.real_name_normalized,
      ]
        .map(normalizeHandle)
        .filter(Boolean);

      for (const candidate of candidates) {
        if (!handleToId.has(candidate)) {
          handleToId.set(candidate, user.id);
        }
      }
    }

    cursor = response.response_metadata?.next_cursor;
  } while (cursor);

  return handleToId;
}

async function parseSlackUserIds(text, client) {
  const fromMentions = [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)].map((m) => m[1]);
  const fromRawIds = [...text.matchAll(/\b(U[A-Z0-9]{8,})\b/g)].map((m) => m[1]);
  const fromHandles = [...text.matchAll(/(?:^|\s)@([a-z0-9._-]+)/gi)].map((m) => normalizeHandle(m[1]));

  if (!fromHandles.length) {
    return [...new Set([...fromMentions, ...fromRawIds])];
  }

  const handleMap = await buildSlackHandleMap(client);
  const resolvedHandles = fromHandles.map((handle) => handleMap.get(handle)).filter(Boolean);
  return [...new Set([...fromMentions, ...fromRawIds, ...resolvedHandles])];
}

function hasUserToken(text) {
  const value = text || '';
  return /<@[A-Z0-9]+(?:\|[^>]+)?>/.test(value) || /(?:^|\s)@[a-z0-9._-]+/i.test(value) || /\bU[A-Z0-9]{8,}\b/.test(value);
}

function parseChannelId(text) {
  const match = /<#([A-Z0-9]+)(?:\|[^>]+)?>/.exec(text);
  if (match) {
    return match[1];
  }
  if (/^[A-Z0-9]+$/.test(text.trim())) {
    return text.trim();
  }
  return null;
}

function mention(userId) {
  return `<@${userId}>`;
}

function stripUserTokens(text) {
  return (text || '')
    .replace(/<@[^>]+>/g, ' ')
    .replace(/(?:^|\s)@[a-z0-9._-]+/gi, ' ')
    .replace(/\bU[A-Z0-9]{8,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatMember(member) {
  if (!member) {
    return '_unassigned_';
  }

  const displayName = (member.display_name || member.slack_user_id || '').trim();
  if (!displayName || displayName.toLowerCase() === member.slack_user_id.toLowerCase()) {
    return mention(member.slack_user_id);
  }

  return `${mention(member.slack_user_id)} (${displayName})`;
}

async function sendEphemeral({ respond, client, command, logger, text }) {
  const payload = { response_type: 'ephemeral', text };

  try {
    await respond(payload);
    return;
  } catch (error) {
    logger.warn(`respond() failed for ${command.command}: ${error.message}`);
  }

  try {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text,
    });
  } catch (error) {
    logger.error(`Fallback ephemeral message failed for ${command.command}: ${error.message}`);
  }
}

function formatSchedule(schedule) {
  return schedule
    .map((entry) => `${entry.weekStart}: ${formatMember(entry.member)}`)
    .join('\n');
}

function createHandlers({ app, rotationService, logger }) {
  function isApprovalSatisfied(approval) {
    return Boolean(approval && approval.user_approved_by && approval.admin_approved_by);
  }

  async function requestBackToBackApproval({ weekStart, target, createdBy, overrideType, respond, client, command, autoApproveUserId }) {
    const approval = rotationService.createBackToBackApproval({
      weekStart,
      memberId: target.id,
      memberSlackUserId: target.slack_user_id,
      overrideType,
      requestedBy: createdBy,
    });

    let currentApproval = approval;
    if (autoApproveUserId && autoApproveUserId === target.slack_user_id) {
      currentApproval = rotationService.approveBackToBack({
        id: approval.id,
        approverUserId: autoApproveUserId,
        isAdmin: rotationService.isAdmin(autoApproveUserId),
        isTargetUser: true,
      });
    }

    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: `Back-to-back on-call detected for ${mention(target.slack_user_id)} on ${weekStart}. Approval request created: \`${currentApproval.id}\`. Required: target user + admin approval via \`/oncall-override approve ${currentApproval.id}\` (or reject).`,
    });

    try {
      await client.chat.postMessage({
        channel: target.slack_user_id,
        text: `Approval needed: back-to-back on-call for week ${weekStart}. Reply with \`/oncall-override approve ${currentApproval.id}\` or \`/oncall-override reject ${currentApproval.id}\`.`,
      });
    } catch (error) {
      logger.warn(`Could not notify target user ${target.slack_user_id} for approval ${currentApproval.id}: ${error.message}`);
    }

    const admins = rotationService.getAdmins().filter((admin) => admin.slack_user_id !== target.slack_user_id);
    for (const admin of admins) {
      try {
        await client.chat.postMessage({
          channel: admin.slack_user_id,
          text: `Admin approval needed for back-to-back on-call (${weekStart}) for ${mention(target.slack_user_id)}. Approve with \`/oncall-override approve ${currentApproval.id}\` or reject with \`/oncall-override reject ${currentApproval.id}\`.`,
        });
      } catch (error) {
        logger.warn(`Could not notify admin ${admin.slack_user_id} for approval ${currentApproval.id}: ${error.message}`);
      }
    }

    return currentApproval;
  }

  async function applyOverrideWithBackToBackGuard({ weekStart, target, createdBy, overrideType, respond, client, command, successText, autoApproveUserId }) {
    const wouldCauseBackToBack = rotationService.wouldCauseBackToBack({ weekStart, memberId: target.id });
    if (!wouldCauseBackToBack) {
      rotationService.setOverride({ weekStart, memberId: target.id, createdBy, type: overrideType });
      await sendEphemeral({ respond, client, command, logger, text: successText });
      return { applied: true };
    }

    const approval = await requestBackToBackApproval({
      weekStart,
      target,
      createdBy,
      overrideType,
      respond,
      client,
      command,
      autoApproveUserId,
    });

    return { applied: false, approval };
  }

  async function resolveUserDisplayName(userId) {
    try {
      const userInfo = await app.client.users.info({ user: userId });
      return userInfo.user?.profile?.display_name || userInfo.user?.real_name || userId;
    } catch (error) {
      logger.warn(`Could not resolve user ${userId}: ${error.message}`);
      return userId;
    }
  }

  async function requireAdmin({ userId, respond, client, command }) {
    if (rotationService.isAdmin(userId)) {
      return true;
    }
    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: 'Admin access required.',
    });
    return false;
  }

  app.command('/oncall-help', async ({ ack, command, respond, client }) => {
    await ack();
    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: [
        '*On-call bot commands*',
        '`/oncall` — show this week on-call',
        '`/oncall-schedule [weeks]` — show upcoming schedule',
        '`/oncall-add @user` — add participant (admin)',
        '`/oncall-remove @user` — remove participant (admin)',
        '`/oncall-list` — list participants in queue order',
        '`/oncall-swap @user1 @user2 [week]` — admin swap/assign',
        '`/oncall-swap @user [week]` — request swap (target confirms via /oncall-swap accept ...)',
        '`/oncall-swap accept @user [week]` — accept a swap request',
        '`/oncall-skip [week]` or `/oncall-skip @user [week]` — mark unavailable',
        '`/oncall-override @user [week]` — force assign (admin)',
        '`/oncall-config ...` — view/update config (admin)',
      ].join('\n'),
    });
  });

  app.command('/oncall', async ({ ack, command, respond, client }) => {
    await ack();
    const thisWeek = weekStartISO(new Date());
    const nextWeek = addWeeks(thisWeek, 1);
    const thisAssignee = rotationService.getFinalAssignmentForWeek(thisWeek);
    const nextAssignee = rotationService.getFinalAssignmentForWeek(nextWeek);

    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: `:rotating_light: This week (${thisWeek}): ${formatMember(thisAssignee)}\nNext week (${nextWeek}): ${formatMember(nextAssignee)}`,
    });
  });

  app.command('/oncall-schedule', async ({ ack, command, respond, client }) => {
    await ack();
    const weeks = Number.parseInt(command.text?.trim() || '6', 10);
    const count = Number.isNaN(weeks) ? 6 : Math.min(Math.max(weeks, 1), 12);
    const start = weekStartISO(new Date());
    const schedule = rotationService.getUpcomingSchedule(start, count);
    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: `*Upcoming on-call (${count} weeks):*\n${formatSchedule(schedule)}`,
    });
  });

  app.command('/oncall-list', async ({ ack, command, respond, client }) => {
    await ack();
    const members = rotationService.listMembers();
    if (!members.length) {
      await sendEphemeral({ respond, client, command, logger, text: 'No active participants yet.' });
      return;
    }

    const lines = members.map((member, index) => `${index + 1}. ${formatMember(member)}${member.is_admin ? ' (admin)' : ''}`);
    await sendEphemeral({ respond, client, command, logger, text: lines.join('\n') });
  });

  app.command('/oncall-add', async ({ ack, command, respond, client }) => {
    await ack();
    if (!(await requireAdmin({ userId: command.user_id, respond, client, command }))) {
      return;
    }

    const userIds = await parseSlackUserIds(command.text || '', client);
    if (userIds.length !== 1) {
      await sendEphemeral({ respond, client, command, logger, text: 'Usage: /oncall-add @user' });
      return;
    }

    const userId = userIds[0];
    const displayName = await resolveUserDisplayName(userId);
    rotationService.addMember({ slackUserId: userId, displayName });
    await sendEphemeral({ respond, client, command, logger, text: `Added ${mention(userId)} to the rotation.` });
  });

  app.command('/oncall-remove', async ({ ack, command, respond, client }) => {
    await ack();
    if (!(await requireAdmin({ userId: command.user_id, respond, client, command }))) {
      return;
    }

    const userIds = await parseSlackUserIds(command.text || '', client);
    if (userIds.length !== 1) {
      await sendEphemeral({ respond, client, command, logger, text: 'Usage: /oncall-remove @user' });
      return;
    }

    const result = rotationService.removeMember(userIds[0]);
    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: result.removed ? `Removed ${mention(userIds[0])} from rotation.` : 'User is not an active participant.',
    });
  });

  app.command('/oncall-override', async ({ ack, command, respond, client }) => {
    await ack();
    const text = (command.text || '').trim();

    const approvalAction = /^(approve|reject)\s+([a-f0-9-]{8,})$/i.exec(text);
    if (approvalAction) {
      const [, action, approvalId] = approvalAction;
      const approval = rotationService.getBackToBackApproval(approvalId);
      if (!approval || approval.status !== 'pending') {
        await sendEphemeral({ respond, client, command, logger, text: 'No pending approval found with that ID.' });
        return;
      }

      const isTargetUser = approval.member_slack_user_id === command.user_id;
      const isAdmin = rotationService.isAdmin(command.user_id);
      if (!isTargetUser && !isAdmin) {
        await sendEphemeral({ respond, client, command, logger, text: 'Only the target user or an admin can approve/reject this request.' });
        return;
      }

      if (action.toLowerCase() === 'reject') {
        rotationService.rejectBackToBack({ id: approvalId, rejectedBy: command.user_id });
        await sendEphemeral({ respond, client, command, logger, text: `Approval request ${approvalId} rejected.` });
        return;
      }

      const updated = rotationService.approveBackToBack({
        id: approvalId,
        approverUserId: command.user_id,
        isAdmin,
        isTargetUser,
      });

      if (!isApprovalSatisfied(updated)) {
        const waiting = [];
        if (!updated.user_approved_by) {
          waiting.push('target user');
        }
        if (!updated.admin_approved_by) {
          waiting.push('admin');
        }
        await sendEphemeral({
          respond,
          client,
          command,
          logger,
          text: `Approval recorded for ${approvalId}. Still waiting on: ${waiting.join(' + ')}.`,
        });
        return;
      }

      rotationService.setOverride({
        weekStart: updated.week_start,
        memberId: updated.member_id,
        createdBy: updated.requested_by,
        type: updated.override_type,
      });
      rotationService.markBackToBackApproved(approvalId);
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: `Approval complete. Override applied for ${updated.week_start}: ${mention(updated.member_slack_user_id)}.`,
      });
      return;
    }

    if (!(await requireAdmin({ userId: command.user_id, respond, client, command }))) {
      return;
    }

    const userIds = await parseSlackUserIds(command.text || '', client);
    if (userIds.length < 1) {
      const hasToken = hasUserToken(command.text || '');
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: hasToken
          ? 'Could not resolve that user. Use the exact @handle from Slack autocomplete and try again.'
          : 'Usage: /oncall-override @user [YYYY-MM-DD]',
      });
      return;
    }

    const weekToken = stripUserTokens(command.text || '');
    let weekStart;
    try {
      weekStart = normalizeWeekInput(weekToken || weekStartISO(new Date()));
    } catch (error) {
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: 'Invalid week format. Use YYYY-MM-DD, for example: /oncall-override @user 2026-03-02',
      });
      return;
    }
    const target = rotationService.getMemberBySlackId(userIds[0]);
    if (!target || !target.is_active) {
      await sendEphemeral({ respond, client, command, logger, text: 'Target user is not an active participant.' });
      return;
    }

    await applyOverrideWithBackToBackGuard({
      weekStart,
      target,
      createdBy: command.user_id,
      overrideType: 'override',
      respond,
      client,
      command,
      successText: `Override set for ${weekStart}: ${mention(userIds[0])}.`,
    });
  });

  app.command('/oncall-skip', async ({ ack, command, respond, client }) => {
    await ack();

    const userIds = await parseSlackUserIds(command.text || '', client);
    const isAdmin = rotationService.isAdmin(command.user_id);
    let targetUserId = command.user_id;
    let weekText = command.text || '';

    if (userIds.length >= 1) {
      if (!isAdmin && userIds[0] !== command.user_id) {
        await sendEphemeral({ respond, client, command, logger, text: 'Only admins can skip other users.' });
        return;
      }
      targetUserId = userIds[0];
      weekText = stripUserTokens(weekText);
    }

    const target = rotationService.getMemberBySlackId(targetUserId);
    if (!target || !target.is_active) {
      await sendEphemeral({ respond, client, command, logger, text: 'Target user is not an active participant.' });
      return;
    }

    let weekStart;
    try {
      weekStart = normalizeWeekInput(weekText || weekStartISO(new Date()));
    } catch (error) {
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: 'Invalid week format. Use YYYY-MM-DD, for example: /oncall-skip 2026-03-02',
      });
      return;
    }
    const fallback = rotationService.setSkip({ weekStart, memberId: target.id, createdBy: command.user_id });
    if (!fallback) {
      await sendEphemeral({ respond, client, command, logger, text: `Everyone is unavailable for ${weekStart}. No assignment could be made.` });
      return;
    }

    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: `${mention(targetUserId)} marked unavailable for ${weekStart}. Covering on-call: ${mention(fallback.slack_user_id)}.`,
    });
  });

  app.command('/oncall-swap', async ({ ack, command, respond, client }) => {
    await ack();
    const text = (command.text || '').trim();

    const acceptMatch = /^accept\s+<@([A-Z0-9]+)(?:\|[^>]+)?>\s*(\d{4}-\d{2}-\d{2})?$/i.exec(text);
    if (acceptMatch) {
      const requesterUserId = acceptMatch[1];
      let weekStart;
      try {
        weekStart = normalizeWeekInput(acceptMatch[2] || weekStartISO(new Date()));
      } catch (error) {
        await sendEphemeral({
          respond,
          client,
          command,
          logger,
          text: 'Invalid week format. Use YYYY-MM-DD, for example: /oncall-swap accept @user 2026-03-02',
        });
        return;
      }
      const pending = rotationService.getPendingSwap({ weekStart, requesterUserId, targetUserId: command.user_id });
      if (!pending) {
        await sendEphemeral({ respond, client, command, logger, text: 'No matching pending swap found.' });
        return;
      }

      const requester = rotationService.getMemberBySlackId(requesterUserId);
      const target = rotationService.getMemberBySlackId(command.user_id);
      if (!requester || !target) {
        await sendEphemeral({ respond, client, command, logger, text: 'Both users must be active participants.' });
        return;
      }

      const result = await applyOverrideWithBackToBackGuard({
        weekStart,
        target,
        createdBy: command.user_id,
        overrideType: 'swap',
        respond,
        client,
        command,
        successText: `Swap accepted for ${weekStart}. ${mention(command.user_id)} will cover.`,
        autoApproveUserId: command.user_id,
      });

      if (result.applied) {
        rotationService.resolvePendingSwap(pending.id, 'accepted');
        await client.chat.postMessage({ channel: command.channel_id, text: `Swap confirmed for ${weekStart}: ${mention(requesterUserId)} ↔ ${mention(command.user_id)}.` });
      }
      return;
    }

    const declineMatch = /^decline\s+<@([A-Z0-9]+)(?:\|[^>]+)?>\s*(\d{4}-\d{2}-\d{2})?$/i.exec(text);
    if (declineMatch) {
      const requesterUserId = declineMatch[1];
      let weekStart;
      try {
        weekStart = normalizeWeekInput(declineMatch[2] || weekStartISO(new Date()));
      } catch (error) {
        await sendEphemeral({
          respond,
          client,
          command,
          logger,
          text: 'Invalid week format. Use YYYY-MM-DD, for example: /oncall-swap decline @user 2026-03-02',
        });
        return;
      }
      const pending = rotationService.getPendingSwap({ weekStart, requesterUserId, targetUserId: command.user_id });
      if (!pending) {
        await sendEphemeral({ respond, client, command, logger, text: 'No matching pending swap found.' });
        return;
      }
      rotationService.resolvePendingSwap(pending.id, 'declined');
      await sendEphemeral({ respond, client, command, logger, text: `Swap declined for ${weekStart}.` });
      return;
    }

    const userIds = await parseSlackUserIds(text, client);
    const weekToken = stripUserTokens(text);
    let weekStart;
    try {
      weekStart = normalizeWeekInput(weekToken || weekStartISO(new Date()));
    } catch (error) {
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: 'Invalid week format. Use YYYY-MM-DD, for example: /oncall-swap @user 2026-03-02',
      });
      return;
    }

    if (userIds.length === 2) {
      if (!(await requireAdmin({ userId: command.user_id, respond, client, command }))) {
        return;
      }
      const user1 = rotationService.getMemberBySlackId(userIds[0]);
      const user2 = rotationService.getMemberBySlackId(userIds[1]);
      if (!user1 || !user2 || !user1.is_active || !user2.is_active) {
        await sendEphemeral({ respond, client, command, logger, text: 'Both users must be active participants.' });
        return;
      }
      await applyOverrideWithBackToBackGuard({
        weekStart,
        target: user2,
        createdBy: command.user_id,
        overrideType: 'swap',
        respond,
        client,
        command,
        successText: `Admin swap recorded for ${weekStart}: ${mention(userIds[0])} ↔ ${mention(userIds[1])}.`,
      });
      return;
    }

    if (userIds.length === 1) {
      const currentAssignee = rotationService.getFinalAssignmentForWeek(weekStart);
      if (!currentAssignee || currentAssignee.slack_user_id !== command.user_id) {
        await sendEphemeral({ respond, client, command, logger, text: `You can request a swap only for a week where you are on-call (${weekStart}).` });
        return;
      }

      const target = rotationService.getMemberBySlackId(userIds[0]);
      if (!target || !target.is_active) {
        await sendEphemeral({ respond, client, command, logger, text: 'Target user is not an active participant.' });
        return;
      }

      rotationService.createPendingSwap({ weekStart, requesterUserId: command.user_id, targetUserId: userIds[0] });
      await sendEphemeral({ respond, client, command, logger, text: `Swap request sent to ${mention(userIds[0])} for ${weekStart}.` });
      await client.chat.postMessage({
        channel: userIds[0],
        text: `${mention(command.user_id)} requested a swap for week ${weekStart}. Reply with \`/oncall-swap accept ${mention(command.user_id)} ${weekStart}\` or \`/oncall-swap decline ${mention(command.user_id)} ${weekStart}\` within 24 hours.`,
      });
      return;
    }

    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: 'Usage: /oncall-swap @user OR /oncall-swap @user1 @user2 [YYYY-MM-DD] OR /oncall-swap accept|decline @user [YYYY-MM-DD]',
    });
  });

  app.command('/oncall-config', async ({ ack, command, respond, client }) => {
    await ack();
    if (!(await requireAdmin({ userId: command.user_id, respond, client, command }))) {
      return;
    }

    const text = (command.text || '').trim();
    if (!text) {
      const config = rotationService.getConfig();
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: Object.entries(config).map(([k, v]) => `${k}: ${v}`).join('\n') || 'No config set.',
      });
      return;
    }

    if (text.startsWith('channel ')) {
      const raw = text.replace(/^channel\s+/i, '').trim();
      const channelId = parseChannelId(raw);
      if (!channelId) {
        await sendEphemeral({ respond, client, command, logger, text: 'Usage: /oncall-config channel #channel or CHANNEL_ID' });
        return;
      }
      rotationService.setConfig('reminder_channel', channelId);
      await sendEphemeral({ respond, client, command, logger, text: `Reminder channel set to <#${channelId}>.` });
      return;
    }

    const scheduleMatch = /^schedule\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+([0-2]\d:[0-5]\d)\s+([A-Za-z_\-/]+)$/i.exec(text);
    if (scheduleMatch) {
      const [, day, time, timezone] = scheduleMatch;
      rotationService.setConfig('reminder_day', day);
      rotationService.setConfig('reminder_time', time);
      rotationService.setConfig('reminder_timezone', timezone);
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: `Reminder schedule updated: ${day} ${time} ${timezone}. Restart bot to apply scheduler changes.`,
      });
      return;
    }

    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: 'Usage: /oncall-config channel #channel OR /oncall-config schedule Monday 09:00 America/New_York',
    });
  });
}

module.exports = {
  createHandlers,
};
