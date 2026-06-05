// src/scheduler/index.js
//
// CHANGES:
//   1. clearCategoryCache() — deletes visited.json, collected_urls.json,
//      products_full.json, products_prices.json before each scheduled scrape
//      so the scraper always starts fresh on automated runs.
//
//   2. pushScrapedDataToCosmos() — now uses the in-memory products[]
//      returned directly from scrapeCategory() instead of reading back
//      from the output/ folder on disk. This is Azure-safe because the
//      local filesystem on Azure App Service / Functions is ephemeral.
//
//   3. scrapedProducts[] — collected in memory during the scrape loop,
//      passed directly to pushScrapedDataToCosmos(). No disk read needed.
//
//   4. The output/ folder writes still happen inside scrapeCategory()
//      as a local backup/log — but the scheduler does NOT depend on them.
//
// FULL AUTOMATED FLOW:
//   Scheduler fires
//     → Load category schedule from SQL
//     → For each due category:
//         a. clearCategoryCache()        wipe stale disk files
//         b. scrapeCategory()            scrape + write disk (backup) + return products[] in memory
//         c. updateScrapedTimestamps()   update NextScrapDueAt in SQL
//     → pushScrapedDataToCosmos()        push in-memory products[] directly to Cosmos (no disk read)
//     → runCleanupMapper()               Cosmos → map → upsert CompetitorPrices SQL
// ─────────────────────────────────────────────────────────────

require('dotenv').config();

const fs   = require('fs');
const sql  = require('mssql');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');
const { CosmosClient }         = require('@azure/cosmos');

const { STORES }               = require('../urls');
const { scrapeCategory }       = require('../scraper/index');
const { upsertManyFromCosmos } = require('../services/competitorPriceService');
const { getPaths }             = require('../scraper/fileHelpers');

// ── System-wide default frequencies (days) ───────────────────
const DEFAULT_FREQUENCIES = {
  'Processor' : 7,
  'RAM'       : 3,
  'SSD'       : 3,
  'HDD'       : 3,
  'Storage'   : 3,
  'DEFAULT'   : 2,
};

function getDefaultFrequency(categoryName) {
  const key = Object.keys(DEFAULT_FREQUENCIES).find(
    k => k.toLowerCase() === (categoryName || '').toLowerCase()
  );
  return DEFAULT_FREQUENCIES[key] || DEFAULT_FREQUENCIES['DEFAULT'];
}

function isDue(nextScrapDueAt) {
  if (!nextScrapDueAt) return true;
  return new Date() >= new Date(nextScrapDueAt);
}

// ── SQL connection ────────────────────────────────────────────
async function getSqlPool() {
  const credential = process.env.AZURE_ENV === 'production'
    ? new ManagedIdentityCredential({ clientId: process.env.db_userclientid })
    : new AzureCliCredential();

  const tokenResponse = await credential.getToken(
    'https://database.windows.net/.default'
  );

  return await sql.connect({
    server  : process.env.db_serverendpoint,
    database: 'db_tpstechautomata',
    authentication: {
      type   : 'azure-active-directory-access-token',
      options: { token: tokenResponse.token },
    },
    options: {
      encrypt              : true,
      trustServerCertificate: false,
      requestTimeout       : 60_000,
    },
  });
}

// ── Load category schedule ────────────────────────────────────
async function loadCategorySchedule(pool) {
  const result = await pool.request().query(`
    SELECT
      ip.Category,
      MAX(ip.NextScrapDueAt)     AS NextScrapDueAt,
      MAX(ip.LastScrapedAt)      AS LastScrapedAt,
      MAX(cs.ScrapFreqDays)      AS ScrapFreqDays,
      MAX(cs.IsScrapEnabled)     AS IsScrapEnabled
    FROM InternalProducts ip
    LEFT JOIN CategorySettings cs ON cs.CategoryName = ip.Category
    WHERE ip.Category IS NOT NULL
    GROUP BY ip.Category
    ORDER BY ip.Category
  `);

  return result.recordset;
}

