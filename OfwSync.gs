/**
 * OUR FAMILY WIZARD -> GOOGLE CALENDAR SYNC
 * ---------------------------------------------------
 * Fetches calendar events from your OurFamilyWizard (OFW) account and
 * mirrors them into a Google Calendar called "OFW" under this Google
 * account. Updates and deletions on OFW are reflected on the next sync.
 *
 * !!! READ BEFORE USING !!!
 * OurFamilyWizard has no public/documented API. This script logs in with
 * your real OFW username + password (via OFW's internal web login form)
 * and calls OFW's internal, undocumented calendar endpoints — the same
 * technique used by the open-source chrischall/ofw-mcp project, which this
 * script's request shapes were derived from. OFW's Terms of Service say
 * users may not "obtain or attempt to obtain any materials or information
 * through any means not intentionally made available" — this script's
 * approach arguably falls in that gray area. OFW is also a court-of-record
 * platform: the data this script reads may carry legal weight.
 *   - Only run this against YOUR OWN OFW account.
 *   - This script is READ-ONLY against OFW (it only lists events; it never
 *     creates/edits/deletes anything on OFW itself). It only writes to a
 *     Google Calendar under your own Google account.
 *   - You are solely responsible for complying with OFW's Terms of Service
 *     and for any consequences (account warnings/suspension, or how this
 *     automation is viewed in a legal proceeding). This is not legal advice.
 *   - OFW's internal endpoints can change at any time without notice,
 *     which would break this script. See debugFetchRaw() below.
 *
 * Rules:
 * - Every sync fetches a configurable date window (default: 90 days back,
 *   395 days forward — see CONFIG below) from OFW and reconciles it
 *   against the "OFW" Google Calendar.
 * - New OFW events are created on the Google Calendar; changed events are
 *   deleted + recreated (simplest way to handle OFW's all-day/timed and
 *   multi-day quirks correctly with the CalendarApp API); OFW events no
 *   longer present in the fetched window are deleted from Google Calendar.
 * - An event that falls outside the fetch window looks identical to a
 *   deleted event (the window is the sync's horizon). Widen PAST_DAYS /
 *   FUTURE_DAYS if you need a wider horizon.
 *
 * CREDENTIAL STORAGE:
 * Apps Script has no secret manager for a project that must run
 * unattended on a time trigger — the password has to be readable by the
 * script itself at trigger time, which rules out "real" encryption (the
 * decryption key would have to live right next to the ciphertext). The
 * practical option used here is Script Properties (PropertiesService):
 * encrypted at rest by Google's infrastructure, and visible only to
 * someone who already has edit access to this Apps Script project (i.e.
 * the same access level needed to read/change this code in the first
 * place). Credentials are NEVER written into this file — you paste them
 * into a throwaway function, run it once, then delete that function. See
 * SETUP step 4 below.
 *
 * SETUP:
 * 1. Go to https://script.google.com and create a new project under the
 *    Google account that should own the "OFW" calendar.
 * 2. Paste the contents of this file in.
 * 3. Adjust CONFIG below if you want a different calendar name, sync
 *    interval, or date window.
 * 4. Store your OFW credentials (one-time):
 *    a. Temporarily add this function anywhere in the file:
 *         function _setupOfwCredentialsOnce() {
 *           setOfwCredentials('your-ofw-login-email@example.com', 'your-ofw-password');
 *         }
 *    b. Select `_setupOfwCredentialsOnce` in the function dropdown and
 *       click Run. You'll be prompted to authorize the script.
 *    c. Delete that function (and your password) from the file and save.
 *       The credentials now live only in Script Properties.
 * 5. Run syncOfwToCalendar() once manually to do a first sync.
 * 6. Run createTrigger() once to schedule automatic syncing (every
 *    CONFIG.SYNC_INTERVAL_HOURS hours; default 24). Safe to re-run any
 *    time — it clears duplicate triggers automatically.
 * 7. If a sync ever throws a parsing error, run debugFetchRaw() and check
 *    the logged JSON against extractEventFields() — OFW's internal API
 *    shape may have drifted from what this script expects.
 */

// ─── Configuration ───────────────────────────────────────────────────────────
const CONFIG = {
  CALENDAR_NAME: 'OFW',          // Google Calendar this script creates/maintains
  SYNC_INTERVAL_HOURS: 24,       // how often createTrigger() schedules syncOfwToCalendar()
  PAST_DAYS: 90,                 // how far back each sync fetches from OFW
  FUTURE_DAYS: 395               // how far forward each sync fetches from OFW
};
// ─────────────────────────────────────────────────────────────────────────────

