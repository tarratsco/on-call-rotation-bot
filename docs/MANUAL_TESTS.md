# Manual Slack Test Commands

Use this checklist to validate bot behavior manually in Slack.

## Preconditions

- Bot process is running
- Slack app is installed and slash commands are available
- You have admin access (for admin-only commands)

## 1) Seed temporary participants

Run in terminal:

```bash
npm run seed:test-users
```

Expected:
- Script reports seeded users (default prefix `UTEST`)

## 2) Core visibility checks

Run in Slack:

1. `/oncall-list`
   - Expect multiple participants in order
   - Expect seeded users to show readable names (not blank placeholders)
2. `/oncall`
   - Expect "This week" and "Next week" on-call output
3. `/oncall-schedule 6`
   - Expect a 6-week schedule output

## 3) Operational flow checks

Run in Slack:

4. `/oncall-override @onix.tarratscalderon 2026-03-02`
   - Expect admin override confirmation

## 4) Config checks

Run in Slack:

5. `/oncall-admin help`
   - Expect current config values and available subcommands
   - Expect `reminder_channel` to render as a channel mention (`<#...>`)
6. `/oncall-set channel #social`
   - Run this command in `#social`
   - Expect reminder channel confirmation
7. `/oncall-set schedule Monday 09:00 America/New_York`
   - Expect schedule update confirmation with scheduler reload (no restart needed)
8. `/oncall-reset schedule`
   - Expect schedule-state reset confirmation and active users kept
9. `/oncall-set rotation @user1 @user2 @user3`
   - Expect queue reorder confirmation
10. `/oncall-reset all confirm`
   - Expect full reset confirmation with active users deactivated
11. `/oncall-help`
   - Expect command summary list

## 5) Negative checks

Run in Slack:

12. `/oncall-add not-a-user`
   - Expect usage guidance
13. `/oncall-schedule 999`
   - Expect clamp to max weeks (12)
14. `/oncall-set channel #different-channel`
   - If run outside that channel, expect usage guidance

## 6) Cleanup temporary participants

Run in terminal:

```bash
npm run cleanup:test-users
```

Expected:
- Script reports removed users

## Optional variants

Use env vars to control seeded test users:

```bash
TEST_USER_PREFIX=UDEMO TEST_USER_COUNT=5 npm run seed:test-users
TEST_USER_PREFIX=UDEMO npm run cleanup:test-users
```
