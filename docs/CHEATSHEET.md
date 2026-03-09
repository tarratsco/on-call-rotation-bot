# On-Call Rotation Bot — One-Page Cheatsheet

Quick reference for day-to-day Slack usage.

## Quick Setup (Admin)

Use these once to get a new workspace ready for weekly reminders and fair assignments.

1. `/oncall-add @user1` — add first participant to the active queue
2. `/oncall-add @user2` — add additional participants
3. `/oncall-set channel #on-call` — set where reminder messages are posted
4. `/oncall-set schedule Monday 09:00 America/New_York` — set reminder day/time/timezone
5. `/oncall-admin help` — verify saved config and view admin commands

## Core Commands (Anyone)

These are the day-to-day commands for participants to view schedule status and handle coverage changes.

- `/oncall` — show this week + next week assignee
- `/oncall-schedule [weeks]` — upcoming rotation (default 6, max 12)
- `/oncall-list` — active participants in queue order
- `/oncall-help` — show command list

## Admin Commands

These commands are restricted to admins and control roster management, scheduling, and configuration.

- `/oncall-add @user [@user2 ...]` — add one or more participants to the rotation queue
- `/oncall-remove @user` — remove/deactivate a participant from the active queue
- `/oncall-override @user [YYYY-MM-DD]` — force assign on-call for a specific week
- `/oncall-admin help` — show current config + admin command help
- `/oncall-set channel #channel` — set reminder destination channel
- `/oncall-set schedule Monday 09:00 America/New_York` — set reminder cadence (applies immediately)
- `/oncall-set rotation @user1 @user2 ... [apply-now]` — set manual queue order
- `/oncall-reset schedule` — clear schedule state only (keep active users)
- `/oncall-reset all confirm` — deactivate all active users + clear schedule state

## Common Recovery Flows

Use these when testing data, queue order, or reminder setup needs to be corrected quickly.

### Rebuild queue order

Use when the assignment order looks wrong or you want to set a specific starting sequence.

1. `/oncall-list`
2. `/oncall-set rotation @user1 @user2 @user3 ...`

Rule: include each active participant exactly once.

### Clear schedule state but keep users

Use when override/history state needs reset but participant roster is correct.

- `/oncall-reset schedule`

Clears rotation history, overrides, pending swaps, and pending approvals.

### Reset test state completely

Use when test override/history state has polluted the current schedule.

- `/oncall-reset all confirm`

This deactivates all active participants and clears rotation history, overrides, pending swaps, and pending approvals.

### Set reminder channel

Use when reminders are posting in the wrong place or no channel is configured.

- Preferred: `/oncall-set channel #channel-name` (run inside that same channel)
- Alternative: `/oncall-set channel CHANNEL_ID`

`/oncall-admin help` displays `reminder_channel` as a Slack channel mention (`<#CHANNEL_ID>`).

## Useful Local Test Scripts

Use these terminal commands for local verification and synthetic test data workflows.

- `npm test` — run the unit test suite
- `npm run seed:test-users` — create temporary synthetic participants
- `npm run cleanup:test-users` — remove previously seeded synthetic participants
