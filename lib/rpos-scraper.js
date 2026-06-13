async function scrapeAdminTable(page) {
  const headers = await page.locator('#result_list thead th').evaluateAll((els) =>
    els.map((el) => el.innerText.trim()).filter(Boolean)
  );

  const rows = await page.locator('#result_list tbody tr').evaluateAll((trs) =>
    trs
      .map((tr) => Array.from(tr.querySelectorAll('th, td')).map((el) => el.innerText.trim()))
      .filter((cells) => cells.length > 0)
  );

  return { headers, rows };
}

async function getCurrentPageNumber(page) {
  return page.evaluate(() => {
    const thisPage = document.querySelector('p.paginator .this-page');
    if (thisPage) {
      const n = parseInt(thisPage.textContent.trim(), 10);
      if (Number.isFinite(n)) return n;
    }
    return 1;
  });
}

async function hasNextAdminPage(page) {
  return page.evaluate(() => {
    const paginator = document.querySelector('p.paginator');
    if (!paginator) return false;

    const thisPage = paginator.querySelector('.this-page');
    const current = thisPage ? parseInt(thisPage.textContent.trim(), 10) : 1;

    return Array.from(paginator.querySelectorAll('a[href*="p="]')).some((link) => {
      const match = link.getAttribute('href').match(/[?&]p=(\d+)/);
      return match && parseInt(match[1], 10) > current;
    });
  });
}

function buildPageUrl(baseUrl, pageNumber) {
  const url = new URL(baseUrl);
  if (pageNumber <= 1) {
    url.searchParams.delete('p');
  } else {
    url.searchParams.set('p', String(pageNumber));
  }
  return url.toString();
}

module.exports = {
  scrapeAdminTable,
  getCurrentPageNumber,
  hasNextAdminPage,
  buildPageUrl,
};
