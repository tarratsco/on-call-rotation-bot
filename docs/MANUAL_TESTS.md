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

4. `/oncall-skip 2026-02-24`
   - Expect skip confirmation with fallback user, or all-unavailable warning
5. `/oncall-override @onix.tarratscalderon 2026-03-02`
   - Expect admin override confirmation
6. `/oncall-swap @onix.tarratscalderon 2026-03-09`
   - If you are not assigned that week, expect a guard message

## 4) Config checks

Run in Slack:

7. `/oncall-config`
   - Expect current config values
8. `/oncall-config channel #social`
   - Expect reminder channel confirmation
9. `/oncall-config schedule Monday 09:00 America/New_York`
   - Expect schedule update confirmation
10. `/oncall-help`
   - Expect command summary list

## 5) Negative checks

Run in Slack:

11. `/oncall-add not-a-user`
   - Expect usage guidance
12. `/oncall-schedule 999`
   - Expect clamp to max weeks (12)
13. `/oncall-skip @someoneelse 2026-03-02`
   - As non-admin, expect rejection

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