const OFW_BASE_URL = 'https://ofw.ourfamilywizard.com';
const OFW_PROTOCOL_HEADERS = {
  'ofw-client': 'WebApplication',
  'ofw-version': '1.0.0'
};
const OFW_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;   // OFW doesn't return an expiry; synthesize 6h like ofw-mcp does
const OFW_TOKEN_SKEW_MS = 5 * 60 * 1000;

const USERNAME_PROP = 'OFW_USERNAME';
const PASSWORD_PROP = 'OFW_PASSWORD';
const TOKEN_PROP = 'OFW_TOKEN';
const TOKEN_EXPIRES_PROP = 'OFW_TOKEN_EXPIRES';
const CALENDAR_ID_PROP = 'OFW_CALENDAR_ID';
const KNOWN_IDS_PROP = 'OFW_KNOWN_IDS';
const MAP_PROP_PREFIX = 'OFW_MAP_';   // OFW event id -> Google event id
const HASH_PROP_PREFIX = 'OFW_HASH_'; // OFW event id -> content hash, to skip no-op updates

// ─── Public entry points ─────────────────────────────────────────────────────

/**
 * One-time credential setup. See SETUP step 4 in the header comment —
 * call this from a throwaway wrapper function, run it once, then delete
 * the wrapper (and your password) from the source.
 */
function setOfwCredentials(username, password) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(USERNAME_PROP, username);
  props.setProperty(PASSWORD_PROP, password);
  props.deleteProperty(TOKEN_PROP);
  props.deleteProperty(TOKEN_EXPIRES_PROP);
  Logger.log('OFW credentials saved to Script Properties. Now delete the ' +
    'wrapper function (and your password) from the source and save.');
}

/** Removes stored OFW credentials and cached token. Does not touch synced events. */
function clearOfwCredentials() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(USERNAME_PROP);
  props.deleteProperty(PASSWORD_PROP);
  props.deleteProperty(TOKEN_PROP);
  props.deleteProperty(TOKEN_EXPIRES_PROP);
}

/**
 * Main sync function. Fetches CONFIG.PAST_DAYS..CONFIG.FUTURE_DAYS of OFW
 * calendar events and reconciles them against the "OFW" Google Calendar:
 * creates new events, recreates changed ones, deletes ones no longer on OFW.
 */
function syncOfwToCalendar() {
  const props = PropertiesService.getScriptProperties();
  const calendar = getOrCreateOfwCalendar();

  const today = new Date();
  const startDate = formatDate(addDays(today, -CONFIG.PAST_DAYS));
  const endDate = formatDate(addDays(today, CONFIG.FUTURE_DAYS));

  let events;
  try {
    events = fetchOfwEvents(getOfwToken(), startDate, endDate);
  } catch (e) {
    if (e instanceof OfwAuthError) {
      // Token was rejected; getOfwToken() will log in fresh since the
      // cached token property was already cleared by fetchOfwEvents().
      events = fetchOfwEvents(getOfwToken(), startDate, endDate);
    } else {
      throw e;
    }
  }

  const seenIds = {};
  let created = 0, updated = 0, unchanged = 0, deleted = 0;

  events.forEach(function (ev) {
    const id = ofwEventId(ev);
    if (!id) return;
    seenIds[id] = true;
    const result = upsertEvent(calendar, id, ev, props);
    if (result === 'created') created++;
    else if (result === 'updated') updated++;
    else unchanged++;
  });

  const knownIds = getKnownIds(props);
  Object.keys(knownIds).forEach(function (id) {
    if (!seenIds[id]) {
      removeEvent(id, props);
      deleted++;
    }
  });

  setKnownIds(props, seenIds);

  Logger.log('OFW sync complete (' + startDate + ' to ' + endDate + '): ' +
    created + ' created, ' + updated + ' updated, ' + unchanged +
    ' unchanged, ' + deleted + ' deleted.');
}

/**
 * Deletes every event this script created on the "OFW" calendar and
 * clears all sync state (id mappings, hashes, cached token). Credentials
 * are kept. Run this if you want a completely clean re-sync.
 */
