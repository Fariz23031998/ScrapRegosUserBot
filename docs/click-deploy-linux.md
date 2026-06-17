# CLICK Server Deploy (Linux + nginx + systemd)

## 1) Run local CLICK webhook server

Service command:

```bash
cd /srv/ScrapRegosUserBot
npm run click-server
```

It listens on `CLICK_SERVER_PORT` (default `3000`).

## 2) nginx reverse proxy

Use the ready-made config in the repo root: `no-thing.uz.conf`.

**Do not** proxy all of `/api/` to port 3000 if the same host already serves another API (e.g. Regos Partner Bot on `:8001`). Route only payment paths:

- `/api/orders/` → `:3000` (longer prefix wins over `/api` → `:8001`)
- `/click/`, `/pay`, `/bot-admin/`, payment static assets, order UUID pages

Copy to the server and reload:

```bash
sudo cp /srv/ScrapRegosUserBot/no-thing.uz.conf /etc/nginx/sites-available/no-thing.uz.conf
sudo ln -sf /etc/nginx/sites-available/no-thing.uz.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 3) CLICK merchant cabinet URLs

Set:

- Prepare URL: `https://your-domain/click/prepare`
- Complete URL: `https://your-domain/click/complete`

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
ExecStart=/usr/bin/node click-server.js
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
```

## 5) Required environment variables

Set in `.env`:

- `CLICK_MERCHANT_ID`
- `CLICK_SERVICE_ID`
- `CLICK_MERCHANT_USER_ID`
- `CLICK_SECRET_KEY`
- `CLICK_RETURN_URL`
- `CLICK_SERVER_PORT`
- `PUBLIC_BASE_URL` (used for payment page links like `https://your-domain/{order_id}`)
- `PAYME_MERCHANT_ID`, `PAYME_SECRET_KEY`, `PAYME_TEST_KEY`, `PAYME_TEST_MODE`, `PAYME_RETURN_URL` (optional Payme)
- `BOT_ADMIN_LOGIN`, `BOT_ADMIN_PASSWORD` (web admin at `/bot-admin/`)

## 6) Bot admin and employees

Open `https://your-domain/bot-admin/` and sign in with `BOT_ADMIN_LOGIN` / `BOT_ADMIN_PASSWORD`.

1. Add employee phone and rights in the admin panel.
2. Employee opens the Telegram bot and sends the same phone to link their account.
3. `/report` sends earnings summary and Excel file (based on assigned rights).

## 7) Payment page

Open in browser:

`https://your-domain/ORDER_UUID`

The page loads payment options from:

`GET /api/orders/{order_id}/payments`
