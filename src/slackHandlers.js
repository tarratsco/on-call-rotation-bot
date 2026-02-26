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

function resolveChannelId(text, command) {
  const fromToken = parseChannelId(text);
  if (fromToken) {
    return fromToken;
  }

  const raw = (text || '').trim();
  const nameMatch = /^#([a-z0-9._-]+)$/i.exec(raw);
  if (!nameMatch) {
    return null;
  }

  const requestedName = nameMatch[1].toLowerCase();
  const currentName = (command.channel_name || '').trim().toLowerCase();
  if (requestedName && currentName && requestedName === currentName) {
    return command.channel_id;
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

function formatCommandEcho(command) {
  const cmd = command?.command || '';
  const args = (command?.text || '').trim();
  return args ? `*Command:* \`${cmd} ${args}\`` : `*Command:* \`${cmd}\``;
}

async function sendEphemeral({ respond, client, command, logger, text }) {
  const fullText = `${formatCommandEcho(command)}\n\n${text}`;
  const payload = { response_type: 'ephemeral', text: fullText };

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
      text: fullText,
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

  async function showAdminConfigSummary({ respond, client, command }) {
    const config = rotationService.getConfig();
    const configText = Object.entries(config)
      .map(([key, value]) => {
        if (key === 'reminder_channel' && value) {
          return `${key}: <#${value}>`;
        }
        return `${key}: ${value}`;
      })
      .join('\n') || 'No config set.';

    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: [
        '*Current config*',
        configText,
        '',
        '*Admin commands*',
        '- `/oncall-set channel #channel`',
        '- `/oncall-set schedule Monday 09:00 America/New_York`',
        '- `/oncall-set rotation @user1 @user2 ... [apply-now]`',
        '- `/oncall-reset schedule`',
        '- `/oncall-reset queue`',
        '- `/oncall-reset all confirm`',
      ].join('\n'),
    });
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
        '`/oncall-add @user [@user2 ...]` — add participant(s) (admin)',
        '`/oncall-remove @user` — remove participant (admin)',
        '`/oncall-list` — list participants in queue order',
        '`/oncall-override @user [week]` — force assign (admin)',
        '`/oncall-admin help` — show admin config/reset help (admin)',
        '`/oncall-set channel|schedule|rotation ...` — set config/rotation (admin)',
        '`/oncall-reset schedule|queue|all confirm` — reset state (admin)',
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
    if (userIds.length < 1) {
      await sendEphemeral({ respond, client, command, logger, text: 'Usage: /oncall-add @user [@user2 ...]' });
      return;
    }

    for (const userId of userIds) {
      const displayName = await resolveUserDisplayName(userId);
      rotationService.addMember({ slackUserId: userId, displayName });
    }

    const addedMentions = userIds.map((userId) => mention(userId));
    if (addedMentions.length === 1) {
      await sendEphemeral({ respond, client, command, logger, text: `Added ${addedMentions[0]} to the rotation.` });
      return;
    }

    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: `Added ${addedMentions.length} users to the rotation: ${addedMentions.join(', ')}.`,
    });
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


  app.command('/oncall-admin', async ({ ack, command, respond, client }) => {
    await ack();
    if (!(await requireAdmin({ userId: command.user_id, respond, client, command }))) {
      return;
    }

    const text = (command.text || '').trim();
    if (!text || /^help$/i.test(text)) {
      await showAdminConfigSummary({ respond, client, command });
      return;
    }

    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: 'Usage: /oncall-admin help',
    });
  });

  app.command('/oncall-set', async ({ ack, command, respond, client }) => {
    await ack();
    if (!(await requireAdmin({ userId: command.user_id, respond, client, command }))) {
      return;
    }

    const text = (command.text || '').trim();
    if (!text) {
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: 'Usage: /oncall-set channel #channel OR /oncall-set schedule Monday 09:00 America/New_York OR /oncall-set rotation @user1 @user2 ... [apply-now]',
      });
      return;
    }

    if (text.startsWith('rotation ')) {
      let raw = text.replace(/^rotation\s+/i, '').trim();
      const applyNow = /\s+apply-now$/i.test(raw);
      if (applyNow) {
        raw = raw.replace(/\s+apply-now$/i, '').trim();
      }

      const userIds = await parseSlackUserIds(raw, client);
      if (!userIds.length) {
        await sendEphemeral({ respond, client, command, logger, text: 'Usage: /oncall-set rotation @user1 @user2 ... [apply-now] (include each active participant exactly once)' });
        return;
      }

      const result = rotationService.setQueueOrderBySlackIds(userIds);
      if (!result.updated) {
        await sendEphemeral({ respond, client, command, logger, text: result.error || 'Could not update rotation order.' });
        return;
      }

      if (applyNow) {
        rotationService.clearScheduleState();
      }

      const lines = result.members.map((member, index) => `${index + 1}. ${formatMember(member)}`);
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: applyNow
          ? `Rotation order updated and applied now (future schedule state cleared):\n${lines.join('\n')}`
          : `Rotation order updated:\n${lines.join('\n')}\n\nTo apply this order to upcoming generated weeks immediately, run \`/oncall-set rotation @user1 @user2 ... apply-now\` or \`/oncall-reset schedule\`.`,
      });
      return;
    }

    if (text.startsWith('channel ')) {
      const raw = text.replace(/^channel\s+/i, '').trim();
      const channelId = resolveChannelId(raw, command);
      if (!channelId) {
        await sendEphemeral({
          respond,
          client,
          command,
          logger,
          text: 'Usage: /oncall-set channel #channel or CHANNEL_ID. For #channel-name input, run the command inside that channel.',
        });
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
      text: 'Usage: /oncall-set channel #channel OR /oncall-set schedule Monday 09:00 America/New_York OR /oncall-set rotation @user1 @user2 ... [apply-now]',
    });
  });

  app.command('/oncall-reset', async ({ ack, command, respond, client }) => {
    await ack();
    if (!(await requireAdmin({ userId: command.user_id, respond, client, command }))) {
      return;
    }

    const text = (command.text || '').trim().toLowerCase();
    if (!text) {
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: 'Usage: /oncall-reset schedule OR /oncall-reset queue OR /oncall-reset all confirm',
      });
      return;
    }

    if (text === 'schedule') {
      rotationService.clearScheduleState();
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: 'Schedule state cleared. Active participants were kept. Cleared rotation history, overrides, pending swaps, and pending approvals.',
      });
      return;
    }

    if (text === 'queue') {
      const result = rotationService.clearQueueKeepUsers();
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: `Queue reset complete. Kept ${result.activeMembers} active participant(s), reset queue order, and cleared rotation history/overrides/pending swaps/approvals.`,
      });
      return;
    }

    if (text === 'all') {
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: 'This is destructive. Confirm with: /oncall-reset all confirm',
      });
      return;
    }

    if (text === 'all confirm') {
      const result = rotationService.clearAllData();
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: `Full reset complete. Deactivated ${result.deactivatedMembers} active participant(s) and cleared rotation history/overrides/pending swaps/approvals.`,
      });
      return;
    }

    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: 'Usage: /oncall-reset schedule OR /oncall-reset queue OR /oncall-reset all confirm',
    });
  });
}

module.exports = {
  createHandlers,
};
