# SMS gateway (Redis + Android)

After an order is created in the Telegram employee flow, the bot enqueues SMS jobs in Redis: first a Telegram bot invite, then the payment page link. A dedicated Android app connects to the backend over WebSocket, sends the SMS natively, and reports success or failure back for audit logging.

## Flow

1. Employee creates an order in the Telegram bot.
2. `bot.js` enqueues an SMS job in Redis (`sms:pending` + `sms:job:{id}`).
3. `server.js` pushes the job to the connected Android device via WebSocket.
4. The Android app sends the SMS with `SmsManager` and sends a result ack.
5. The server writes `sms_sent` or `sms_failed` to `order_logs`.

Telegram customer notifications are unchanged and run independently.

## Recipient

| Condition | SMS sent to |
|-----------|-------------|
| Additional phone entered during order wizard | `additional_phone` |
| Additional phone skipped | `client_phone` (primary) |

## Environment variables

Set in `.env` on the host running **both** `npm run bot` and `npm run server`:

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | yes (to enable) | e.g. `redis://127.0.0.1:6379` |
| `SMS_GATEWAY_TOKEN` | yes (with Redis) | Shared secret for WebSocket auth |
| `PUBLIC_BASE_URL` | yes | Payment link in SMS, e.g. `https://aserver.tech` |
| `TELEGRAM_BOT_USERNAME` | recommended | Bot handle for the invite SMS, e.g. `@MyShopBot`. If unset, invite SMS is skipped |

When `REDIS_URL` is not set, SMS enqueue is skipped automatically (safe for local development).

## SMS text

Two messages are queued in order (Russian):

1. Telegram invite (skipped if `TELEGRAM_BOT_USERNAME` is unset):

```
Для получение ссылку на оплату, зайдите в наш телеграм бот {TELEGRAM_BOT_USERNAME}
```

2. Payment link:

```
Ссылка на оплату создана на сумму {amount} {currency}. Оплатите: {payment_page_url}
```
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

- `sms_sent` — Android device confirmed send
- `sms_failed` — enqueue error, invalid phone, or device reported failure

## Manual test

1. Start Redis locally (`redis-server` or Docker).
2. Set `REDIS_URL` and `SMS_GATEWAY_TOKEN` in `.env`.
3. Run `npm run server` and `npm run bot`.
4. Open the Android app and connect (emulator: `ws://10.0.2.2:3000/sms-gateway/ws`).
5. Create a test order via the employee bot flow.
6. Verify SMS delivery and `order_logs` entry.

## Deployment

See [CLICK Server Deploy (Linux)](click-deploy-linux.md) for Redis install, nginx WebSocket proxy, and systemd notes.
