const test = require('node:test');
const assert = require('node:assert/strict');

const { createHandlers } = require('./slackHandlers');

function createFakeApp() {
  const handlers = new Map();
  return {
    handlers,
    client: {
      users: {
        list: async () => ({ members: [], response_metadata: { next_cursor: '' } }),
        info: async ({ user }) => ({ user: { profile: { display_name: user }, real_name: user } }),
      },
      chat: {
        postEphemeral: async () => {},
        postMessage: async () => {},
      },
    },
    command(name, handler) {
      handlers.set(name, handler);
    },
  };
}

function createRotationServiceStub(overrides = {}) {
  return {
    isAdmin: () => false,
    addMember: () => {},
    removeMember: () => ({ removed: false }),
    listMembers: () => [],
    getMemberBySlackId: () => null,
    getFinalAssignmentForWeek: () => null,
    getUpcomingSchedule: () => [],
    setSkip: () => null,
    setOverride: () => {},
    createPendingSwap: () => 'pending-id',
    getPendingSwap: () => null,
    resolvePendingSwap: () => {},
    wouldCauseBackToBack: () => false,
    createBackToBackApproval: () => ({
      id: 'APPROVAL-1',
      week_start: '2026-03-02',
      member_id: 'MID1',
      member_slack_user_id: 'U1',
      override_type: 'override',
      requested_by: 'UADMIN',
      status: 'pending',
      user_approved_by: null,
      admin_approved_by: null,
    }),
    getBackToBackApproval: () => null,
    approveBackToBack: () => null,
    markBackToBackApproved: () => {},
    rejectBackToBack: () => null,
    getAdmins: () => [],
    getConfig: () => ({ reminder_channel: '', reminder_day: 'Monday', reminder_time: '09:00', reminder_timezone: 'UTC' }),
    setConfig: () => {},
    ...overrides,
  };
}

async function invoke(app, commandName, { text = '', userId = 'U1', channelId = 'C1', respondImpl, client } = {}) {
  const handler = app.handlers.get(commandName);
  let response;

  await handler({
    ack: async () => {},
    command: { command: commandName, user_id: userId, channel_id: channelId, text },
    respond: respondImpl || (async (payload) => {
      response = payload;
    }),
    client: client || app.client,
  });

  return response;
}

test('/oncall-add resolves plain @handle and adds member', async () => {
  const app = createFakeApp();
  const added = [];
  app.client.users.list = async () => ({
    members: [
      {
        id: 'U123',
        deleted: false,
        is_bot: false,
        name: 'onix.tarratscalderon',
        profile: { display_name: 'onix.tarratscalderon', real_name: 'Onix' },
      },
    ],
    response_metadata: { next_cursor: '' },
  });

  const rotationService = {
    isAdmin: () => true,
    addMember: (member) => added.push(member),
  };

  createHandlers({ app, rotationService, logger: console });

  const handler = app.handlers.get('/oncall-add');
  const responses = [];

  await handler({
    ack: async () => {},
    command: { command: '/oncall-add', user_id: 'UADMIN', channel_id: 'C1', text: '@onix.tarratscalderon' },
    respond: async (payload) => responses.push(payload),
    client: app.client,
  });

  assert.equal(added.length, 1);
  assert.equal(added[0].slackUserId, 'U123');
  assert.match(responses[0].text, /Added <@U123>/);
});

test('/oncall-list returns members in order', async () => {
  const app = createFakeApp();
  const rotationService = {
    listMembers: () => [
      { slack_user_id: 'U1', is_admin: 1 },
      { slack_user_id: 'U2', is_admin: 0 },
    ],
  };

  createHandlers({ app, rotationService, logger: console });
  const handler = app.handlers.get('/oncall-list');

  let response;
  await handler({
    ack: async () => {},
    command: { command: '/oncall-list', user_id: 'U1', channel_id: 'C1', text: '' },
    respond: async (payload) => {
      response = payload;
    },
    client: app.client,
  });

  assert.match(response.text, /1\. <@U1> \(admin\)/);
  assert.match(response.text, /2\. <@U2>/);
});

