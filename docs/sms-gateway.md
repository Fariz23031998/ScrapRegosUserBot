# SMS transports (Android Redis gateway + GETSMS + Eskiz)

After an order is created in the Telegram employee flow, the bot can send through independent transports:

- Android: queues one multiline payment message in Redis. A dedicated Android app receives it over WebSocket and sends it natively.
- GETSMS.UZ: sends a payment message directly over HTTP.
- Eskiz.uz: sends a payment message over HTTP with a Bearer token.

`SMS_GATEWAY_ENABLED` controls Android, `ENABLE_GETSMS` controls GETSMS, and `ENABLE_ESKIZ` controls Eskiz. Enabling several intentionally sends through each provider, so the customer may receive messages from each. Each transport can use its own message template (see below).

## Flow

1. Employee creates an order in the Telegram bot.
2. `apps/bot/index.js` enqueues an SMS job in Redis (`sms:pending` + `sms:job:{id}`).
3. `apps/server/index.js` pushes the job to the connected Android device via WebSocket.
4. The Android app sends the SMS with `SmsManager` and sends a result ack.
5. The server writes `sms_sent` or `sms_failed` to `order_logs`.

The GETSMS HTTP request and Telegram customer notifications run independently. A failure in one SMS provider does not prevent the other provider from running.

## Recipient

| Condition | SMS sent to |
|-----------|-------------|
| Additional phone entered during order wizard | `additional_phone` |
| Additional phone skipped | `client_phone` (primary) |

## Environment variables

Set in `.env` on the host running **both** `npm run bot` and `npm run server`:

| Variable | Required | Description |
|----------|----------|-------------|
| `SMS_GATEWAY_ENABLED` | no | Set to `0` to disable SMS enqueue and the WebSocket gateway. Unset or any other value keeps it enabled |
| `REDIS_URL` | yes (to enable) | e.g. `redis://127.0.0.1:6379` |
| `SMS_GATEWAY_TOKEN` | yes (with Redis) | Shared secret for WebSocket auth |
| `PUBLIC_BASE_URL` | yes | Payment link in SMS, e.g. `https://aserver.tech` |
| `GETSMS_MESSAGE_TEMPLATE` | no | GETSMS body; also the shared fallback when channel-specific templates are unset |
| `ESKIZ_MESSAGE_TEMPLATE` | no | Eskiz body (falls back to `GETSMS_MESSAGE_TEMPLATE`) |
| `SMS_GATEWAY_MESSAGE_TEMPLATE` | no | Android WebSocket body (falls back to `GETSMS_MESSAGE_TEMPLATE`) |
| `TELEGRAM_MTPROTO_MESSAGE_TEMPLATE` | no | MTProto Telegram body (HTML supported; falls back to `GETSMS_MESSAGE_TEMPLATE`) |

When `SMS_GATEWAY_ENABLED=0` or `REDIS_URL` is not set, Android enqueue and the WebSocket gateway are skipped automatically (safe for local development). This does not disable GETSMS or Eskiz; see [`getsms.md`](getsms.md) and [`eskiz.md`](eskiz.md).

## SMS text

One message is queued per order for the Android path, rendered from `SMS_GATEWAY_MESSAGE_TEMPLATE` (or `GETSMS_MESSAGE_TEMPLATE` / the built-in default):

```
Оплата услуг ROFEEV TECHNOLOGY
Ссылка на оплату создана на сумму {amount} {currency}.
Оплатить: {payment_page_url}
Служба поддержки (Telegram): {support_telegram_url}
Веб-сайт: {website_url}
Телефон: {support_phone}
```

Unknown placeholders remain unchanged. A known placeholder with no value renders as an empty string. See [`getsms.md`](getsms.md) for footer env defaults.

## WebSocket protocol

Endpoint: `wss://{host}/sms-gateway/ws` (or `ws://` for local dev).

1. Client connects and sends: `{ "type": "auth", "token": "<SMS_GATEWAY_TOKEN>" }`
2. Server replies: `{ "type": "auth_ok" }` or closes with `{ "type": "auth_failed" }`
3. Server pushes jobs: `{ "type": "sms", "job": { "id", "phone", "message", "orderId" } }`
4. Client replies: `{ "type": "result", "jobId": "...", "success": true }` or `{ "success": false, "error": "..." }`

Pending jobs are delivered one at a time. On reconnect, all pending jobs are drained in order.

## Android app

Source: [`sms-gateway/`](../sms-gateway/)

1. Install the app on a dedicated Android phone with a SIM card.
2. Grant **Send SMS** permission when prompted.
3. Enter server URL (e.g. `wss://aserver.tech/sms-gateway/ws`) and gateway token.
4. Tap **Connect**. When prompted, **allow background running** (disable battery optimization).

Build (from repo root):

```bash
cd sms-gateway
npm install
npm run android
```

### Background service

The WebSocket connection runs entirely in a **native foreground service** (`SmsGatewayForegroundService` + `SmsGatewayConnection`), not in JavaScript. This means it keeps working after the app is swiped away or the OS reclaims memory, and it reconnects on its own:

- Config (server URL, token, SIM subscription id) is saved to `SharedPreferences`; the service reconnects using it after a process kill (`START_STICKY`) or reboot (`BootReceiver`, `RECEIVE_BOOT_COMPLETED`).
- The foreground service uses the `specialUse` type (no daily runtime cap, unlike `dataSync` on Android 14+).
- Tapping **Disconnect** clears the running flag so it will not auto-restart until you connect again.

### Aggressive OEM battery managers

On Xiaomi/Redmi/POCO, Oppo/Realme, Vivo, Huawei, etc., a foreground service alone is not enough. On the gateway phone also:

- Disable battery optimization for the app (the in-app "Allow background running" button opens this).
- Enable **Autostart** for the app in system settings (cannot be toggled programmatically).
- Lock the app in the recents screen so the OS does not kill it.

## Audit log

Order events in `order_logs`:

- `sms_sent` — GETSMS accepted the request or the Android device confirmed send
- `sms_failed` — GETSMS request failed, Android enqueue failed, or the device reported failure

## Manual test

1. Start Redis locally (`redis-server` or Docker).
2. Set `REDIS_URL` and `SMS_GATEWAY_TOKEN` in `.env`.
3. Run `npm run server` and `npm run bot`.
4. Open the Android app and connect (emulator: `ws://10.0.2.2:3000/sms-gateway/ws`).
5. Create a test order via the employee bot flow.
6. Verify SMS delivery and `order_logs` entry.

## Deployment

See [CLICK Server Deploy (Linux)](click-deploy-linux.md) for Redis install, nginx WebSocket proxy, and systemd notes.
