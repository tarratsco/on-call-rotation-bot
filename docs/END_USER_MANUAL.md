# On-Call Rotation Bot — End User Manual

## 1) What this bot does

The bot manages a weekly on-call rotation in Slack.

- Assigns who is on-call each week
- Shows upcoming schedule
- Supports admin overrides
- Sends weekly reminder messages to a configured channel

---

## 2) Who can run what

### Anyone

- `/oncall` — Show this week and next week on-call
- `/oncall-schedule [weeks]` — Show upcoming schedule (default 6, max 12; preview-only)
- `/oncall-list` — Show participants and queue order
- `/oncall-help` — Show command help

### Admin only

- `/oncall-add @user [@user2 ...]` — Add one or more participants
- `/oncall-remove @user` — Remove participant
- `/oncall-override @user [YYYY-MM-DD]` — Force assign a user for a week
- `/oncall-admin help` — Show current config + admin command help
- `/oncall-set channel #channel` — Set reminder channel
- `/oncall-set schedule Monday 09:00 America/New_York` — Set reminder schedule
- `/oncall-set rotation @user1 @user2 ... [apply-now]` — Manually set queue order (optional immediate apply). Saves this order as the rotation baseline.
- `/oncall-reset schedule` — Clear schedule state (keep active participants) and restore saved rotation baseline when available
- `/oncall-reset all confirm` — Deactivate all active participants + clear schedule state

Admin command notes:

- Running `/oncall-admin help` shows current config values and available admin commands.
- `reminder_channel` is displayed as a channel mention (`<#CHANNEL_ID>`) in output.
- When using `/oncall-set channel #channel-name`, run the command in that same channel.

---

## 3) First-time setup (admin)

1. Add participants:
   - `/oncall-add @alice`
   - `/oncall-add @bob`
2. Confirm roster:
   - `/oncall-list`
3. Configure reminder channel:
   - `/oncall-set channel #on-call`
4. Configure reminder schedule:
   - `/oncall-set schedule Monday 09:00 America/New_York`
5. (Optional) Clear schedule state after testing while keeping users:
   - `/oncall-reset schedule`
6. (Optional) Full destructive reset (deactivates all active users):
   - `/oncall-reset all confirm`
7. Verify config/help output:
   - `/oncall-admin help`

---

## 4) Common daily workflows

## Check who is on-call

- `/oncall`

## View upcoming rotation

- `/oncall-schedule`
- `/oncall-schedule 8`

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

- Verify reminder channel: `/oncall-set channel #on-call`
- Verify schedule config: `/oncall-set schedule Monday 09:00 America/New_York`
- Schedule changes apply immediately; no restart required

---

## 7) Quick command reference

- `/oncall`
- `/oncall-schedule [weeks]`
- `/oncall-list`
- `/oncall-add @user`
- `/oncall-add @user [@user2 ...]`
- `/oncall-remove @user`
- `/oncall-override @user [week]`
- `/oncall-admin help`
- `/oncall-set channel #channel`
- `/oncall-set schedule Monday 09:00 America/New_York`
- `/oncall-set rotation @user1 @user2 ... [apply-now]`
- `/oncall-reset schedule`
- `/oncall-reset all confirm`
- `/oncall-help`
