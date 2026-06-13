const { chromium } = require('playwright');
const { EASYTRADE_AUTH_STATE_PATH, createEasyTradeContext, ensureEasyTradeSession } = require('./lib/easytrade-auth');

const TARGET_URL = 'https://my.easytrade.uz/Licenses/Index';

async function main() {
  const browser = await chromium.launch({ headless: false });
  let context;

  try {
    context = await createEasyTradeContext(browser);
  } catch {
    context = await browser.newContext({ locale: 'ru-RU', ignoreHTTPSErrors: true });
  }

  const page = await context.newPage();
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });

  if (page.url().toLowerCase().includes('/account/login')) {
    console.log('\n=== EasyTrade login required ===');
    console.log('1. Click "Войти через REGOS ID" (or complete login manually)');
    console.log('2. Wait until Licenses page loads');
    console.log('Waiting up to 5 minutes...\n');

    const loginLink = page.getByRole('link', { name: /войти через regos/i });
    if (await loginLink.count()) {
      await loginLink.click().catch(() => {});
    }

    await page
      .waitForURL((url) => !url.pathname.toLowerCase().includes('/account/login'), { timeout: 300000 })
      .catch(async () => {
        await page.waitForFunction(
          () => !window.location.pathname.toLowerCase().includes('/account/login'),
          { timeout: 300000 }
        );
      });
  }

  await context.storageState({ path: EASYTRADE_AUTH_STATE_PATH });
  console.log(`Session saved to ${EASYTRADE_AUTH_STATE_PATH}`);
  console.log(`Final URL: ${page.url()}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
