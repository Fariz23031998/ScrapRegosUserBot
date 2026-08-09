const { chromium } = require('playwright');
const {
  createRegosContext,
  ensureRegosSession,
  ensureEasyTradeSession,
  ensureVcr1PartnersIndex,
  persistRegosAuthState,
} = require('../sync/regos-auth');
const {
  createRposContext,
  ensureRposSession,
  persistRposAuthState,
} = require('../sync/rpos-auth');
const { getAccountCredentials, getRposCredentials } = require('../sync/accounts');

async function bootstrapRegosSession(accountLabel, { headless = true } = {}) {
  const credentials = getAccountCredentials(accountLabel);
  const browser = await chromium.launch({ headless });
  const context = await createRegosContext(browser, { accountLabel });
  const page = await context.newPage();
  try {
    await ensureRegosSession(context, page, { ...credentials, accountLabel });
    await ensureEasyTradeSession(page).catch(() => {});
    await ensureVcr1PartnersIndex(page, accountLabel).catch(() => {});
    const statePath = await persistRegosAuthState(context, accountLabel);
    const storageState = await context.storageState();
    return { statePath, storageState };
  } finally {
    await browser.close();
  }
}

async function bootstrapRposSession(accountLabel, { headless = true } = {}) {
  const credentials = getRposCredentials(accountLabel);
  if (!credentials) {
    throw new Error(`RPOS credentials not configured for ${accountLabel}`);
  }
  const browser = await chromium.launch({ headless });
  const context = await createRposContext(browser, { accountLabel });
  const page = await context.newPage();
  try {
    await ensureRposSession(context, page, { ...credentials, accountLabel });
    const statePath = await persistRposAuthState(context, accountLabel);
    const storageState = await context.storageState();
    return { statePath, storageState };
  } finally {
    await browser.close();
  }
}

module.exports = {
  bootstrapRegosSession,
  bootstrapRposSession,
};
