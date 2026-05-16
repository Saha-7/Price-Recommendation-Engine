# Price Scraper — Compete Intelligence Engine

Scrapes competitor product prices from multiple stores, dumps raw data into Azure Cosmos DB (noSQL), and maps it into a structured format for the SQL-based Recommendation Engine.

---

## Project Structure

```
price-scraper/
├── src/
│   ├── scraper.js            # Main scraper — runs all stores via Bright Data
│   ├── urls.js               # Store URLs and category config
│   ├── upload_to_cosmos.js   # Pushes scraped JSON to Azure Cosmos DB
│   ├── cleanup_mapper.js     # Maps raw noSQL data → structured SQL format
│   └── parsers/
│       ├── mdcomputers.js    # Parser for mdcomputers.in
│       ├── pickpcparts.js    # Parser for pickpcparts.in
│       └── primeabgb.js      # Parser for primeabgb.com
├── output/                   # Scraped JSON files (gitignored)
├── .env                      # Environment variables (never commit)
└── package.json
```

---

## Setup

```bash
npm install
```

Create a `.env` file in root:

```
BRIGHT_DATA_AUTH=your_brightdata_credentials
COSMOS_CONNECTION_STRING=AccountEndpoint=https://...;AccountKey=...;
```

---

## Scripts

### 1. Scrape competitor prices
```bash
node src/scraper.js
```
Scrapes all stores and categories defined in `urls.js`. Output saved to `output/<store>/<category>/`. Fully resumable — if it crashes, re-run and it continues from where it stopped.

### 2. Push scraped data to Cosmos DB
```bash
node src/upload_to_cosmos.js
```
Reads all `products_full.json` files from `output/` and pushes to **Azure Cosmos DB → ScraperDB → scrap_results**. Uses `upsert` so re-running updates existing records.

### 3. Map/clean data for SQL
```bash
node src/cleanup_mapper.js
```
Reads from Cosmos, normalizes all store-specific field names into a standard structure, and prints a preview. SQL insert logic is a TODO — will be wired up once the external SQL DB is ready.


### 4. Sync internal products from Zoho + Shopify
```bash
node src/internal_db_sync.js
```
Reads purchase prices from Zoho bills view and SKUs/titles from Shopify view, combines them, and bulk upserts into **InternalProducts** table in Azure SQL. Uses TVP for performance — ~7700 products in under 2 minutes.

### 5. Run the recommendation engine
```bash
node src/recommendation_engine.js
```
Reads InternalProducts (PP not null, isActive=1, isInStock=1) and CompetitorPrices (in-stock only), matches on SKU, and calculates RecommendedSP using:
- **Floor formula:** `PP × (1 + 0.18 GST + 0.07 CoB + 0.05 margin) = PP × 1.30`
- **Optimized:** if competitor price > floor → `RecommendedSP = competitor × 0.99`

Writes `RecommendedSP` directly into the `InternalProducts` table.

### 6. Start the API server
```bash
node src/api_server.js
```
Starts Express server on port 3001. Serves `/api/recommendations` — joins InternalProducts + CompetitorPrices and returns matched products with recommended prices to the frontend.

### 7. Start the frontend dashboard
```bash
# In tps-price-dashboard/ folder
npm run dev
```
Opens the React UI at `http://localhost:5173`. Shows all SKU-matched products in a sortable table with PP, SP, RecommendedSP, Extra Profit %, competitor price and link.

---

## Data Flow

```
Scraper (Bright Data)
    ↓
output/<store>/<category>/products_full.json   ← raw per store
    ↓
Azure Cosmos DB (ScraperDB → scrap_results)    ← raw noSQL dump
    ↓
cleanup_mapper.js                              ← normalize & map
    ↓
External SQL DB → Compete_ScrapResults         ← structured (coming)
```

---

## SQL Output Schema (Compete_ScrapResults)

| Column | Type | Notes |
|---|---|---|
| `ScrapID` | UUID | Primary key — unique per store + SKU + scrape run |
| `SKU` | VARCHAR | Product code from each store |
| `Name` | VARCHAR | Product name |
| `CompetePrice` | DECIMAL | Sale/lowest price |
| `ProductURL` | VARCHAR | Direct link to product page |
| `StockStatus` | VARCHAR | In Stock / Out of Stock |
| `StoreName` | VARCHAR | mdcomputers / primeabgb / pickpcparts |
| `Category` | VARCHAR | Product category |
| `ScrapedAt` | DATETIME | When this record was scraped |

> `ScrapID` is required because the same SKU can appear across multiple stores. SKU alone is not unique across the dataset.

---

## Stores Configured

| Store | Parser | Categories |
|---|---|---|
| mdcomputers.in | `mdcomputers.js` | cpu-processor |
| primeabgb.com | `primeabgb.js` | cpu-processor |
| pickpcparts.in | `pickpcparts.js` | cpu-processor, ram-memory |

To add a new store: create a parser in `src/parsers/` and add an entry in `src/urls.js`.

