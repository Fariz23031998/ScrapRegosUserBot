# CLICK Server Deploy (Linux + nginx + systemd)

## 1) Run local CLICK webhook server

Service command:

```bash
cd /srv/ScrapRegosUserBot
npm run click-server
```

It listens on `CLICK_SERVER_PORT` (default `3000`).

## 2) nginx reverse proxy

Add to your site config:

```nginx
location /click/ {
  proxy_pass http://127.0.0.1:3000/click/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /pay {
  proxy_pass http://127.0.0.1:3000/pay;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /api/ {
  proxy_pass http://127.0.0.1:3000/api/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /css/ {
  proxy_pass http://127.0.0.1:3000/css/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /js/ {
  proxy_pass http://127.0.0.1:3000/js/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location ~ ^/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

Reload nginx:

```bash
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

## 6) Payment page

Open in browser:

`https://your-domain/ORDER_UUID`

The page loads payment options from:

`GET /api/orders/{order_id}/payments`
