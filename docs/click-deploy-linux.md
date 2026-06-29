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

`/srv/RegosWholeSale/deploy/aserver.tech`

Routes proxied to port `3000`:

- `/api/orders/` — payment API
- `/click/`, `/pay`, `/bot-admin/`, payment static assets, order UUID pages
- `/sms-gateway/` — WebSocket SMS gateway for Android app (requires upgrade headers)

Existing webhook routes on the same host are unchanged (`/webhook`, `/api/v1/telegram/webhook/`).

Copy to the server and reload:

```bash
sudo cp /srv/RegosWholeSale/deploy/aserver.tech /etc/nginx/sites-available/aserver.tech
sudo ln -sf /etc/nginx/sites-available/aserver.tech /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Also update `no-thing.uz` if it still had payment routes (Partner Bot only):

```bash
sudo cp /srv/ScrapRegosUserBot/no-thing.uz.conf /etc/nginx/sites-available/no-thing.uz.conf
sudo nginx -t && sudo systemctl reload nginx
```

WebSocket proxy block for the SMS gateway (add inside the `server` block for aserver.tech):

```nginx
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

Create `/etc/systemd/system/scrapregos-click.service`:

```ini
[Unit]
Description=ScrapRegosUserBot CLICK Webhook Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=app
Group=app
WorkingDirectory=/srv/ScrapRegosUserBot
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable scrapregos-click
sudo systemctl start scrapregos-click
sudo systemctl status scrapregos-click
sudo systemctl restart scrapregos-click
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
- `BOT_ADMIN_LOGIN`, `BOT_ADMIN_PASSWORD` (web admin at `/bot-admin/`)
- `REDIS_URL`, `SMS_GATEWAY_TOKEN` (SMS gateway; see [SMS gateway](sms-gateway.md))

Both `npm run server` and `npm run bot` need `REDIS_URL` in `.env`.

## 5.1) Redis (SMS queue)

Install and enable Redis on the host:

```bash
sudo apt install redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

Default bind is localhost (`127.0.0.1:6379`). Set `REDIS_URL=redis://127.0.0.1:6379` in `.env`.

## 6) Bot admin and employees

Open `https://aserver.tech/bot-admin/` and sign in with `BOT_ADMIN_LOGIN` / `BOT_ADMIN_PASSWORD`.

1. Add employee phone and rights in the admin panel.
2. Employee opens the Telegram bot and sends the same phone to link their account.
3. `/report` sends earnings summary and Excel file (based on assigned rights).

## 7) Payment page

Open in browser:

`https://aserver.tech/ORDER_UUID`

The page loads payment options from:

`GET /api/orders/{order_id}/payments`
