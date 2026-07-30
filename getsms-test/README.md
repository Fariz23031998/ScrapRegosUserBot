# GETSMS.UZ test sender

Minimal Node script to send **one** SMS via [GETSMS.UZ](https://getsms.uz/page/index/16). Full API notes: [`docs/getsms.md`](../docs/getsms.md).

## Setup

1. Whitelist this machine’s public IP with GETSMS support (required).
2. Copy env and fill credentials:

```bash
cd getsms-test
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `GETSMS_LOGIN` | yes | Login from GETSMS |
| `GETSMS_PASSWORD` | yes | Password |
| `GETSMS_NICKNAME` | no | Alpha name; omit for short number |
| `GETSMS_PHONE` | yes | Recipient without `+`, e.g. `998901234567` |
| `GETSMS_TEXT` | yes | SMS body (UTF-8) |
| `GETSMS_URL` | no | Default `http://185.8.212.184/smsgateway/` |

3. Install and send:

```bash
npm install
npm run send
```

On success the script prints `request_id` (use it later for status checks; see docs).
