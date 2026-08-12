# Eskiz.uz test tools

Minimal Node scripts for [Eskiz.uz](https://eskiz.uz): send one SMS, list templates, submit a template for moderation.

- API overview: [`docs/eskiz.md`](../docs/eskiz.md)
- **Templates (moderation, statuses, matching):** [`docs/eskiz-templates.md`](../docs/eskiz-templates.md)

## Setup

1. Create / activate an account at [my.eskiz.uz](https://my.eskiz.uz/) and copy the **API** password.
2. Copy env and fill credentials:

```bash
cd eskiz-test
cp .env.example .env
npm install
```

| Variable | Required for | Description |
|----------|--------------|-------------|
| `ESKIZ_EMAIL` | all | Cabinet email |
| `ESKIZ_PASSWORD` | all | API password |
| `ESKIZ_FROM` | `send` | Alpha name; default `4546` |
| `ESKIZ_PHONE` | `send` | Recipient without `+`, e.g. `998901234567` |
| `ESKIZ_TEXT` | `send` | SMS body (must match an approved template on activated accounts) |
| `ESKIZ_TEMPLATE` | `templates:create` (or pass argv) | Template body to submit for moderation |
| `ESKIZ_BASE_URL` | optional | Default `https://notify.eskiz.uz` |

## Send one SMS

```bash
npm run send
```

On success prints `request_id` (Eskiz send `id`).

On activated accounts the body in `ESKIZ_TEXT` must match an approved template — see [`docs/eskiz-templates.md`](../docs/eskiz-templates.md).

## List templates

```bash
curl --location 'https://notify.eskiz.uz/api/user/templates' \
  --header 'Authorization: Bearer {your_token_here}'
```

Or:

```bash
npm run templates:list
```

Prints each template `id`, `status` (with Russian label), and text.

Statuses: `moderation`, `inproccess`, `service`, `reklama`, `rejected`.

## Submit a template

```bash
curl --location --request POST 'https://notify.eskiz.uz/api/user/template' \
  --header 'Authorization: Bearer {your_token_here}' \
  --form 'template="Your SMS template text"'
```

Or:

```bash
npm run templates:create -- "rofeev.uz: Oplata. Ssylka: https://example.com/pay/1"
```

Or set `ESKIZ_TEMPLATE` in `.env` and run `npm run templates:create`.

This only queues text for moderation — it does not send an SMS. Re-check with `npm run templates:list` until status is `service` or `reklama`.
