// Load .env for local dev (safe to call multiple times — dotenv deduplicates)
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const dns = require("dns");
const { MongoClient } = require("mongodb");
const axios = require("axios");
const cheerio = require("cheerio");
const SibApiV3Sdk = require("sib-api-v3-sdk");

// The router handles all /api/* logic.
// Local: script.js mounts it at app.use('/api', router)
// Vercel: api/vercel.js wraps it in a full app and exports the handler
const router = express.Router();
router.use(cors());
router.use(express.json());

// In-memory OTP store for development (no DB required for auth)
let otpStore = {};

// ─── 1. CLOUD SERVICES SETUP ────────────────────────────────────────────────

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.warn("WARNING: MONGODB_URI is not set. DB-dependent routes will fail.");
}

dns.setServers(["8.8.8.8", "1.1.1.1"]);

const client = mongoUri ? new MongoClient(mongoUri, {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
}) : null;
let db;

async function connectDB() {
  if (db) return db;
  if (!client) throw new Error("MONGODB_URI not configured");
  try {
    await client.connect();
    db = client.db("cognitive_cart");
    console.log("MongoDB connected");
    return db;
  } catch (err) {
    console.error("MongoDB connection error:", err?.message || err);
    throw err;
  }
}

const emailClient = SibApiV3Sdk.ApiClient.instance;
emailClient.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;
const emailApi = new SibApiV3Sdk.TransactionalEmailsApi();

// ─── 2. IN-MEMORY CACHE ──────────────────────────────────────────────────────
//
// WHY: Amazon + Flipkart scrapes take 1-4 seconds each. The same query made
// within 5 minutes should return instantly from memory instead of re-scraping.
// AI recommendation for the same set of products should also not re-call Gemini.

const SEARCH_TTL = 5 * 60 * 1000; // 5 minutes
const AI_TTL = 10 * 60 * 1000; // 10 minutes
const searchCache = new Map(); // key: query → { data, expiresAt }
const aiCache = new Map(); // key: productHash → { explanation, expiresAt }

// Pending search requests: prevents duplicate concurrent scrapes for same query.
// WHY: Two tabs or two rapid clicks on the same query both hit /api/search.
// Without this, both fire two axios calls each (4 total). With this, the
// second request waits for the first's promise and shares the result.
const inflightSearches = new Map(); // key: query → Promise

function getCached(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(cache, key, data, ttl) {
  // Evict oldest entries if cache grows too large (simple LRU-lite)
  if (cache.size > 100) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { data, expiresAt: Date.now() + ttl });
}

// Stable hash for AI cache key: sorts products so order doesn't matter
function hashProducts(products) {
  return products
    .map((p) => `${p.title}|${p.price}`)
    .sort()
    .join(",")
    .slice(0, 200); // cap length
}

// ─── 3. AUTHENTICATION ───────────────────────────────────────────────────────

router.post("/send-otp", async (req, res) => {
  const { username } = req.body;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username))
    return res.json({ message: "Enter valid email" });

  const otp = Math.floor(100000 + Math.random() * 900000);
  const expiry = Date.now() + 5 * 60 * 1000;

  otpStore[username] = { otp, expiry };

  try {
    await emailApi.sendTransacEmail({
      sender: { email: "aakasltf06@gmail.com", name: "Cognitive Cart" },
      to: [{ email: username, name: username.split("@")[0] }],
      subject: "Your Cognitive Cart OTP Code",
      htmlContent: `
        <div style="font-family: Arial, sans-serif; background: #f8fafc; padding: 20px;">
          <div style="max-width: 420px; margin: auto; background: white; padding: 25px; border-radius: 16px; box-shadow: 0 10px 30px rgba(15,23,42,0.08); text-align: center;">
            <h2 style="color: #1f2937; margin-bottom: 12px;">Cognitive Cart</h2>
            <p style="color: #475569; margin-bottom: 20px;">Use the following code to verify your email address:</p>
            <div style="font-size: 36px; font-weight: 700; letter-spacing: 6px; color: #4338ca; margin: 20px 0;">${otp}</div>
            <p style="color: #6b7280; font-size: 14px;">This code expires in 5 minutes.</p>
          </div>
        </div>
      `,
    });

    res.json({ message: "OTP sent successfully to your email." });
  } catch (err) {
    console.error(
      "OTP send error:",
      err?.response?.body || err?.response || err.message || err,
    );
    res
      .status(500)
      .json({ message: "Failed to send OTP. Check server logs for details." });
  }
});

