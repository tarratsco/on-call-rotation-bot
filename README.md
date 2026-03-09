# On-Call Rotation Slack Bot (MVP)

Slack bot for fair weekly on-call assignment with round-robin rotation, override support, and weekly reminders.

## Documentation

- End-user guide: [docs/END_USER_MANUAL.md](docs/END_USER_MANUAL.md)
- One-page cheatsheet: [docs/CHEATSHEET.md](docs/CHEATSHEET.md)

## Prerequisites

- Node.js 22+
- A Slack workspace where you can install apps

## Step 1: Create the Slack App (first-time setup)

1. Open https://api.slack.com/apps and click **Create New App**.
2. Choose **From an app manifest**.
3. Select your workspace.
4. Paste the contents of [slack-app-manifest.yml](slack-app-manifest.yml).
5. Click **Create**.

The manifest preconfigures:
- Socket Mode
- Bot scopes: `chat:write`, `commands`, `users:read`, `im:write`
- Slash commands used by this bot

## Step 2: Enable Socket Mode + create App-Level token

1. In your Slack app, go to **Settings → Socket Mode** and ensure it is enabled.
2. Go to **Basic Information → App-Level Tokens**.
3. Create a token with scope `connections:write`.
4. Copy that token (starts with `xapp-...`) for `SLACK_APP_TOKEN`.

## Step 3: Install the app to your workspace

1. Go to **OAuth & Permissions**.
2. Click **Install to Workspace**.
3. Copy the **Bot User OAuth Token** (starts with `xoxb-...`) for `SLACK_BOT_TOKEN`.
4. Go to **Basic Information** and copy **Signing Secret** for `SLACK_SIGNING_SECRET`.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy env file:
   ```bash
   cp .env.example .env
   ```
3. Fill `.env` values:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `SLACK_APP_TOKEN`
   - Optional defaults: `INITIAL_ADMIN_IDS`, `REMINDER_*`
4. Start bot:
   ```bash
   npm start
   ```
5. In Slack, run:
   - `/oncall-help`
   - `/oncall-admin help`
   - `/oncall-set channel #your-channel`
   - `/oncall-set schedule Monday 09:00 America/New_York`
   - `/oncall-set rotation @user1 @user2 @user3`
   - `/oncall-reset schedule`
   - `/oncall-reset queue`
   - `/oncall-reset all confirm`
   - `/oncall-add @user1 @user2 @user3`

## Testing

### Run unit tests

```bash
npm test
```

The suite covers rotation logic, command handlers, reminder behavior, and edge cases.

### Seed temporary test users (no extra real Slack users required)

```bash
npm run seed:test-users
```

Optional environment variables:

- `TEST_USER_PREFIX` (default: `UTEST`)
- `TEST_USER_COUNT` (default: `4`)
- `TEST_USER_ADMIN_ID` (optional)
- `DB_PATH` (default: `./data/oncall.sqlite`)

Example:

```bash
TEST_USER_PREFIX=UDEMO TEST_USER_COUNT=5 npm run seed:test-users
```

### Cleanup seeded test users

```bash
npm run cleanup:test-users
```

Example:

```bash
TEST_USER_PREFIX=UDEMO npm run cleanup:test-users
```

## Slack Slash Commands

Slash commands are already defined in the manifest file. If you change command names later, update [slack-app-manifest.yml](slack-app-manifest.yml), run `npm run sync:manifest` to update [slack-app-manifest.json](slack-app-manifest.json), and re-apply the manifest in Slack.

- `/oncall`
- `/oncall-schedule`
- `/oncall-add`
- `/oncall-remove`
- `/oncall-list`
- `/oncall-override`
- `/oncall-set`
- `/oncall-reset`
- `/oncall-admin`
- `/oncall-help`

Admin configuration commands:

- `/oncall-admin help` — show current config + admin command help
- `/oncall-set channel #channel` — set reminder channel
- `/oncall-set schedule Monday 09:00 America/New_York` — set reminder schedule
- `/oncall-set rotation @user1 @user2 ... [apply-now]` — set queue order (optionally apply immediately)
- `/oncall-reset schedule` — clear schedule state only (keep active users)
- `/oncall-reset queue` — reset queue order + clear schedule state (keep active users)
- `/oncall-reset all confirm` — deactivate all active users + clear schedule state

To manually set starting queue order, use:

- `/oncall-set rotation @user1 @user2 @user3 ...`

Include each active participant exactly once in the desired order.

To reset schedule state while keeping users, use:

- `/oncall-reset schedule`

To reset queue order + schedule state while keeping users, use:

- `/oncall-reset queue`

To fully reset all active participants and schedule state, use:

- `/oncall-reset all confirm`

`/oncall-reset schedule` and `/oncall-reset queue` keep active participants. `/oncall-reset all confirm` deactivates all active participants. All three clear rotation history, overrides, and pending swaps/approvals.

`/oncall-add` supports one or more users in a single command:

- `/oncall-add @user`
- `/oncall-add @user1 @user2 @user3`

Channel input notes:

- `reminder_channel` is shown as a Slack channel mention (`<#CHANNEL_ID>`) in `/oncall-admin help` output.
- If you pass `/oncall-set channel #channel-name`, run it inside that same channel so the bot can resolve the ID.

## Notes

- Participants are manually managed (no auto-sync from channel members).
- Queue order is preserved across swaps/overrides; explicit week assignment is stored separately.
- If no assignee can be determined for a week, the reminder posts a warning and admins are DM’d.
- Config updates via `/oncall-set schedule ...` reload the reminder scheduler immediately.
- The command URLs in the manifest are placeholders for Socket Mode and are not used by this local MVP runtime.
