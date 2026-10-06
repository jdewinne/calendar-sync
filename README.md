# calendar-sync

Google Apps Scripts for keeping a work Google Calendar in sync and readable:

- **`BusySync.gs`** — mirrors "Busy" events from your personal calendar to your work calendar, without exposing event details.
- **`ColorExternalMeetings.gs`** — color codes meetings on your work calendar that include external attendees, so they stand out.
- **`OfwSync.gs`** — mirrors events from your OurFamilyWizard (OFW) account into a Google Calendar called "OFW", keeping updates and deletions in sync.

## Busy sync (`BusySync.gs`)

### How it works

The script runs entirely under your **personal** Google account. It reads events from your primary personal calendar and creates matching "Busy" events on a secondary calendar called **Work Busy Sync**. Each Busy event invites your work email as a guest, so it appears on your work calendar automatically.

**Initial sync behavior:**
On the very first run, the script only looks back **24 hours**. Existing events older than that will not be mirrored. After the first run a sync token is saved, and all subsequent runs only process incremental changes (new, updated, or cancelled events) from that point forward. If you want older events to be covered, edit them after installing the script so they appear as changes.

**Rules:**
- Events marked "Free" (transparent) are ignored — only "Busy" (opaque) events are mirrored.
- Recurring events are mirrored as a single recurring Busy event (same RRULE), not one invite per instance.
- Individually modified or cancelled occurrences within a recurring series are best-effort mirrored.
- The sync runs every 15 minutes via a time-based trigger.

### Setup (first time)