// ── Update timestamps after successful scrape ─────────────────
async function updateScrapedTimestamps(pool, categoryName, frequencyDays) {
  const now     = new Date();
  const nextDue = new Date(now);
  nextDue.setDate(nextDue.getDate() + frequencyDays);

  await pool.request()
    .input('Category',       sql.NVarChar(200), categoryName)
    .input('LastScrapedAt',  sql.NVarChar(50),  now.toISOString())
    .input('NextScrapDueAt', sql.NVarChar(50),  nextDue.toISOString())
    .query(`
      UPDATE InternalProducts
      SET LastScrapedAt  = @LastScrapedAt,
          NextScrapDueAt = @NextScrapDueAt
      WHERE Category = @Category
    `);

  console.log(`   ⏰ NextScrapDueAt set to ${nextDue.toISOString()} (+${frequencyDays} days)`);
}

// ── Find matching store + category config from urls.js ────────
function findStoreConfig(categoryName) {
  for (const store of STORES) {
    for (const cat of store.categories) {
      const normalised = categoryName.toLowerCase().replace(/\s+/g, '-');
      if (
        cat.slug.toLowerCase() === normalised ||
        cat.slug.toLowerCase().includes(normalised) ||
        normalised.includes(cat.slug.toLowerCase())
      ) {
        return { store, category: cat };
      }
    }
  }
  return null;
}

// ── Clear stale cache files before each scheduled scrape ──────
// Deletes visited.json and collected_urls.json so the scraper
// re-discovers all product URLs and re-scrapes everything fresh.
// Also clears output JSON files so no stale products get mixed
// into the new run's data.
//
// Only called by the scheduler — manual runs keep resume support.
function clearCategoryCache(storeName, categorySlug) {
  const paths = getPaths(storeName, categorySlug);

  const filesToDelete = [
    paths.visitedCache,   // visited.json         — would skip all URLs if kept
    paths.urlsCache,      // collected_urls.json   — URL discovery cache
    paths.fullOutput,     // products_full.json    — stale scraped data
    paths.priceOutput,    // products_prices.json  — stale price extract
  ];

  for (const filePath of filesToDelete) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`   🗑️  Cleared: ${filePath}`);
    }
  }
}

// ── Push in-memory scraped products directly to Cosmos ────────
// CHANGE: accepts products[] array directly from scrapeCategory()
// instead of reading back from the output/ folder on disk.
//
// WHY: Azure App Service / Functions has an ephemeral filesystem.
// Reading from disk after writing is unreliable in cloud deployments.
// Holding products in memory and pushing directly is Azure-safe.
async function pushScrapedDataToCosmos(scrapedProducts) {
  if (scrapedProducts.length === 0) {
    console.log('   ⚠️  No products to push to Cosmos');
    return;
  }

  const client    = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client.database('ScraperDB').container('scrap_results');

  let pushed = 0;
  let failed = 0;

  console.log(`   Uploading ${scrapedProducts.length} products to Cosmos...`);

  for (const product of scrapedProducts) {
    try {
      // Cosmos requires an 'id' field — same logic as upload_to_cosmos.js
      product.id = Buffer.from(product.url).toString('base64').substring(0, 255);
      await container.items.upsert(product);
      pushed++;
    } catch (err) {
      console.error(`   ❌ Cosmos upsert failed: ${product.url} — ${err.message}`);
      failed++;
    }
  }

  console.log(`   ✅ Cosmos upload done — pushed: ${pushed} | failed: ${failed}`);
}

// ── Read from Cosmos → map → push to SQL (unchanged) ─────────
async function runCleanupMapper() {
  const client    = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client.database('ScraperDB').container('scrap_results');

  const { resources } = await container.items
    .query('SELECT * FROM c')
    .fetchAll();

  console.log(`\n📦 Cosmos → SQL: ${resources.length} documents`);
  const stats = await upsertManyFromCosmos(resources);
  console.log(`   Inserted: ${stats.inserted} | Updated: ${stats.updated} | Failed: ${stats.failed}`);
}

