// ─────────────────────────────────────────────────────────────
//  src/recommendation_engine.js
//
//  Run: node src/recommendation_engine.js
//
//  What it does:
//    1. Reads InternalProducts — only where PP is not null,
//       isActive = 1, isInStock = 1
//    2. Reads CompetitorPrices — only in-stock entries
//    3. Matches on SKU (InternalProducts.SKU_ID = CompetitorPrices.SKU)
//    4. Skips internal products with no competitor match
//    5. Calculates: RecommendedPrice = PP × (1 + COST_OF_BUSINESS) × (1 + MIN_PROFIT_MARGIN)
//    6. Upserts results into PriceRecommendations table
//
//  Prototype constants (manager confirmed):
//    COST_OF_BUSINESS  = 7%
//    MIN_PROFIT_MARGIN = 5%
// ─────────────────────────────────────────────────────────────

require('dotenv').config();
const sql              = require('mssql');
const { v4: uuidv4 }   = require('uuid');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

// ── Prototype constants ───────────────────────────────────────
const COST_OF_BUSINESS  = 0.07;  // 7%
const MIN_PROFIT_MARGIN = 0.05;  // 5%

// ── In-stock signal words ─────────────────────────────────────
// CompetitorPrices.StockStatus can be:
//   "In Stock" | "Hurry, Only X left." | "Out of Stock"
// We treat anything that is NOT "Out of Stock" as available.
function isInStock(stockStatus) {
  if (!stockStatus) return false;
  const s = stockStatus.toLowerCase().trim();
  return s !== 'out of stock';
}

// ── SQL connection ────────────────────────────────────────────
async function getSqlPool() {
  const credential = process.env.AZURE_ENV === 'production'
    ? new ManagedIdentityCredential({ clientId: process.env.db_userclientid })
    : new AzureCliCredential();

  const tokenResponse = await credential.getToken(
    'https://database.windows.net/.default'
  );

  const config = {
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
  };

  return await sql.connect(config);
}

// ── Step 1: Load internal products eligible for recommendation ─
// Conditions:
//   - PP is not null          (we need a cost base for the formula)
//   - isActive = 1            (product is live on the store)
//   - isInStock = 1           (we are currently selling it)
async function loadInternalProducts(pool) {
  console.log('📦 Loading internal products (PP not null, active, in stock)...');

  const result = await pool.request().query(`
    SELECT
      SKU_ID,
      Title,
      PP,
      SP,
      Category
    FROM InternalProducts
    WHERE PP        IS NOT NULL
      AND isActive  = 1
      AND isInStock = 1
  `);

  console.log(`   ✅ ${result.recordset.length} eligible internal products`);
  return result.recordset;
}

// ── Step 2: Load competitor prices (in-stock only) ────────────
// We load ALL rows and filter in JS so we can group by SKU
async function loadCompetitorPrices(pool) {
  console.log('🏪 Loading competitor prices...');

  const result = await pool.request().query(`
    SELECT
      SKU,
      CompetitorPrice,
      StockStatus,
      StoreName
    FROM CompetitorPrices
    WHERE CompetitorPrice IS NOT NULL
  `);

  console.log(`   ✅ ${result.recordset.length} competitor price rows`);
  return result.recordset;
}

// ── Step 3: Build competitor map ──────────────────────────────
// Groups competitor rows by SKU (uppercase for case-insensitive match)
// Only keeps in-stock entries per the isInStock() helper above
// Returns: Map<SKU_uppercase → [ { price, storeName } ]>
function buildCompetitorMap(competitorRows) {
  const map = new Map();

  for (const row of competitorRows) {
    if (!row.SKU) continue;
    if (!isInStock(row.StockStatus)) continue;  // skip out-of-stock

    const key = row.SKU.trim().toUpperCase();

    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      price    : parseFloat(row.CompetitorPrice),
      storeName: row.StoreName,
    });
  }

  console.log(`   🗺️  ${map.size} unique SKUs with at least one in-stock competitor price`);
  return map;
}

// ── Step 4: Calculate recommended price ───────────────────────
// Formula: PP × (1 + COST_OF_BUSINESS) × (1 + MIN_PROFIT_MARGIN)
// Example: PP=1000 → 1000 × 1.07 × 1.05 = ₹1123.50
function calculateRecommendedPrice(pp) {
  return parseFloat(
    (pp * (1 + COST_OF_BUSINESS) * (1 + MIN_PROFIT_MARGIN)).toFixed(2)
  );
}

