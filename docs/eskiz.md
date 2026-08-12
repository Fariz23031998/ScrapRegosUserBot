# Eskiz.uz SMS Gateway API

HTTP SMS API from [Eskiz.uz](https://eskiz.uz). Official Postman collection: [SMS Gateway by Eskiz.uz](https://documenter.getpostman.com/view/663428/TVK5eMco?version=latest#fa33daba-632d-4f50-8b2d-17cd9503478f).

**Base URL:** `https://notify.eskiz.uz`

Register / get credentials: [my.eskiz.uz](https://my.eskiz.uz/) · [eskiz.uz/sms](https://eskiz.uz/sms)

## Bot integration

Set these variables in the main project `.env`:

```dotenv
ENABLE_ESKIZ=1
ESKIZ_EMAIL=you@example.uz
ESKIZ_PASSWORD=your_api_password
# Optional approved alpha name and API base override:
# ESKIZ_FROM=ROFEEV
# ESKIZ_BASE_URL=https://notify.eskiz.uz
```

Eskiz is active only when `ENABLE_ESKIZ=1` and both credentials are nonblank. It sends one message after order creation using `ESKIZ_MESSAGE_TEMPLATE` when set; otherwise it falls back to `GETSMS_MESSAGE_TEMPLATE`, then the built-in default. The transport is independent of GETSMS, Android (`SMS_GATEWAY_ENABLED`), and MTProto — enabling several intentionally sends through each. Failures are isolated and recorded as `sms_failed`.

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
ESKIZ_MESSAGE_TEMPLATE="Оплата услуг ROFEEV TECHNOLOGY
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

The bot client caches the Bearer token from `/api/auth/login` and refreshes on `401` (`PATCH /api/auth/refresh`, then re-login if refresh fails).

A minimal standalone sender (without the bot) lives in [`eskiz-test/`](../eskiz-test/).

**Templates / moderation:** production SMS bodies must be approved by Eskiz before send. See the dedicated guide [`eskiz-templates.md`](eskiz-templates.md) and `npm run templates:list` / `templates:create` in `eskiz-test/`.

## Authentication

All messaging endpoints use a **Bearer token**.

### Get token

`POST /api/auth/login` — `multipart/form-data`

| Field | Required | Description |
|-------|----------|-------------|
| `email` | yes | Account email |
| `password` | yes | **API** password from the cabinet (not necessarily the web UI password) |

```bash
curl --location 'https://notify.eskiz.uz/api/auth/login' \
  --form 'email="you@example.uz"' \
  --form 'password="your_api_password"'
```

```json
{
  "message": "token_generated",
  "data": {
    "token": "YOUR_TOKEN"
  },
  "token_type": "bearer"
}
```

Use the token on later requests:

```http
Authorization: Bearer YOUR_TOKEN
```

### Refresh token

`PATCH /api/auth/refresh` — send the current Bearer token in the header (no body required).

```bash
curl --location --request PATCH 'https://notify.eskiz.uz/api/auth/refresh' \
  --header 'Authorization: Bearer YOUR_TOKEN'
```

Response shape matches login (`token_generated` + new `data.token`). Prefer refresh on `401`, then fall back to login if refresh fails. Cache the token; do not log in on every send.

---

## Message statuses

### Overall message status

| Status | Meaning |
|--------|---------|
| `NEW` | Pending send to the operator |
| `STORED` | Saved in DB; delivered only via `callback_url` path semantics |
| `ACCEPTED` | At least one part sent to the operator; no operator DLR yet |
| `PARTDELIVERED` | At least one part delivered |
| `DELIVERED` | Fully delivered |
| `REJECTED` | Often: number is blacklisted |

### Per-part status (`dlr_state` / part status)

| Status | Meaning |
|--------|---------|
| `NEW` | Pending send to the operator |
| `ACCEPTED` | Sent to operator; no DLR yet |
| `DELIVRD` | Delivered |
| `UNDELIV` / `UNDELIVERABLE` | Undelivered (e.g. subscriber blocked, debt) |
| `EXPIRED` | Validity window expired (unreachable) |
| `REJECTD` | Often: blacklist |
| `DELETED` | Submit error (e.g. bad sender) |
| `UNKNOWN` | Undefined |
| `ENROUTE` | In flight / undefined in-transit |

---

## Sending

### Send SMS (Uzbekistan)

`POST /api/message/sms/send` — `multipart/form-data`

| Field | Required | Description |
|-------|----------|-------------|
| `mobile_phone` | yes | Phone, e.g. `998991234567` |
| `message` | yes | SMS text |
| `from` | yes | Sender / nickname. Default short number is `4546`; replace with your approved alpha name |
| `callback_url` | no | URL that receives delivery status POSTs (see [Callbacks](#callbacks)) |

```bash
curl --location 'https://notify.eskiz.uz/api/message/sms/send' \
  --header 'Authorization: Bearer {your_token_here}' \
  --form 'mobile_phone="998990123456"' \
  --form 'message="Eskiz Test"' \
  --form 'from="4546"' \
  --form 'callback_url="https://example.com/sms-callback"'
```

Example response:

```json
{
  "id": "59bf10a2-aba8-4694-8fd5-0be20102a580",
  "message": "Waiting for SMS provider",
  "status": "waiting"
}
```

`id` is the **request_id** used in callbacks and reports.

### Send SMS broadcast (batch)

`POST /api/message/sms/send-batch` — `application/json`

```json
{
  "messages": [
    { "user_sms_id": "sms1", "to": 998990000000, "text": "eto test" },
    { "user_sms_id": "sms2", "to": 998980000000, "text": "eto test 2" }
  ],
  "from": "4546",
  "dispatch_id": 123,
  "callback_url": ""
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `messages` | yes | Array of `{ user_sms_id, to, text }` |
| `from` | yes | Sender / nickname |
| `dispatch_id` | no | Your broadcast id (used when querying by dispatch) |
| `callback_url` | no | Delivery webhook URL |

```bash
curl --location 'https://notify.eskiz.uz/api/message/sms/send-batch' \
  --header 'Authorization: Bearer {your_token_here}' \
  --header 'Content-Type: application/json' \
  --data '{
    "messages": [
      {"user_sms_id":"sms1","to": 998990000000, "text": "eto test"},
      {"user_sms_id":"sms2","to": 998980000000, "text": "eto test 2"}
    ],
    "from": "4546",
    "dispatch_id": 123
  }'
```

Example response:

```json
{
  "id": "03759b6d-c4db-449f-81c1-f625ab1bc1b4",
  "message": "Waiting for SMS provider",
  "status": ["waiting", "waiting"]
}
```

### Send international SMS

`POST /api/message/sms/send-global` — `multipart/form-data`

| Field | Required | Description |
|-------|----------|-------------|
| `mobile_phone` | yes | International number (no `+`) |
| `message` | yes | SMS text |
| `country_code` | yes | ISO country, e.g. `US` |
| `callback_url` | no | Delivery webhook URL |
| `unicode` | no | `1` for Cyrillic / UNICODE; `0` otherwise |

```bash
curl --location 'https://notify.eskiz.uz/api/message/sms/send-global' \
  --header 'Authorization: Bearer {your_token_here}' \
  --form 'mobile_phone="1234567891011"' \
  --form 'message="Test message"' \
  --form 'country_code="US"' \
  --form 'callback_url=""' \
  --form 'unicode="0"'
```

---

## Callbacks

Optional `callback_url` receives a **POST** when status updates. Payload shape:

```json
{
  "request_id": "UUID",
  "message_id": "4385062",
  "user_sms_id": "your_ID_here",
  "country": "UZ",
  "phone_number": "998991234567",
  "sms_count": "1",
  "status": "DELIVRD",
  "status_date": "2021-04-02 00:39:36"
}
```

`request_id` is the `id` returned by `send`, `send-batch`, or `send-global`.

---

## Reports

### Message details (list)

`POST /api/message/sms/get-user-messages` — `multipart/form-data`

Query param `status` (optional):

| Value | Meaning |
|-------|---------|
| _(empty)_ | All |
| `delivered` | Partially and fully delivered |
| `rejected` | Undelivered only |

Body fields:

| Field | Required | Description |
|-------|----------|-------------|
| `start_date` | yes | From, `%Y-%m-%d %H:%M` (e.g. `2023-11-01 00:00`) |
| `end_date` / `to_date` | yes | To, same format. Docs label `to_date`; curl examples use `end_date` |
| `page_size` | no | Page size **20–200** (default often 20) |
| `count` | no | `1` = summary by status; `0` = list |
| `is_ad` | no | empty = all; `1` = promotional; `0` = service |

```bash
curl --location 'https://notify.eskiz.uz/api/message/sms/get-user-messages' \
  --header 'Authorization: Bearer {your_token_here}' \
  --form 'start_date="2023-11-01 00:00"' \
  --form 'end_date="2023-11-02 23:59"' \
  --form 'page_size="20"' \
  --form 'count="0"'
```

Useful result fields (per message):

| Field | Description |
|-------|-------------|
| `id` | Message id |
| `user_sms_id` | Your id from batch send |
| `request_id` | Id from send / send-batch / send-global |
| `dispatch_id` | Broadcast id |
| `price` | Price per part; total ≈ `price * parts_count` |
| `is_ad` | Advertising flag |
| `nick` | Sender nickname |
| `to` | Destination phone |
| `message` | Text |
| `encoding` | `0` GSM 03.38, `1` ASCII, `8` UCS2 |
| `parts_count` | Number of parts |
| `parts` | Per-part accept/delivery info |
| `status` | Overall status (e.g. `DELIVERED`) |
| `smsc_data` | Status updates per part |
| `sent_at` / `delivery_sm_at` / `created_at` / `updated_at` | Timestamps |

Response is paginated (`current_page`, `next_page_url`, `result`, …) with top-level `"status": "success"`.

### Messages by broadcast

`POST /api/message/sms/get-user-messages-by-dispatch`

Same optional `status` query param as above.

| Field | Required | Description |
|-------|----------|-------------|
| `dispatch_id` | yes | Broadcast id from `send-batch` |
| `count` | no | `1` for status summary |
| `is_ad` | no | Filter promotional / service |

```bash
curl --location 'https://notify.eskiz.uz/api/message/sms/get-user-messages-by-dispatch' \
  --header 'Authorization: Bearer {your_token_here}' \
  --form 'dispatch_id="123"' \
  --form 'count="0"'
```

### Broadcast status summary

`POST /api/message/sms/get-dispatch-status`

| Field | Required | Description |
|-------|----------|-------------|
| `dispatch_id` | yes | Broadcast id |
| `user_id` | no | User id (docs list it; examples may omit) |
| `is_global` | no | e.g. `0` for domestic |

```bash
curl --location 'https://notify.eskiz.uz/api/message/sms/get-dispatch-status' \
  --header 'Authorization: Bearer {your_token_here}' \
  --form 'dispatch_id="123"' \
  --form 'is_global="0"'
```

Example response:

```json
{
  "status": "success",
  "data": [
    { "status": "DELIVERED", "total": 18 }
  ],
  "id": null
}
```

---

## Quick start checklist

1. Create / activate an account at [my.eskiz.uz](https://my.eskiz.uz/).
2. Copy email + **API password** from the cabinet.
3. `POST /api/auth/login` → store `data.token`.
4. Approve a nickname (alpha name) if you do not want the default `4546`.
5. `POST /api/message/sms/send` with `Authorization: Bearer …`.
6. Optionally set `callback_url` and/or poll `get-user-messages` by `request_id` / date range.
7. On `401`, `PATCH /api/auth/refresh`; if that fails, login again.

## Endpoint summary

| Action | Method | Path |
|--------|--------|------|
| Login | `POST` | `/api/auth/login` |
| Refresh token | `PATCH` | `/api/auth/refresh` |
| Send SMS | `POST` | `/api/message/sms/send` |
| Send batch | `POST` | `/api/message/sms/send-batch` |
| Send international | `POST` | `/api/message/sms/send-global` |
| List messages | `POST` | `/api/message/sms/get-user-messages` |
| List by dispatch | `POST` | `/api/message/sms/get-user-messages-by-dispatch` |
| Dispatch status | `POST` | `/api/message/sms/get-dispatch-status` |

Source: [Eskiz Postman — Sending](https://documenter.getpostman.com/view/663428/TVK5eMco?version=latest#fa33daba-632d-4f50-8b2d-17cd9503478f).