function resetAndCleanup() {
  const props = PropertiesService.getScriptProperties();
  const known = getKnownIds(props);
  Object.keys(known).forEach(function (id) {
    removeEvent(id, props);
  });
  props.deleteProperty(KNOWN_IDS_PROP);
  props.deleteProperty(TOKEN_PROP);
  props.deleteProperty(TOKEN_EXPIRES_PROP);
  Logger.log('Reset complete. Run syncOfwToCalendar() for a fresh sync.');
}

/** Schedules syncOfwToCalendar() every CONFIG.SYNC_INTERVAL_HOURS. Safe to re-run. */
function createTrigger() {
  removeTrigger();
  const hours = CONFIG.SYNC_INTERVAL_HOURS;
  if (hours % 24 === 0) {
    ScriptApp.newTrigger('syncOfwToCalendar').timeBased().everyDays(hours / 24).create();
    return;
  }
  // Apps Script's everyHours() only accepts 1, 2, 4, 6, 8, or 12 — pick the
  // largest of those that divides evenly into the requested interval.
  const allowed = [12, 8, 6, 4, 2, 1];
  let pick = 1;
  for (let i = 0; i < allowed.length; i++) {
    if (hours % allowed[i] === 0) { pick = allowed[i]; break; }
  }
  ScriptApp.newTrigger('syncOfwToCalendar').timeBased().everyHours(pick).create();
  if (pick !== hours) {
    Logger.log('Note: CONFIG.SYNC_INTERVAL_HOURS=' + hours + ' is not a multiple of 24 ' +
      'and not directly supported; scheduled every ' + pick + ' hours instead.');
  }
}

/** Removes the sync trigger (pauses automatic syncing). */
function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncOfwToCalendar') ScriptApp.deleteTrigger(t);
  });
}

/**
 * Logs the raw JSON OFW returns for the configured date window, truncated.
 * Use this to diagnose a parsing error if OFW's internal API shape has
 * drifted from what extractEventFields() expects.
 */
function debugFetchRaw() {
  const token = getOfwToken();
  const startDate = formatDate(addDays(new Date(), -7));
  const endDate = formatDate(addDays(new Date(), 30));
  const url = OFW_BASE_URL + '/pub/v1/calendar/detailed?startDate=' +
    encodeURIComponent(startDate) + '&endDate=' + encodeURIComponent(endDate);
  const resp = UrlFetchApp.fetch(url, {
    headers: Object.assign({}, OFW_PROTOCOL_HEADERS, {
      Accept: 'application/json',
      Authorization: 'Bearer ' + token
    }),
    muteHttpExceptions: true
  });
  Logger.log('HTTP ' + resp.getResponseCode());
  Logger.log(resp.getContentText().substring(0, 4000));
}

// ─── OFW auth ─────────────────────────────────────────────────────────────

/** Thrown when OFW rejects the bearer token (401), distinct from other failures. */
class OfwAuthError extends Error {}

function getOfwToken() {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty(TOKEN_PROP);
  const expires = Number(props.getProperty(TOKEN_EXPIRES_PROP) || 0);
  if (cached && Date.now() < expires) return cached;

  const username = props.getProperty(USERNAME_PROP);
  const password = props.getProperty(PASSWORD_PROP);
  if (!username || !password) {
    throw new Error('OFW credentials not set. See setOfwCredentials() in the setup instructions at the top of this file.');
  }

  const token = ofwLogin(username, password);
  props.setProperty(TOKEN_PROP, token);
  props.setProperty(TOKEN_EXPIRES_PROP, String(Date.now() + OFW_TOKEN_TTL_MS - OFW_TOKEN_SKEW_MS));
  return token;
}

/**
 * OFW's web login: a SESSION cookie from GET /ofw/login.form, then a
 * form-urlencoded POST to /ofw/login carrying that cookie. A successful
 * login returns JSON {auth: "<bearer token>", redirectUrl}; a rejected
 * login re-serves the HTML login page instead.
 */
