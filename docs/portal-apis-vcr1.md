# VCR Billing (vcr1.regos.uz) — reverse-engineered APIs

Base URL: `https://vcr1.regos.uz`

## Authentication

Regos ID SSO (same as sb). Open `/Partners/Index` or `/Licenses/Index`; if on `/Account/Login`, use **Войти через Regos**.

### Cookies (typical)

| Cookie | Domain | Role |
|--------|--------|------|
| `Regos.VCRBilling` | `vcr1.regos.uz` | App session |
| `Regos.VCRBilling.External` | `vcr1.regos.uz` | Auth bridge |
| `SERVERID` | `vcr1.regos.uz` | Load balancer |

## Endpoints

### `POST /Partners/Get`

- **Referer:** `https://vcr1.regos.uz/Partners/Index`
- **Extra form fields:**
  - `additionalproperty[0][name]=legal_status`
  - `additionalproperty[1][name]=company`
- Columns: `id`, `name`, `inn`, `phone`, `contacts`, `company`, `balance`, `id`

**Search:** `search[value]` = phone, INN/PINFL, or name.

**Row fields:** `id`, `name`, `inn`, `legal_status`, `contacts`, `phone`, `balance`, `company`.  
Note: list API often omits registration date; support expiry may be unavailable for vcr1 partners unless a date field appears.

### `POST /Licenses/Get`

- **Referer:** `https://vcr1.regos.uz/Licenses/Index`
- Columns: `partner`, `contract`, `create`, `status`, `fm`, `serial`, `license`, `fda_version`, `app_build_time`, `db_version`, `last_receipt_date`, `last_check_attempt`, `last_sync`, `id`

**Search:** `search[value]` = serial, license hash, or FM code.

**Join:** license `partner` label often ends with `(INN)`. Resolve balance / phone via a partners search on that INN or name.

Mapped: `create` → `created_at`.