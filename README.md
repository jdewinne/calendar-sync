# calendar-sync

A Google Apps Script that mirrors "Busy" events from your personal Google Calendar to your work calendar, without exposing event details.

## How it works

The script runs entirely under your **personal** Google account. It reads events from your primary personal calendar and creates matching "Busy" events on a secondary calendar called **Work Busy Sync**. Each Busy event invites your work email as a guest, so it appears on your work calendar automatically.

**Rules:**
- Events marked "Free" (transparent) are ignored — only "Busy" (opaque) events are mirrored.
- Recurring events are mirrored as a single recurring Busy event (same RRULE), not one invite per instance.
- Individually modified or cancelled occurrences within a recurring series are best-effort mirrored.
- The sync runs every 15 minutes via a time-based trigger.

## Setup (first time)

1. Go to [script.google.com](https://script.google.com) and create a new project under your **personal** Google account.
2. Paste the contents of `Code.gs` into the editor.
3. Change `WORK_EMAIL` at the top of the file to your real work email address.
4. Add the **Google Calendar API** service:
   - Click **Services** (the `+` icon in the left sidebar).
   - Select **Google Calendar API** and click **Add**.
5. Run `syncBusyToWork()` once manually to do a fresh initial sync.
   - You will be prompted to authorize the script the first time.
6. Run `createTrigger()` once to set up the 15-minute recurring sync.
   - This is safe to re-run at any time; it removes duplicate triggers automatically.

## Updating from an earlier version

1. Open your existing project at [script.google.com](https://script.google.com).
2. Select all, delete, and paste the new `Code.gs` content in.
3. Run `resetAndCleanup()` **once**. This deletes all events the old script created and clears the sync state so the next run starts clean.
4. Run `syncBusyToWork()` once manually to do a fresh sync.
5. Run `createTrigger()` to ensure the trigger is set up correctly.

## Available functions

| Function | Description |
|---|---|
| `syncBusyToWork()` | Main sync function — mirrors personal Busy events to the work calendar. |
| `createTrigger()` | Sets up a time-based trigger to run `syncBusyToWork()` every 15 minutes. |
| `removeTrigger()` | Removes the time-based trigger (pauses automatic syncing). |
| `resetAndCleanup()` | Deletes all synced Busy events and clears sync state for a clean restart. |
