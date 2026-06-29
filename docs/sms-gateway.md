# SMS gateway (Redis + Android)

After an order is created in the Telegram employee flow, the bot enqueues one SMS job in Redis with the payment page link. A dedicated Android app connects to the backend over WebSocket, sends the SMS natively, and reports success or failure back for audit logging.

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

When `REDIS_URL` is not set, SMS enqueue is skipped automatically (safe for local development).

## SMS text

Default message (Russian):

```
Создан заказ на {amount} UZS. Оплатите: {payment_page_url}
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
4. Keep the app running in the foreground or allow background operation on the gateway device.

Build (from repo root):

```bash
cd sms-gateway
npm install
npm run android
```

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
