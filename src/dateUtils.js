const DAY_NAME_TO_INDEX = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 0,
};

/**
 * Normalize a date-time into a UTC date-only value.
 * @param {Date} date
 * @returns {Date}
 */
function toDateOnly(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Returns the Monday week start in YYYY-MM-DD format for a given date.
 * @param {Date} [inputDate]
 * @returns {string}
 */
function weekStartISO(inputDate = new Date()) {
  const date = toDateOnly(inputDate);
  const day = date.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - diffToMonday);
  return date.toISOString().slice(0, 10);
}

/**
 * Adds or subtracts full weeks from an ISO date.
 * @param {string} isoDate
 * @param {number} weeks
 * @returns {string}
 */
function addWeeks(isoDate, weeks) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}

/**
 * Validates week input and normalizes it to the corresponding Monday.
 * @param {string} weekInput
 * @returns {string}
 */
function normalizeWeekInput(weekInput) {
  if (!weekInput) {
    return weekStartISO(new Date());
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekInput)) {
    throw new Error('Week must be in YYYY-MM-DD format');
  }
  const parsed = new Date(`${weekInput}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid date');
  }
  return weekStartISO(parsed);
}

/**
 * Converts day/time configuration into a cron expression.
 * @param {string} day
 * @param {string} time
 * @returns {{cron: string, day: string, time: string}}
 */
function parseReminderConfig(day, time) {
  const dayValue = (day || 'Monday').trim().toLowerCase();
  const dayIndex = DAY_NAME_TO_INDEX[dayValue];
  if (dayIndex === undefined) {
    throw new Error('Invalid reminder day. Use Monday-Sunday.');
  }

  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((time || '09:00').trim());
  if (!match) {
    throw new Error('Invalid reminder time. Use HH:MM 24h format.');
  }

  const [, hours, minutes] = match;
  return {
    cron: `${minutes} ${hours} * * ${dayIndex}`,
    day: capitalize(dayValue),
    time: `${hours}:${minutes}`,
  };
}

/**
 * Capitalizes the first character of a string.
 * @param {string} value
 * @returns {string}
 */
function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

module.exports = {
  addWeeks,
  normalizeWeekInput,
  parseReminderConfig,
  weekStartISO,
};
