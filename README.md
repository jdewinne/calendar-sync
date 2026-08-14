# calendar-sync

Google Apps Scripts for keeping a work Google Calendar in sync and readable:

- **`BusySync.gs`** — mirrors "Busy" events from your personal calendar to your work calendar, without exposing event details.
- **`ColorExternalMeetings.gs`** — color codes meetings on your work calendar that include external attendees, so they stand out.

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
- Only events in the next 7 days are checked on each run.
- Runs automatically every morning at 7am via a time-based trigger.

### Setup (first time)

1. Go to [script.google.com](https://script.google.com) and create a new project under your **work** Google account (or add this file to an existing project).
2. Paste the contents of `ColorExternalMeetings.gs` into the editor.
3. Change `CONFIG.calendarId` and `CONFIG.internalDomains` at the top of the file to your work email and internal domain(s).
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
