require('dotenv').config();

const cron = require('node-cron');
const { App, LogLevel } = require('@slack/bolt');
const { initDb } = require('./db');
const { parseReminderConfig, weekStartISO, addWeeks } = require('./dateUtils');
const { RotationService } = require('./rotationService');
const { createHandlers } = require('./slackHandlers');

/**
 * Creates the bot runtime with optional dependency injection for tests.
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   logger?: Console,
 *   dependencies?: {
 *     initDbFn?: Function,
 *     RotationServiceClass?: Function,
 *     AppClass?: Function,
 *     cronLib?: { schedule: Function },
 *     createHandlersFn?: Function
 *   }
 * }} [options]
 */
function createRuntime(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const deps = options.dependencies || {};
  const initDbFn = deps.initDbFn || initDb;
  const RotationServiceClass = deps.RotationServiceClass || RotationService;
  const AppClass = deps.AppClass || App;
  const cronLib = deps.cronLib || cron;
  const createHandlersFn = deps.createHandlersFn || createHandlers;

  // Keep state durable so assignments and config survive process restarts.
  const db = initDbFn(env.DB_PATH || './data/oncall.sqlite');
  const adminIds = (env.INITIAL_ADMIN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const rotationService = new RotationServiceClass(db, { initialAdminIds: adminIds });

  // Seed defaults only for missing config keys to avoid clobbering admin changes.
  rotationService.bootstrapConfig({
    reminder_channel: env.REMINDER_CHANNEL_ID || '',
    reminder_day: env.REMINDER_DAY || 'Monday',
    reminder_time: env.REMINDER_TIME || '09:00',
    reminder_timezone: env.REMINDER_TIMEZONE || 'America/New_York',
  });

  rotationService.bootstrapAdmins(adminIds);

  const app = new AppClass({
    token: env.SLACK_BOT_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    appToken: env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.INFO,
  });

  app.error(async (error) => {
    logger.error('Bolt app error:', error);
  });

  let scheduledReminderTask = null;

  /** Stops the currently scheduled cron task, if one exists. */
  function stopScheduledReminderTask() {
    if (!scheduledReminderTask) {
      return;
    }

    if (typeof scheduledReminderTask.stop === 'function') {
      scheduledReminderTask.stop();
    }
    if (typeof scheduledReminderTask.destroy === 'function') {
      scheduledReminderTask.destroy();
    }
    scheduledReminderTask = null;
  }

  /** Posts the weekly reminder summary to the configured channel. */
  async function postWeeklyReminder() {
    const config = rotationService.getConfig();
    if (!config.reminder_channel) {
      logger.warn('Reminder channel is not configured. Skipping reminder.');
      return;
    }

    const thisWeek = weekStartISO(new Date());
    const nextWeek = addWeeks(thisWeek, 1);

    // Final-assignment lookups intentionally materialize weeks so reminders and /oncall stay consistent.
    const thisAssignee = rotationService.getFinalAssignmentForWeek(thisWeek);
    const nextAssignee = rotationService.getFinalAssignmentForWeek(nextWeek);

    if (!thisAssignee && !nextAssignee) {
      await app.client.chat.postMessage({
        channel: config.reminder_channel,
        text: ':warning: On-call reminder could not assign anyone this week. Please resolve coverage assignment.',
      });

      const admins = rotationService.getAdmins();
      for (const admin of admins) {
        await app.client.chat.postMessage({
          channel: admin.slack_user_id,
          text: `:warning: No eligible on-call assignee for week ${thisWeek}.`,
        });
      }
      return;
    }

    await app.client.chat.postMessage({
      channel: config.reminder_channel,
      text: [
        ':rotating_light: *On-Call Rotation Update*',
        '',
        `This week (${thisWeek}): ${thisAssignee ? `<@${thisAssignee.slack_user_id}>` : '_unassigned_'}`,
        `Next week (${nextWeek}): ${nextAssignee ? `<@${nextAssignee.slack_user_id}>` : '_unassigned_'}`,
        '',
        'Use /oncall-override (admin) to reassign coverage.',
      ].join('\n'),
    });
  }

  /** Registers (or re-registers) the reminder cron task from config. */
  function scheduleWeeklyReminder() {
    // Rebuild task on every schedule change so cron/timezone updates take effect immediately.
    stopScheduledReminderTask();

    const config = rotationService.getConfig();
    const parsed = parseReminderConfig(config.reminder_day, config.reminder_time);

    scheduledReminderTask = cronLib.schedule(
      parsed.cron,
      async () => {
        try {
          await postWeeklyReminder();
        } catch (error) {
          logger.error('Failed weekly reminder:', error);
        }
      },
      { timezone: config.reminder_timezone || 'America/New_York' }
    );

    logger.info(`Reminder scheduler active: ${parsed.day} ${parsed.time} ${config.reminder_timezone}`);
  }

  createHandlersFn({
    app,
    rotationService,
    logger,
    onScheduleConfigChanged: async () => {
      scheduleWeeklyReminder();
    },
  });

  /**
   * Sends a catch-up reminder shortly after startup when current week already has assignment history.
   */
  async function sendMissedReminderIfNeeded() {
    const config = rotationService.getConfig();
    if (!config.reminder_channel) {
      return;
    }

    const thisWeek = weekStartISO(new Date());
    const alreadyAssigned = rotationService.getFinalAssignmentForWeek(thisWeek);
    if (!alreadyAssigned) {
      return;
    }

    // Require existing history to avoid posting a catch-up reminder for hypothetical/unmaterialized weeks.
    const history = db.prepare('SELECT id FROM rotation_history WHERE week_start = ?').get(thisWeek);
    if (!history) {
      return;
    }

    // Limit catch-up reminders to a short window to avoid stale notifications.
    const thisWeekDate = new Date(`${thisWeek}T00:00:00Z`);
    const ageInHours = (Date.now() - thisWeekDate.getTime()) / (1000 * 60 * 60);
    if (ageInHours > 36) {
      return;
    }

    await postWeeklyReminder();
  }

  /** Starts the Slack app and reminder workflows. */
  async function start() {
    await app.start(Number(env.PORT || 3000));
    logger.log('⚡️ On-call rotation bot is running');
    scheduleWeeklyReminder();
    await sendMissedReminderIfNeeded();
  }

  return {
    app,
    db,
    rotationService,
    postWeeklyReminder,
    scheduleWeeklyReminder,
    sendMissedReminderIfNeeded,
    start,
  };
}

if (require.main === module) {
  createRuntime()
    .start()
    .catch((error) => {
      console.error('Fatal startup error:', error);
      process.exit(1);
    });
}

module.exports = {
  createRuntime,
};
