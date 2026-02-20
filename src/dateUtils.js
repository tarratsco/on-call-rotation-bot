const DAY_NAME_TO_INDEX = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 0,
};

function toDateOnly(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function weekStartISO(inputDate = new Date()) {
  const date = toDateOnly(inputDate);
  const day = date.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - diffToMonday);
  return date.toISOString().slice(0, 10);
}

function addWeeks(isoDate, weeks) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}

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

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

module.exports = {
  addWeeks,
  normalizeWeekInput,
  parseReminderConfig,
  weekStartISO,
};
