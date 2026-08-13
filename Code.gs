/**
 * PERSONAL -> WORK "BUSY" CALENDAR SYNC
 * ---------------------------------------------------
 * Runs entirely against your PERSONAL Google account.
 * Reads events from your main personal calendar, and for each one
 * creates/updates/cancels a matching "Busy" event on a SEPARATE
 * secondary calendar (also under your personal account) so your
 * primary calendar stays uncluttered. That Busy event invites your
 * work email as a guest, so it shows up on your work calendar.
 *
 * Rules:
 * - Events marked "Free" (transparency = transparent) are ignored.
 *   Only "Busy" (opaque) events get mirrored.
 * - Recurring events are mirrored as a SINGLE recurring Busy event
 *   (same RRULE), not one invite per instance. Individually modified
 *   or cancelled occurrences ("exceptions") are best-effort mirrored
 *   onto the matching instance of the Busy series.
 *
 * SETUP / UPDATE:
 * 1. Go to https://script.google.com, open your existing project
 *    (personal Google account).
 * 2. Select all, delete, paste this whole file in.
 * 3. Change WORK_EMAIL below to your real work email.
 * 4. Make sure "Google Calendar API" is added under Services.
 * 5. If you're updating from an earlier version of this script,
 *    run resetAndCleanup() ONCE. This wipes everything the old
 *    script created (including the old per-instance duplicates)
 *    and clears the sync token so the next sync starts clean.
 * 6. Run syncBusyToWork() once manually to do a fresh sync.
 * 7. Make sure createTrigger() has been run at some point (safe to
 *    re-run any time; it clears duplicate triggers automatically).
 * 8. On your WORK Google account: Calendar Settings > Event
 *    settings > turn ON "Automatically add invitations" so Busy
 *    invites appear without manual accepting.
 */

const WORK_EMAIL = 'you@yourwork.com';   // <-- CHANGE THIS
const SOURCE_CALENDAR_ID = 'primary';    // where you keep real personal events
const BUSY_CALENDAR_NAME = 'Work Busy Sync'; // secondary calendar the script creates
const SYNC_TOKEN_PROP = 'CAL_SYNC_TOKEN';
const BUSY_CALENDAR_ID_PROP = 'BUSY_CALENDAR_ID';
const MAP_PROP_PREFIX = 'MAP_';          // maps source event id -> busy event id

function syncBusyToWork() {
  const props = PropertiesService.getScriptProperties();
  const busyCalendarId = getOrCreateBusyCalendarId();
  let syncToken = props.getProperty(SYNC_TOKEN_PROP);
  let pageToken;
  const allItems = [];

  do {
    const options = {
      maxResults: 250,
      singleEvents: false, // IMPORTANT: get master recurring events + exceptions, not every instance
      pageToken: pageToken
    };

    if (syncToken) {
      options.syncToken = syncToken;
    } else {
      options.timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    }

    let events;
    try {
      events = Calendar.Events.list(SOURCE_CALENDAR_ID, options);
    } catch (e) {
      if (e.message && e.message.indexOf('Sync token') !== -1) {
        props.deleteProperty(SYNC_TOKEN_PROP);
        return syncBusyToWork();
      }
      throw e;
    }

    allItems.push.apply(allItems, events.items);
    pageToken = events.nextPageToken;

    if (!pageToken && events.nextSyncToken) {
      props.setProperty(SYNC_TOKEN_PROP, events.nextSyncToken);
    }
  } while (pageToken);

  // Two passes: masters & standalone singles first, then exceptions
  // (an exception needs its master already processed/mapped).
  const exceptions = [];
  allItems.forEach(function (event) {
    if (event.recurringEventId) {
      exceptions.push(event);
    } else {
      handleMasterOrSingle(event, busyCalendarId);
    }
  });
  exceptions.forEach(function (event) {
    handleExceptionInstance(event, busyCalendarId);
  });
}

function isFree(event) {
  return event.transparency === 'transparent';
}

/**
 * Handles a standalone single event OR the master of a recurring series.
 */
function handleMasterOrSingle(event, busyCalendarId) {
  const props = PropertiesService.getScriptProperties();
  const mapKey = MAP_PROP_PREFIX + event.id;
  const existingBusyId = props.getProperty(mapKey);

  if (event.status === 'cancelled') {
    removeBusyEvent(busyCalendarId, existingBusyId, mapKey);
    return;
  }

  if (isFree(event)) {
    // Explicitly marked "Free" -> should NOT show as busy at work.
    // If we'd previously created a busy event for it (e.g. it used
    // to be Busy and was edited to Free), remove that now.
    removeBusyEvent(busyCalendarId, existingBusyId, mapKey);
    return;
  }

  if (!event.start || !event.end) return;

  const busyBody = {
    summary: 'Busy',
    start: event.start,
    end: event.end,
    visibility: 'private',
    guestsCanModify: false,
    attendees: [{ email: WORK_EMAIL }],
    extendedProperties: {
      private: { isBusySync: 'true', sourceEventId: event.id }
    }
  };

  if (event.recurrence && event.recurrence.length) {
    busyBody.recurrence = event.recurrence; // mirror the RRULE as-is
  }

  upsertBusyEvent(busyCalendarId, existingBusyId, busyBody, mapKey);
}