// ── Step 5: Generate recommendations ─────────────────────────
function generateRecommendations(internalProducts, competitorMap) {
  console.log('\n🧮 Generating recommendations...');

  const recommendations = [];
  let skippedNoMatch = 0;

  for (const product of internalProducts) {
    const key = (product.SKU_ID || '').trim().toUpperCase();
    const competitorEntries = competitorMap.get(key);

    // Skip if no competitor has this SKU in stock
    if (!competitorEntries || competitorEntries.length === 0) {
      skippedNoMatch++;
      continue;
    }

    // Find the lowest competitor price
    const lowestEntry = competitorEntries.reduce((a, b) =>
      a.price < b.price ? a : b
    );

    const recommendedPrice = calculateRecommendedPrice(product.PP);

    recommendations.push({
      RecommendationID      : uuidv4(),
      SKU_ID                : product.SKU_ID,
      ProductName           : product.Title,
      PP                    : parseFloat(product.PP),
      CurrentSP             : product.SP ? parseFloat(product.SP) : null,
      RecommendedPrice      : recommendedPrice,
      LowestCompetitorPrice : lowestEntry.price,
      LowestCompetitorStore : lowestEntry.storeName,
      CompetitorCount       : competitorEntries.length,
      CostOfBusiness        : COST_OF_BUSINESS,
      MinProfitMargin       : MIN_PROFIT_MARGIN,
    });
  }

  console.log(`   ✅ Recommendations generated : ${recommendations.length}`);
  console.log(`   ⏭️  Skipped (no competitor match): ${skippedNoMatch}`);

  // Preview first 5
  console.log('\n   📋 Sample recommendations:');
  recommendations.slice(0, 5).forEach(r => {
    const diff = r.CurrentSP
      ? ` | CurrentSP=₹${r.CurrentSP} | Diff=₹${(r.RecommendedPrice - r.CurrentSP).toFixed(2)}`
      : '';
    console.log(
      `   → ${r.SKU_ID} | PP=₹${r.PP} | Recommended=₹${r.RecommendedPrice}` +
      ` | LowestCompetitor=₹${r.LowestCompetitorPrice} (${r.LowestCompetitorStore})` +
      diff
    );
  });

  return recommendations;
}

// ── Step 6: Upsert into PriceRecommendations ──────────────────
// MERGE on SKU_ID — re-running the engine updates existing rows
async function upsertRecommendations(pool, recommendations) {
  console.log('\n📤 Updating RecommendedSP in InternalProducts...');

  let updated = 0;
  let failed  = 0;

  for (const row of recommendations) {
    try {
      await pool.request()
        .input('SKU_ID',           sql.NVarChar(100),  row.SKU_ID)
        .input('RecommendedSP',    sql.Decimal(10, 2), row.RecommendedPrice)
        .query(`
          UPDATE InternalProducts
          SET    RecommendedSP = @RecommendedSP,
                 UpdatedAt     = GETDATE()
          WHERE  SKU_ID = @SKU_ID
        `);
      updated++;
    } catch (err) {
      failed++;
      console.error(`   → ${row.SKU_ID}: ${err.message}`);
    }
  }

  console.log(`   ✅ Updated : ${updated}`);
  console.log(`   ❌ Failed  : ${failed}`);
}

// ── Main ──────────────────────────────────────────────────────
async function run() {
  const startTime = Date.now();

  console.log('🚀 Recommendation Engine starting...');
  console.log(`   Cost of Business  : ${COST_OF_BUSINESS * 100}%`);
  console.log(`   Min Profit Margin : ${MIN_PROFIT_MARGIN * 100}%`);
  console.log(`   Formula           : PP × ${1 + COST_OF_BUSINESS} × ${1 + MIN_PROFIT_MARGIN}\n`);

  let pool;
  try {
    console.log('🔌 Connecting to Azure SQL...');
    pool = await getSqlPool();
    console.log('   Connected\n');

    // Steps 1 & 2: Load data
    const internalProducts = await loadInternalProducts(pool);
    const competitorRows   = await loadCompetitorPrices(pool);

    // Step 3: Build lookup map
    const competitorMap = buildCompetitorMap(competitorRows);

    // Step 4 & 5: Generate
    const recommendations = generateRecommendations(internalProducts, competitorMap);

    if (recommendations.length === 0) {
      console.log('\n⚠️  No recommendations generated — check that SKUs match between tables.');
      return;
    }

    // Step 6: Save to SQL
    await upsertRecommendations(pool, recommendations);

    const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 Done in ${totalSec}s`);
    console.log(`   Results saved to: PriceRecommendations table`);
    console.log(`\n   To view in SSMS:`);
    console.log(`   SELECT * FROM PriceRecommendations ORDER BY GeneratedAt DESC`);

  } catch (err) {
    console.error('\n❌ Fatal error:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
  }
}

run();