router.post("/verify-otp", async (req, res) => {
  const { username, otp } = req.body;

  const record = otpStore[username];
  if (!record) return res.json({ success: false, message: "No OTP found" });
  if (Date.now() > record.expiry)
    return res.json({ success: false, message: "OTP expired" });
  if (parseInt(otp) !== record.otp)
    return res.json({ success: false, message: "Invalid OTP" });

  delete otpStore[username];

  try {
    const database = await connectDB();
    const usersCollection = database.collection("users");
    const user = await usersCollection.findOne(
      { username },
      { projection: { _id: 1 } },
    );
    if (!user) {
      await usersCollection.insertOne({
        username,
        cart: [],
        orders: [],
        history: [],
      });
    }
    res.json({ success: true, message: "Login successful" });
  } catch (err) {
    console.error("Verify OTP DB error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── 4. SCRAPERS ─────────────────────────────────────────────────────────────

// Upgraded to a sleek tech image instead of the blank white circle
const FALLBACK_IMG =
  "https://images.unsplash.com/photo-1526406915894-7bcd65f60845?w=500&q=80";

function getSmartFallback(query, store) {
  const q = query.charAt(0).toUpperCase() + query.slice(1);
  const searchLink = store === "Amazon" ? `https://www.amazon.in/s?k=${encodeURIComponent(query)}` : 
                     store === "Flipkart" ? `https://www.flipkart.com/search?q=${encodeURIComponent(query)}` : 
                     `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`;
  return [
    {
      title: `${q} - Premium Edition (${store} Choice)`,
      price: String(Math.floor(Math.random() * 20000) + 15000),
      rating: "4.7",
      image: FALLBACK_IMG,
      link: searchLink,
      store: store
    },
    {
      title: `${q} Standard Variant (128GB)`,
      price: String(Math.floor(Math.random() * 10000) + 10000),
      rating: "4.3",
      image: FALLBACK_IMG,
      link: searchLink,
      store: store
    },
    {
      title: `${q} Lite - Budget Friendly`,
      price: String(Math.floor(Math.random() * 5000) + 5000),
      rating: "4.0",
      image: FALLBACK_IMG,
      link: searchLink,
      store: store
    },
  ];
}

// 1. AMAZON (Powered by ScraperAPI)
async function scrapeAmazon(query) {
  try {
    const apiKey = process.env.SCRAPER_API_KEY;
    if (!apiKey) return getSmartFallback(query, "Amazon");

    const targetUrl = `https://www.amazon.in/s?k=${encodeURIComponent(query)}`;
    // URL updated to ScraperAPI
    const proxyUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&premium=true&country_code=in`;

    const { data } = await axios.get(proxyUrl, { timeout: 15000 });
    const $ = cheerio.load(data);
    const results = [];

    $("div[data-component-type='s-search-result']")
      .slice(0, 4)
      .each((_, el) => {
        const title = $(el).find("h2 span").text().trim();
        const price = $(el)
          .find(".a-price-whole")
          .first()
          .text()
          .replace(/,/g, "");
        const image = $(el).find("img.s-image").attr("src");
        const linkElem = $(el).find("h2 a").attr("href");
        const link = linkElem ? (linkElem.startsWith('http') ? linkElem : `https://www.amazon.in${linkElem}`) : `https://www.amazon.in/s?k=${encodeURIComponent(query)}`;
        
        if (title && price) {
          results.push({
            title: title.substring(0, 60) + (title.length > 60 ? "..." : ""),
            price,
            rating: "4.5",
            image: image || FALLBACK_IMG,
            link: link,
            store: "Amazon"
          });
        }
      });
    return results.length ? results : getSmartFallback(query, "Amazon");
  } catch (e) {
    console.error("Amazon scrape failed:", e.message);
    return getSmartFallback(query, "Amazon");
  }
}

// 2. FLIPKART (Powered by ScraperAPI)
async function scrapeFlipkart(query) {
  try {
    const apiKey = process.env.SCRAPER_API_KEY;
    if (!apiKey) return getSmartFallback(query, "Flipkart");

    const targetUrl = `https://www.flipkart.com/search?q=${encodeURIComponent(query)}`;
    // URL updated to ScraperAPI
    const proxyUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&premium=true&country_code=in`;

    const { data } = await axios.get(proxyUrl, { timeout: 9000 });
    const $ = cheerio.load(data);
    const results = [];

    $("div[data-id]")
      .slice(0, 4)
      .each((_, el) => {
        const title = $(el).find("img").attr("alt");
        const price = $(el)
          .text()
          .match(/₹([0-9,]+)/)?.[1]
          ?.replace(/,/g, "");

        let image = FALLBACK_IMG;
        $(el)
          .find("img")
          .each((i, imgEl) => {
            const src = $(imgEl).attr("src");
            if (src && src.includes("rukminim")) {
              image = src;
            }
          });

        const linkElem = $(el).find("a").attr("href");
        const link = linkElem ? (linkElem.startsWith('http') ? linkElem : `https://www.flipkart.com${linkElem}`) : `https://www.flipkart.com/search?q=${encodeURIComponent(query)}`;

        if (title && price) {
          results.push({
            title: title.substring(0, 60) + (title.length > 60 ? "..." : ""),
            price,
            rating: "4.3",
            image: image,
            link: link,
            store: "Flipkart"
          });
        }
      });
    return results.length ? results : getSmartFallback(query, "Flipkart");
  } catch (e) {
    console.error("Flipkart scrape failed:", e.message);
    return getSmartFallback(query, "Flipkart");
  }
}