test('/oncall-list shows readable names for seeded synthetic users', async () => {
  const app = createFakeApp();
  const rotationService = {
    listMembers: () => [
      { slack_user_id: 'UTEST0001', display_name: 'Test User 1', is_admin: 0 },
      { slack_user_id: 'UTEST0002', display_name: 'Test User 2', is_admin: 0 },
    ],
  };

  createHandlers({ app, rotationService, logger: console });
  const response = await invoke(app, '/oncall-list', { userId: 'U1' });

  assert.match(response.text, /Test User 1/);
  assert.match(response.text, /Test User 2/);
});

test('falls back to postEphemeral when respond fails', async () => {
  const app = createFakeApp();
  const calls = [];
  app.client.chat.postEphemeral = async (payload) => {
    calls.push(payload);
  };

  const rotationService = {
    listMembers: () => [],
  };

  createHandlers({ app, rotationService, logger: console });
  const handler = app.handlers.get('/oncall-list');

  await handler({
    ack: async () => {},
    command: { command: '/oncall-list', user_id: 'U1', channel_id: 'C123', text: '' },
    respond: async () => {
      throw new Error('response_url failed');
    },
    client: app.client,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'C123');
  assert.equal(calls[0].user, 'U1');
  assert.match(calls[0].text, /No active participants yet/);
});

test('/oncall-add requires admin access', async () => {
  const app = createFakeApp();
  const rotationService = createRotationServiceStub({ isAdmin: () => false });
  createHandlers({ app, rotationService, logger: console });

  const response = await invoke(app, '/oncall-add', { text: '@user', userId: 'UNONADMIN' });
  assert.match(response.text, /Admin access required/);
});

test('/oncall-add returns usage on unresolved user', async () => {
  const app = createFakeApp();
  const rotationService = createRotationServiceStub({ isAdmin: () => true });
  createHandlers({ app, rotationService, logger: console });

  const response = await invoke(app, '/oncall-add', { text: 'not-a-user', userId: 'UADMIN' });
  assert.match(response.text, /Usage: \/oncall-add @user/);
});

test('/oncall-remove returns not-active response when absent', async () => {
  const app = createFakeApp();
  const rotationService = createRotationServiceStub({
    isAdmin: () => true,
    removeMember: () => ({ removed: false }),
  });
  createHandlers({ app, rotationService, logger: console });

  const response = await invoke(app, '/oncall-remove', { text: '<@U404>', userId: 'UADMIN' });
  assert.match(response.text, /not an active participant/);
});

test('/oncall-schedule clamps invalid week counts', async () => {
  const app = createFakeApp();
  const seen = [];
  const rotationService = createRotationServiceStub({
    getUpcomingSchedule: (_start, count) => {
      seen.push(count);
      return [];
    },
  });
  createHandlers({ app, rotationService, logger: console });

  await invoke(app, '/oncall-schedule', { text: '999' });
  await invoke(app, '/oncall-schedule', { text: '0' });
  assert.deepEqual(seen, [12, 1]);
});

test('/oncall-skip blocks non-admin skipping another user', async () => {
  const app = createFakeApp();
  const rotationService = createRotationServiceStub({
    isAdmin: () => false,
  });
  createHandlers({ app, rotationService, logger: console });

  const response = await invoke(app, '/oncall-skip', {
    text: '<@U2>',
    userId: 'U1',
  });
  assert.match(response.text, /Only admins can skip other users/);
});

test('/oncall-skip reports all unavailable when fallback missing', async () => {
  const app = createFakeApp();
  const rotationService = createRotationServiceStub({
    isAdmin: () => true,
    getMemberBySlackId: () => ({ id: 'MID1', is_active: 1 }),
    setSkip: () => null,
  });
  createHandlers({ app, rotationService, logger: console });

  const response = await invoke(app, '/oncall-skip', {
    text: '<@U2> 2026-02-16',
    userId: 'UADMIN',
  });
  assert.match(response.text, /Everyone is unavailable/);
});

test('/oncall-swap requester must be current assignee', async () => {
  const app = createFakeApp();
  const rotationService = createRotationServiceStub({
    getFinalAssignmentForWeek: () => ({ slack_user_id: 'UOTHER' }),
  });
  createHandlers({ app, rotationService, logger: console });

  const response = await invoke(app, '/oncall-swap', {
    text: '<@UTARGET> 2026-02-16',
    userId: 'U1',
  });
  assert.match(response.text, /request a swap only for a week where you are on-call/);
});

test('/oncall-swap creates pending request and DMs target', async () => {
  const app = createFakeApp();
  const dmCalls = [];
  app.client.chat.postMessage = async (payload) => dmCalls.push(payload);

  const rotationService = createRotationServiceStub({
    getFinalAssignmentForWeek: () => ({ slack_user_id: 'U1' }),
    getMemberBySlackId: () => ({ id: 'MID2', is_active: 1 }),
  });
  createHandlers({ app, rotationService, logger: console });

  const response = await invoke(app, '/oncall-swap', {
    text: '<@UTARGET> 2026-02-16',
    userId: 'U1',
  });

  assert.match(response.text, /Swap request sent/);
  assert.equal(dmCalls.length, 1);
  assert.equal(dmCalls[0].channel, 'UTARGET');
});

test('/oncall-swap accept applies override and announces confirmation', async () => {
  const app = createFakeApp();
  const posts = [];
  app.client.chat.postMessage = async (payload) => posts.push(payload);

  const resolved = [];
  const overridden = [];
  const rotationService = createRotationServiceStub({
    getPendingSwap: () => ({ id: 'P1' }),
    getMemberBySlackId: () => ({ id: 'MID', is_active: 1 }),
    resolvePendingSwap: (id, status) => resolved.push({ id, status }),
    setOverride: (payload) => overridden.push(payload),
  });
  createHandlers({ app, rotationService, logger: console });

  const response = await invoke(app, '/oncall-swap', {
    text: 'accept <@UREQ> 2026-02-16',
    userId: 'UTARGET',
  });

  assert.match(response.text, /Swap accepted/);
  assert.deepEqual(resolved, [{ id: 'P1', status: 'accepted' }]);
  assert.equal(overridden.length, 1);
  assert.equal(posts.length, 1);
});

test('/oncall-swap decline resolves pending request', async () => {
  const app = createFakeApp();
  const resolved = [];
  const rotationService = createRotationServiceStub({
    getPendingSwap: () => ({ id: 'P2' }),
    resolvePendingSwap: (id, status) => resolved.push({ id, status }),
  });
  createHandlers({ app, rotationService, logger: console });

  const response = await invoke(app, '/oncall-swap', {
    text: 'decline <@UREQ> 2026-02-16',
    userId: 'UTARGET',
  });

  assert.match(response.text, /Swap declined/);
  assert.deepEqual(resolved, [{ id: 'P2', status: 'declined' }]);
});

test('/oncall-config requires admin and validates channel input', async () => {
  const app = createFakeApp();
  const setCalls = [];
  const rotationService = createRotationServiceStub({
    isAdmin: () => false,
    setConfig: (key, value) => setCalls.push({ key, value }),
  });
  createHandlers({ app, rotationService, logger: console });

  const denied = await invoke(app, '/oncall-config', { text: 'channel #ops', userId: 'UUSER' });
  assert.match(denied.text, /Admin access required/);

  rotationService.isAdmin = () => true;
  const bad = await invoke(app, '/oncall-config', { text: 'channel invalid-channel', userId: 'UADMIN' });
  assert.match(bad.text, /Usage: \/oncall-config channel/);
  assert.equal(setCalls.length, 0);
});

test('/oncall-config updates channel and schedule values', async () => {
  const app = createFakeApp();
  const setCalls = [];
  const rotationService = createRotationServiceStub({
    isAdmin: () => true,
    setConfig: (key, value) => setCalls.push({ key, value }),
  });
  createHandlers({ app, rotationService, logger: console });

  const channelResponse = await invoke(app, '/oncall-config', {
    text: 'channel <#COPS|ops>',
    userId: 'UADMIN',
  });
  assert.match(channelResponse.text, /Reminder channel set/);

  const scheduleResponse = await invoke(app, '/oncall-config', {
    text: 'schedule Monday 09:00 America/New_York',
    userId: 'UADMIN',
  });
  assert.match(scheduleResponse.text, /Reminder schedule updated/);
  assert.deepEqual(setCalls, [
    { key: 'reminder_channel', value: 'COPS' },
    { key: 'reminder_day', value: 'Monday' },
    { key: 'reminder_time', value: '09:00' },
    { key: 'reminder_timezone', value: 'America/New_York' },
  ]);
});

test('/oncall-override accepts plain @handle with valid date', async () => {
  const app = createFakeApp();
  app.client.users.list = async () => ({
    members: [
      {
        id: 'UONIX',
        deleted: false,
        is_bot: false,
        name: 'onix.tarratscalderon',
        profile: { display_name: 'onix', real_name: 'Onix' },
      },
    ],
    response_metadata: { next_cursor: '' },
  });

  const overrides = [];
  const rotationService = createRotationServiceStub({
    isAdmin: () => true,
    getMemberBySlackId: (id) => (id === 'UONIX' ? { id: 'MID-ONIX', is_active: 1 } : null),
    setOverride: (payload) => overrides.push(payload),
  });

  createHandlers({ app, rotationService, logger: console });
  const response = await invoke(app, '/oncall-override', {
    text: '@onix.tarratscalderon 2026-03-02',
    userId: 'UADMIN',
  });

  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].weekStart, '2026-03-02');
  assert.equal(overrides[0].memberId, 'MID-ONIX');
  assert.match(response.text, /Override set for 2026-03-02/);
});

