const test = require('node:test');
const assert = require('node:assert/strict');

const { addWeeks, normalizeWeekInput, parseReminderConfig, weekStartISO } = require('./dateUtils');

test('weekStartISO returns Monday for mid-week date', () => {
  const value = weekStartISO(new Date('2026-02-19T12:00:00Z'));
  assert.equal(value, '2026-02-16');
});

test('addWeeks adds and subtracts full weeks', () => {
  assert.equal(addWeeks('2026-02-16', 1), '2026-02-23');
  assert.equal(addWeeks('2026-02-16', -1), '2026-02-09');
});

test('normalizeWeekInput validates format and normalizes to Monday', () => {
  assert.equal(normalizeWeekInput('2026-02-19'), '2026-02-16');
  assert.throws(() => normalizeWeekInput('2026/02/19'), /YYYY-MM-DD/);
});

test('parseReminderConfig builds cron expression', () => {
  const parsed = parseReminderConfig('Tuesday', '09:30');
  assert.deepEqual(parsed, {
    cron: '30 09 * * 2',
    day: 'Tuesday',
    time: '09:30',
  });
});

test('parseReminderConfig rejects invalid day/time', () => {
  assert.throws(() => parseReminderConfig('Funday', '09:00'), /Invalid reminder day/);
  assert.throws(() => parseReminderConfig('Monday', '9:00'), /Invalid reminder time/);
});
