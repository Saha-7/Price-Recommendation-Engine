// src/internal_db_sync.js
// Reads from Zoho + Shopify views → merges → bulk upserts into InternalProducts
// Uses TVP (Table-Valued Parameter) — entire sync runs in seconds not hours
// Token expiry is no longer an issue

require('dotenv/config');
const sql = require('mssql');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');
const { fetchCombinedData } = require('./services/azureSqlService.js');

// ── SQL connection to db_tpstechautomata ──────────────────────
async function getTargetPool() {
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
      type: 'azure-active-directory-access-token',
      options: { token: tokenResponse.token }
    },
    options: {
      encrypt              : true,
      trustServerCertificate: false,
      requestTimeout       : 120_000, // 2 min for bulk MERGE
    }
  };

  return await sql.connect(config);
}

// ── Dummy bit — random independent 0 or 1 ────────────────────
// Gives all 4 combinations: 0-0, 0-1, 1-0, 1-1
function randomBit() {
  return Math.random() < 0.5 ? 0 : 1;
}

// ── Build TVP table from deduped rows ────────────────────────
function buildTVP(rows) {
  const table = new sql.Table('InternalProductsType');
  table.columns.add('SKU_ID',    sql.NVarChar(100));
  table.columns.add('Title',     sql.NVarChar(500));
  table.columns.add('Brand',     sql.NVarChar(200));
  table.columns.add('Category',  sql.NVarChar(200));
  table.columns.add('PP',        sql.Decimal(10, 2));
  table.columns.add('SP',        sql.Decimal(10, 2));
  table.columns.add('isActive',  sql.Bit);
  table.columns.add('isInStock', sql.Bit);

  rows.forEach((row) => {
    table.rows.add(
      row.SKU_ID   ?? null,
      row.Title    ?? null,
      row.Brand    ?? null,
      row.Category ?? null,
      row.PP       ?? null,
      row.SP       ?? null,
      randomBit(),   // isActive  — independent
      randomBit()    // isInStock — independent
    );
  });

  return table;
}

// ── Main ──────────────────────────────────────────────────────
async function syncInternalProducts() {
  const startTime = Date.now();

  try {
    // Step 1: Fetch combined data from both views
    const { combined } = await fetchCombinedData();
    console.log(`\n📦 Products to sync: ${combined.length}`);

    // Step 2: Filter out rows with no SKU
    const valid   = combined.filter(r => r.SKU_ID);
    const skipped = combined.length - valid.length;
    console.log(`   Valid  : ${valid.length}`);
    console.log(`   Skipped: ${skipped} (null SKU)`);

    // Step 2b: Deduplicate by SKU_ID — keep last occurrence
    const dedupMap = new Map();
    for (const row of valid) {
      dedupMap.set(row.SKU_ID, row); // later entry overwrites earlier
    }
    const deduped = [...dedupMap.values()];
    console.log(`   Deduped: ${deduped.length} unique SKUs (removed ${valid.length - deduped.length} duplicates)`);

    // Step 3: Connect to SQL
    console.log('\n🔌 Connecting to db_tpstechautomata...');
    const pool = await getTargetPool();
    console.log('   Connected');

    // Step 4: Build TVP
    console.log('\n🏗️  Building TVP...');
    const tvp = buildTVP(deduped);
    console.log(`   TVP ready — ${deduped.length} rows packed`);

    // Step 5: Single bulk MERGE
    console.log('\n📤 Running bulk MERGE into InternalProducts...');
    const mergeStart = Date.now();

    const result = await pool.request()
      .input('tvp', tvp)
      .query(`
        MERGE InternalProducts AS target
        USING @tvp AS source
          ON target.SKU_ID = source.SKU_ID
        WHEN MATCHED THEN
          UPDATE SET
            Title     = source.Title,
            Brand     = source.Brand,
            Category  = source.Category,
            PP        = source.PP,
            SP        = source.SP,
            UpdatedAt = GETDATE()
        WHEN NOT MATCHED THEN
          INSERT (SKU_ID, Title, Brand, Category, PP, SP, isActive, isInStock, UpdatedAt)
          VALUES (source.SKU_ID, source.Title, source.Brand, source.Category,
                  source.PP, source.SP, source.isActive, source.isInStock, GETDATE());
      `);

    const mergeSec = ((Date.now() - mergeStart) / 1000).toFixed(1);
    const totalSec = ((Date.now() - startTime)  / 1000).toFixed(1);

    console.log(`\n🎉 Done!`);
    console.log(`   Rows touched : ${result.rowsAffected[0]}`);
    console.log(`   Merge time   : ${mergeSec}s`);
    console.log(`   Total time   : ${totalSec}s`);

    await pool.close();

  } catch (err) {
    console.error('\n❌ Fatal error:', err.message);
    process.exit(1);
  }
}

syncInternalProducts();