# Regos SubBilling (sb.regos.uz) — reverse-engineered APIs

Base URL: `https://sb.regos.uz`

## Authentication

Shared **Regos ID** SSO (`https://auth.regos.uz`).

1. Open `https://sb.regos.uz/Partners/Index` (or any app page).
2. If redirected to `/Account/Login`, follow **Войти через Regos** → `auth.regos.uz`.
3. Submit phone + password on `#PhoneNumber` / `#Password`.
4. SSO sets cookies and redirects back to the billing app.

### Cookies (typical)

| Cookie | Domain | Role |
|--------|--------|------|
| `Regos.SubBilling` | `sb.regos.uz` | App session |
| `Regos.SubBilling.External` | `sb.regos.uz` | External/auth bridge |
| `SERVERID` | `sb.regos.uz` | Load balancer |
| `regos.auth.v1` | `auth.regos.uz` | SSO session |
| `Regos.Device` | `.regos.uz` | Device id |

Sessions are stored as Playwright `storageState` JSON under `data/auth/auth-state-<account>.json`. Live queries reuse those cookies over plain HTTP (`fetch`); Playwright is only used to refresh an expired session.

Accounts: `BUKHARA_*` / `SAMARKAND_*` env credentials. Query **both** accounts and dedupe by record `id`.

## Endpoints

### `POST /Partners/Get`

DataTables JSON list of partners.

- **Referer:** `https://sb.regos.uz/Partners/Index`
- **Headers:** `X-Requested-With: XMLHttpRequest`, `Content-Type: application/x-www-form-urlencoded`
- **Body (form):** standard DataTables fields (`draw`, `start`, `length`, `search[value]`, `search[regex]`, `order[0][column]`, `order[0][dir]`, `columns[n][data|name|searchable|orderable|search][value|regex]`)

Column `data` keys (order matters for `order[0][column]`):

`id`, `name`, `legal_status`, `phone`, `contacts`, `description`, `status`, `balance`, `create_date`, `id`

**Search:** set `search[value]` to phone digits, name fragment, or numeric id. Server-side filter updates `recordsFiltered`.

**Response:**

```json
{
  "draw": 1,
  "recordsTotal": 52,
  "recordsFiltered": 1,
  "data": [
    {
      "id": 4956,
      "create_date": "30.07.2026 14:48:14",
      "name": "…",
      "legal_status": "Физическое лицо",
      "phone": "998936260990",
      "contacts": "",
      "description": "",
      "balance": "1,000",
      "status": "Не требуется",
      "sale_partner": false,
      "sale_partner_accept": false,
      "sale_partner_accept_date": null,
      "sale_partner_status": null,
      "sale_partner_status_until": null
    }
  ]
}
```

Mapped fields: `status` → `moderation_status`, `create_date` → `registered_at`.

### `POST /PartnerAccounts/Get`

- **Referer:** `https://sb.regos.uz/PartnerAccounts/Index`
- **Extra form field:** `additionalproperty` = JSON string `[{"name":"account_status","value":"5"}]` (5 = active)
- Columns: `partner`, `status`, `api_server`, `api_login`, `tariff`, `paid_until`, `dealer_create`, `date_create`, `dealer`, `id`

**Search:** `search[value]` = exact/partial `api_login` (e.g. `DB800268-KF44Y4`).

### `GET /PartnerAccounts/Detail/{id}`

- **Referer:** `https://sb.regos.uz/PartnerAccounts/Index`
- Full HTML page for one partner account (opened from the Index «view» button).
- Overview tab («Информация об аккаунте») KPIs used by the bot «О тарифе» button:
  - **Статус**
  - **Используемый лимит**
  - **Стоимость тарифа**
  - **Лимиты тарифа** (Всего / По тарифу / Фактически for enterprises, warehouses, cash registers, users, disk MB, data period)

Parsed by `src/sync/partner-accounts-detail.js`. Public plan prices for calculated totals come from `https://regos.uz/ru/price` (Redis key `regos:price:ru`, long TTL).

## Timeouts

Default HTTP timeout for live search: 30s per request. Prefer `length` 20–50 for interactive queries.