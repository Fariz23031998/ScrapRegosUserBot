# Telegram MTProto payment notifier

Sends the order payment-link message via a **Telegram user account** (MTProto / GramJS), addressed by the customer phone number (e.g. `+998901234567` / `t.me/+998901234567`). This is independent of:

- the Bot API (`TELEGRAM_BOT_TOKEN`)
- GETSMS HTTP ([`getsms.md`](getsms.md))
- Eskiz HTTP ([`eskiz.md`](eskiz.md))
- the Android SMS gateway ([`sms-gateway.md`](sms-gateway.md))

If several transports are enabled, each may send the same payment text after order creation. Failures are isolated.

## Why MTProto (not the bot)

Bot API can only message users who already started the bot. A user-account client can resolve a phone number and open a DM when that number has a Telegram account and privacy settings allow it.

Messages appear as coming from the **logged-in personal/business account**, not from your bot.

## Setup

1. Open [my.telegram.org](https://my.telegram.org) → **API development tools** → create an app. Copy `api_id` and `api_hash`.
2. Put them in the project `.env`:

```dotenv
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=your_api_hash
ENABLE_TELEGRAM_MTPROTO=0
TELEGRAM_MTPROTO_SESSION=
```

3. Log in once with the sender account:

```bash
npm run telegram:login
```

Enter the phone, the Telegram login code, and 2FA password if enabled. The CLI prints a `TELEGRAM_MTPROTO_SESSION=...` value — paste it into `.env`.

4. Enable the transport:

```dotenv
ENABLE_TELEGRAM_MTPROTO=1
```

Active only when `ENABLE_TELEGRAM_MTPROTO=1` and `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `TELEGRAM_MTPROTO_SESSION` are all set.

## Test send

```bash
npm run telegram:send -- +998901234567 "Test payment link"
```

Or set `TELEGRAM_MTPROTO_PHONE` / `TELEGRAM_MTPROTO_TEXT` in `.env`.

## Bot integration

Wired into `enqueueOrderPaymentSms` ([`src/sms/sms-queue.js`](../src/sms/sms-queue.js)) as a third branch (`mtproto`). It uses the same recipient as SMS (`additional_phone || client_phone`) and `TELEGRAM_MTPROTO_MESSAGE_TEMPLATE` when set; otherwise it falls back to `GETSMS_MESSAGE_TEMPLATE`, then the built-in default.

MTProto payment text is sent with Telegram **HTML** parse mode. You can use tags such as `<b>`, `<i>`, `<u>`, `<code>`, and `<a href="...">` in `TELEGRAM_MTPROTO_MESSAGE_TEMPLATE`. Placeholder values (`{payment_page_url}`, `{amount}`, etc.) are HTML-escaped automatically so URLs with `&` stay valid. Keep GETSMS / SMS gateway templates plain — only the MTProto channel uses HTML.

Example:

```dotenv
TELEGRAM_MTPROTO_MESSAGE_TEMPLATE="<b>Оплата услуг</b>
Сумма: {amount} {currency}
<a href=\"{payment_page_url}\">Оплатить</a>
Поддержка: {support_telegram_url}"
```

Payment DMs send a **random greeting** first, wait 1.5s, then send the payment-link text. The greeting stays plain text.

Override greetings with `HELLO_SENTENCES` in `.env` (one sentence per line). If unset or empty, the built-in Russian list is used:

```dotenv
HELLO_SENTENCES="Здравствуйте!
Добрый день!
Приветствую!"
```

The CLI test send does not include the greeting unless you pass `withGreeting` in code.

The separate **Bot API** customer notify (`notifyCustomersAboutOrder`) only works if that person already started your bot. If they have not, Bot API returns `chat not found` — that is now logged and skipped so SMS/MTProto still run. First contact by phone is the MTProto path’s job.

Order log actions:

- `telegram_mtproto_sent`
- `telegram_mtproto_failed`

## Resolve flow

1. Normalize phone to E.164 (`+998…`).
2. Prefer `contacts.ResolvePhone`.
3. If that fails (privacy / not found), fall back to `contacts.ImportContacts`, then send.
4. If no Telegram user is found, the send fails and is logged; GETSMS / gateway are unaffected.

## Notes

- Keep the session string secret (same as passwords). It grants full access to the sender account.
- Flood waits and privacy blocks can cause intermittent failures; retry manually with `telegram:send` when debugging.
- Prefer a dedicated sender account (not a personal day-to-day phone) so customers see a consistent identity.
- GramJS package name is `telegram` (archived upstream; still used here). A future migration to `teleproto` is optional.