// ── Main scheduler ────────────────────────────────────────────
async function runScheduler() {
  const startTime = Date.now();
  console.log('⏰ Scheduler starting...\n');

  let pool;

  try {
    pool = await getSqlPool();
    console.log('🔌 Connected to SQL\n');

    const categories = await loadCategorySchedule(pool);
    console.log(`📋 Found ${categories.length} distinct categories\n`);

    const due     = [];
    const skipped = [];
    const paused  = [];

    for (const row of categories) {
      if (row.IsScrapEnabled === false || row.IsScrapEnabled === 0) {
        paused.push(row);
        continue;
      }

      const freqDays = row.ScrapFreqDays ?? getDefaultFrequency(row.Category);

      if (isDue(row.NextScrapDueAt)) {
        due.push({ ...row, freqDays });
      } else {
        skipped.push({ ...row, freqDays });
      }
    }

    console.log(`✅ Due for scraping   : ${due.length} categories`);
    console.log(`⏭️  Not due yet        : ${skipped.length} categories`);
    if (paused.length > 0) {
      console.log(`⏸️  Paused (UI)        : ${paused.length} categories`);
      paused.forEach(r => console.log(`   → ${r.Category}`));
    }

    if (skipped.length > 0) {
      console.log('\n   Skipped (next due):');
      skipped.forEach(r =>
        console.log(`   → ${r.Category.padEnd(25)} next: ${r.NextScrapDueAt || 'unknown'}`)
      );
    }

    if (due.length === 0) {
      console.log('\n🎉 Nothing to scrape today. All categories are up to date.');
      return;
    }

    console.log('\n🚀 Starting scrapes...');

    let totalScraped    = 0;
    let totalFailed     = 0;
    const allProducts   = []; // ← collect all scraped products in memory across all categories

    for (const row of due) {
      console.log(`\n━━━ ${row.Category} (every ${row.freqDays} days) ━━━`);

      const config = findStoreConfig(row.Category);

      if (!config) {
        console.log(`   ⚠️  No store config found for "${row.Category}" in urls.js — skipping`);
        continue;
      }

      console.log(`   Store: ${config.store.name} | Slug: ${config.category.slug}`);

      // Clear stale cache so scraper starts completely fresh
      console.log(`   🗑️  Clearing stale cache...`);
      clearCategoryCache(config.store.name, config.category.slug);

      try {
        // scrapeCategory() now returns products[] in memory
        const result = await scrapeCategory(config.store, config.category);
        totalScraped += result.saved;
        totalFailed  += result.failed;

        // Collect products in memory for Cosmos upload
        if (result.products && result.products.length > 0) {
          allProducts.push(...result.products);
          console.log(`   📦 ${result.products.length} products collected in memory`);
        }

        await updateScrapedTimestamps(pool, row.Category, row.freqDays);
      } catch (err) {
        console.error(`   ❌ Scrape failed for ${row.Category}: ${err.message}`);
        totalFailed++;
      }
    }

    // Push all freshly scraped products directly to Cosmos from memory
    // No disk read needed — Azure-safe
    if (allProducts.length > 0) {
      console.log(`\n☁️  Pushing ${allProducts.length} products to Cosmos (in-memory, no disk read)...`);
      await pushScrapedDataToCosmos(allProducts);
    } else {
      console.log('\n⚠️  No products collected — skipping Cosmos upload');
    }

    // Map Cosmos documents → upsert into CompetitorPrices SQL table
    console.log('\n📤 Running cleanup mapper (Cosmos → SQL)...');
    await runCleanupMapper();

    const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 Scheduler done in ${totalSec}s`);
    console.log(`   Products scraped : ${totalScraped}`);
    console.log(`   Failed           : ${totalFailed}`);

  } catch (err) {
    console.error('\n❌ Scheduler fatal error:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
  }
}

if (require.main === module) {
  runScheduler();
}

module.exports = { runScheduler };