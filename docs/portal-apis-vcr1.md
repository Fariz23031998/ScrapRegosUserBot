# VCR Billing (vcr1.regos.uz) — reverse-engineered APIs

Base URL: `https://vcr1.regos.uz`  
Observed portal version: **REGOS Software · 1.22.28.0**

## Authentication (Billing 1.22+)

Regos ID OAuth via the hosted Regos Account widget (no «Войти через Regos» link).

1. Open `/account/login` or any protected page → redirect to login.
2. Widget **Войти** (or navigate directly) to:
   - `GET /account/external-login?provider=Regos&returnUrl=…&ui_locales=ru`
3. OAuth authorize on `https://auth.regos.uz` (PKCE, scopes include `openid profile phone email roles offline_access`).
4. Callback: `https://vcr1.regos.uz/signin-regos`
5. Default authenticated landing: `/Billing/Search` (Partners/Licenses Index still work).

Silent SSO: the login page may open a hidden iframe to `/account/external-login?mode=silent`.

### Access token (UI widget only)

`GET /account/account-token` (same-origin cookies, `X-Requested-With: XMLHttpRequest`)  
→ `{ accessToken, expiresAt }`. Used by the hosted account SDK; list `/Get` endpoints still rely on **cookies**.

### Cookies (typical)

| Cookie | Domain | Role |
|--------|--------|------|
| `Regos.VCRBilling` | `vcr1.regos.uz` | App session |
| `regos.auth.v1` | `auth.regos.uz` | Regos ID SSO |
| `Regos.Device` | `.regos.uz` | Device trust |
| `SERVERID` | `vcr1.regos.uz` | Load balancer |
| `.AspNetCore.Antiforgery.*` | vcr1 / auth | CSRF |

### Session expiry

Unauthenticated XHR to `/Partners/Get`, `/Licenses/Get`, or `/Billing/Search` returns **HTTP 401** (not login HTML). Older builds sometimes returned empty HTTP 500 on `/Get`.

## Endpoints

### `POST /Partners/Get`

- **Referer:** `https://vcr1.regos.uz/Partners/Index`
- **Extra form fields (additionalproperty):**
  - `legal_status`
  - `company`
  - `archived` (Billing 1.22+)
- Columns (UI): `id`, `name`, `inn`, `phone`, `company`, `balance`

**Search:** `search[value]` = phone, INN/PINFL, or name.

**Row fields:** `id`, `name`, `inn`, `legal_status`, `contacts`, `phone`, `balance`, `company`.  
Note: list API often omits registration date; support expiry may be unavailable for vcr1 partners unless a date field appears.

### `POST /Licenses/Get`

- **Referer:** `https://vcr1.regos.uz/Licenses/Index`
- **Extra form fields:** `additionalproperty[0][name]=status`
- Columns: `partner`, `contract`, `create`, `status`, `fm`, `serial`, `license`, `fda_version`, `app_build_time`, `db_version`, `last_receipt_date`, `last_check_attempt`, `last_sync`, `id`

**Search:** `search[value]` = serial, license hash, or FM code.

**Row fields:** same as columns, plus **`monthly_fee`** (Billing 1.22+).

**Join:** license `partner` label often ends with `(INN)`. Resolve balance / phone via a partners search on that INN or name.

Mapped: `create` → `created_at`.

### `GET /Billing/Search?q=…` (UI search)

- XHR with `X-Requested-With: XMLHttpRequest`
- Success responses include header `X-Billing-Search: 1` and an HTML fragment
- Query length 3–100 characters
- Not used by the bot client (prefers structured `/Get` JSON)

## Bot / live client notes

- Warm sessions with Playwright: OAuth external-login, then open `/Partners/Index` and `/Licenses/Index`.
- Live search: cookie jar → `POST …/Get` → mappers in `src/live/mappers.ts`.
- Probe helper: `npx tsx scripts/probe-vcr1-api.ts` (writes redacted samples under `logs/vcr1-probe/`).
