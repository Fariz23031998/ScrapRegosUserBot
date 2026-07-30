# GETSMS.UZ HTTP SMS API

HTTP SMS gateway for Uzbekistan ([official API](https://getsms.uz/page/index/16)). It is integrated into the order-created SMS dispatcher and is independently controlled from the Android Redis WebSocket gateway documented in [`sms-gateway.md`](sms-gateway.md). If both are enabled, both send.

## Prerequisite

Tell GETSMS support your server’s **static public IP**. Requests from unknown hosts are rejected.

## Bot integration

Set these variables in the main project `.env`:

```dotenv
ENABLE_GETSMS=1
GETSMS_LOGIN=your_login
GETSMS_PASSWORD=your_password
# Optional registered alpha name and API override:
GETSMS_NICKNAME=ROFEEV
GETSMS_URL=http://185.8.212.184/smsgateway/
```

GETSMS is active only when `ENABLE_GETSMS=1` and both credentials are nonblank. It sends one message after order creation using the same `GETSMS_MESSAGE_TEMPLATE` as the Android WebSocket path. `SMS_GATEWAY_ENABLED` controls only the Android path; enabling both transports intentionally sends through both. Failures are isolated and recorded as `sms_failed`.

The default message is:

```text
Оплата услуг ROFEEV TECHNOLOGY
Ссылка на оплату создана на сумму {amount} {currency}.
Оплатить: {payment_page_url}
Служба поддержки (Telegram): {support_telegram_url}
Веб-сайт: {website_url}
Телефон: {support_phone}
```

Override it with a quoted multiline dotenv value:

```dotenv
GETSMS_MESSAGE_TEMPLATE="Оплата услуг ROFEEV TECHNOLOGY
Ссылка на оплату создана на сумму {amount} {currency}.
Оплатить: {payment_page_url}
Служба поддержки (Telegram): {support_telegram_url}
Веб-сайт: {website_url}
Телефон: {support_phone}"
```

Supported placeholders:

| Placeholder | Value |
|-------------|-------|
| `{amount}` | Order amount with spaces between thousands, e.g. `50 000` |
| `{currency}` | Order currency, default `UZS` |
| `{payment_page_url}` | Order payment page |
| `{support_telegram_url}` | `SMS_SUPPORT_TELEGRAM_URL`, default `https://t.me/EasyTradesupport_bot` |
| `{website_url}` | `SMS_WEBSITE_URL`, default `https://rofeev.uz` |
| `{support_phone}` | `SMS_SUPPORT_PHONE`, default `+998 55 705-00-30` |

## Endpoints

| Action | Method | URL |
|--------|--------|-----|
| Send SMS | `POST` | `http://185.8.212.184/smsgateway/` |
| Delivery status | `POST` | `http://185.8.212.184/smsgateway/status/` |

Body: `application/x-www-form-urlencoded`.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `login` | yes | Account login from GETSMS support |
| `password` | yes | Account password |
| `nickname` | no | One of your registered alpha names. If omitted, SMS is sent from a short number |
| `data` | yes | URL-encoded JSON array (see below) |

### Send — `data`

Array of up to **100** objects:

```json
[
  { "phone": "998901234567", "text": "Your SMS text" }
]
```

| Field | Format |
|-------|--------|
| `phone` | International number **without** `+` (e.g. `998901234567`) |
| `text` | UTF-8 SMS body |

### Status — `data`

Array with one object using `request_id` from a prior send response:

```json
[
  { "request_id": "52480252" }
]
```

## Send response

Success:

```json
[
  {
    "recipient": 998909711322,
    "text": "тестовое смс 1",
    "user_id": 1,
    "date_received": 1499493672,
    "message_id": 16854781,
    "request_id": 52480252,
    "client_ip": "185.8.212.184"
  }
]
```

Keep `request_id` to check delivery later.

Invalid phone (example):

```json
[
  {
    "error": 1,
    "error_text": "is NOT a phone number",
    "error_no": 300,
    "recipient": "+998909711322",
    "text": "text1",
    "user_id": 1,
    "date_received": 1499493758,
    "message_id": 20766930,
    "request_id": 76181024,
    "client_ip": "185.8.212.184"
  }
]
```

## Status response

```json
[
  {
    "recipient": "998909711322",
    "text": "Ваш текст смс",
    "user_id": "1",
    "date_received": "2018-07-08 10:40:34",
    "date_sent": "2018-07-08 10:40:34",
    "date_delivered": "2018-07-08 10:40:52",
    "message_id": "38457358",
    "request_id": "93786401",
    "status": "delivered",
    "count_messages": "1",
    "client_ip": "185.8.212.184",
    "description": "OK"
  }
]
```

## Error codes

| `error_no` | Meaning |
|------------|---------|
| `100` | Login or password is null |
| `101` | Incorrect login or password |
| `102` | Account blocked |
| `103` | Limit is over |
| `200` | `data` is not valid JSON |
| `201` | `data` array is invalid |
| `202` | Nickname not set |
| `203` | Incorrect nickname |
| `300` | Not a phone number (seen on bad `phone`) |
| `400` | `request_id` is wrong |

Auth/account errors often look like:

```json
[
  { "error": 1, "text": "Incorrect Login or Password", "error_no": 101 }
]
```

## Example (cURL)

```bash
curl -X POST 'http://185.8.212.184/smsgateway/' \
  --data-urlencode 'login=YOUR_LOGIN' \
  --data-urlencode 'password=YOUR_PASSWORD' \
  --data-urlencode 'nickname=YOUR_NICK' \
  --data-urlencode 'data=[{"phone":"998901234567","text":"Test SMS"}]'
```

## Standalone local tester

The separate minimal Node project can still send one SMS without running the bot: [`getsms-test/`](../getsms-test/).

```bash
cd getsms-test
cp .env.example .env   # fill login, password, phone, text
npm install
npm run send
```