test('/oncall-override returns friendly error for invalid date input', async () => {
  const app = createFakeApp();
  app.client.users.list = async () => ({
    members: [
      {
        id: 'UONIX',
        deleted: false,
        is_bot: false,
        name: 'onix.tarratscalderon',
        profile: { display_name: 'onix', real_name: 'Onix' },
      },
    ],
    response_metadata: { next_cursor: '' },
  });

  const rotationService = createRotationServiceStub({
    isAdmin: () => true,
    getMemberBySlackId: () => ({ id: 'MID-ONIX', is_active: 1 }),
  });

  createHandlers({ app, rotationService, logger: console });
  const response = await invoke(app, '/oncall-override', {
    text: '@onix.tarratscalderon march-2-2026',
    userId: 'UADMIN',
  });

  assert.match(response.text, /Invalid week format/);
});

test('/oncall-override returns clear feedback for unresolved @handle', async () => {
  const app = createFakeApp();
  app.client.users.list = async () => ({
    members: [
      {
        id: 'UONIX',
        deleted: false,
        is_bot: false,
        name: 'onix',
        profile: { display_name: 'onix', real_name: 'Onix' },
      },
    ],
    response_metadata: { next_cursor: '' },
  });

  const rotationService = createRotationServiceStub({
    isAdmin: () => true,
  });

  createHandlers({ app, rotationService, logger: console });
  const response = await invoke(app, '/oncall-override', {
    text: '@onix.lastname 2026-03-02',
    userId: 'UADMIN',
  });

  assert.match(response.text, /Could not resolve that user/);
});

