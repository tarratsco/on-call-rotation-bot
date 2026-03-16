const { addWeeks, normalizeWeekInput, weekStartISO } = require('./dateUtils');

/** Normalizes a potential Slack handle for case-insensitive matching. */
function normalizeHandle(value) {
  return (value || '').trim().toLowerCase();
}

/**
 * Builds a best-effort map of Slack handles/display names to Slack user IDs.
 * @param {*} client
 * @returns {Promise<Map<string, string>>}
 */
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
        // First-win avoids unstable remaps when duplicate handles exist in workspace.
        if (!handleToId.has(candidate)) {
          handleToId.set(candidate, user.id);
        }
      }
    }

    cursor = response.response_metadata?.next_cursor;
  } while (cursor);

  return handleToId;
}

/**
 * Parses mentions/raw IDs/handles from command text and resolves them to Slack user IDs.
 * @param {string} text
 * @param {*} client
 * @returns {Promise<string[]>}
 */
async function parseSlackUserIds(text, client) {
  const fromMentions = [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)].map((m) => m[1]);
  const fromRawIds = [...text.matchAll(/\b(U[A-Z0-9]{8,})\b/g)].map((m) => m[1]);
  const fromHandles = [...text.matchAll(/(?:^|\s)@([a-z0-9._-]+)/gi)].map((m) => normalizeHandle(m[1]));

  if (!fromHandles.length) {
    // Preserve user-entered order while dropping duplicates.
    return [...new Set([...fromMentions, ...fromRawIds])];
  }

  const handleMap = await buildSlackHandleMap(client);
  // Handle tokens are best-effort because Slack does not guarantee global uniqueness for display names.
  const resolvedHandles = fromHandles.map((handle) => handleMap.get(handle)).filter(Boolean);
  return [...new Set([...fromMentions, ...fromRawIds, ...resolvedHandles])];
}

/** Returns true when command text appears to include a user token. */
function hasUserToken(text) {
  const value = text || '';
  return /<@[A-Z0-9]+(?:\|[^>]+)?>/.test(value) || /(?:^|\s)@[a-z0-9._-]+/i.test(value) || /\bU[A-Z0-9]{8,}\b/.test(value);
}

/** Extracts channel ID from a channel mention token or direct channel ID input. */
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

/**
 * Resolves channel input to channel ID.
 * Supports channel mention tokens, direct IDs, and same-channel `#name` usage.
 */
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
  // Name-only lookups are intentionally limited to current channel to avoid broad channel-search scopes.
  if (requestedName && currentName && requestedName === currentName) {
    return command.channel_id;
  }

  return null;
}

/** Formats a Slack mention token. */
function mention(userId) {
  return `<@${userId}>`;
}

