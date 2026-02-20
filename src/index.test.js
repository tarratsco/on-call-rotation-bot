const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntime } = require('./index');
const { weekStartISO, addWeeks } = require('./dateUtils');

function createRuntimeHarness(overrides = {}) {
  const scheduleCalls = [];
  const handlerCalls = [];
  const appStartCalls = [];
  const postedMessages = [];
  const loggerCalls = { log: [], info: [], warn: [], error: [] };

  class FakeApp {
    constructor(options) {
      this.options = options;
      this.client = {
        chat: {
          postMessage: async (payload) => {
            postedMessages.push(payload);
          },
        },
      };
    }

    error(handler) {
      this.errorHandler = handler;
    }

    async start(port) {
      appStartCalls.push(port);
    }
  }

  class FakeRotationService {
    constructor(db, { initialAdminIds }) {
      this.db = db;
      this.initialAdminIds = initialAdminIds;
      this.config = {
        reminder_channel: '',
        reminder_day: 'Monday',
        reminder_time: '09:00',
        reminder_timezone: 'UTC',
      };
      this.assignments = new Map();
      this.admins = [];
    }

    bootstrapConfig(defaults) {
      this.config = { ...this.config, ...defaults };
    }

    bootstrapAdmins(adminIds) {
      this.bootstrappedAdmins = adminIds;
    }

    getConfig() {
      return this.config;
    }

    getFinalAssignmentForWeek(weekStart) {
      return this.assignments.get(weekStart) ?? null;
    }

    getAdmins() {
      return this.admins;
    }
  }

  const fakeDb = {
    historyByWeek: new Map(),
    prepare(sql) {
      return {
        get: (weekStart) => {
          if (!sql.includes('rotation_history')) {
            return undefined;
          }
          return this.historyByWeek.get(weekStart);
        },
      };
    },
  };

  const logger = {
    log: (...args) => loggerCalls.log.push(args),
    info: (...args) => loggerCalls.info.push(args),
    warn: (...args) => loggerCalls.warn.push(args),
    error: (...args) => loggerCalls.error.push(args),
  };

  const runtime = createRuntime({
    env: {
      PORT: '3333',
      INITIAL_ADMIN_IDS: 'U1,U2',
      REMINDER_DAY: 'Tuesday',
      REMINDER_TIME: '08:30',
      REMINDER_TIMEZONE: 'UTC',
      DB_PATH: ':memory:',
      ...overrides.env,
    },
    logger,
    dependencies: {
      initDbFn: () => fakeDb,
      RotationServiceClass: FakeRotationService,
      AppClass: FakeApp,
      createHandlersFn: (args) => handlerCalls.push(args),
      cronLib: {
        schedule: (cronExpr, task, options) => {
          scheduleCalls.push({ cronExpr, task, options });
        },
      },
      ...(overrides.dependencies || {}),
    },
  });

  return {
    runtime,
    scheduleCalls,
    handlerCalls,
    appStartCalls,
    postedMessages,
    loggerCalls,
    fakeDb,
  };
}

test('createRuntime wires services, handlers, and scheduler', () => {
  const { runtime, scheduleCalls, handlerCalls, appStartCalls } = createRuntimeHarness();

  assert.equal(typeof runtime.start, 'function');
  assert.equal(handlerCalls.length, 1);
  assert.equal(scheduleCalls.length, 0);

  return runtime.start().then(() => {
    assert.deepEqual(appStartCalls, [3333]);
    assert.equal(scheduleCalls.length, 1);
    assert.equal(scheduleCalls[0].cronExpr, '30 08 * * 2');
    assert.equal(scheduleCalls[0].options.timezone, 'UTC');
  });
});

test('postWeeklyReminder warns and skips when reminder channel is missing', async () => {
  const { runtime, loggerCalls, postedMessages } = createRuntimeHarness();
  await runtime.postWeeklyReminder();

  assert.equal(postedMessages.length, 0);
  assert.equal(loggerCalls.warn.length, 1);
  assert.match(String(loggerCalls.warn[0][0]), /Reminder channel is not configured/);
});

test('postWeeklyReminder posts warning and DM admins when no assignee available', async () => {
  const { runtime, postedMessages } = createRuntimeHarness({
    env: { REMINDER_CHANNEL_ID: 'CMAIN' },
  });

  runtime.rotationService.admins = [{ slack_user_id: 'UADMIN1' }, { slack_user_id: 'UADMIN2' }];
  await runtime.postWeeklyReminder();

  assert.equal(postedMessages.length, 3);
  assert.equal(postedMessages[0].channel, 'CMAIN');
  assert.match(postedMessages[0].text, /could not assign anyone/);
  assert.deepEqual(
    postedMessages.slice(1).map((m) => m.channel).sort(),
    ['UADMIN1', 'UADMIN2']
  );
});

test('postWeeklyReminder posts standard rotation update', async () => {
  const { runtime, postedMessages } = createRuntimeHarness({
    env: { REMINDER_CHANNEL_ID: 'CMAIN' },
  });

  const thisWeek = weekStartISO(new Date());
  const nextWeek = addWeeks(thisWeek, 1);

  runtime.rotationService.assignments.set(thisWeek, { slack_user_id: 'U1' });
  runtime.rotationService.assignments.set(nextWeek, { slack_user_id: 'U2' });

  await runtime.postWeeklyReminder();

  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].channel, 'CMAIN');
  assert.match(postedMessages[0].text, /This week .*<@U1>/);
  assert.match(postedMessages[0].text, /Next week .*<@U2>/);
});

test('sendMissedReminderIfNeeded posts only when recent history exists', async () => {
  const { runtime, fakeDb, postedMessages } = createRuntimeHarness({
    env: { REMINDER_CHANNEL_ID: 'CMAIN' },
  });

  const thisWeek = weekStartISO(new Date());
  const nextWeek = addWeeks(thisWeek, 1);

  runtime.rotationService.assignments.set(thisWeek, { slack_user_id: 'U1' });
  runtime.rotationService.assignments.set(nextWeek, { slack_user_id: 'U2' });
  fakeDb.historyByWeek.set(thisWeek, { id: 'H1' });

  const realNow = Date.now;
  Date.now = () => new Date(`${thisWeek}T10:00:00Z`).getTime();
  try {
    await runtime.sendMissedReminderIfNeeded();
    assert.equal(postedMessages.length, 1);
  } finally {
    Date.now = realNow;
  }
});

test('sendMissedReminderIfNeeded does nothing without history or assignment', async () => {
  const { runtime, postedMessages } = createRuntimeHarness({
    env: { REMINDER_CHANNEL_ID: 'CMAIN' },
  });

  await runtime.sendMissedReminderIfNeeded();
  assert.equal(postedMessages.length, 0);
});
