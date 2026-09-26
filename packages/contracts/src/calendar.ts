/**
 * Calendar arithmetic both sides of the wire agree on: the environment's
 * deciders (a snooze's window, an auto-settle span in months) and a client
 * that refuses a time before the environment would.
 */

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/**
 * `months` calendar months after `date`, in UTC, at the same time of day: the
 * same day of the month, or the month's last day when it is shorter (January
 * 31st and one month is February 28th, or 29th in a leap year).
 */
export const addCalendarMonths = (date: Date, months: number): Date => {
  const target = new Date(date.getTime());
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  target.setUTCDate(Math.min(day, daysInMonth(target.getUTCFullYear(), target.getUTCMonth())));
  return target;
};

/** The latest `until` a snooze takes (`sessions.snooze`, `out_of_window`): a calendar year after the environment's now. */
export const snoozeLimit = (now: Date): Date => addCalendarMonths(now, 12);
