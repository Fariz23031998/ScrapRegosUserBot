const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGET_URL = 'https://sb.regos.uz/Partners/Index';
const OUTPUT_DIR = path.join(__dirname, 'output');

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ru-RU',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  console.log(`Navigating to ${TARGET_URL}...`);
  const response = await page.goto(TARGET_URL, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });

  console.log(`Status: ${response?.status()}`);
  console.log(`Final URL: ${page.url()}`);
  console.log(`Title: ${await page.title()}`);

  const screenshotPath = path.join(OUTPUT_DIR, 'page.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Screenshot saved: ${screenshotPath}`);

  const htmlPath = path.join(OUTPUT_DIR, 'page.html');
  const html = await page.content();
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(`HTML saved: ${htmlPath}`);

  const text = await page.locator('body').innerText();
  const textPath = path.join(OUTPUT_DIR, 'page.txt');
  fs.writeFileSync(textPath, text, 'utf8');
  console.log(`Text saved: ${textPath}`);

  const isAuthPage =
    /авторизац/i.test(text) ||
    /войти через regos/i.test(text) ||
    page.url().toLowerCase().includes('login') ||
    page.url().toLowerCase().includes('auth');

  if (isAuthPage) {
    console.log('\n--- AUTH REQUIRED ---');
    console.log('Page appears to require Regos ID login.');
    console.log('Run with HEADED=1 to sign in manually, or provide saved session cookies.');
  } else {
    const tables = await page.locator('table').count();
    const rows = await page.locator('table tr').count();
    console.log(`\nFound ${tables} table(s), ${rows} row(s).`);

    if (tables > 0) {
      const tableData = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('table')).map((table, i) => {
          const headers = Array.from(table.querySelectorAll('thead th, tr:first-child th, tr:first-child td')).map(
            (el) => el.innerText.trim()
          );
          const rows = Array.from(table.querySelectorAll('tbody tr, tr')).slice(0, 50).map((tr) =>
            Array.from(tr.querySelectorAll('td, th')).map((el) => el.innerText.trim())
          );
          return { index: i, headers, rows };
        });
      });
      const jsonPath = path.join(OUTPUT_DIR, 'tables.json');
      fs.writeFileSync(jsonPath, JSON.stringify(tableData, null, 2), 'utf8');
      console.log(`Table data saved: ${jsonPath}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