1. Go to [script.google.com](https://script.google.com) and create a new project under your **personal** Google account.
2. Paste the contents of `BusySync.gs` into the editor.
3. Change `WORK_EMAIL` at the top of the file to your real work email address.
4. Add the **Google Calendar API** service:
   - Click **Services** (the `+` icon in the left sidebar).
   - Select **Google Calendar API** and click **Add**.
5. Run `syncBusyToWork()` once manually to do a fresh initial sync.
   - You will be prompted to authorize the script the first time.
6. Run `createTrigger()` once to set up the 15-minute recurring sync.
   - This is safe to re-run at any time; it removes duplicate triggers automatically.

### Updating from an earlier version

1. Open your existing project at [script.google.com](https://script.google.com).
2. Select all, delete, and paste the new `BusySync.gs` content in.
3. Run `resetAndCleanup()` **once**. This deletes all events the old script created and clears the sync state so the next run starts clean.
4. Run `syncBusyToWork()` once manually to do a fresh sync.
5. Run `createTrigger()` to ensure the trigger is set up correctly.

### Available functions

| Function | Description |
|---|---|
| `syncBusyToWork()` | Main sync function — mirrors personal Busy events to the work calendar. |
| `createTrigger()` | Sets up a time-based trigger to run `syncBusyToWork()` every 15 minutes. |
| `removeTrigger()` | Removes the time-based trigger (pauses automatic syncing). |
| `resetAndCleanup()` | Deletes all synced Busy events and clears sync state for a clean restart. |

## Color external meetings (`ColorExternalMeetings.gs`)

### How it works

The script runs under your **work** Google account. It scans the next 7 days of events on your work calendar and, for any event that has at least one guest whose email domain isn't in your internal domain list, sets the event's color to orange. Events that already have that color are skipped, and events with no guests are ignored.

**Rules:**
- A guest counts as external if their email domain isn't in `CONFIG.internalDomains`.
- Guests listed in `CONFIG.excludeEmailAddresses` are ignored entirely (e.g. note-taking bots like `assistant@gong.io` that get added to otherwise-internal meetings).
- Only events in the next 7 days are checked on each run.
- Runs automatically every morning at 7am via a time-based trigger.

### Setup (first time)

1. Go to [script.google.com](https://script.google.com) and create a new project under your **work** Google account (or add this file to an existing project).
2. Paste the contents of `ColorExternalMeetings.gs` into the editor.
3. Change `CONFIG.calendarId` and `CONFIG.internalDomains` at the top of the file to your work email and internal domain(s). Optionally add emails to `CONFIG.excludeEmailAddresses` to ignore bots/note-takers.
4. Add the **Google Calendar API** service:
   - Click **Services** (the `+` icon in the left sidebar).
   - Select **Google Calendar API** and click **Add**.
5. Run `colorExternalMeetings()` once manually to authorize it and do an initial pass.
6. Run `createDailyTrigger()` once to set up the daily 7am recurring run.
   - This is safe to re-run at any time; it removes duplicate triggers automatically.

### Available functions

| Function | Description |
|---|---|
| `colorExternalMeetings()` | Scans the next 7 days and colors meetings that include external attendees. |
| `createDailyTrigger()` | Sets up a time-based trigger to run `colorExternalMeetings()` daily at 7am. |

## OFW sync (`OfwSync.gs`)

> [!WARNING]
> OurFamilyWizard has **no public/documented API**. This script logs in with your real OFW username + password (via OFW's internal web login form) and calls OFW's internal, undocumented calendar endpoints — the same technique used by the open-source [chrischall/ofw-mcp](https://github.com/chrischall/ofw-mcp) project, which this script's request shapes were derived from. OFW's Terms of Service say users may not "obtain or attempt to obtain any materials or information through any means not intentionally made available," and OFW is a court-of-record platform. Only run this against your own OFW account. This script is **read-only against OFW** — it never creates, edits, or deletes anything on OFW, it only reads your calendar and writes to a Google Calendar under your own Google account. You are solely responsible for complying with OFW's Terms of Service and for any consequences; this is not legal advice. OFW's internal endpoints can change without notice, which would break this script — see `debugFetchRaw()` below.

### How it works

The script logs into OFW (capturing a session cookie, then posting the login form to get a bearer token) and fetches a configurable date window of calendar events from OFW's internal `/pub/v1/calendar/detailed` endpoint. It reconciles that against a Google Calendar called **OFW** under this Google account:

- New OFW events are created on the Google Calendar.
- Changed OFW events are deleted and recreated on the Google Calendar (simplest way to handle all-day/timed and multi-day differences correctly).
- OFW events no longer present in the fetched window are deleted from the Google Calendar.
- Unchanged events (same content hash) are left alone.

**Sync window:** Each run fetches `CONFIG.PAST_DAYS` behind and `CONFIG.FUTURE_DAYS` ahead of today (default: 90 days back, 395 days forward) — OFW's API requires an explicit date range, there's no "list everything" option. An event outside that window looks identical to a deleted one, so widen the window if you need a longer horizon, or temporarily set `PAST_DAYS` very high for a one-time historical backfill.

**Credential storage:** Apps Script has no secret manager that works for an unattended time-triggered script (the password has to be readable by the script itself when the trigger fires, which rules out real encryption — the decryption key would have to sit right next to the ciphertext). Credentials are stored in Script Properties: encrypted at rest by Google, and visible only to someone who already has edit access to this Apps Script project. Credentials are never written into the source file — see Setup step 3 below.

### Setup (first time)

1. Go to [script.google.com](https://script.google.com) and create a new project under the Google account that should own the "OFW" calendar.
2. Paste the contents of `OfwSync.gs` into the editor. Adjust `CONFIG` at the top if you want a different calendar name, sync interval, or date window.
3. Store your OFW credentials (one-time):
   - Temporarily add this function anywhere in the file:
     ```js
     function _setupOfwCredentialsOnce() {
       setOfwCredentials('your-ofw-login-email@example.com', 'your-ofw-password');
     }
     ```
   - Select `_setupOfwCredentialsOnce` in the function dropdown and click **Run**. You'll be prompted to authorize the script.
   - Delete that function (and your password) from the file and save. The credentials now live only in Script Properties.
4. Run `syncOfwToCalendar()` once manually to do a first sync.
5. Run `createTrigger()` once to schedule automatic syncing (every `CONFIG.SYNC_INTERVAL_HOURS` hours; default 24). Safe to re-run at any time; it removes duplicate triggers automatically.
6. If a sync ever throws a parsing error, run `debugFetchRaw()` and check the logged JSON — OFW's internal API shape may have drifted from what the script expects.

### Available functions

| Function | Description |
|---|---|
| `setOfwCredentials(username, password)` | One-time credential setup — see Setup step 3. |
| `clearOfwCredentials()` | Removes stored OFW credentials and the cached auth token. |
| `syncOfwToCalendar()` | Main sync function — mirrors OFW calendar events to the "OFW" Google Calendar. |
| `createTrigger()` | Schedules `syncOfwToCalendar()` every `CONFIG.SYNC_INTERVAL_HOURS` hours. |
| `removeTrigger()` | Removes the time-based trigger (pauses automatic syncing). |
| `resetAndCleanup()` | Deletes all synced OFW events and clears sync state (keeps credentials) for a clean restart. |
| `debugFetchRaw()` | Logs the raw JSON OFW returns, for diagnosing a parsing error. |
