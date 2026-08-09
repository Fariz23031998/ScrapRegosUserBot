# ScrapRegosUserBot

Telegram bot and data pipeline for looking up Regos clients. It scrapes partner, license, and account data from the Regos billing portals (via authenticated Playwright sessions), stores everything in a local SQLite database, and exposes it through a Telegram bot plus an HTTP server for payments (CLICK / Payme), a bot-admin panel, and an SMS gateway.

## Data sources

| Source | Portal | What is synced |
|--------|--------|----------------|
| Regos (sb) | `https://sb.regos.uz` | Partners, partner accounts |
| EasyTrade | `https://my.easytrade.uz` | Licenses |
| VCR Billing (vcr1) | `https://vcr1.regos.uz` | Partners, licenses |
| RPOS (Chayxanshik) | Django admin | Clients, accounts (optional per account) |

All portals authenticate through the shared **Regos ID** SSO. Support status ("Срок технической поддержки истёк") is derived from a record's registration/creation date using a 90-day rule — never from a license's own `support` field. Paid technical-support subscriptions (linked by customer phone) replace the expired badge with `Есть платные подписки ТП` while active.

## Requirements

- **Node.js 22+** (the project uses the built-in `node:sqlite` module — no native build step)
- **Playwright Chromium** browser (installed via `npx playwright install chromium`)
- **Windows** for the bundled service/scheduled-task scripts (the app itself is cross-platform; see [docs/server-deploy-linux.md](docs/server-deploy-linux.md) for Linux)
- Optional: **Redis** if you enable the Android SMS gateway (GETSMS HTTP does not require it)

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Install the Playwright browser
npx playwright install chromium

