/**
 * COLOR EXTERNAL MEETINGS
 * ---------------------------------------------------
 * Runs entirely against your WORK Google account.
 * Scans upcoming events on your work calendar and colors any
 * meeting that includes a guest outside your internal domains,
 * so external meetings stand out at a glance.
 *
 * Rules:
 * - Only events with at least one guest are considered.
 * - A guest is "external" if their email doesn't end in one of
 *   CONFIG.internalDomains.
 * - Events already set to the external color are left alone.
 *
 * SETUP:
 * 1. Go to https://script.google.com and create a new project
 *    under your WORK Google account (or add this file to an
 *    existing project).
 * 2. Paste the contents of this file in.
 * 3. Change CONFIG.calendarId and CONFIG.internalDomains below.
 * 4. Add the "Google Calendar API" service (Services > + icon >
 *    Google Calendar API > Add).
 * 5. Run colorExternalMeetings() once manually to authorize it.
 * 6. Run createDailyTrigger() once to run it automatically every
 *    morning at 7am. Safe to re-run any time; it clears duplicate
 *    triggers automatically.
 */

// ─── Configuration ───────────────────────────────────────────────────────────
const CONFIG = {
  calendarId: 'you@yourwork.com',        // <-- CHANGE THIS
  internalDomains: ['yourwork.com'],     // <-- CHANGE THIS
  externalColor: CalendarApp.EventColor.ORANGE,
};
// ─────────────────────────────────────────────────────────────────────────────

function isInternal(email) {
  return CONFIG.internalDomains.some(domain => email.endsWith('@' + domain));
}

function colorExternalMeetings() {
  const calendar = CalendarApp.getCalendarById(CONFIG.calendarId);
  const now = new Date();
  const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const events = calendar.getEvents(now, sevenDaysLater);
  let updated = 0;

  for (const event of events) {
    const guests = event.getGuestList();

    if (guests.length === 0) continue;

    const hasExternal = guests.some(g => !isInternal(g.getEmail()));
    if (!hasExternal) continue;

    if (event.getColor() === CONFIG.externalColor) continue;

    event.setColor(CONFIG.externalColor);
    updated++;
    Logger.log(`Updated: ${event.getTitle()} on ${event.getStartTime()}`);
  }

  Logger.log(`Done. ${updated} events updated.`);
}

function createDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('colorExternalMeetings')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();
}
