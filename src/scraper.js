// ─────────────────────────────────────────────────────────────
//  scraper.js  —  Multi-store price scraper
//
//  Run: node src/scraper.js
//
//  Logic per store:
//    - freeScrapable: true  → try free Playwright first
//                             if blocked/fails → fall back to Bright Data
//    - freeScrapable: false → go straight to Bright Data
// ─────────────────────────────────────────────────────────────

require('dotenv').config();
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { STORES } = require('./urls');

const AUTH = process.env.BRIGHT_DATA_AUTH;

// ─────────────────────────────────────────────────────────────
//  BROWSER MANAGEMENT — two separate browser instances
//  _freeBrowser  : plain local Chromium (free, no proxy)
//  _paidBrowser  : Bright Data CDP connection (paid)
// ─────────────────────────────────────────────────────────────

let _freeBrowser = null;
let _paidBrowser = null;

// ── Free browser ──────────────────────────────────────────────

async function launchFreeBrowser() {
  console.log('🆓 Launching free local Chromium...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,800',
    ],
  });
  browser.on('disconnected', () => { _freeBrowser = null; });
  console.log('✅ Free browser ready');
  return browser;
}

async function getFreeBrowser() {
  if (!_freeBrowser) _freeBrowser = await launchFreeBrowser();
  return _freeBrowser;
}

