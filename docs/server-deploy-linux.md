# CLICK Server Deploy (Linux + nginx + systemd)

## 1) Run local CLICK webhook server

Service command:

```bash
cd /srv/ScrapRegosUserBot
npm run server
```

It listens on `CLICK_SERVER_PORT` (default `3000`).

## 2) nginx reverse proxy

Payment routes live on **aserver.tech** (not `no-thing.uz`). Config file:

`/srv/ScrapRegosUserBot/deploy/aserver.tech`

Routes proxied to port `3000`:

- `/api/orders/` — payment API (including Payme status check)
- `/api/prices` — public service prices JSON
- `/prices` — public prices page (bot `/prices`)
- `/click/`, `/pay`, `/health`
- `/bot-admin/api/`, `/bot-admin/auth/`, `/bot-admin/rights-meta`, `/bot-admin/mcp` — admin APIs only
- `/css/`, `/js/`, `/images/`, `/brand-logo.png` — public static assets
- order UUID pages (`/{uuid}`)
- `/sms-gateway/` — WebSocket SMS gateway for Android app (requires upgrade headers)

**Bot admin UI** (`/bot-admin/` SPA + `/bot-admin/assets/`) is served by nginx directly from `/srv/ScrapRegosUserBot/bot-admin-ui/dist/` — not by Node. Deep links fall back to `index.html`.

Existing webhook routes on the same host are unchanged (`/webhook`, `/api/v1/telegram/webhook/`).

### Deploy / update the React admin UI

Build the SPA, then reload nginx (no Node restart needed for UI-only changes):

```bash
cd /srv/ScrapRegosUserBot
npm ci --prefix bot-admin-ui
npm run bot-admin-ui:build
sudo cp /srv/ScrapRegosUserBot/deploy/aserver.tech /etc/nginx/sites-available/aserver.tech
sudo ln -sf /etc/nginx/sites-available/aserver.tech /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Restart `scrapregos-server` only when backend/API code or `.env` changes:

```bash
sudo systemctl restart scrapregos-server
```

**Emergency rollback:** restore a full `/bot-admin/` `proxy_pass` to `127.0.0.1:3000` in nginx (so Express serves the UI again), reload nginx, and optionally set `BOT_ADMIN_USE_LEGACY_UI=1` in `.env` for legacy `public/bot-admin/` HTML.

Also update `no-thing.uz` if it still had payment routes (Partner Bot only):

```bash
sudo cp /srv/ScrapRegosUserBot/no-thing.uz.conf /etc/nginx/sites-available/no-thing.uz.conf
sudo nginx -t && sudo systemctl reload nginx
```

WebSocket proxy blocks for the print tray agent and SMS gateway (add inside the `server` block):

```nginx
location /print-gateway/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400;
}

location /sms-gateway/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400;
}
```

## 3) CLICK merchant cabinet URLs

Set (use **aserver.tech** as the public payment host):

- Prepare URL: `https://aserver.tech/click/prepare`
- Complete URL: `https://aserver.tech/click/complete`

## 3.1) Payme cabinet

Payme uses the **Subscribe API** (receipts). No billing webhook URL is required.

- Create receipt server-side via `receipts.create`
- Client pays at `https://checkout.paycom.uz/{receipt_id}`
- Check status via `receipts.check` (`POST /api/orders/{order_id}/payme/check`)

## 4) systemd unit

Create `/etc/systemd/system/scrapregos-server.service`:

```ini
[Unit]
Description=ScrapRegosUserBot Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=app
Group=app
WorkingDirectory=/srv/ScrapRegosUserBot
ExecStart=/usr/bin/node apps/server/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable scrapregos-server
sudo systemctl start scrapregos-server
sudo systemctl status scrapregos-server
sudo systemctl restart scrapregos-server
```

## 5) Required environment variables

Set in `.env`:

- `CLICK_MERCHANT_ID`
- `CLICK_SERVICE_ID`
- `CLICK_MERCHANT_USER_ID`
- `CLICK_SECRET_KEY`
- `CLICK_RETURN_URL` (e.g. `https://aserver.tech/{order-uuid}`)
- `CLICK_SERVER_PORT`
- `PUBLIC_BASE_URL=https://aserver.tech` (payment page links like `https://aserver.tech/{order_id}`)
- `PAYME_MERCHANT_ID`, `PAYME_SECRET_KEY`, `PAYME_TEST_KEY`, `PAYME_TEST_MODE`, `PAYME_RETURN_URL` (optional Payme)
- `BOT_ADMIN_LOGIN`, `BOT_ADMIN_PASSWORD` (web admin at `/bot-admin/` — React SPA served by nginx from `bot-admin-ui/dist`)
- `REDIS_URL`, `SMS_GATEWAY_TOKEN` (SMS gateway; see [SMS gateway](sms-gateway.md)). Same `REDIS_URL` also backs short-TTL live portal search cache (`PORTAL_CACHE_*`; see `.env.example`).

Both `npm run server` and `npm run bot` need `REDIS_URL` in `.env`.

## 5.1) Redis (SMS queue + portal search cache)

Install and enable Redis on the host:

```bash
sudo apt install redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

Default bind is localhost (`127.0.0.1:6379`). Set `REDIS_URL=redis://127.0.0.1:6379` in `.env`.

Optional portal cache knobs (defaults apply when unset): `PORTAL_CACHE_ENABLED=0` to disable, `PORTAL_CACHE_TTL_BALANCE_SEC=60` for partner balances, `PORTAL_CACHE_TTL_SEC=120` for licenses/accounts/RPOS.

## 6) Bot admin and employees

Build the React admin UI if `bot-admin-ui/dist` is missing, reload nginx, then open `https://aserver.tech/bot-admin/` and sign in with `BOT_ADMIN_LOGIN` / `BOT_ADMIN_PASSWORD`.

```bash
npm run bot-admin-ui:build
sudo nginx -t && sudo systemctl reload nginx
```

1. Add employee phone and rights in the admin panel.
2. Employee opens the Telegram bot and sends the same phone to link their account.
3. `/report` sends earnings summary and Excel file (based on assigned rights).

## 7) Payment page

Open in browser:

`https://aserver.tech/ORDER_UUID`

The page loads payment options from:

`GET /api/orders/{order_id}/payments`
