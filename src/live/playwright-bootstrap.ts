import type { Unchecked } from '../types/unchecked';
import { chromium } from 'playwright';
import {
  createRegosContext,
  ensureRegosSession,
  ensureEasyTradeSession,
  ensureVcr1PartnersIndex,
  ensureVcr1LicensesIndex,
  persistRegosAuthState,
} from '../sync/regos-auth';
import { createRposContext, ensureRposSession, persistRposAuthState } from '../sync/rpos-auth';
import { getAccountCredentials, getRposCredentials } from '../sync/accounts';

async function bootstrapRegosSession(accountLabel: any, { headless = true }: Unchecked = {}) {
  const credentials = getAccountCredentials(accountLabel);
  const browser = await chromium.launch({ headless });
  const context = await createRegosContext(browser, { accountLabel });
  const page = await context.newPage();
  try {
    await ensureRegosSession(context, page, { ...credentials, accountLabel });
    await ensureEasyTradeSession(page).catch((err: any) => {
      console.error(
        `[bootstrap] ${accountLabel} EasyTrade session skipped: ${String(err?.message || err).split('\n')[0]}`
      );
    });
    await ensureVcr1PartnersIndex(page, accountLabel).catch((err: any) => {
      console.error(
        `[bootstrap] ${accountLabel} vcr1 session skipped: ${String(err?.message || err).split('\n')[0]}`
      );
    });
    await ensureVcr1LicensesIndex(page, accountLabel).catch((err: any) => {
      console.error(
        `[bootstrap] ${accountLabel} vcr1 licenses skipped: ${String(err?.message || err).split('\n')[0]}`
      );
    });
    const statePath = await persistRegosAuthState(context, accountLabel);
    const storageState = await context.storageState();
    return { statePath, storageState };
  } finally {
    await browser.close();
  }
}

async function bootstrapRposSession(accountLabel: any, { headless = true }: Unchecked = {}) {
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

export { bootstrapRegosSession, bootstrapRposSession };