/** Removes any user tokens from command text and returns remaining text. */
function stripUserTokens(text) {
  return (text || '')
    .replace(/<@[^>]+>/g, ' ')
    .replace(/(?:^|\s)@[a-z0-9._-]+/gi, ' ')
    .replace(/\bU[A-Z0-9]{8,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Formats a member row for user-facing output. */
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

/** Formats the command that triggered a response for better traceability. */
function formatCommandEcho(command) {
  const cmd = command?.command || '';
  const args = (command?.text || '').trim();
  return args ? `*Command:* \`${cmd} ${args}\`` : `*Command:* \`${cmd}\``;
}

/**
 * Sends ephemeral response, falling back to `chat.postEphemeral` if `respond()` fails.
 * @param {{ respond: Function, client: *, command: *, logger: *, text: string }} args
 */
async function sendEphemeral({ respond, client, command, logger, text }) {
  const fullText = `${formatCommandEcho(command)}\n\n${text}`;
  const payload = { response_type: 'ephemeral', text: fullText };

  try {
    await respond(payload);
    return;
  } catch (error) {
    // Keep command UX resilient when response_url expires or fails.
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

/** Formats schedule rows for display. */
function formatSchedule(schedule) {
  return schedule
    .map((entry) => `${entry.weekStart}: ${formatMember(entry.member)}`)
    .join('\n');
}

/**
 * Registers all slash-command handlers.
 * @param {{
 *   app: *,
 *   rotationService: *,
 *   logger: *,
 *   onScheduleConfigChanged?: Function
 * }} deps
 */
function createHandlers({ app, rotationService, logger, onScheduleConfigChanged }) {
  function isApprovalSatisfied(approval) {
    return Boolean(approval && approval.user_approved_by && approval.admin_approved_by);
  }

  async function requestBackToBackApproval({ weekStart, target, createdBy, overrideType, respond, client, command, autoApproveUserId }) {
    // Persist request first so every follow-up notification references a stable approval ID.
    const approval = rotationService.createBackToBackApproval({
      weekStart,
      memberId: target.id,
      memberSlackUserId: target.slack_user_id,
      overrideType,
      requestedBy: createdBy,
    });

    let currentApproval = approval;
    if (autoApproveUserId && autoApproveUserId === target.slack_user_id) {
      // If requester is also target user, pre-record user-side approval to reduce friction.
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

    // Exclude target user from admin fan-out to avoid duplicate instructions.
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
      // Fast path: when safe, apply override immediately with no approval ceremony.
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
    // Keep unauthorized attempts visible to the caller while avoiding noisy channel posts.
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
    const membersBySlackId = new Map(rotationService.listMembers().map((member) => [member.slack_user_id, member]));
    const configText = Object.entries(config)
      .map(([key, value]) => {
        if (key === 'reminder_channel' && value) {
          return `${key}: <#${value}>`;
        }

        if (key === 'queue_baseline' && value) {
          let ids = [];
          try {
            // Newer format stores JSON array for explicit ordering.
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) {
              ids = parsed.map((item) => String(item));
            }
          } catch (_error) {
            // Fallback keeps support for legacy comma-separated baseline values.
            ids = String(value)
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean);
          }

          const readable = ids.map((slackUserId) => {
            const member = membersBySlackId.get(slackUserId);
            return member ? formatMember(member) : mention(slackUserId);
          });

          return `${key}: ${readable.join(' -> ') || '_none_'}`;
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
        '- `/oncall-set channel #channel` - set reminder destination channel',
        '- `/oncall-set schedule Monday 09:00 America/New_York` - set reminder day/time/timezone',
        '- `/oncall-set rotation @user1 @user2 ... [apply-now]` - set manual queue order (optional immediate apply)',
        '- `/oncall-reset schedule` - clear schedule state (keep active users)',
        '- `/oncall-reset all confirm` - deactivate all users and clear schedule state',
      ].join('\n'),
    });
  }

  /**
   * Slash command: `/oncall-help`
   * Shows a compact command catalog for end users and admins.
   */
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
        '`/oncall-reset schedule|all confirm` — reset state (admin)',
      ].join('\n'),
    });
  });

  /**
   * Slash command: `/oncall`
   * Returns current and next week assignees using final-assignment resolution.
   */
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

  /**
   * Slash command: `/oncall-schedule [weeks]`
   * Returns a bounded, preview-only schedule projection (default 6, max 12).
   */
  app.command('/oncall-schedule', async ({ ack, command, respond, client }) => {
    await ack();
    const weeks = Number.parseInt(command.text?.trim() || '6', 10);
    const count = Number.isNaN(weeks) ? 6 : Math.min(Math.max(weeks, 1), 12);
    const start = weekStartISO(new Date());
    // Prefer non-mutating preview so viewing schedule does not alter assignment state.
    const schedule = typeof rotationService.getUpcomingSchedulePreview === 'function'
      ? rotationService.getUpcomingSchedulePreview(start, count)
      : rotationService.getUpcomingSchedule(start, count);
    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: `*Upcoming on-call (${count} weeks):*\n${formatSchedule(schedule)}`,
    });
  });

  /**
   * Slash command: `/oncall-list`
   * Lists active participants in current queue order.
   */
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

  /**
   * Slash command: `/oncall-add @user [@user2 ...]`
   * Admin-only participant enrollment (supports multiple users in one call).
   */
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

  /**
   * Slash command: `/oncall-remove @user`
   * Admin-only participant deactivation and queue reindexing trigger.
   */
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

  /**
   * Slash command: `/oncall-override ...`
   * Admin override entrypoint plus approval action handling (`approve|reject <id>`).
   */
  app.command('/oncall-override', async ({ ack, command, respond, client }) => {
    await ack();
    const text = (command.text || '').trim();

    // Approval IDs are UUID-like values issued by this bot for back-to-back guardrails.
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
        // Keep request pending until both roles sign off.
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
      // Anything left after stripping user tokens is interpreted as optional week argument.
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


  /**
   * Slash command: `/oncall-admin help`
   * Admin-only config summary and operational command reference.
   */
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

  /**
   * Slash command: `/oncall-set ...`
   * Admin config updates for channel, schedule, and rotation baseline/order.
   */
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
      // `apply-now` is parsed as a suffix so participant handles can remain positional.
      const applyNow = /\s+apply-now$/i.test(raw);
      if (applyNow) {
        raw = raw.replace(/\s+apply-now$/i, '').trim();
      }

      const userIds = await parseSlackUserIds(raw, client);
      if (!userIds.length) {
        await sendEphemeral({ respond, client, command, logger, text: 'Usage: /oncall-set rotation @user1 @user2 ... [apply-now] (include each active participant exactly once)' });
        return;
      }

      // This write also refreshes the persisted rotation baseline used by reset.
      const result = rotationService.setQueueOrderBySlackIds(userIds);
      if (!result.updated) {
        await sendEphemeral({ respond, client, command, logger, text: result.error || 'Could not update rotation order.' });
        return;
      }

      if (applyNow) {
        // Clearing schedule state forces future generated weeks to honor the new queue immediately.
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

      let scheduleMessage = `Reminder schedule updated: ${day} ${time} ${timezone}.`;
      if (typeof onScheduleConfigChanged === 'function') {
        try {
          // Runtime callback rebinds cron task so change applies without process restart.
          await onScheduleConfigChanged({ day, time, timezone });
          scheduleMessage = `${scheduleMessage} Scheduler reloaded.`;
        } catch (error) {
          logger.error(`Failed to reload scheduler after schedule update: ${error.message}`);
          scheduleMessage = `${scheduleMessage} Failed to reload scheduler automatically. Restart bot to apply scheduler changes.`;
        }
      }

      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: scheduleMessage,
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

  /**
   * Slash command: `/oncall-reset ...`
   * Admin reset entrypoint for schedule-state clear or full destructive reset.
   */
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
        text: 'Usage: /oncall-reset schedule OR /oncall-reset all confirm',
      });
      return;
    }

    if (text === 'schedule') {
      rotationService.clearScheduleState();
      // Backward compatible fallback when running older test stubs or injected services.
      const restore = typeof rotationService.restoreQueueFromBaseline === 'function'
        ? rotationService.restoreQueueFromBaseline()
        : { restored: false, reason: 'unsupported' };

      let details = 'Cleared prior assignment state.';
      if (restore.restored) {
        details = 'Restored queue order from saved rotation baseline and cleared prior assignment state.';
      } else if (restore.reason === 'no-baseline') {
        // First-time setups may not have baseline yet; preserve current order rather than guessing.
        details = 'No saved rotation baseline found; kept current queue order and cleared prior assignment state.';
      } else if (restore.reason === 'baseline-mismatch') {
        // Participant set drift means safe automatic restore is impossible.
        details = 'Saved rotation baseline no longer matches active participants; kept current queue order and cleared prior assignment state.';
      }

      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: `Schedule state cleared. Active participants were kept. ${details}`,
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
      // Explicit two-token confirmation reduces accidental destructive resets.
      const result = rotationService.clearAllData();
      await sendEphemeral({
        respond,
        client,
        command,
        logger,
        text: `Full reset complete. Deactivated ${result.deactivatedMembers} active participant(s) and cleared prior assignment state.`,
      });
      return;
    }

    await sendEphemeral({
      respond,
      client,
      command,
      logger,
      text: 'Usage: /oncall-reset schedule OR /oncall-reset all confirm',
    });
  });
}

module.exports = {
  createHandlers,
};