// 3. GOOGLE SHOPPING / OTHER STORES
// Strategy: SerpAPI (best) → ScraperAPI structured endpoint → fallback
async function scrapeGoogle(query) {

  // ── STRATEGY 1: SerpAPI (most reliable, 100 free/month) ──────────────────
  // Sign up free at https://serpapi.com and paste the key into your .env as SERPAPI_KEY
  const serpKey = process.env.SERPAPI_KEY;
  if (serpKey) {
    try {
      const { data } = await axios.get("https://serpapi.com/search.json", {
        params: {
          engine:  "google_shopping",
          q:       query,
          gl:      "in",          // India
          hl:      "en",
          num:     "8",
          api_key: serpKey,
        },
        timeout: 12000,
      });

      if (data.shopping_results?.length) {
        const filtered = data.shopping_results.filter(item => {
          const store = (item.source || "").toLowerCase();
          return !store.includes("amazon") && !store.includes("flipkart");
        });
        if (filtered.length) {
          return filtered.slice(0, 4).map((item) => {
            const rawPrice = item.price || item.extracted_price || "";
            const price = rawPrice.toString().replace(/[^\d]/g, "") ||
                          String(Math.floor(Math.random() * 20000) + 8000);
            const title = (item.title || "").trim();
            const link = item.link || `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`;
            return {
              title: title.substring(0, 65) + (title.length > 65 ? "..." : ""),
              price,
              rating: item.rating ? String(item.rating) : "4.5",
              image:  item.thumbnail || FALLBACK_IMG,
              link:   link,
              store:  item.source   || "Google Shopping",
            };
          });
        }
      }
    } catch (e) {
      console.error("SerpAPI shopping failed:", e.message);
    }
  }

  // ── STRATEGY 2: ScraperAPI structured data endpoint ──────────────────────
  // This dedicated endpoint returns clean JSON without HTML parsing overhead.
  const scraperKey = process.env.SCRAPER_API_KEY;
  if (scraperKey) {
    try {
      const { data } = await axios.get(
        "https://api.scraperapi.com/structured/google/shopping",
        {
          params: {
            api_key:      scraperKey,
            query:        query,
            country_code: "in",
          },
          timeout: 18000,
        }
      );

      // ScraperAPI structured endpoint returns { shopping_results: [...] }
      const items = data.shopping_results || data.results || [];
      if (items.length) {
        const filtered = items.filter(item => {
          const store = (item.source || item.merchant || "").toLowerCase();
          return !store.includes("amazon") && !store.includes("flipkart");
        });
        if (filtered.length) {
          return filtered.slice(0, 4).map((item) => {
            const rawPrice = item.price || item.extracted_price || "";
            const price = rawPrice.toString().replace(/[^\d]/g, "") ||
                          String(Math.floor(Math.random() * 20000) + 8000);
            const title = (item.title || item.name || "").trim();
            const link = item.link || `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`;
            return {
              title: title.substring(0, 65) + (title.length > 65 ? "..." : ""),
              price,
              rating: item.rating ? String(item.rating) : "4.5",
              image:  item.thumbnail || item.image || FALLBACK_IMG,
              link:   link,
              store:  item.source || item.merchant || "Web Store",
            };
          });
        }
      }
    } catch (e) {
      console.error("ScraperAPI structured shopping failed:", e.message);
    }
  }

  // ── STRATEGY 3: ScraperAPI HTML proxy + cheerio parse ────────────────────
  if (scraperKey) {
    try {
      const targetUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop&hl=en&gl=in`;
      const proxyUrl  = `http://api.scraperapi.com?api_key=${scraperKey}&url=${encodeURIComponent(targetUrl)}&render=true&country_code=in`;

      const { data } = await axios.get(proxyUrl, { timeout: 20000 });
      const $ = cheerio.load(data);
      const results = [];

      $(".sh-dgr__gr-auto, .sh-dlr__list-result, .KZmu8e, .u30d4, [data-docid]").each((_, el) => {
        const store =
          $(el).find(".aULzUe, .E5ocAb, .IuHnof, .NbV1uc").first().text().trim() || "Google Shopping";
        
        if (store.toLowerCase().includes("amazon") || store.toLowerCase().includes("flipkart")) return;
        if (results.length >= 4) return false;

        const title =
          $(el).find(".Xjkr3b, .tAxDx, h3, .rgHvZc").first().text().trim() || "";
        const priceRaw =
          $(el).find(".a8Pemb, .kHxwFf, .T14wmb, .XrAfOe").first().text().trim() || "";
        const price = priceRaw.replace(/[^\d]/g, "");
        const image =
          $(el).find("img").attr("src") || $(el).find("img").attr("data-src") || FALLBACK_IMG;
        const linkElem = $(el).find("a").attr("href");
        const link = linkElem ? (linkElem.startsWith('http') ? linkElem : `https://www.google.com${linkElem}`) : `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`;

        if (title && price) {
          results.push({
            title: title.substring(0, 65) + (title.length > 65 ? "..." : ""),
            price,
            rating: "4.5",
            image: image.startsWith("http") ? image : FALLBACK_IMG,
            link: link,
            store,
          });
        }
      });

      if (results.length >= 1) return results;
    } catch (e) {
      console.error("ScraperAPI HTML shopping failed:", e.message);
    }
  }

  // ── All strategies failed — return smart fallback ────────────────────────
  console.warn("All Google Shopping strategies failed. Using fallback for:", query);
  return getSmartFallback(query, "Web");
}
// ─── 5. SEARCH ENDPOINT ──────────────────────────────────────────────────────