function ofwLogin(username, password) {
  const initResp = UrlFetchApp.fetch(OFW_BASE_URL + '/ofw/login.form', {
    headers: OFW_PROTOCOL_HEADERS,
    followRedirects: false,
    muteHttpExceptions: true
  });
  const cookie = extractCookieHeader(initResp);

  const body = 'submit=' + encodeURIComponent('Sign In') +
    '&_eventId=submit' +
    '&username=' + encodeURIComponent(username) +
    '&password=' + encodeURIComponent(password);

  const loginResp = UrlFetchApp.fetch(OFW_BASE_URL + '/ofw/login', {
    method: 'post',
    headers: Object.assign({}, OFW_PROTOCOL_HEADERS, {
      Accept: 'application/json',
      Cookie: cookie
    }),
    contentType: 'application/x-www-form-urlencoded',
    payload: body,
    muteHttpExceptions: true
  });

  const code = loginResp.getResponseCode();
  const headers = loginResp.getHeaders();
  const contentType = String(headers['Content-Type'] || headers['content-type'] || '');

  if (contentType.indexOf('application/json') === -1) {
    if (contentType.indexOf('text/html') !== -1) {
      throw new Error('OFW login failed: your OFW username or password was not accepted.');
    }
    throw new Error('OFW login returned an unexpected response (HTTP ' + code + ', ' +
      (contentType || 'no content-type') + '): ' + loginResp.getContentText().substring(0, 200));
  }
  if (code < 200 || code >= 300) {
    throw new Error('OFW login failed: HTTP ' + code + ' - ' + loginResp.getContentText().substring(0, 200));
  }

  const data = JSON.parse(loginResp.getContentText());
  if (!data || !data.auth) {
    throw new Error('OFW login response was missing the expected "auth" token.');
  }
  return data.auth;
}

function extractCookieHeader(response) {
  const headers = response.getAllHeaders();
  const raw = headers['Set-Cookie'] || headers['set-cookie'];
  if (!raw) return '';
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(function (c) { return c.split(';')[0]; }).join('; ');
}

// ─── OFW calendar API ─────────────────────────────────────────────────────

function fetchOfwEvents(token, startDate, endDate) {
  const url = OFW_BASE_URL + '/pub/v1/calendar/detailed?startDate=' +
    encodeURIComponent(startDate) + '&endDate=' + encodeURIComponent(endDate);
  const resp = UrlFetchApp.fetch(url, {
    headers: Object.assign({}, OFW_PROTOCOL_HEADERS, {
      Accept: 'application/json',
      Authorization: 'Bearer ' + token
    }),
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  if (code === 401) {
    PropertiesService.getScriptProperties().deleteProperty(TOKEN_PROP);
    throw new OfwAuthError('OFW API returned 401 Unauthorized.');
  }
  if (code < 200 || code >= 300) {
    throw new Error('OFW calendar API error: HTTP ' + code + ' - ' + resp.getContentText().substring(0, 500));
  }

  return normalizeEventList(JSON.parse(resp.getContentText()));
}

function normalizeEventList(data) {
  if (Array.isArray(data)) return data;
  // /pub/v1/calendar/detailed returns {calendarItems: [...], guardianData: ...}
  if (data && Array.isArray(data.calendarItems)) return data.calendarItems;
  if (data && Array.isArray(data.events)) return data.events;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.data)) return data.data;
  throw new Error('Unexpected OFW calendar response shape (run debugFetchRaw() to inspect). ' +
    'Top-level keys: ' + (data && typeof data === 'object' ? Object.keys(data).join(', ') : String(data)));
}

function ofwEventId(ev) {
  const id = (ev.id !== undefined && ev.id !== null) ? ev.id : ev.eventRecurrenceId;
  return (id === undefined || id === null) ? null : String(id);
}

// ─── Reconciliation against the "OFW" Google Calendar ──────────────────────

function upsertEvent(calendar, id, ev, props) {
  const mapKey = MAP_PROP_PREFIX + id;
  const hashKey = HASH_PROP_PREFIX + id;
  const mappedGoogleId = props.getProperty(mapKey);
  const fields = extractEventFields(ev);
  const hash = contentHash(fields);

  let googleEvent = null;
  if (mappedGoogleId) {
    try { googleEvent = calendar.getEventById(mappedGoogleId); } catch (e) { googleEvent = null; }
  }

  if (googleEvent && props.getProperty(hashKey) === hash) {
    return 'unchanged';
  }

  // Delete + recreate rather than patch in place: CalendarApp's update API
  // has awkward edge cases around toggling all-day vs timed and multi-day
  // all-day ranges, and these are plain informational mirror events with no
  // attendees/RSVPs to preserve, so a clean replace is simplest and correct.
  if (googleEvent) {
    try { googleEvent.deleteEvent(); } catch (e) { /* already gone */ }
  }
  const created = createGoogleEvent(calendar, fields);
  props.setProperty(mapKey, created.getId());
  props.setProperty(hashKey, hash);
  return googleEvent ? 'updated' : 'created';
}

