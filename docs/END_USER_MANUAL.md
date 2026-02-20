# On-Call Rotation Bot — End User Manual

## 1) What this bot does

The bot manages a weekly on-call rotation in Slack.

- Assigns who is on-call each week
- Shows upcoming schedule
- Supports skips, swaps, and admin overrides
- Sends weekly reminder messages to a configured channel

---

## 2) Who can run what

### Anyone

- `/oncall` — Show this week and next week on-call
- `/oncall-schedule [weeks]` — Show upcoming schedule (default 6, max 12)
- `/oncall-list` — Show participants and queue order
- `/oncall-swap @user [YYYY-MM-DD]` — Request a swap for your on-call week
- `/oncall-swap accept @user [YYYY-MM-DD]` — Accept a swap request
- `/oncall-swap decline @user [YYYY-MM-DD]` — Decline a swap request
- `/oncall-skip [YYYY-MM-DD]` — Mark yourself unavailable for a week
- `/oncall-help` — Show command help

### Admin only

- `/oncall-add @user` — Add participant
- `/oncall-remove @user` — Remove participant
- `/oncall-override @user [YYYY-MM-DD]` — Force assign a user for a week
- `/oncall-swap @user1 @user2 [YYYY-MM-DD]` — Admin swap/assign flow
- `/oncall-config ...` — View/update reminder settings

---

## 3) First-time setup (admin)

1. Add participants:
   - `/oncall-add @alice`
   - `/oncall-add @bob`
2. Confirm roster:
   - `/oncall-list`
3. Configure reminder channel:
   - `/oncall-config channel #on-call`
4. Configure reminder schedule:
   - `/oncall-config schedule Monday 09:00 America/New_York`

---

## 4) Common daily workflows

## Check who is on-call

- `/oncall`

## View upcoming rotation

- `/oncall-schedule`
- `/oncall-schedule 8`

## Request a swap (current on-call user)

1. Request:
   - `/oncall-swap @teammate 2026-03-02`
2. Teammate accepts in Slack:
   - `/oncall-swap accept @yourname 2026-03-02`

## Mark yourself unavailable

- `/oncall-skip`
- `/oncall-skip 2026-03-09`

---

## 5) Testing without real extra Slack users

You can seed temporary database-only users for local testing.

### Seed test users

- `npm run seed:test-users`

Optional environment variables:

- `TEST_USER_PREFIX` (default: `UTEST`)
- `TEST_USER_COUNT` (default: `4`)
- `TEST_USER_ADMIN_ID` (optional)
- `DB_PATH` (defaults to `./data/oncall.sqlite`)

Example:

- `TEST_USER_PREFIX=UDEMO TEST_USER_COUNT=5 npm run seed:test-users`

### Cleanup seeded users

- `npm run cleanup:test-users`

Example:

- `TEST_USER_PREFIX=UDEMO npm run cleanup:test-users`

Note: seeded users are not real Slack accounts; the bot shows their display names in lists/schedules for readability.

---

## 6) Troubleshooting

## Command shows no response

- Ensure the bot process is running
- Restart the bot after code/config changes
- Check logs for Slack API failures

## "Admin access required"

- Add your Slack user ID to `INITIAL_ADMIN_IDS` in `.env`
- Or ensure your user is marked admin in `team_members`

## Users appear blank in `/oncall-list`

- Use the latest version with display-name fallback for seeded users
- Re-seed users if needed: `npm run seed:test-users`

## Reminder not posting

- Verify reminder channel: `/oncall-config channel #on-call`
- Verify schedule config: `/oncall-config schedule Monday 09:00 America/New_York`
- Restart bot after schedule changes

---

## 7) Quick command reference

- `/oncall`
- `/oncall-schedule [weeks]`
- `/oncall-list`
- `/oncall-add @user`
- `/oncall-remove @user`
- `/oncall-skip [week]`
- `/oncall-swap ...`
- `/oncall-override @user [week]`
- `/oncall-config ...`
- `/oncall-help`
