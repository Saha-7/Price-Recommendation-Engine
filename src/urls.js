// ─────────────────────────────────────────────────────────────
//  urls.js  —  Master store + category config
//
//  To add a new store:
//    1. Add a new entry to STORES array below
//    2. Create src/parsers/<storename>.js
//    3. Set freeScrapable: true if the site has no heavy bot protection
//    4. scraper.js will auto try free first, fall back to Bright Data
// ─────────────────────────────────────────────────────────────

const STORES = [
  // {
  //   name: 'Primeabgb',
  //   freeScrapable: false,  // Cloudflare protected — needs Bright Data
  //   parser: require('./parsers/primeabgb'),
  //   categories: [
  //     { slug: 'cpu-processor', url: 'https://www.primeabgb.com/buy-online-price-india/cpu-processor/' },
  //     //{ slug: 'motherboards',  url: 'https://www.primeabgb.com/buy-online-price-india/motherboards/' },
  //     // { slug: 'graphic-cards', url: 'https://www.primeabgb.com/buy-online-price-india/graphic-cards-gpu/' },
  //     {slug: 'HDD',      url: 'https://www.primeabgb.com/buy-online-price-india/internal-hard-drive/' },
  //     // { slug: 'ram-memory',    url: 'https://www.primeabgb.com/buy-online-price-india/ram-memory/' },
  //   ],
  // },

  // {
  //   name: 'MDComputers',
  //   freeScrapable: false,  // Had 502 errors without Bright Data — keep paid
  //   parser: require('./parsers/mdcomputers'),
  //   categories: [
  //     { slug: 'cpu-processor', url: 'https://mdcomputers.in/catalog/processor' },
  //     //{ slug: 'motherboards',  url: 'https://mdcomputers.in/catalog/motherboard' },
  //     //{ slug: 'ram-memory',    url: 'https://mdcomputers.in/catalog/ram' },
  //   ],
  // },

  {
    name: 'pickpcparts',
    freeScrapable: true,   // No heavy bot protection — try free first
    parser: require('./parsers/pickpcparts'),
    categories: [
      { slug: 'cpu-processor', url: 'https://pickpcparts.in/processors/' },
     // { slug: 'ram-memory',    url: 'https://pickpcparts.in/rams/', maxProducts: 60 },
      //{ slug: 'motherboards',  url: 'https://pickpcparts.in/motherboards/', maxProducts: 100 },
     // { slug: 'graphic-cards', url: 'https://pickpcparts.in/graphics_cards/', maxProducts: 100 },
     // { slug: 'storages',      url: 'https://pickpcparts.in/storages/', maxProducts: 60 },
     // { slug:'Keyboards', url: 'https://pickpcparts.in/keyboards/' },
     // { slug:'Mouse', url: 'https://pickpcparts.in/mice/' },
    ],
  },

  // {
  //   name: 'vedant',
  //   freeScrapable: false,
  //   parser: require('./parsers/vedant'),
  //   categories: [
  //     { slug: 'cpu-processor', url: 'https://www.vedantcomputers.com/...' },
  //   ],
  // },
];

module.exports = { STORES };