// src/services/azureSqlService.js
// Connects to Azure SQL using Azure CLI credential (local dev)
// or Managed Identity (production/Azure App Service)

const sql = require('mssql');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

// ── Env vars ──────────────────────────────────────────────────
const SERVER     = process.env.db_serverendpoint;
const DB_ZOHO    = process.env.db_zoho;
const DB_RETURNS = process.env.db_returns;
const CLIENT_ID  = process.env.db_userclientid;

if (!SERVER)     throw new Error('Missing env var: db_serverendpoint');
if (!DB_ZOHO)    throw new Error('Missing env var: db_zoho');
if (!DB_RETURNS) throw new Error('Missing env var: db_returns');

const SQL_SCOPE        = 'https://database.windows.net//.default';
const TOKEN_REFRESH_MS = 50 * 60 * 1000; // 50 minutes

// ── Token cache ───────────────────────────────────────────────
const tokenCache = {
  db_zoho_accesstoken:    { token: null, refreshTimer: null },
  db_returns_accesstoken: { token: null, refreshTimer: null },
};

// ── Get credential based on environment ──────────────────────
// Locally → AzureCliCredential (uses az login)
// Azure   → ManagedIdentityCredential (uses UAMI)
function getCredential() {
  if (process.env.AZURE_ENV === 'production' && CLIENT_ID) {
    return new ManagedIdentityCredential({ clientId: CLIENT_ID });
  }
  return new AzureCliCredential();
}

async function fetchFreshToken() {
  const credential = getCredential();
  const result = await credential.getToken(SQL_SCOPE);
  return result.token;
}

function scheduleTokenRefresh(cacheKey) {
  if (tokenCache[cacheKey].refreshTimer) {
    clearTimeout(tokenCache[cacheKey].refreshTimer);
  }
  tokenCache[cacheKey].refreshTimer = setTimeout(async () => {
    console.log(`🔄 Refreshing token for ${cacheKey}...`);
    try {
      tokenCache[cacheKey].token = await fetchFreshToken();
      console.log(`   ✅ Token refreshed for ${cacheKey}`);
    } catch (err) {
      console.error(`   ⚠️ Token refresh failed, keeping old token: ${err.message}`);
    }
    scheduleTokenRefresh(cacheKey);
  }, TOKEN_REFRESH_MS);
}

async function getToken(cacheKey) {
  if (!tokenCache[cacheKey].token) {
    console.log(`🔄 Getting initial token for ${cacheKey}...`);
    tokenCache[cacheKey].token = await fetchFreshToken();
    console.log(`   ✅ Token acquired for ${cacheKey}`);
    scheduleTokenRefresh(cacheKey);
  }
  return tokenCache[cacheKey].token;
}

// ── Build mssql config ────────────────────────────────────────
function buildConfig(database, accessToken) {
  return {
    server: SERVER,
    database,
    authentication: {
      type: 'azure-active-directory-access-token',
      options: { token: accessToken },
    },
    options: {
      encrypt: true,
      trustServerCertificate: false,
      connectTimeout: 30_000,
    },
  };
}

// ── Generic query helper ──────────────────────────────────────
async function queryDB(database, queryString, accessToken) {
  let pool;
  try {
    pool = await sql.connect(buildConfig(database, accessToken));
    const result = await pool.request().query(queryString);
    return result.recordset;
  } finally {
    if (pool) await pool.close();
  }
}

// ── Fetch purchase prices from Zoho view ──────────────────────
async function fetchPurchasePrices() {
  console.log(`📡 Fetching from ${DB_ZOHO} → vw_Zoho_Bills_Data...`);
  const accessToken = await getToken('db_zoho_accesstoken');
  const rows = await queryDB(
    DB_ZOHO,
    `SELECT col_item_name, col_item_price_per_item
     FROM [dbo].[vw_Zoho_Bills_Data]`,
    accessToken
  );
  console.log(`   ✅ ${rows.length} rows from Zoho`);
  return rows;
}

// ── Fetch SKUs from Shopify view ──────────────────────────────
async function fetchShopifySKUs() {
  console.log(`📡 Fetching from ${DB_RETURNS} → vw_Shopify_Product_SKUs...`);
  const accessToken = await getToken('db_returns_accesstoken');
  const rows = await queryDB(
    DB_RETURNS,
    `SELECT title, shopify_type_name, sku, brand_name, price, compare_at_price
     FROM [dbo].[vw_Shopify_Product_SKUs]`,
    accessToken
  );
  console.log(`   ✅ ${rows.length} rows from Shopify`);
  return rows;
}

// ── Combine both datasets ────────────────────────────────────
// FIX: price = SP (selling price), compare_at_price = MRP
// Old code had these reversed — corrected here.
function combineData(zohoRows, shopifyRows) {
  const priceMap = new Map();
  for (const row of zohoRows) {
    const key = (row.col_item_name || '').toLowerCase().trim();
    if (key) priceMap.set(key, row.col_item_price_per_item);
  }

  return shopifyRows.map(row => {
    const key = (row.title || '').toLowerCase().trim();
    return {
      SKU_ID   : row.sku             ?? null,
      Title    : row.title           ?? null,
      Brand    : row.brand_name      ?? null,
      Category : row.shopify_type_name ?? null,
      SP       : row.price           ?? null,   // ✅ FIXED: price = selling price
      MRP      : row.compare_at_price ?? null,  // ✅ FIXED: compare_at_price = MRP
      PP       : priceMap.get(key)   ?? null,   // from Zoho
    };
  });
}

// ── Public API ────────────────────────────────────────────────
async function fetchCombinedData() {
  console.log('🔄 Fetching from both SQL views...');
  const zohoRows    = await fetchPurchasePrices();
  const shopifyRows = await fetchShopifySKUs();
  const combined    = combineData(zohoRows, shopifyRows);
  console.log(`✅ Combined ${combined.length} products`);
  return { zohoRows, shopifyRows, combined };
}

module.exports = { fetchPurchasePrices, fetchShopifySKUs, fetchCombinedData };