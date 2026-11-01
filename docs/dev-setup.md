# Development environment

Local setup for the Telegram bot, HTTP server, and REGOS ticket webhook.

## Requirements

- Node.js 22+
- [ngrok](https://ngrok.com/download) (needed to receive REGOS webhooks on your machine)

## Install

From the project root:

```powershell
npm install
npm install --prefix bot-admin-ui
npx playwright install chromium
copy .env.example .env
```

`bot-admin-ui` is its own package. The root install does not put `vite` on that package’s path, so `npm run bot-admin-ui:dev` fails until the second install runs.

Edit `.env` and set at least:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
REGOS_INTEGRATION_TOKEN=your_regos_integration_token
CLICK_SERVER_PORT=3000
```

`REGOS_INTEGRATION_TOKEN` must be the same value REGOS sends as `connected_integration_id`. The server rejects webhooks when it is missing or does not match.

## Run the app

HTTP server (payments, `/bot-admin/`, webhook) on port `3000`:

```powershell
npm run server
```

Telegram bot, in a second terminal:

```powershell
npm run bot
```

Admin UI with hot reload, in a third terminal (optional):

```powershell
npm run bot-admin-ui:dev
```

Open http://localhost:5301/bot-admin/ while the server is running.

## REGOS webhook through ngrok

REGOS calls a public HTTPS URL. Your machine is not reachable from the internet, so proxy the local server with ngrok.

1. Sign in once (free account is enough):

```powershell
ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
```

2. With `npm run server` already listening on port `3000`, start the tunnel:

```powershell
ngrok http 3000
```

3. Copy the `https://….ngrok-free.app` forwarding URL from the ngrok window.

4. In REGOS, set the webhook URL to:

```text
https://YOUR-SUBDOMAIN.ngrok-free.app/api/regos/webhook
```

5. Point local links at the same public origin so payment pages and dashboard links match the tunnel:

```env
PUBLIC_BASE_URL=https://YOUR-SUBDOMAIN.ngrok-free.app
```

Restart `npm run server` after changing `.env`.

The tunnel URL changes each time you start ngrok (unless you use a reserved domain). Update the REGOS webhook URL and `PUBLIC_BASE_URL` when it changes.

### Check the route

Replace the host and token, then send an ignored test event. A `200` with `Event ignored` means ngrok, the server, and the token check all work. It does not change a ticket.

```powershell
curl.exe -sS -i -H "Content-Type: application/json" -d "{\"action\":\"HandleWebhook\",\"event_id\":\"dev-route-test\",\"connected_integration_id\":\"YOUR_REGOS_INTEGRATION_TOKEN\",\"data\":{\"action\":\"WebhookRouteTest\",\"data\":{}}}" https://YOUR-SUBDOMAIN.ngrok-free.app/api/regos/webhook
```

Expected body:

```json
{"ok":true,"message":"Event ignored"}
```

Inspect live requests at http://127.0.0.1:4040 (ngrok's local inspector).