test('/oncall-override creates approval request when override would be back-to-back', async () => {
  const app = createFakeApp();
  app.client.users.list = async () => ({
    members: [
      {
        id: 'UONIX',
        deleted: false,
        is_bot: false,
        name: 'onix',
        profile: { display_name: 'onix', real_name: 'Onix' },
      },
    ],
    response_metadata: { next_cursor: '' },
  });

  const approvals = [];
  const rotationService = createRotationServiceStub({
    isAdmin: () => true,
    getMemberBySlackId: () => ({ id: 'MID-ONIX', slack_user_id: 'UONIX', is_active: 1 }),
    wouldCauseBackToBack: () => true,
    createBackToBackApproval: (payload) => {
      approvals.push(payload);
      return {
        id: 'APPROVAL-123',
        week_start: payload.weekStart,
        member_id: payload.memberId,
        member_slack_user_id: payload.memberSlackUserId,
        override_type: payload.overrideType,
        requested_by: payload.requestedBy,
        status: 'pending',
        user_approved_by: null,
        admin_approved_by: null,
      };
    },
  });

  createHandlers({ app, rotationService, logger: console });
  const response = await invoke(app, '/oncall-override', {
    text: '@onix 2026-03-02',
    userId: 'UADMIN',
  });

  assert.equal(approvals.length, 1);
  assert.match(response.text, /Back-to-back on-call detected/);
  assert.match(response.text, /APPROVAL-123/);
});
