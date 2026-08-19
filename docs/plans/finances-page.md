# Plan: Finances page (IN/OUT to accounts)

**Goal:** `docs/goals/finances-page.md`
**Status:** done

Slice rules: one checkbox = one new agent. Touch ~1–3 files. Name a verify command. Stop after the item.

## Slices

- [x] **S1 — Goal and plan files**
  - Area: `docs/goals/finances-page.md`, `docs/plans/finances-page.md`
  - Verify: files exist with acceptance checks and these slices
  - Done when: workers can follow the markdown without this chat
  - Notes:

- [x] **S2 — Permissions**
  - Area: `src/db/user-rights.js`, `src/db/bot-users-db.js`
  - Verify: `node --test test/task-posting.test.js`
  - Done when: `finances_read`, `finances_create`, `finances_delete` exist in `RIGHTS`, `ADMIN_PERMISSION_KEYS`, `DEFAULT_RIGHTS`, and `ADMIN_RIGHTS_COLUMNS`
  - Notes: Labels «Админ: финансы — просмотр / создание / удаление».

- [x] **S3 — `account_payments` module**
  - Area: `src/db/account-payments.js`, `test/account-payments.test.js`, `src/db/partners-db.js`
  - Verify: `node --test test/account-payments.test.js`
  - Done when: table exists; create/list/delete IN/OUT work; `ensureAccountPaymentTables` is called from partners-db
  - Notes: Fields: `account_id`, `direction` (`in`|`out`), `amount`, `currency`, `amount_uzs`, `amount_usd`, `usd_uzs_rate`, `note`, `created_by_user_id`, `created_at`.

- [x] **S4 — Account balances**
  - Area: `src/db/accounts.js`, `test/accounts.test.js` and/or `test/account-payments.test.js`
  - Verify: `node --test test/accounts.test.js test/account-payments.test.js`
  - Done when: `recalculateAccountValue` includes IN (+) and OUT (−); deleting an account with movements throws `ACCOUNT_IN_USE`
  - Notes:

- [x] **S5 — HTTP API**
  - Area: `src/admin/finances-admin.js`, `src/admin/bot-admin.js`, `test/finances-admin.test.js`
  - Verify: `node --test test/finances-admin.test.js`
  - Done when: GET accounts, GET/POST payments, DELETE payment work with finance rights and audit
  - Notes: `entityType: 'account_payment'`. POST returns `{ payment, account }`. DELETE returns `{ ok, account }`.

- [x] **S6 — UI client**
  - Area: `bot-admin-ui/src/api/finances.ts`, `bot-admin-ui/src/lib/types.ts`
  - Verify: `npx tsc --noEmit` in `bot-admin-ui`
  - Done when: `AccountPayment` type and finances API helpers exist
  - Notes:

- [x] **S7 — Route and nav**
  - Area: `bot-admin-ui/src/lib/permissions.ts`, `bot-admin-ui/src/App.tsx`
  - Verify: `npx tsc --noEmit` in `bot-admin-ui`
  - Done when: **Финансы** nav item and `/finances` route are gated by `finances_read`
  - Notes: Nav after Задачи.

- [x] **S8 — Finances page**
  - Area: `bot-admin-ui/src/pages/FinancesPage.tsx` (+ modal component if needed)
  - Verify: `npx tsc --noEmit` in `bot-admin-ui`
  - Done when: account cards, Приход/Расход modal, movement list, and delete are on the page
  - Notes: Reuse Devices/Settings patterns; `TaskPaymentModal` as modal reference. No new design system.
