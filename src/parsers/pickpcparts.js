// ─────────────────────────────────────────────────────────────
//  parsers/pickpcparts.js
// ─────────────────────────────────────────────────────────────

async function parseProductLinks(page) {
  return await page.evaluate(() => {
    const links = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      if (href.includes('pickpcparts.in/processors/') ||
          href.includes('pickpcparts.in/storages/') ||
          href.includes('pickpcparts.in/graphics_cards/') ||
          href.includes('pickpcparts.in/rams/') ||
          href.includes('pickpcparts.in/motherboards/') || href.includes('pickpcparts.in/keyboards/') || href.includes('pickpcparts.in/mice/')) {
        links.add(href.split('?')[0]);
      }
    });
    return [...links];
  });
}

// async function getNextPageUrl(page) {
//   return await page.evaluate(() => {
//     const next = document.querySelector('a.next, .ct-pagination a[rel="next"]');
//     return next ? next.href : null;
//   });
// }

async function getNextPageUrl(page) {
  return await page.evaluate(() => {
    // Find the pagination nav links
    const navLinks = [...document.querySelectorAll('.pcp-archive-pagination a[data-page]')];
    
    // Find the current active page number
    const activePage = document.querySelector('.pcp-archive-pagination span');
    if (!activePage) return null;
    
    const currentPage = parseInt(activePage.textContent.trim());
    if (isNaN(currentPage)) return null;
    
    // Find the link with data-page = currentPage + 1
    const nextLink = navLinks.find(a => parseInt(a.getAttribute('data-page')) === currentPage + 1);
    return nextLink ? nextLink.href : null;
  });
}

async function parseProductDetails(page, url) {
  return await page.evaluate((pageUrl) => {
    const getText = (selector) =>
      document.querySelector(selector)?.innerText?.trim() || null;

    // ── Name ──────────────────────────────────────────────────
    const name = getText('h1.elementor-heading-title') || getText('h1');

    // ── Category from URL ─────────────────────────────────────
    const urlParts = pageUrl.split('/');
    const category = urlParts[urlParts.length - 2] || null;

    // ── Retailer prices table ─────────────────────────────────
    // Columns: Retailer | Price | Availability | Buy | Last Checked
    // FIX: skip rows where price is "—" (Amazon shows this when unlisted)
    const retailerPrices = [];
    document.querySelectorAll('table.pcpps-price-table tbody tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 4) {
        const retailer    = cells[0]?.innerText?.trim();
        const price       = cells[1]?.innerText?.trim();
        const available   = cells[2]?.innerText?.trim();
        const buyLink     = cells[3]?.querySelector('a')?.href || null;
        const lastChecked = cells[4]?.innerText?.trim() || null;

        // Skip rows with no real price (e.g. Amazon shows "—" when unlisted)
        if (retailer && price && price !== '—') {
          retailerPrices.push({ retailer, price, available, buyLink, lastChecked });
        }
      }
    });

    // ── Lowest price across retailers ─────────────────────────
    const lowestPrice = retailerPrices.length
      ? retailerPrices.reduce((a, b) => {
          const aVal = parseFloat(a.price.replace(/[^0-9.]/g, ''));
          const bVal = parseFloat(b.price.replace(/[^0-9.]/g, ''));
          return aVal < bVal ? a : b;
        })
      : null;

    // ── Specifications ────────────────────────────────────────
    // Elementor layout: parent container has 2 child e-con containers
    // left child = label (strong/p), right child = value (.elementor-widget-container)
    const specs = {};
    document.querySelectorAll('.e-con-full.e-flex.e-con.e-child').forEach(container => {
      const children = container.querySelectorAll(':scope > .e-con-full');
      if (children.length === 2) {
        const keyEl   = children[0].querySelector('strong, p');
        const valueEl = children[1].querySelector('.elementor-widget-container');
        if (keyEl && valueEl) {
          const key   = keyEl.innerText.replace(':', '').trim();
          const value = valueEl.innerText.trim();
          if (key && value && value !== '–' && key !== value) {
            specs[key] = value;
          }
        }
      }
    });

    // ── Part IDs ──────────────────────────────────────────────
    // FIX: Part ID uses <ul class="acf-list"> in the DOM, not plain text.
    // Querying specs['Part ID'] gives a mangled newline-joined string.
    // Read directly from the acf-list <li> elements instead.
    const rawPartIds = [...document.querySelectorAll(
      '.elementor-widget-container ul.acf-list li'
    )].map(li => li.innerText.trim()).filter(Boolean);

    const partId  = rawPartIds[0] || null;
    const partId2 = rawPartIds[1] || undefined; // undefined = field won't appear in MongoDB doc

    // FIX: remove the mangled Part ID entry from specs since we extract it separately
    delete specs['Part ID'];

    // ── Price history from Chart.js script ────────────────────
    // The chart data is inlined as: var data = { labels: [...], datasets: [...] }
    let priceHistory = null;
    document.querySelectorAll('script').forEach(script => {
      if (script.textContent.includes('pcpps_ph_')) {
        const match = script.textContent.match(/var data = ({.*?});/s);
        if (match) {
          try {
            const chartData = JSON.parse(match[1]);
            priceHistory = {
              labels: chartData.labels,
              datasets: chartData.datasets?.map(d => ({
                retailer: d.label,
                data: d.data,
              }))
            };
          } catch (_) {}
        }
      }
    });

    // ── Amazon link ───────────────────────────────────────────
    const amazonLink =
      document.querySelector('a[href*="amzn.to"], a[href*="amazon.in"]')?.href || null;

    return {
      url:      pageUrl,
      store:    'pickpcparts',
      name,
      category,
      partId,             // primary Part ID  e.g. "YD3200C5FHBOZ"
      partId2,            // only present when a second Part ID exists (rare)
      lowestPrice: lowestPrice
        ? { retailer: lowestPrice.retailer, price: lowestPrice.price }
        : null,
      retailerPrices,     // array of { retailer, price, available, buyLink, lastChecked }
      specs,              // all spec key-value pairs (Part ID removed — stored as partId/partId2)
      priceHistory,       // { labels: [...dates], datasets: [{ retailer, data: [...prices] }] }
      amazonLink,
      scrapedAt: new Date().toISOString(),
    };
  }, url);
}

module.exports = { parseProductLinks, getNextPageUrl, parseProductDetails };





// Normalise for SQL — always produces a flat string
// const partIdForSQL = [doc.partId, doc.partId2].filter(Boolean).join(' / ');
// → "100-100000457BOX"  or  "100-100000457BOX / 100-100000457MPK"