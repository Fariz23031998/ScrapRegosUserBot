# Goal: Finances page (IN/OUT to accounts)

**Id:** `finances-page`
**Status:** done

## Outcome

The admin UI has a **Финансы** page at `/finances`. Staff with finance rights can record standalone приход (IN) and расход (OUT) payments against cash accounts. Those movements update `accounts.value` together with existing task payments/refunds. Task payments stay on the task page and are not listed here.

## Acceptance

- [x] `node --test test/task-posting.test.js`
- [x] `node --test test/account-payments.test.js test/accounts.test.js`
- [x] `node --test test/finances-admin.test.js`
- [x] `npx tsc --noEmit` in `bot-admin-ui`
- [x] Nav item **Финансы** at `/finances`, gated by `finances_read`
- [x] Create IN/OUT payments on accounts; delete standalone movements; balances include both task payments and account payments
- [x] APIs: `GET /bot-admin/api/finances/accounts`, `GET/POST /bot-admin/api/finances/payments`, `DELETE /bot-admin/api/finances/payments/:id`

## Out of scope

- Mixing task payments into the Finances list
- Transfers between accounts
- Cash-flow categories / articles
- Blocking negative balances
- Finance report / AI ops tools / legacy `public/bot-admin` HTML nav

## Notes

Payment types are not used on this page — pick an account directly. Amount must be > 0. Currency conversion matches task payments (`amount_uzs` / `amount_usd` / `usd_uzs_rate`).