/**
 * Handles a single modified or cancelled OCCURRENCE within a recurring
 * series (a "recurring event exception" in Google Calendar's model).
 * Best-effort: finds the matching instance on the Busy series and
 * applies the same change to it.
 */
function handleExceptionInstance(event, busyCalendarId) {
  const props = PropertiesService.getScriptProperties();
  const masterMapKey = MAP_PROP_PREFIX + event.recurringEventId;
  const busyMasterId = props.getProperty(masterMapKey);

  if (!busyMasterId) return; // master hasn't been synced yet; will resolve on a later run
  if (!event.originalStartTime) return;

  const origStart = event.originalStartTime.dateTime || event.originalStartTime.date;
  const origEnd = addSameDuration(origStart, event.originalStartTime.dateTime ? 'dateTime' : 'date');

  let instances;
  try {
    instances = Calendar.Events.instances(busyCalendarId, busyMasterId, {
      timeMin: origStart,
      timeMax: origEnd,
      maxResults: 5
    });
  } catch (e) {
    return; // busy master might not exist yet
  }

  const match = (instances.items || []).find(function (inst) {
    const instStart = inst.originalStartTime && (inst.originalStartTime.dateTime || inst.originalStartTime.date);
    return instStart === origStart;
  });
  if (!match) return;

  if (event.status === 'cancelled' || isFree(event)) {
    try {
      Calendar.Events.remove(busyCalendarId, match.id, { sendUpdates: 'all' });
    } catch (e) {}
    return;
  }

  if (!event.start || !event.end) return;

  try {
    Calendar.Events.patch(
      { start: event.start, end: event.end },
      busyCalendarId,
      match.id,
      { sendUpdates: 'all' }
    );
  } catch (e) {}
}

function addSameDuration(isoStart, kind) {
  // widen the instance search window slightly beyond the original start
  const d = new Date(isoStart);
  if (kind === 'date') {
    d.setDate(d.getDate() + 1);
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  d.setHours(d.getHours() + 1);
  return d.toISOString();
}

function upsertBusyEvent(busyCalendarId, existingBusyId, busyBody, mapKey) {
  const props = PropertiesService.getScriptProperties();
  if (existingBusyId) {
    try {
      Calendar.Events.update(busyBody, busyCalendarId, existingBusyId, { sendUpdates: 'all' });
      return;
    } catch (e) {
      // fall through to recreate
    }
  }
  const created = Calendar.Events.insert(busyBody, busyCalendarId, { sendUpdates: 'all' });
  props.setProperty(mapKey, created.id);
}

function removeBusyEvent(busyCalendarId, existingBusyId, mapKey) {
  const props = PropertiesService.getScriptProperties();
  if (existingBusyId) {
    try {
      Calendar.Events.remove(busyCalendarId, existingBusyId, { sendUpdates: 'all' });
    } catch (e) {}
    props.deleteProperty(mapKey);
  }
}

/**
 * Finds the "Work Busy Sync" secondary calendar, or creates it the
 * first time the script runs. Caches the id in Script Properties.
 */
function getOrCreateBusyCalendarId() {
  const props = PropertiesService.getScriptProperties();
  let calId = props.getProperty(BUSY_CALENDAR_ID_PROP);

  if (calId) {
    try {
      Calendar.Calendars.get(calId);
      return calId;
    } catch (e) {
      props.deleteProperty(BUSY_CALENDAR_ID_PROP);
    }
  }

  const list = Calendar.CalendarList.list({ showHidden: true });
  if (list.items) {
    for (let i = 0; i < list.items.length; i++) {
      if (list.items[i].summary === BUSY_CALENDAR_NAME) {
        props.setProperty(BUSY_CALENDAR_ID_PROP, list.items[i].id);
        return list.items[i].id;
      }
    }
  }

  const tz = Calendar.Settings.get('timezone').value;
  const newCal = Calendar.Calendars.insert({ summary: BUSY_CALENDAR_NAME, timeZone: tz });
  props.setProperty(BUSY_CALENDAR_ID_PROP, newCal.id);
  return newCal.id;
}

/**
 * Run this ONCE after updating from an earlier version of the script,
 * or any time you want to fully reset. Deletes every event this
 * script created on the Busy calendar and clears the sync token and
 * id mappings, so the next syncBusyToWork() starts from scratch.
 */
function resetAndCleanup() {
  const props = PropertiesService.getScriptProperties();
  const busyCalendarId = getOrCreateBusyCalendarId();

  let pageToken;
  do {
    const result = Calendar.Events.list(busyCalendarId, { maxResults: 2500, pageToken: pageToken });
    (result.items || []).forEach(function (ev) {
      try {
        Calendar.Events.remove(busyCalendarId, ev.id, { sendUpdates: 'all' });
      } catch (e) {}
    });
    pageToken = result.nextPageToken;
  } while (pageToken);

  const allProps = props.getProperties();
  Object.keys(allProps).forEach(function (k) {
    if (k === SYNC_TOKEN_PROP || k.indexOf(MAP_PROP_PREFIX) === 0) {
      props.deleteProperty(k);
    }
  });
}

function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncBusyToWork') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('syncBusyToWork').timeBased().everyMinutes(15).create();
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncBusyToWork') {
      ScriptApp.deleteTrigger(t);
    }
  });
}
