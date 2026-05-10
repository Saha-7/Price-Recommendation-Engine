// src/api_server.js
// Simple Express API — serves recommendation data to the React frontend
// Run: node src/api_server.js

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const sql      = require('mssql');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

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

// ── GET /api/recommendations ──────────────────────────────────
// Returns products where:
//   - PP is not null
//   - isActive = 1
//   - isInStock = 1
//   - RecommendedSP is not null (means competitor match was found)
// Joined with CompetitorPrices to get competitor price + link
app.get('/api/recommendations', async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();

    const result = await pool.request().query(`
      SELECT
        i.SKU_ID,
        i.Title,
        i.PP,
        i.SP,
        i.RecommendedSP,
        i.Category,

        -- Extra profit % above the floor (PP × 1.30)
        -- Floor = PP × 1.30, ExtraProfit = RecommendedSP - Floor
        ROUND(
          ((i.RecommendedSP - (i.PP * 1.30)) / (i.PP * 1.30)) * 100,
          2
        ) AS ExtraProfitPct,

        -- Lowest in-stock competitor price and link for this SKU
        c.CompetitorPrice,
        c.ProductURL      AS CompetitorURL,
        c.StoreName,
        c.StockStatus     AS CompetitorStockStatus

      FROM InternalProducts i

      -- Join to the cheapest in-stock competitor row for each SKU
      INNER JOIN (
        SELECT
          SKU,
          CompetitorPrice,
          ProductURL,
          StoreName,
          StockStatus,
          ROW_NUMBER() OVER (
            PARTITION BY SKU
            ORDER BY CompetitorPrice ASC
          ) AS rn
        FROM CompetitorPrices
        WHERE CompetitorPrice IS NOT NULL
          AND LOWER(StockStatus) != 'out of stock'
      ) c ON c.SKU = i.SKU_ID AND c.rn = 1

      WHERE i.PP          IS NOT NULL
        AND i.isActive    = 1
        AND i.isInStock   = 1
        AND i.RecommendedSP IS NOT NULL

      ORDER BY i.SKU_ID
    `);

    console.log(`✅ /api/recommendations — ${result.recordset.length} rows served`);
    res.json({ success: true, data: result.recordset });

  } catch (err) {
    console.error('❌ API error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 API server running at http://localhost:${PORT}`);
  console.log(`   Endpoints:`);
  console.log(`   GET http://localhost:${PORT}/api/recommendations`);
  console.log(`   GET http://localhost:${PORT}/api/health`);
});