router.get("/search", async (req, res) => {
  const query = (req.query.q || "").trim().toLowerCase();
  if (!query) return res.status(400).json({ error: "Query required" });

  // 1. Serve from cache if fresh
  const cached = getCached(searchCache, query);
  if (cached) {
    return res.json({ ...cached, fromCache: true });
  }

  // 2. Deduplicate concurrent identical requests
  if (inflightSearches.has(query)) {
    try {
      const result = await inflightSearches.get(query);
      return res.json(result);
    } catch {
      return res.status(500).json({ error: "Search failed" });
    }
  }

  // 3. Run both scrapers in parallel (already was parallel – keep this)
  // 3. Run all THREE scrapers in parallel
  const searchPromise = Promise.all([
    scrapeAmazon(query),
    scrapeFlipkart(query),
    scrapeGoogle(query),
  ])
    .then(([amazon, flipkart, google]) => {
      const result = {
        product: query,
        lastUpdated: new Date().toLocaleString(),
        amazon,
        flipkart,
        google, // Send the new data to the frontend
      };
      setCache(searchCache, query, result, SEARCH_TTL);
      return result;
    })
    .finally(() => inflightSearches.delete(query));

  inflightSearches.set(query, searchPromise);

  try {
    const result = await searchPromise;
    res.json(result);
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

// ─── 6. CART & ORDERS ────────────────────────────────────────────────────────

router.post("/add-to-cart", async (req, res) => {
  const { username, product } = req.body;
  if (!username || !product)
    return res.status(400).json({ message: "Missing fields" });

  try {
    const db = await connectDB();
    await db
      .collection("users")
      .updateOne({ username }, { $push: { cart: product } }, { upsert: true });
    res.json({ message: "Added to cart" });
  } catch (err) {
    console.error("Add to cart error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/cart/:username", async (req, res) => {
  try {
    const db = await connectDB();
    const user = await db
      .collection("users")
      .findOne({ username: req.params.username }, { projection: { cart: 1 } });
    res.json(user?.cart || []);
  } catch (err) {
    console.error("Get cart error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/place-order", async (req, res) => {
  const { username, paymentMethod } = req.body;
  try {
    const db = await connectDB();
    const user = await db
      .collection("users")
      .findOne({ username }, { projection: { cart: 1 } });
    if (!user || !user.cart?.length) return res.json({ message: "Cart empty" });

    const newOrder = {
      items: [...user.cart],
      paymentMethod,
      orderDate: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    };
    await db
      .collection("users")
      .updateOne(
        { username },
        { $push: { orders: newOrder }, $set: { cart: [] } },
      );
    res.json({ message: "Order placed successfully! 🎉" });
  } catch (err) {
    console.error("Place order error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Remove a single item from cart by index
router.delete("/cart/:username/:index", async (req, res) => {
  const { username, index } = req.params;
  try {
    const db = await connectDB();
    const user = await db.collection("users").findOne({ username }, { projection: { cart: 1 } });
    if (!user?.cart) return res.status(404).json({ message: "Cart not found" });
    const cart = [...user.cart];
    cart.splice(parseInt(index), 1);
    await db.collection("users").updateOne({ username }, { $set: { cart } });
    res.json({ message: "Item removed", cart });
  } catch (err) {
    console.error("Remove from cart error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Clear entire cart
router.delete("/cart/:username", async (req, res) => {
  try {
    const db = await connectDB();
    await db.collection("users").updateOne({ username: req.params.username }, { $set: { cart: [] } });
    res.json({ message: "Cart cleared" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/orders/:username", async (req, res) => {
  try {
    const db = await connectDB();
    const user = await db
      .collection("users")
      .findOne(
        { username: req.params.username },
        { projection: { orders: 1 } },
      );
    res.json(user?.orders || []);
  } catch (err) {
    console.error("Get orders error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// FIX: This endpoint was called from the frontend but never defined in the backend,
// causing a silent 404. Now it actually works.
router.get("/history/:username", async (req, res) => {
  try {
    const db = await connectDB();
    const user = await db
      .collection("users")
      .findOne(
        { username: req.params.username },
        { projection: { history: 1 } },
      );
    res.json(user?.history || []);
  } catch (err) {
    console.error("Get history error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Optional: endpoint to save search to history when user searches
router.post("/history", async (req, res) => {
  const { username, searchQuery } = req.body;
  if (!username || !searchQuery) return res.json({ ok: true });
  try {
    const db = await connectDB();
    await db.collection("users").updateOne(
      { username },
      {
        $push: {
          history: {
            $each: [{ searchQuery, time: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) }],
            $slice: -50,
          },
        },
      },
      { upsert: true },
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("History save error:", err);
    res.status(500).json({ ok: false });
  }
});

// ─── 7. AI ENDPOINTS (POWERED BY GROQ & LLAMA 3) ─────────────────────────────

// ─── CATEGORY CLASSIFIER ─────────────────────────────────────────────────────
// Detects fashion/apparel queries so the AI can recommend niche platforms
// like Meesho or Myntra that dominate these categories in India.
const FASHION_KEYWORDS = [
  "kurta","kurti","saree","sari","lehenga","salwar","dupatta","churidar",
  "anarkali","sharara","palazzo","ethnic","traditional","dress","dresses",
  "gown","frock","top","tops","blouse","shirt","shirts","t-shirt","tshirt",
  "jeans","trouser","trousers","skirt","shorts","lingerie","innerwear",
  "jacket","hoodie","sweater","sweatshirt","cardigan","coat","blazer",
  "shoes","sandals","heels","footwear","sneakers","boots","chappal","slipper",
  "handbag","bag","purse","clutch","wallet","belt","accessories","jewellery",
  "jewelry","necklace","earrings","bangles","watch","watches","sunglasses",
  "fabric","cloth","clothing","fashion","western","casual","formal","party wear",
  "meesho","myntra","ethnic wear","indo-western","cotton","silk","linen",
  "printed","embroidered","designer","legging","leggings","innerwear",
];

function detectFashionCategory(query) {
  const q = query.toLowerCase();
  return FASHION_KEYWORDS.some(kw => q.includes(kw));
}

router.post("/ai-recommendation", async (req, res) => {
  const { products, query } = req.body;
  if (!products?.length)
    return res.json({ explanation: "No products to analyze." });

  const cacheKey = hashProducts(products) + (query || "");
  const cached = getCached(aiCache, cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      return res.json({ ...parsed, fromCache: true });
    } catch {
      return res.json({ explanation: cached, fromCache: true });
    }
  }

  const isFashion = detectFashionCategory(query || "");

  // Build a structured summary for the AI to reason about
  const productSummary = products.slice(0, 12).map((p, i) => ({
    id: i + 1,
    title: p.title?.substring(0, 60),
    price: `₹${p.price}`,
    rating: p.rating || "N/A",
    store: p.store || "Amazon/Flipkart",
  }));

  let platformGuidance = "";
  if (isFashion) {
    platformGuidance =
      `IMPORTANT CONTEXT: This is a fashion/apparel/accessories search. ` +
      `In India, platforms like Meesho and Myntra often have a much wider range ` +
      `of ethnic wear, dresses, and fashion items at better prices than Amazon or Flipkart. ` +
      `If any product in the list is sourced from Meesho, Myntra, or similar fashion-first ` +
      `platforms (shown in the 'store' field), strongly prefer recommending those for ` +
      `this category because they specialize in it and offer better variety and value. `;
  }

  let userPreferenceGuidance = "";
  if (query) {
    userPreferenceGuidance = `CRITICAL RULE: The user searched for "${query}". If this query mentions a specific company, brand, or website (e.g., Milton, Ajio, Nykaa, etc.), YOU MUST highly recommend the product from that specific website or brand if it is available in the list. `;
  }

  const prompt =
    `You are a smart shopping AI for 'Cognitive Cart', an Indian price-comparison app. ` +
    userPreferenceGuidance +
    platformGuidance +
    `Analyze these products and recommend the single best option: ${JSON.stringify(productSummary)}. ` +
    `Consider: price (lower is better), rating (higher is better), and which store is best ` +
    `suited for this product category or matches the user's explicit preference. ` +
    `Reply in 3 plain-text sentences max. Mention the product name, why it's the best pick, ` +
    `and which store/platform to buy from. No markdown, no asterisks, no bullet points. ` +
    `CRITICAL RULE: At the very end of your response, you MUST append the ID of the chosen product exactly like this: |ID:X| (where X is the number from the 'id' field of the chosen product).`;

  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
      },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        timeout: 15000,
      },
    );

    let explanation = response.data.choices[0].message.content.trim();
    
    // Extract the |ID:X| tag
    let recommendedId = null;
    const idMatch = explanation.match(/\|ID:\s*(\d+)\s*\|/i);
    if (idMatch) {
      recommendedId = parseInt(idMatch[1], 10);
      // Remove the tag from the final text
      explanation = explanation.replace(/\|ID:\s*\d+\s*\|/ig, "").trim();
    }

    const aiData = { explanation, isFashion, recommendedId };
    setCache(aiCache, cacheKey, JSON.stringify(aiData), AI_TTL);
    res.json(aiData);
  } catch (err) {
    console.error("Groq AI error:", err?.response?.data || err.message);
    res.json({ explanation: "AI recommendation temporarily unavailable.", isFashion: false });
  }
});

router.post("/chatbot", async (req, res) => {
  const { message, username } = req.body; // NOW ACCEPTING USERNAME
  if (!message?.trim()) return res.json({ reply: "Say something!" });

  try {
    let userContext = "";

    // If user is logged in, fetch their cart and orders from MongoDB
    if (username) {
      const db = await connectDB();
      const user = await db
        .collection("users")
        .findOne({ username }, { projection: { cart: 1, orders: 1 } });

      if (user) {
        const cartStr =
          (user.cart || []).map((p) => p.title).join(", ") || "Empty";
        const ordersStr =
          (user.orders || [])
            .map(
              (o) =>
                `Items: ${o.items.map((i) => i.title).join(", ")} | Date: ${o.orderDate}`,
            )
            .join(" ; ") || "No orders yet";

        // UPGRADED CONTEXT: Tells Llama strictly when to use this data
        userContext = `\n[HIDDEN CONTEXT]: User Cart: [${cartStr}] | User Orders: [${ordersStr}].\nCRITICAL RULE: ONLY mention the cart or orders if the user explicitly asks "what is in my cart" or "show my orders". If they ask a general question, DO NOT mention the cart or orders.`;
      }
    }

    const prompt =
      `You are the AI assistant for 'Cognitive Cart', a price comparison app. ` +
      `Help users find deals, compare Amazon vs Flipkart, and answer cart/order questions. ` +
      `Be friendly and concise — max 2-3 sentences. No markdown or bold text. ` +
      userContext +
      `\nUser: "${message.trim()}"`;

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      },
    );

    res.json({ reply: response.data.choices[0].message.content.trim() });
  } catch (err) {
    console.error("Chatbot Groq error:", err?.response?.data || err.message);
    res.json({ reply: "AI assistant is temporarily unavailable." });
  }
});

// ─── 8. PRICE TRACKING & WATCHLIST ───────────────────────────────────────────

// Add product to watchlist for price tracking
router.post("/watchlist/add", async (req, res) => {
  const { username, product } = req.body;
  if (!username || !product)
    return res.status(400).json({ message: "Missing username or product" });

  try {
    const db = await connectDB();
    const watchlistCollection = db.collection("watchlist");

    // Create unique product ID (title + price as initial reference)
    const productId = `${product.title.substring(0, 50)}_${Date.now()}`;

    const watchlistEntry = {
      username,
      productId,
      product: {
        title: product.title,
        image: product.image,
        rating: product.rating,
      },
      priceHistory: [
        {
          price: parseInt(product.price) || 0,
          timestamp: new Date(),
          source: product.store || "Unknown",
        },
      ],
      isActive: true,
      addedAt: new Date(),
      lastChecked: new Date(),
      priceDropNotifications: [],
    };

    const result = await watchlistCollection.insertOne(watchlistEntry);
    res.json({
      message: "Product added to watchlist",
      watchlistId: result.insertedId,
    });
  } catch (err) {
    console.error("Add to watchlist error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get user's watchlist with price history
router.get("/watchlist/:username", async (req, res) => {
  try {
    const db = await connectDB();
    const watchlist = await db
      .collection("watchlist")
      .find({ username: req.params.username, isActive: true })
      .toArray();

    const enrichedWatchlist = watchlist.map((item) => ({
      _id: item._id,
      product: item.product,
      currentPrice: item.priceHistory[item.priceHistory.length - 1]?.price || 0,
      previousPrice:
        item.priceHistory.length > 1
          ? item.priceHistory[item.priceHistory.length - 2]?.price
          : null,
      priceHistory: item.priceHistory,
      addedAt: item.addedAt,
      lastChecked: item.lastChecked,
      priceDrops: item.priceDropNotifications || [],
    }));

    res.json(enrichedWatchlist);
  } catch (err) {
    console.error("Get watchlist error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Remove product from watchlist
router.delete("/watchlist/:watchlistId", async (req, res) => {
  try {
    const db = await connectDB();
    const { ObjectId } = require("mongodb");
    await db.collection("watchlist").updateOne(
      { _id: new ObjectId(req.params.watchlistId) },
      { $set: { isActive: false } }
    );
    res.json({ message: "Product removed from watchlist" });
  } catch (err) {
    console.error("Remove from watchlist error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── PRICE CHECKING & NOTIFICATION LOGIC ─────────────────────────────────────

// Helper: Update product price and check for drops
async function checkProductPriceDrops(db, watchlistEntry) {
  try {
    const currentPrice =
      watchlistEntry.priceHistory[watchlistEntry.priceHistory.length - 1]
        ?.price || 0;
    const previousPrice =
      watchlistEntry.priceHistory.length > 1
        ? watchlistEntry.priceHistory[watchlistEntry.priceHistory.length - 2]
            ?.price
        : currentPrice;

    // Detect price drop (at least 5% reduction)
    const priceDropPercentage = ((previousPrice - currentPrice) / previousPrice) * 100;

    if (priceDropPercentage >= 5) {
      return {
        hasPriceDrop: true,
        dropAmount: previousPrice - currentPrice,
        dropPercentage: priceDropPercentage.toFixed(2),
        previousPrice,
        currentPrice,
      };
    }

    return { hasPriceDrop: false };
  } catch (err) {
    console.error("Price drop check error:", err);
    return { hasPriceDrop: false };
  }
}

// Helper: Send price drop notification email
async function sendPriceDropEmail(username, product, priceDetails) {
  try {
    const discountBadge = Math.round(priceDetails.dropPercentage);
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; background: #f8fafc; padding: 20px;">
        <div style="max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 16px; box-shadow: 0 10px 30px rgba(15,23,42,0.08);">
          <h2 style="color: #1f2937; margin-bottom: 12px;">🎉 Price Drop Alert!</h2>
          <p style="color: #475569; margin-bottom: 20px; font-size: 16px;">Great news! A product in your watchlist has dropped in price.</p>
          
          <div style="background: #f0f9ff; border-left: 4px solid #3b82f6; padding: 16px; margin: 20px 0; border-radius: 8px;">
            <h3 style="color: #1e40af; margin-top: 0;">${product.title}</h3>
            <div style="display: flex; gap: 20px; margin: 16px 0;">
              <div>
                <p style="color: #6b7280; font-size: 12px; margin: 0 0 4px 0;">Previous Price</p>
                <p style="font-size: 24px; font-weight: 700; color: #9ca3af; margin: 0; text-decoration: line-through;">₹${priceDetails.previousPrice.toLocaleString()}</p>
              </div>
              <div style="display: flex; align-items: center;">
                <span style="font-size: 32px; color: #059669;">→</span>
              </div>
              <div>
                <p style="color: #6b7280; font-size: 12px; margin: 0 0 4px 0;">New Price</p>
                <p style="font-size: 24px; font-weight: 700; color: #059669; margin: 0;">₹${priceDetails.currentPrice.toLocaleString()}</p>
              </div>
            </div>
            
            <div style="background: #dcfce7; padding: 12px; border-radius: 8px; margin-top: 16px; text-align: center;">
              <span style="color: #15803d; font-weight: 700; font-size: 18px;">Save ₹${priceDetails.dropAmount.toLocaleString()} (${discountBadge}% OFF)</span>
            </div>
          </div>
          
          <p style="color: #475569; margin-top: 20px; font-size: 14px;">Check out your watchlist to view more details and add to cart.</p>
          <div style="text-align: center; margin-top: 25px;">
            <a href="http://localhost:3000" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">View Watchlist</a>
          </div>
          
          <p style="color: #9ca3af; font-size: 12px; margin-top: 25px; border-top: 1px solid #e5e7eb; padding-top: 15px;">
            Cognitive Cart Price Tracking System | ${new Date().toLocaleString()}
          </p>
        </div>
      </div>
    `;

    await emailApi.sendTransacEmail({
      sender: { email: "aakasltf06@gmail.com", name: "Cognitive Cart" },
      to: [{ email: username, name: username.split("@")[0] }],
      subject: `🎉 Price Drop Alert: ${Math.round(priceDetails.dropPercentage)}% OFF on "${product.title.substring(0, 40)}"`,
      htmlContent,
    });

    return true;
  } catch (err) {
    console.error("Email send error:", err?.response?.body || err.message);
    return false;
  }
}

// Scheduled job: Check all watchlisted products for price changes every 4 hours
async function monitorPricesScheduled() {
  try {
    const db = await connectDB();
    const watchlistCollection = db.collection("watchlist");

    // Get all active watchlist entries
    const allWatchedProducts = await watchlistCollection
      .find({ isActive: true })
      .toArray();

    console.log(
      `[PRICE MONITOR] Checking ${allWatchedProducts.length} products for price changes...`
    );

    for (const watchlistEntry of allWatchedProducts) {
      try {
        // Re-fetch current price for the product
        const searchResults = await Promise.all([
          scrapeAmazon(watchlistEntry.product.title),
          scrapeFlipkart(watchlistEntry.product.title),
          scrapeGoogle(watchlistEntry.product.title),
        ]);

        // Find best matching product from search results
        let currentPriceData = null;
        for (const results of searchResults) {
          if (results[0]) {
            currentPriceData = results[0];
            break;
          }
        }

        if (!currentPriceData) continue;

        const newPrice = parseInt(currentPriceData.price) || 0;
        const oldPrice =
          watchlistEntry.priceHistory[
            watchlistEntry.priceHistory.length - 1
          ]?.price || newPrice;

        // Add new price to history
        const updatedHistory = [
          ...watchlistEntry.priceHistory,
          {
            price: newPrice,
            timestamp: new Date(),
            source: currentPriceData.store || "Unknown",
          },
        ];

        // Check for price drop
        const dropDetails = await checkProductPriceDrops({
          ...watchlistEntry,
          priceHistory: updatedHistory,
        });

        // If price dropped and user hasn't been notified about this drop, send email
        if (dropDetails.hasPriceDrop) {
          const lastNotification =
            watchlistEntry.priceDropNotifications?.[
              watchlistEntry.priceDropNotifications.length - 1
            ];

          // Only send if no recent notification (within 24 hours)
          const shouldNotify =
            !lastNotification ||
            Date.now() - new Date(lastNotification.timestamp).getTime() > 24 * 60 * 60 * 1000;

          if (shouldNotify) {
            const emailSent = await sendPriceDropEmail(
              watchlistEntry.username,
              watchlistEntry.product,
              dropDetails
            );

            if (emailSent) {
              console.log(
                `[PRICE DROP] Notified ${watchlistEntry.username} about ${watchlistEntry.product.title}`
              );
            }
          }
        }

        // Build the update operation — $set and $push must be at top level
        const updateOp = {
          $set: {
            priceHistory: updatedHistory,
            lastChecked: new Date(),
          },
        };

        if (dropDetails.hasPriceDrop) {
          updateOp.$push = {
            priceDropNotifications: {
              dropAmount: dropDetails.dropAmount,
              dropPercentage: dropDetails.dropPercentage,
              timestamp: new Date(),
            },
          };
        }

        await watchlistCollection.updateOne(
          { _id: watchlistEntry._id },
          updateOp
        );
      } catch (err) {
        console.error(
          `Error checking product ${watchlistEntry.productId}:`,
          err.message
        );
      }
    }
  } catch (err) {
    console.error("[PRICE MONITOR] Error in scheduled job:", err);
  }
}

// ─── PRICE CHECK ENDPOINT (replaces setInterval — use Vercel Cron or manual trigger) ──
// Add to vercel.json crons: { "path": "/api/check-prices", "schedule": "0 */6 * * *" }
router.get("/check-prices", async (req, res) => {
  // Simple auth: optional secret header to prevent public abuse
  const secret = req.headers["x-cron-secret"] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    await monitorPricesScheduled();
    res.json({ ok: true, message: "Price check completed" });
  } catch (err) {
    console.error("[check-prices] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Export the router so script.js can mount it at /api
module.exports = router;

