async function scrapeAdminTable(page?: any) {
  const headers = await page.locator('#result_list thead th').evaluateAll((els?: any) =>
    els.map((el?: any) => el.innerText.trim()).filter(Boolean)
  );

  const rows = await page.locator('#result_list tbody tr').evaluateAll((trs?: any) =>
    trs
      .map((tr?: any) => Array.from(tr.querySelectorAll('th, td')).map((el?: any) => el.innerText.trim()))
      .filter((cells?: any) => cells.length > 0)
  );

  return { headers, rows };
}

async function getCurrentPageNumber(page?: any) {
  return page.evaluate(() => {
    const thisPage = document.querySelector('p.paginator .this-page');
    if (thisPage) {
      const n = parseInt(thisPage.textContent.trim(), 10);
      if (Number.isFinite(n)) return n;
    }
    return 1;
  });
}

async function hasNextAdminPage(page?: any) {
  return page.evaluate(() => {
    const paginator = document.querySelector('p.paginator');
    if (!paginator) return false;

    const thisPage = paginator.querySelector('.this-page');
    const current = thisPage ? parseInt(thisPage.textContent.trim(), 10) : 1;

    return Array.from(paginator.querySelectorAll('a[href*="p="]')).some((link?: any) => {
      const match = link.getAttribute('href').match(/[?&]p=(\d+)/);
      return match && parseInt(match[1], 10) > current;
    });
  });
}

function buildPageUrl(baseUrl?: any, pageNumber?: any) {
  const url = new URL(baseUrl);
  if (pageNumber <= 1) {
    url.searchParams.delete('p');
  } else {
    url.searchParams.set('p', String(pageNumber));
  }
  return url.toString();
}

export {
  scrapeAdminTable,
  getCurrentPageNumber,
  hasNextAdminPage,
  buildPageUrl,
};
