# RPOS / Chayxanshik Django admin — reverse-engineered access

Base URL: `https://api.chayxanshik.uz`

## Authentication

Django admin form login (not Regos SSO).

1. `GET /admin/login/` — read `csrfmiddlewaretoken` from the form.
2. `POST /admin/login/` with `username`, `password`, `csrfmiddlewaretoken`, and `Referer` / CSRF cookie.
3. Session cookie (`sessionid`) + CSRF cookie grant access to `/admin/…`.

Credentials: `{ACCOUNT}_RPOS_USERNAME` / `{ACCOUNT}_RPOS_PASSWORD` (optional per account). Stored session: `data/auth/auth-state-rpos-<account>.json`.

## Endpoints (HTML, not JSON)

There is no DataTables JSON API. Lists are classic Django admin HTML tables (`#result_list`).

### Clients

`GET /admin/license/client/?q=<query>`

- `q` filters the changelist (phone / name).
- Table columns (observed): id, name, phone, region, created, owner.

### Accounts

`GET /admin/license/account/?q=<query>`

- `q` filters by account code / client name.
- Table columns (observed): id, code, client_name, …, created, …

Pagination: `?p=<page>` (1-based Django admin page). Live search uses `q` and reads the first page only.

## Live client strategy

1. Ensure Django session cookies (HTTP CSRF login or Playwright bootstrap).
2. `GET` the changelist with `q` set to the user query.
3. Parse `#result_list` rows from HTML (no headless browser on the hot path).
