// src/internal_db_sync.js
// Reads from Zoho + Shopify views → merges → upserts into InternalProducts table
// isActive and isInStock are left as DEFAULT (0) until new view access is available

import 'dotenv/config';
import sql from 'mssql';
import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity';
import { fetchCombinedData } from './services/azureSqlService.js';

// ── SQL connection to db_tpstechautomata (target DB) ─────────
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
    options: { encrypt: true, trustServerCertificate: false }
  };

  return await sql.connect(config);
}

// ── Main ──────────────────────────────────────────────────────
async function syncInternalProducts() {
  try {
    // Step 1: Fetch combined data from both views
    const { combined } = await fetchCombinedData();
    console.log(`\n📦 Products to sync: ${combined.length}`);

    // Step 2: Filter out rows with no SKU
    const valid = combined.filter(r => r.SKU_ID);
    const skipped = combined.length - valid.length;
    console.log(`   Valid  : ${valid.length}`);
    console.log(`   Skipped: ${skipped} (null SKU)`);

    // Step 3: Connect to target SQL DB
    console.log('\n🔌 Connecting to db_tpstechautomata...');
    const pool = await getTargetPool();
    console.log('   Connected');

    // Step 4: Upsert into InternalProducts
    console.log('\n📤 Syncing into InternalProducts...');

    let inserted = 0;
    let updated  = 0;
    let failed   = 0;
    const failedRows = [];

    for (const row of valid) {
      try {
        const result = await pool.request()
          .input('SKU_ID',   sql.NVarChar(100),  row.SKU_ID)
          .input('Title',    sql.NVarChar(500),   row.Title)
          .input('Brand',    sql.NVarChar(200),   row.Brand)
          .input('Category', sql.NVarChar(200),   row.Category)
          .input('PP',       sql.Decimal(10, 2),  row.PP)
          .input('SP',       sql.Decimal(10, 2),  row.SP)
          .query(`
            MERGE InternalProducts AS target
            USING (SELECT @SKU_ID AS SKU_ID) AS source
              ON target.SKU_ID = source.SKU_ID
            WHEN MATCHED THEN
              UPDATE SET
                Title     = @Title,
                Brand     = @Brand,
                Category  = @Category,
                PP        = @PP,
                SP        = @SP,
                UpdatedAt = GETDATE()
            WHEN NOT MATCHED THEN
              INSERT (SKU_ID, Title, Brand, Category, PP, SP, UpdatedAt)
              VALUES (@SKU_ID, @Title, @Brand, @Category, @PP, @SP, GETDATE());
          `);

        if (result.rowsAffected[0] === 1) inserted++;
        else updated++;

      } catch (err) {
        failed++;
        failedRows.push({
          SKU_ID: row.SKU_ID,
          Error : err.message,
        });
      }
    }

    console.log(`\n🎉 Done!`);
    console.log(`   Inserted: ${inserted}`);
    console.log(`   Updated : ${updated}`);
    console.log(`   Failed  : ${failed}`);

    if (failedRows.length > 0) {
      console.log('\n❌ Failed rows:');
      failedRows.forEach(r =>
        console.log(`   SKU=${r.SKU_ID} | Error=${r.Error}`)
      );
    }

    await pool.close();

  } catch (err) {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
  }
}

syncInternalProducts();