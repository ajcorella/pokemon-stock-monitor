const https = require("https");
const skuConfig = require("./skus.json");

// --- Config ---
const BESTBUY_KEY = process.env.BESTBUY_API_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;
const NOTIFY_TO = process.env.NOTIFY_PHONE_NUMBER;
const ZIP = process.env.ZIP_CODE || "85308";
const DRY_RUN = process.argv.includes("--dry-run");

// --- Helpers ---
function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${data.substring(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function sendSMS(message) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would send SMS:\n${message}\n`);
    return Promise.resolve();
  }
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    console.log("[NO TWILIO] SMS skipped — credentials not set.\n");
    return Promise.resolve();
  }
  const twilio = require("twilio")(TWILIO_SID, TWILIO_TOKEN);
  return twilio.messages.create({ body: message, from: TWILIO_FROM, to: NOTIFY_TO })
    .then((msg) => console.log(`SMS sent: ${msg.sid}`));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============================================================
// TARGET — Public API, no key needed, store-level inventory
// ============================================================
const TARGET_API_KEY = "9f36aeafbe60771e321a7cc95a78140772ab3e96"; // public key from target.com

async function checkTarget(product) {
  const { tcin, name } = product;
  const url = `https://redsky.target.com/redsky_aggregations/v1/web/fiats_v1?key=${TARGET_API_KEY}&tcin=${tcin}&nearby=${ZIP}&limit=10&include_only_available_stores=false`;

  const data = await fetch(url);
  const locations = data?.data?.fulfillment_fiats?.locations || [];

  const inStock = [];
  for (const loc of locations) {
    const qty = loc.location_available_to_promise_quantity || 0;
    const status = loc.in_store_only?.availability_status;
    const store = loc.store;

    if (qty > 0 || status === "IN_STOCK") {
      inStock.push({
        store: store.location_name,
        address: store.mailing_address.address_line1,
        city: store.mailing_address.city,
        zip: store.mailing_address.postal_code,
        distance: loc.distance,
        qty,
      });
    }
  }

  return { name, tcin, retailer: "Target", inStock };
}

// ============================================================
// BEST BUY — Requires API key (set BESTBUY_API_KEY)
// ============================================================
async function checkBestBuy(product) {
  if (!BESTBUY_KEY) return null;

  const { sku, name } = product;
  const url = `https://api.bestbuy.com/v1/products(sku=${sku})?apiKey=${BESTBUY_KEY}&format=json&show=sku,name,salePrice,onlineAvailability,inStoreAvailability`;

  const data = await fetch(url);
  if (!data.products || data.products.length === 0) return { name, sku, retailer: "Best Buy", inStock: [] };

  const p = data.products[0];
  const inStock = [];

  if (p.onlineAvailability) {
    inStock.push({ store: "Online", address: "bestbuy.com", city: "", zip: "", distance: 0, qty: -1 });
  }

  if (p.inStoreAvailability) {
    // Check nearby stores
    const storeUrl = `https://api.bestbuy.com/v1/stores((area(${ZIP},25))&storeType=BigBox)?apiKey=${BESTBUY_KEY}&format=json&show=storeId,name,city,distance&pageSize=5`;
    await sleep(250);
    try {
      const storeData = await fetch(storeUrl);
      for (const store of (storeData.stores || [])) {
        inStock.push({ store: store.name, address: "", city: store.city, zip: "", distance: store.distance, qty: -1 });
      }
    } catch (e) { /* skip */ }
  }

  return { name, sku, retailer: "Best Buy", inStock };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log(`\n========================================`);
  console.log(`  POKEMON STOCK MONITOR`);
  console.log(`  Zip: ${ZIP} | ${new Date().toLocaleString()}`);
  console.log(`  ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`========================================\n`);

  const alerts = [];

  // --- Target ---
  console.log("--- TARGET ---");
  for (const product of skuConfig.target) {
    try {
      const result = await checkTarget(product);
      if (result.inStock.length > 0) {
        const storeList = result.inStock.map((s) => `${s.store} (${s.city}, ${s.distance}mi) — qty: ${s.qty}`).join(", ");
        const msg = `TARGET: ${result.name} IN STOCK at ${storeList}`;
        console.log(`  ${msg}`);
        alerts.push(msg);
      } else {
        console.log(`  ${product.name} — out of stock`);
      }
      await sleep(500);
    } catch (e) {
      console.log(`  ${product.name} — error: ${e.message}`);
    }
  }

  // --- Best Buy ---
  if (BESTBUY_KEY) {
    console.log("\n--- BEST BUY ---");
    for (const product of skuConfig.bestbuy) {
      try {
        const result = await checkBestBuy(product);
        if (result && result.inStock.length > 0) {
          const storeList = result.inStock.map((s) => `${s.store} (${s.city})`).join(", ");
          const msg = `BEST BUY: ${result.name} IN STOCK at ${storeList}`;
          console.log(`  ${msg}`);
          alerts.push(msg);
        } else {
          console.log(`  ${product.name} — out of stock`);
        }
        await sleep(300);
      } catch (e) {
        console.log(`  ${product.name} — error: ${e.message}`);
      }
    }
  } else {
    console.log("\n--- BEST BUY --- (skipped — no API key)");
  }

  // --- Send alerts (one SMS per product to stay under character limits) ---
  if (alerts.length > 0) {
    console.log(`\n${alerts.length} ALERT(S) FOUND!`);
    for (const alert of alerts) {
      const smsBody = alert.substring(0, 140);
      try { await sendSMS(smsBody); await sleep(1000); } catch (e) { console.error(`SMS failed: ${e.message}`); }
    }
  } else {
    console.log("\nNo stock found. Will check again next run.");
  }
}

main().catch((e) => { console.error("Monitor crashed:", e); process.exit(1); });