function removeEvent(id, props) {
  const mapKey = MAP_PROP_PREFIX + id;
  const hashKey = HASH_PROP_PREFIX + id;
  const googleId = props.getProperty(mapKey);
  if (googleId) {
    try {
      const calendar = getOrCreateOfwCalendar();
      const ev = calendar.getEventById(googleId);
      if (ev) ev.deleteEvent();
    } catch (e) { /* already gone */ }
  }
  props.deleteProperty(mapKey);
  props.deleteProperty(hashKey);
}

/**
 * Pulls the fields this script cares about out of an OFW event, tolerating
 * a couple of plausible shape variants (see header comment on why).
 */
function extractEventFields(ev) {
  const startRaw = extractDateTimeRaw(ev.startDate) || ev.startDateTime || ev.start;
  const endRaw = extractDateTimeRaw(ev.endDate) || ev.endDateTime || ev.end;
  if (!startRaw || !endRaw) {
    throw new Error('OFW event "' + (ev.title || ofwEventId(ev)) + '" is missing a start or end date. Run debugFetchRaw() to inspect.');
  }
  return {
    title: ev.title || '(OFW event)',
    allDay: !!ev.allDay,
    start: parseOfwDate(startRaw),
    end: parseOfwDate(endRaw),
    location: ev.location || '',
    notes: ev.notes || '',
    shared: ev.publicFlag !== false
  };
}

function extractDateTimeRaw(val) {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val.dateTime) return val.dateTime;
  return null;
}

function parseOfwDate(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(raw);
  if (!m) throw new Error('Could not parse OFW date value: "' + raw + '"');
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0, m[6] ? Number(m[6]) : 0
  );
}

function createGoogleEvent(calendar, fields) {
  const options = {
    description: buildDescription(fields),
    location: fields.location || ''
  };
  if (fields.allDay) {
    if (sameDay(fields.start, fields.end)) {
      return calendar.createAllDayEvent(fields.title, fields.start, options);
    }
    // Google's multi-day all-day end date is exclusive; OFW's is assumed
    // inclusive (the last day of the event), so push it out by one day.
    return calendar.createAllDayEvent(fields.title, fields.start, addDays(fields.end, 1), options);
  }
  return calendar.createEvent(fields.title, fields.start, fields.end, options);
}

function buildDescription(fields) {
  const lines = ['Synced from OurFamilyWizard' + (fields.shared ? '' : ' (private event)')];
  if (fields.notes) {
    lines.push('');
    lines.push(fields.notes);
  }
  return lines.join('\n');
}

function contentHash(fields) {
  const raw = JSON.stringify({
    title: fields.title,
    allDay: fields.allDay,
    start: fields.start.getTime(),
    end: fields.end.getTime(),
    location: fields.location,
    notes: fields.notes,
    shared: fields.shared
  });
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw);
  return Utilities.base64Encode(digest);
}

// ─── Google Calendar + Script Properties helpers ───────────────────────────

function getOrCreateOfwCalendar() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(CALENDAR_ID_PROP);
  if (id) {
    const existing = CalendarApp.getCalendarById(id);
    if (existing) return existing;
    props.deleteProperty(CALENDAR_ID_PROP);
  }

  const matches = CalendarApp.getCalendarsByName(CONFIG.CALENDAR_NAME);
  if (matches.length > 0) {
    props.setProperty(CALENDAR_ID_PROP, matches[0].getId());
    return matches[0];
  }

  const created = CalendarApp.createCalendar(CONFIG.CALENDAR_NAME);
  props.setProperty(CALENDAR_ID_PROP, created.getId());
  return created;
}

function getKnownIds(props) {
  const raw = props.getProperty(KNOWN_IDS_PROP);
  if (!raw) return {};
  try {
    const map = {};
    JSON.parse(raw).forEach(function (id) { map[id] = true; });
    return map;
  } catch (e) {
    return {};
  }
}

function setKnownIds(props, seenIdsMap) {
  props.setProperty(KNOWN_IDS_PROP, JSON.stringify(Object.keys(seenIdsMap)));
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
