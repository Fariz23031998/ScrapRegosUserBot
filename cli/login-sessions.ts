import dotenv from 'dotenv';
import { hasRposCredentials, validateAllAccountsConfigured } from '../src/sync/accounts';
import { refreshRegosSession, refreshRposSession } from '../src/live/session-manager';

dotenv.config({ path: require('../src/paths').envPath() });

async function main() {
  const accounts = validateAllAccountsConfigured();
  console.log(`Warming Regos sessions for: ${accounts.join(', ')}`);

  for (const accountLabel of accounts) {
    process.stdout.write(`[${accountLabel}] Regos/EasyTrade/vcr1... `);
    await refreshRegosSession(accountLabel);
    console.log('ok');

    if (hasRposCredentials(accountLabel)) {
      process.stdout.write(`[${accountLabel}] RPOS... `);
      await refreshRposSession(accountLabel);
      console.log('ok');
    } else {
      console.log(`[${accountLabel}] RPOS skipped (no credentials)`);
    }
  }

  console.log('Sessions saved under data/auth/. Live search will reuse these cookies.');
}

main().catch((err: Error) => {
  console.error(err.message || err);
  process.exit(1);
});
