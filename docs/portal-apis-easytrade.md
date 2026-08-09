# EasyTrade (my.easytrade.uz) — reverse-engineered APIs

Base URL: `https://my.easytrade.uz`

## Authentication

Same Regos ID SSO as SubBilling. After logging into `sb.regos.uz`, open EasyTrade (SSO cookie `regos.auth.v1` / device cookie) or click **Войти через Regos** on the EasyTrade login page.

### Cookies (typical)

| Cookie | Domain | Role |
|--------|--------|------|
| `ETLicense.Session` | `my.easytrade.uz` | App session |
| `Regos.ETBilling.External` | `my.easytrade.uz` | Auth bridge |

Cookie jar is shared with the Regos account `storageState` after EasyTrade has been visited once in that browser context.

## Endpoints

### `POST /Licenses/Get`

DataTables JSON list of licenses.

- **Referer:** `https://my.easytrade.uz/Licenses/Index`
- **Headers:** `X-Requested-With: XMLHttpRequest`
- **Body:** DataTables form + `additionalproperty` = `[]` (JSON string)

Columns: `fio`, `phone`, `generated`, `code`, `type`, `support`, `server`, `note`, `partner`, `id`

**Search:** `search[value]` = phone digits or license `code`.

**Response shape:** `{ draw, recordsTotal, recordsFiltered, data: [...] }` where each row includes at least `id`, `fio`, `phone`, `generated`, `code`, `type`, `support`, `server`, `note`, `partner` (and often `key`, `contract`, `active`, `partner_phone`, etc.).

Mapped: `key` → `license_key`, `generated` used for 90-day support rule.

## Notes

Visibility is account-scoped: an account may see `recordsTotal` ≫ 0 but `recordsFiltered` / empty `data` when the dealer has no assigned rows. Always query both configured Regos accounts.

**TLS:** `my.easytrade.uz` currently presents a certificate for `*.regos.uz`. The live HTTP client relaxes TLS verification for `*.easytrade.uz` / `*.regos.uz` (equivalent to Playwright `ignoreHTTPSErrors`).