# 3. Create your environment file
copy .env.example .env    # Windows
# cp .env.example .env    # Linux/macOS
```

Then edit `.env` and fill in the values (see [Configuration](#configuration)).

## Configuration

Environment variables live in `.env` at the project root. Key groups:

### Regos accounts (required for sync)

Two accounts are configured by default, `BUKHARA` and `SAMARKAND`. Each needs a Regos ID phone and password:

```
BUKHARA_REGOS_AUTH_PHONE=+998000000001
BUKHARA_REGOS_AUTH_PASSWORD=your_password
SAMARKAND_REGOS_AUTH_PHONE=+998000000002
SAMARKAND_REGOS_AUTH_PASSWORD=your_password
```

### Telegram bot (required to run the bot)

```
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_BOT_USERNAME=@YourBot
```

### Other integrations (optional)

- **Bot admin panel**: `BOT_ADMIN_LOGIN`, `BOT_ADMIN_PASSWORD` (enables `/bot-admin/`). Password login remains available. Employees with the `open_admin_dashboard` right can also use `/open_dashboard` in Telegram to receive a one-time HTTPS login link (about 5 minutes, single use) built from `PUBLIC_BASE_URL`. Configure technical-support prices and view subscription history under **Техподдержка**.
- **CLICK payments (optional)**: `ENABLE_CLICK_PAYMENT=1` plus `CLICK_MERCHANT_ID`, `CLICK_SERVICE_ID`, `CLICK_MERCHANT_USER_ID`, `CLICK_SECRET_KEY` — see [docs/payme-integration.md](docs/payme-integration.md) and [docs/click-deploy-linux.md](docs/click-deploy-linux.md). With `ENABLE_CLICK_PAYMENT=0` (or blank keys) the bot and server run on Payme only: no CLICK button on the payment page, new orders use the `payme` provider, and `/click/prepare` / `/click/complete` reply with `error: -9`.
- **Payment links**: `PUBLIC_BASE_URL`, `CLICK_SERVER_PORT` — `PUBLIC_BASE_URL` is required for payment pages, tech-support orders, Telegram dashboard login links, and the public `/prices` page opened by the bot `/prices` command.
- **Payme receipts**: `PAYME_*`
- **SMS transports**: Android uses `SMS_GATEWAY_ENABLED`, `REDIS_URL`, and `SMS_GATEWAY_TOKEN`; GETSMS.UZ uses `ENABLE_GETSMS`, `GETSMS_LOGIN`, and `GETSMS_PASSWORD`. The switches are independent and both providers may send. Both use the same one-message `GETSMS_MESSAGE_TEMPLATE` — see [docs/sms-gateway.md](docs/sms-gateway.md) and [docs/getsms.md](docs/getsms.md)
- **RPOS (optional)**: `{ACCOUNT}_RPOS_USERNAME`, `{ACCOUNT}_RPOS_PASSWORD`

See `.env.example` for the full annotated list.

### Access lists

- `config/access/users_phones.txt` — phone numbers allowed to use the bot as employees
- `config/access/vip_clients.txt` — VIP phone numbers (Support-expired banner is suppressed for these)

## Running

The project has two long-running processes (the bot and the HTTP server) and a set of one-off/scheduled sync jobs.

### Telegram bot

```bash
npm run bot
```

Starts the Telegram bot (long-polling). Users share their phone number to register; employees can then search by phone, license code, or API login.

Employees with the `open_admin_dashboard` right see **Open Admin Dashboard** (`/open_dashboard`) in the command menu. The command issues a one-time login link for `/bot-admin/` tied to their Telegram ID (login/password remains a fallback).

### Technical support subscriptions

1. Configure prices for 1 / 3 / 6 / 12 months in `/bot-admin/technical-support` (amounts are integer UZS; `0` means the duration is hidden in the bot).
2. Grant the employee the `create_technical_support` right in the Admin UI. When that employee searches a customer whose result has a phone number, the bot shows **Добавить услуги** and **Добавить ТП** on the same row.
3. **Добавить ТП** opens duration buttons with the current Admin prices. Selecting a duration creates a pending payment order (amount/duration are stored on the order and stay fixed even if prices change later).
4. Coverage activates only after online payment (Payme, or CLICK when enabled) or cash close. Renewals stack from `max(payment time, current paid end)` using calendar months.
5. Active coverage replaces the expired-support warning with `Есть платные подписки ТП`. VIP remains independent.

### HTTP server (payments, bot-admin, SMS gateway)

```bash
npm run server
```

Serves the payment pages, CLICK/Payme endpoints, the `/bot-admin/` panel, the public bilingual price list at `/prices`, and the SMS gateway WebSocket. Listens on `CLICK_SERVER_PORT` (default `3000`).

Public price catalog: open `/prices` (Russian / O‘zbekcha switch). Edit it after logging into `/bot-admin/prices`. The Telegram `/prices` command is available to everyone and opens the public page.

### Data sync

Run the full daily sync for all configured accounts (Regos partners + accounts, EasyTrade licenses, vcr1 partners + licenses, and RPOS when configured). This logs in with the account credentials from `.env` and logs out afterwards:

```bash
npm run sync:all
```

Sync a single source (useful for verification/debugging):

```bash
npm run sync:vcr1        # vcr1 partners + licenses (both accounts)
npm run sync:rpos        # RPOS clients + accounts
npm run sync             # sb partners (uses a saved interactive session)
npm run sync:accounts    # sb partner accounts (saved session)
npm run sync:licenses    # EasyTrade licenses (saved session)
```

`sync:all` and `sync:vcr1` log in automatically using the `*_REGOS_AUTH_*` credentials. The standalone `sync`, `sync:accounts`, and `sync:licenses` scripts reuse a saved browser session instead — create it once with the interactive login commands below.

### Interactive login (for saved-session scripts)

```bash
npm run login            # opens a browser to sign in to sb.regos.uz; saves data/auth/auth-state.json
npm run login:easytrade  # signs in to EasyTrade; saves data/auth/auth-state-easytrade.json
```

### JSON import (offline fallback)

If you have exported table JSON, you can import without scraping:

```bash
npm run import:json            # partners
npm run import:accounts-json   # partner accounts
npm run import:licenses-json   # licenses
```

## How search works

Send the bot (or call `searchUser`) a phone number, license code, serial, or partner API login. Matches from all sources are returned together. For each result the bot checks the relevant date (partner `registered_at`, license `generated`/creation, etc.) and prepends `Срок технической поддержки истёк` when the record is older than 90 days. VIP-listed phones never see the expired banner.

## Deployment (Windows)

Install the bot as an auto-restarting Windows service (run from an elevated terminal):

```bash
npm run service:install     # install + start the bot service
npm run service:uninstall   # stop + remove it
```

Schedule the daily data sync (runs `sync:all` at 19:00):

```bash
npm run task:install        # register the scheduled task
npm run task:uninstall      # remove it
```

Sync logs are written to `logs/sync-YYYY-MM-DD.log`.

For Linux deployment see [docs/server-deploy-linux.md](docs/server-deploy-linux.md).

## Project layout

```
apps/
  bot/        Telegram bot entry point (npm run bot)
  server/     Express server: payments, bot-admin, SMS gateway (npm run server)
cli/          One-off and scheduled sync/login/import scripts
src/
  admin/      Bot admin panel (users, rights, tech-support prices)
  bot/        Search, formatting, VIP/service/report/tech-support handlers
  db/         SQLite schema, upserts, queries (data/regos.db)
  sync/       Auth + DataTables API clients per portal
  payments/   CLICK and Payme integrations
  sms/        GETSMS HTTP client + Redis-backed Android SMS gateway
  paths.js    Central path resolver (data/, logs/, config/, public/)
config/access/ Employee and VIP phone lists
data/          SQLite DB and saved auth sessions (gitignored)
docs/          Integration and deployment guides
scripts/       Windows service + scheduled-task installers
```

## Data & logs

- Database: `data/regos.db` (SQLite, WAL mode) — created automatically on first run
- Saved auth sessions: `data/auth/*.json`
- Sync logs: `logs/sync-YYYY-MM-DD.log`

## Further docs

- [docs/payme-integration.md](docs/payme-integration.md) — Payme receipts setup
- [docs/click-deploy-linux.md](docs/click-deploy-linux.md) — CLICK deployment
- [docs/server-deploy-linux.md](docs/server-deploy-linux.md) — Linux server deployment
- [docs/regos-webhook-troubleshooting.md](docs/regos-webhook-troubleshooting.md) — verify REGOS webhook delivery and ticket SSE updates on Ubuntu
- [docs/sms-gateway.md](docs/sms-gateway.md) / [docs/getsms.md](docs/getsms.md) — SMS gateway