async function newStealthPage(browser) {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-IN',
    extraHTTPHeaders: {
      'Accept-Language': 'en-IN,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return await context.newPage();
}

// ── Paid browser (Bright Data) ────────────────────────────────

async function connectPaidBrowser(retries = 5) {
  for (let i = 1; i <= retries; i++) {
    try {
      console.log(`🔌 Connecting to Bright Data... (attempt ${i})`);
      const browser = await chromium.connectOverCDP(
        `wss://${AUTH}@brd.superproxy.io:9222`,
        { timeout: 60_000 }
      );
      console.log('✅ Bright Data connected');
      browser.on('disconnected', () => {
        console.log('⚡ Bright Data browser disconnected — will reconnect');
        _paidBrowser = null;
      });
      return browser;
    } catch (err) {
      console.error(`  ❌ Connection failed: ${err.message}`);
      if (i < retries) {
        const wait = i * 3000;
        console.log(`  ⏳ Retrying in ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw new Error(`Could not connect to Bright Data after ${retries} attempts`);
      }
    }
  }
}

async function getPaidBrowser() {
  if (!_paidBrowser) _paidBrowser = await connectPaidBrowser();
  return _paidBrowser;
}

// ─────────────────────────────────────────────────────────────
//  NAVIGATION — two variants (free vs paid)
// ─────────────────────────────────────────────────────────────

async function navigateFree(page, url) {
  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body', { timeout: 30_000 });
  const delay = 1500 + Math.floor(Math.random() * 2000);
  await page.waitForTimeout(delay);
}

async function navigatePaid(page, url) {
  await page.goto(url, { timeout: 2 * 60 * 1000, waitUntil: 'domcontentloaded' });
  try {
    const client = await page.context().newCDPSession(page);
    const { status } = await client.send('Captcha.waitForSolve', { detectTimeout: 15_000 });
    if (status !== 'not_detected') console.log(`  🔓 Captcha: ${status}`);
  } catch (_) {}
  await page.waitForSelector('body', { timeout: 30_000 });
  await page.waitForTimeout(2000);
}

// ─────────────────────────────────────────────────────────────
//  DETECTION HELPERS
// ─────────────────────────────────────────────────────────────

async function isPageBlocked(page) {
  const title   = await page.title().catch(() => '');
  const content = await page.content().catch(() => '');

  const blockSignals = [
    'Just a moment',
    'cf-browser-verification',
    'captcha',
    'Access denied',
    'Error 403',
    'Error 503',
    '429 Too Many',
    'blocked',
    'robot',
  ];

  const titleLower   = title.toLowerCase();
  const contentLower = content.toLowerCase();

  return blockSignals.some(signal =>
    titleLower.includes(signal.toLowerCase()) ||
    contentLower.includes(signal.toLowerCase())
  );
}

// ─────────────────────────────────────────────────────────────
//  FILE HELPERS
// ─────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// FIX: priceOutput was accidentally commented out — restored here.
// Removing it caused: "path argument must be of type string... Received undefined"
// which crashed every category after the first product attempt.
function getPaths(storeName, categorySlug) {
  const dir = path.join('output', storeName, categorySlug);
  return {
    dir,
    urlsCache:    path.join(dir, 'collected_urls.json'),
    visitedCache: path.join(dir, 'visited.json'),
    fullOutput:   path.join(dir, 'products_full.json'),
    priceOutput:  path.join(dir, 'products_prices.json'),  // ← was commented out — FIXED
  };
}

function appendProduct(fullOutputPath, product) {
  const existing = readJson(fullOutputPath, []);
  existing.push(product);
  writeJson(fullOutputPath, existing);
}

function rebuildPriceFile(fullOutputPath, priceOutputPath) {
  const all = readJson(fullOutputPath, []);
  const prices = all.map(p => ({
    store:          p.store,
    sku:            p.sku,
    name:           p.name,
    category:       p.category,
    salePrice:      p.salePrice,
    originalPrice:  p.originalPrice,
    stockStatus:    p.stockStatus,
    discountBadge:  p.discountBadge,
    partId:         p.partId,
    partId2:        p.partId2,
    lowestPrice:    p.lowestPrice,
    retailerPrices: p.retailerPrices,
    tags:           p.tags,
    url:            p.url,
    scrapedAt:      p.scrapedAt,
    scrapedVia:     p.scrapedVia,
  }));
  writeJson(priceOutputPath, prices);
}

// ─────────────────────────────────────────────────────────────
//  URL COLLECTION — with free/paid fallback
// ─────────────────────────────────────────────────────────────

async function collectUrlsForCategory(store, startUrl, urlsCachePath) {
  const saved = readJson(urlsCachePath, null);
  if (saved) {
    console.log(`  ♻️  Loaded ${saved.length} cached URLs`);
    return new Set(saved);
  }

  const { parser, freeScrapable } = store;
  const productUrls = new Set();
  let currentUrl = startUrl;
  let pageNum    = 1;
  let useFree    = freeScrapable;

  // FIX: track visited listing pages to prevent infinite pagination loops.
  // MDComputers getNextPageUrl was cycling between /catalog/ram and /catalog/ram?page=2
  // endlessly because the "next" selector matched the wrong element.
  const visitedListingUrls = new Set();

  while (currentUrl) {
    // Stop if we've already visited this listing URL (infinite loop guard)
    if (visitedListingUrls.has(currentUrl)) {
      console.log(`  ⚠️  Pagination loop detected at ${currentUrl} — stopping`);
      break;
    }
    visitedListingUrls.add(currentUrl);

    console.log(`  📄 Page ${pageNum} [${useFree ? '🆓 free' : '💳 paid'}]: ${currentUrl}`);
    let page    = null;
    let success = false;

    // ── Try free first (if enabled) ──────────────────────────
    if (useFree) {
      try {
        const browser = await getFreeBrowser();
        page = await newStealthPage(browser);
        await navigateFree(page, currentUrl);

        const blocked = await isPageBlocked(page);
        if (blocked) {
          console.log(`  ⚠️  Free scrape blocked — switching to Bright Data for this store`);
          await page.context().close();
          page    = null;
          useFree = false;
        } else {
          const links = await parser.parseProductLinks(page);
          console.log(`     ↳ ${links.length} links (free)`);
          links.forEach(l => productUrls.add(l));
          currentUrl = await parser.getNextPageUrl(page);
          pageNum++;
          success = true;
        }
      } catch (err) {
        console.log(`  ⚠️  Free failed (${err.message.substring(0, 60)}) — falling back to Bright Data`);
        if (page) { try { await page.context().close(); } catch (_) {} page = null; }
        useFree = false;
      }
    }

    // ── Use Bright Data (direct or fallback) ─────────────────
    if (!success) {
      try {
        const browser = await getPaidBrowser();
        page = await browser.newPage();
        await navigatePaid(page, currentUrl);
        const links = await parser.parseProductLinks(page);
        console.log(`     ↳ ${links.length} links (Bright Data)`);
        links.forEach(l => productUrls.add(l));
        currentUrl = await parser.getNextPageUrl(page);
        pageNum++;
      } catch (err) {
        console.error(`  ❌ Listing page error: ${err.message}`);
        if (err.message.includes('closed') || err.message.includes('disconnected')) _paidBrowser = null;
        currentUrl = null;
      } finally {
        if (page) { try { await page.close(); } catch (_) {} }
      }
    } else {
      if (page) { try { await page.context().close(); } catch (_) {} }
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  writeJson(urlsCachePath, [...productUrls]);
  return productUrls;
}

// ─────────────────────────────────────────────────────────────
//  PRODUCT SCRAPING — with free/paid fallback
// ─────────────────────────────────────────────────────────────

async function scrapeProductSafe(store, productUrl) {
  const { parser, freeScrapable } = store;

  // ── Try free first ────────────────────────────────────────
  if (freeScrapable) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let page = null;
      try {
        const browser = await getFreeBrowser();
        page = await newStealthPage(browser);
        await navigateFree(page, productUrl);

        const blocked = await isPageBlocked(page);
        if (blocked) {
          console.log(`  ⚠️  Blocked on free — falling back to Bright Data`);
          await page.context().close();
          break;
        }

        const product = await parser.parseProductDetails(page, productUrl);
        await page.context().close();

        if (product?.name) {
          product.scrapedVia = 'free';
          return product;
        }
        break;
      } catch (err) {
        if (page) { try { await page.context().close(); } catch (_) {} }
        if (err.message.includes('closed') || err.message.includes('disconnected')) _freeBrowser = null;
        if (attempt === 2) break;
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    console.log(`  💳 Falling back to Bright Data for: ${productUrl.split('/').slice(-2, -1)[0]}`);
  }

  // ── Bright Data (direct or fallback) ─────────────────────
  for (let attempt = 1; attempt <= 3; attempt++) {
    let page = null;
    try {
      const browser = await getPaidBrowser();
      page = await browser.newPage();
      await navigatePaid(page, productUrl);
      const product = await parser.parseProductDetails(page, productUrl);
      await page.close();
      if (product) product.scrapedVia = 'brightdata';
      return product;
    } catch (err) {
      if (page) { try { await page.close(); } catch (_) {} }
      const dead = err.message.includes('closed') ||
                   err.message.includes('disconnected') ||
                   err.message.includes('Target page');
      if (dead) { _paidBrowser = null; console.log(`  ⚠️  Attempt ${attempt}: Bright Data browser died`); }
      else console.error(`  ⚠️  Attempt ${attempt}: ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 4000 * attempt));
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
//  CATEGORY ORCHESTRATOR
// ─────────────────────────────────────────────────────────────

async function scrapeCategory(store, category) {
  const { name: storeName, freeScrapable } = store;
  const { slug, url: startUrl } = category;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🏪 Store: ${storeName}  📂 Category: ${slug}  [${freeScrapable ? '🆓 free-first' : '💳 paid-only'}]`);
  console.log(`${'─'.repeat(60)}`);

  const paths = getPaths(storeName, slug);
  ensureDir(paths.dir);

  const productUrls = await collectUrlsForCategory(store, startUrl, paths.urlsCache);
  console.log(`  ✅ ${productUrls.size} product URLs total`);

  const visited = new Set(readJson(paths.visitedCache, []));
  const total   = productUrls.size;
  let done      = visited.size;

  if (visited.size > 0) {
    console.log(`  ♻️  Resuming: ${visited.size} done, ${total - visited.size} remaining`);
  }

  let freeCount = 0;
  let paidCount = 0;

  for (const productUrl of productUrls) {
    if (visited.has(productUrl)) continue;
    done++;

    process.stdout.write(`  🛒 [${done}/${total}] `);

    const product = await scrapeProductSafe(store, productUrl);

    if (product?.name) {
      appendProduct(paths.fullOutput, product);
      rebuildPriceFile(paths.fullOutput, paths.priceOutput);
      const via = product.scrapedVia === 'free' ? '🆓' : '💳';
      console.log(`${via} ${product.name.substring(0, 55)}`);

      if (product.scrapedVia === 'free') freeCount++;
      else paidCount++;
    } else {
      console.log(`⚠️  No data — ${productUrl}`);
    }

    // Always save visited — even on failure — so we don't retry endlessly
    visited.add(productUrl);
    writeJson(paths.visitedCache, [...visited]);

    await new Promise(r => setTimeout(r, freeCount > paidCount ? 2000 : 1500));
  }

  console.log(`\n  🏁 ${storeName}/${slug} complete: ${done} products`);
  console.log(`     🆓 Free: ${freeCount}  💳 Bright Data: ${paidCount}`);
  console.log(`     Full  → ${paths.fullOutput}`);
  console.log(`     Price → ${paths.priceOutput}`);
}

// Only for demo quick scraping
// async function scrapeCategory(store, category) {
//   const { name: storeName, freeScrapable } = store;

//   // ── DEMO LIMIT — maxProducts caps scraping for large categories ──
//   // Set maxProducts in urls.js for categories with 300+ products
//   // Remove or set to Infinity for full production scrape
//   const { slug, url: startUrl, maxProducts = Infinity } = category;

//   console.log(`\n${'─'.repeat(60)}`);
//   console.log(`🏪 Store: ${storeName}  📂 Category: ${slug}  [${freeScrapable ? '🆓 free-first' : '💳 paid-only'}]`);
//   // ── Show limit in header if active ──────────────────────────
//   if (maxProducts !== Infinity) {
//     console.log(`  ⚠️  DEMO MODE — capped at ${maxProducts} products`);
//   }
//   console.log(`${'─'.repeat(60)}`);

//   const paths = getPaths(storeName, slug);
//   ensureDir(paths.dir);

//   const productUrls = await collectUrlsForCategory(store, startUrl, paths.urlsCache);
//   console.log(`  ✅ ${productUrls.size} product URLs total`);

//   const visited = new Set(readJson(paths.visitedCache, []));
//   const total   = productUrls.size;
//   let done      = visited.size;

//   if (visited.size > 0) {
//     console.log(`  ♻️  Resuming: ${visited.size} done, ${total - visited.size} remaining`);
//   }

//   let freeCount = 0;
//   let paidCount = 0;

//   for (const productUrl of productUrls) {
//     if (visited.has(productUrl)) continue;

//     // ── DEMO LIMIT — stop once cap is reached ────────────────
//     if (done >= maxProducts) {
//       console.log(`\n  ⏹️  Demo limit reached (${maxProducts}) — skipping remaining ${total - done} products`);
//       break;
//     }
//     // ─────────────────────────────────────────────────────────

//     done++;
//     process.stdout.write(`  🛒 [${done}/${maxProducts === Infinity ? total : maxProducts}] `);

//     const product = await scrapeProductSafe(store, productUrl);

//     if (product?.name) {
//       appendProduct(paths.fullOutput, product);
//       rebuildPriceFile(paths.fullOutput, paths.priceOutput);
//       const via = product.scrapedVia === 'free' ? '🆓' : '💳';
//       console.log(`${via} ${product.name.substring(0, 55)}`);

//       if (product.scrapedVia === 'free') freeCount++;
//       else paidCount++;
//     } else {
//       console.log(`⚠️  No data — ${productUrl}`);
//     }

//     // Always save visited — even on failure — so we don't retry endlessly
//     visited.add(productUrl);
//     writeJson(paths.visitedCache, [...visited]);

//     await new Promise(r => setTimeout(r, freeCount > paidCount ? 2000 : 1500));
//   }

//   console.log(`\n  🏁 ${storeName}/${slug} complete: ${done} products`);
//   // ── Show demo note in footer if limit was active ─────────
//   if (maxProducts !== Infinity) {
//     console.log(`     ⚠️  Demo mode — scraped ${done}/${total} total available`);
//   }
//   console.log(`     🆓 Free: ${freeCount}  💳 Bright Data: ${paidCount}`);
//   console.log(`     Full  → ${paths.fullOutput}`);
//   console.log(`     Price → ${paths.priceOutput}`);
// }

// ─────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────

async function scrape() {
  if (!AUTH || AUTH.includes('your_username')) {
    throw new Error('Set BRIGHT_DATA_AUTH in your .env file');
  }

  console.log('🚀 Multi-store price scraper starting...\n');
  console.log(`Stores: ${STORES.map(s => `${s.name}(${s.freeScrapable ? '🆓→💳' : '💳'})`).join(', ')}`);

  const totalCategories = STORES.reduce((acc, s) => acc + s.categories.length, 0);
  console.log(`Total categories: ${totalCategories}\n`);

  await getPaidBrowser();

  for (const store of STORES) {
    for (const category of store.categories) {
      try {
        await scrapeCategory(store, category);
      } catch (err) {
        console.error(`\n❌ Failed: ${store.name}/${category.slug}: ${err.message}`);
      }
    }
  }

  if (_freeBrowser) try { await _freeBrowser.close(); } catch (_) {}
  if (_paidBrowser) try { await _paidBrowser.close(); } catch (_) {}

  console.log('\n\n🎉 All stores and categories complete!');
  console.log('Output saved in: output/<store>/<category>/');
}

scrape().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});