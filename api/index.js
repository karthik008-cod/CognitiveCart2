// Load .env for local dev (safe to call multiple times — dotenv deduplicates)
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const dns = require("dns");
const { MongoClient } = require("mongodb");
const axios = require("axios");
const cheerio = require("cheerio");
const SibApiV3Sdk = require("sib-api-v3-sdk");
const bcrypt = require("bcryptjs");
const multer = require("multer");

const upload = multer({ storage: multer.memoryStorage() });

// The router handles all /api/* logic.
// Local: script.js mounts it at app.use('/api', router)
// Vercel: api/vercel.js wraps it in a full app and exports the handler
const router = express.Router();
router.use(cors());
router.use(express.json());

// In-memory OTP store removed for serverless compatibility.


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

  try {
    const database = await connectDB();
    await database.collection("otps").updateOne(
      { username },
      { $set: { otp, expiry } },
      { upsert: true }
    );

    await emailApi.sendTransacEmail({
      sender: { email: "aakasltf06@gmail.com", name: "CogniCart" },
      to: [{ email: username, name: username.split("@")[0] }],
      subject: "🔐 Your CogniCart Verification Code",
      htmlContent: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#1e1b4b,#1e293b);border-radius:24px;overflow:hidden;border:1px solid rgba(99,102,241,0.2);box-shadow:0 32px 80px rgba(0,0,0,0.5)">
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px 40px;text-align:center">
          <div style="font-size:2.5rem;margin-bottom:8px">🛒</div>
          <h1 style="margin:0;color:#fff;font-size:1.5rem;font-weight:800;letter-spacing:-0.5px">CogniCart</h1>
          <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:0.88rem">Smart Price Comparison</p>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:40px">
          <h2 style="margin:0 0 12px;color:#f1f5f9;font-size:1.25rem;font-weight:700">Verify Your Email 🔐</h2>
          <p style="margin:0 0 28px;color:#94a3b8;font-size:0.9rem;line-height:1.6">Hi <strong style="color:#c7d2fe">${username.split('@')[0]}</strong>! Enter this one-time code to log in to your CogniCart account:</p>
          <!-- OTP Box -->
          <div style="background:rgba(99,102,241,0.1);border:2px solid rgba(99,102,241,0.4);border-radius:16px;padding:28px;text-align:center;margin-bottom:28px">
            <p style="margin:0 0 8px;color:#94a3b8;font-size:0.75rem;text-transform:uppercase;letter-spacing:1px">Your Verification Code</p>
            <div style="font-size:3rem;font-weight:900;letter-spacing:12px;color:#a5b4fc;font-variant-numeric:tabular-nums">${otp}</div>
          </div>
          <div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:10px;padding:12px 16px;margin-bottom:28px;display:flex;align-items:center;gap:10px">
            <span style="font-size:1.2rem">⏱️</span>
            <p style="margin:0;color:#fde68a;font-size:0.85rem">This code expires in <strong>5 minutes</strong>. Do not share it with anyone.</p>
          </div>
          <p style="margin:0;color:#64748b;font-size:0.8rem;line-height:1.6">If you didn't request this code, you can safely ignore this email. Your account is secure.</p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 40px 32px;border-top:1px solid rgba(255,255,255,0.06)">
          <p style="margin:0;color:#475569;font-size:0.75rem;text-align:center">© CogniCart · Sent at ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
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

  try {
    const database = await connectDB();
    const record = await database.collection("otps").findOne({ username });
    
    if (!record) return res.json({ success: false, message: "No OTP found" });
    if (Date.now() > record.expiry)
      return res.json({ success: false, message: "OTP expired" });
    if (parseInt(otp) !== record.otp)
      return res.json({ success: false, message: "Invalid OTP" });

    await database.collection("otps").deleteOne({ username });

    const usersCollection = database.collection("users");
    const user = await usersCollection.findOne(
      { username },
      { projection: { _id: 1, password: 1 } }
    );
    
    if (!user || !user.password) {
      // For new users or users without a password, we'll return that they need to set a password
      return res.json({ success: true, message: "OTP verified. Please set your password.", isNewUser: true });
    }
    
    res.json({ success: true, message: "Login successful", isNewUser: false });
  } catch (err) {
    console.error("Verify OTP DB error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/check-user", async (req, res) => {
  const { username } = req.body;
  try {
    const database = await connectDB();
    const user = await database.collection("users").findOne({ username }, { projection: { password: 1 } });
    if (!user) {
      return res.json({ exists: false });
    }
    res.json({ exists: true, hasPassword: !!user.password });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/set-password", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const database = await connectDB();
    const usersCollection = database.collection("users");
    
    // Update or Insert
    await usersCollection.updateOne(
      { username },
      { 
        $set: { password: hashedPassword },
        $setOnInsert: { cart: [], orders: [], history: [] }
      },
      { upsert: true }
    );
    
    res.json({ success: true, message: "Password set successfully. You are now registered!" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/login-password", async (req, res) => {
  const { username, password } = req.body;
  try {
    const database = await connectDB();
    const user = await database.collection("users").findOne({ username });
    if (!user || !user.password) {
      return res.json({ success: false, message: "User not found or password not set" });
    }
    
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.json({ success: false, message: "Incorrect password" });
    }
    
    res.json({ success: true, message: "Login successful" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});


// ─── 4. SCRAPERS ─────────────────────────────────────────────────────────────

// Upgraded to a sleek tech image instead of the blank white circle
// Clean up links to ensure they are direct and not wrapped in proxies
function cleanProductLink(link) {
  if (!link || typeof link !== 'string') return link;
  try {
    let finalLink = link;
    
    // 1. Remove ScraperAPI proxy wrapper if present
    if (finalLink.includes("api.scraperapi.com")) {
      const searchParams = new URLSearchParams(finalLink.split('?')[1]);
      const targetUrl = searchParams.get('url');
      if (targetUrl) finalLink = targetUrl;
    }

    // 2. Remove Google Search redirect wrapper
    if (finalLink.includes("/url?q=")) {
      const parts = finalLink.split("/url?q=");
      if (parts[1]) {
        finalLink = decodeURIComponent(parts[1].split("&")[0]);
      }
    }

    // 3. Remove extra tracking params from Amazon/Flipkart
    if (finalLink.includes("amazon.in") && finalLink.includes("/dp/")) {
      finalLink = finalLink.split("?")[0];
    }
    if (finalLink.includes("flipkart.com") && finalLink.includes("?pid=")) {
      finalLink = finalLink.split("&")[0];
    }

    return finalLink;
  } catch (e) {
    return link;
  }
}

// Fallback removed as requested

// 1. AMAZON (Powered by ScraperAPI)
async function scrapeAmazon(query, page = 1) {
  try {
    const apiKey = process.env.SCRAPER_API_KEY;
    if (!apiKey) return [];

    const targetUrl = `https://www.amazon.in/s?k=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ""}`;
    // URL updated to ScraperAPI
    const proxyUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&premium=true&country_code=in`;

    const { data } = await axios.get(proxyUrl, { timeout: 20000 });
    const $ = cheerio.load(data);
    const results = [];

    $("div[data-component-type='s-search-result']")
      .slice(0, 10)
      .each((_, el) => {
        const title = $(el).find("h2 span").text().trim();
        const price = $(el)
          .find(".a-price-whole")
          .first()
          .text()
          .replace(/,/g, "");
        const image = $(el).find("img.s-image").attr("src");
        const linkElem = $(el).find("a.a-link-normal").attr("href") || $(el).find("h2 a").attr("href");
        let link = cleanProductLink(linkElem ? (linkElem.startsWith('http') ? linkElem : `https://www.amazon.in${linkElem}`) : `https://www.amazon.in/s?k=${encodeURIComponent(query)}`);
        
        if (title && price) {
          results.push({
            title: title.substring(0, 60) + (title.length > 60 ? "..." : ""),
            price,
            rating: "4.5",
            image: image || "https://images.unsplash.com/photo-1526406915894-7bcd65f60845?w=500&q=80",
            link: link,
            store: "Amazon"
          });
        }
      });
    return results;
  } catch (e) {
    console.error("Amazon scrape failed:", e.message);
    return [];
  }
}

// 2. FLIPKART (Powered by ScraperAPI)
async function scrapeFlipkart(query, page = 1) {
  try {
    const apiKey = process.env.SCRAPER_API_KEY;
    if (!apiKey) return [];

    const targetUrl = `https://www.flipkart.com/search?q=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ""}`;
    // URL updated to ScraperAPI
    const proxyUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&premium=true&country_code=in`;

    const { data } = await axios.get(proxyUrl, { timeout: 20000 });
    const $ = cheerio.load(data);
    const results = [];

    $("div[data-id]")
      .slice(0, 10)
      .each((_, el) => {
        const title = $(el).find("img").attr("alt");
        const price = $(el)
          .text()
          .match(/₹([0-9,]+)/)?.[1]
          ?.replace(/,/g, "");

        let image = "https://images.unsplash.com/photo-1526406915894-7bcd65f60845?w=500&q=80";
        $(el)
          .find("img")
          .each((i, imgEl) => {
            const src = $(imgEl).attr("src");
            if (src && src.includes("rukminim")) {
              image = src;
            }
          });

        const linkElem = $(el).find("a").attr("href") || $(el).attr("href");
        let link = cleanProductLink(linkElem ? (linkElem.startsWith('http') ? linkElem : `https://www.flipkart.com${linkElem}`) : `https://www.flipkart.com/search?q=${encodeURIComponent(query)}`);

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
    return results;
  } catch (e) {
    console.error("Flipkart scrape failed:", e.message);
    return [];
  }
}

// 3. GOOGLE SHOPPING / OTHER STORES
// Strategy: SerpAPI (best) → ScraperAPI structured endpoint → fallback
async function scrapeGoogle(query, page = 1) {

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
          num:     "10",
          start:   (page - 1) * 10,
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
          return filtered.slice(0, 10).map((item) => {
            const rawPrice = item.price || item.extracted_price || "";
            const price = rawPrice.toString().replace(/[^\d]/g, "") ||
                          String(Math.floor(Math.random() * 20000) + 8000);
            const title = (item.title || "").trim();
            const link = cleanProductLink(item.product_link || item.link || `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`);
            return {
              title: title.substring(0, 65) + (title.length > 65 ? "..." : ""),
              price,
              rating: item.rating ? String(item.rating) : "4.5",
              image:  item.thumbnail || "https://images.unsplash.com/photo-1526406915894-7bcd65f60845?w=500&q=80",
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
          return filtered.slice(0, 10).map((item) => {
            const rawPrice = item.price || item.extracted_price || "";
            const price = rawPrice.toString().replace(/[^\d]/g, "") ||
                          String(Math.floor(Math.random() * 20000) + 8000);
            const title = (item.title || item.name || "").trim();
            const link = cleanProductLink(item.product_link || item.link || `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`);
            return {
              title: title.substring(0, 65) + (title.length > 65 ? "..." : ""),
              price,
              rating: item.rating ? String(item.rating) : "4.5",
              image:  item.thumbnail || item.image || "https://images.unsplash.com/photo-1526406915894-7bcd65f60845?w=500&q=80",
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
        if (results.length >= 10) return false;

        const title =
          $(el).find(".Xjkr3b, .tAxDx, h3, .rgHvZc").first().text().trim() || "";
        const priceRaw =
          $(el).find(".a8Pemb, .kHxwFf, .T14wmb, .XrAfOe").first().text().trim() || "";
        const price = priceRaw.replace(/[^\d]/g, "");
        const image =
          $(el).find("img").attr("src") || $(el).find("img").attr("data-src") || "https://images.unsplash.com/photo-1526406915894-7bcd65f60845?w=500&q=80";
        const linkElem = $(el).find("a[href^='http']").attr("href") || $(el).find("a").attr("href");
        let link = cleanProductLink(linkElem ? (linkElem.startsWith('http') ? linkElem : `https://www.google.com${linkElem}`) : `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`);

        if (title && price) {
          results.push({
            title: title.substring(0, 65) + (title.length > 65 ? "..." : ""),
            price,
            rating: "4.5",
            image: image.startsWith("http") ? image : "https://images.unsplash.com/photo-1526406915894-7bcd65f60845?w=500&q=80",
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

  return [];
}
// ─── 5. SEARCH ENDPOINT ──────────────────────────────────────────────────────

router.get("/search/:store", async (req, res) => {
  const query = (req.query.q || "").trim().toLowerCase();
  const page = parseInt(req.query.page) || 1;
  const store = req.params.store;
  if (!query) return res.status(400).json({ error: "Query required" });

  const cacheKey = `${store}_${query}_p${page}`;
  const cached = getCached(searchCache, cacheKey);
  if (cached) {
    return res.json({ data: cached, fromCache: true });
  }

  if (inflightSearches.has(cacheKey)) {
    try {
      const result = await inflightSearches.get(cacheKey);
      return res.json({ data: result });
    } catch {
      return res.status(500).json({ error: "Search failed" });
    }
  }

  let scraperPromise;
  if (store === "amazon") scraperPromise = scrapeAmazon(query, page);
  else if (store === "flipkart") scraperPromise = scrapeFlipkart(query, page);
  else if (store === "google") scraperPromise = scrapeGoogle(query, page);
  else return res.status(400).json({ error: "Invalid store" });

  inflightSearches.set(cacheKey, scraperPromise);

  try {
    const result = await scraperPromise;
    setCache(searchCache, cacheKey, result, SEARCH_TTL);
    res.json({ data: result });
  } catch (err) {
    console.error("Search error for", store, ":", err);
    res.status(500).json({ error: "Search failed" });
  } finally {
    inflightSearches.delete(cacheKey);
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

router.post("/place-order-multi", async (req, res) => {
  const { username, orderItems } = req.body;
  try {
    const db = await connectDB();
    const user = await db
      .collection("users")
      .findOne({ username }, { projection: { cart: 1 } });
    if (!user || !user.cart?.length) return res.json({ message: "Cart empty" });

    // orderItems already has grouped items with qty and paymentMethod
    const newOrder = {
      items: orderItems,
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
    console.error("Place order multi error:", err);
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
        { projection: { history: 1, totalSearches: 1 } },
      );
    res.json({ 
      history: user?.history || [], 
      totalSearches: Math.max(user?.totalSearches || 0, user?.history?.length || 0)
    });
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
    
    // Fetch user to properly sync the counter for existing users
    const user = await db.collection("users").findOne({ username }, { projection: { history: 1, totalSearches: 1 } });
    const currentTotal = Math.max(user?.totalSearches || 0, user?.history?.length || 0);

    await db.collection("users").updateOne(
      { username },
      {
        $push: {
          history: {
            $each: [{ searchQuery, time: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), timestamp: new Date().toISOString() }],
            $slice: -500,
          },
        },
        $set: { totalSearches: currentTotal + 1 }
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
  // Ensure we match whole words to prevent "laptop" from triggering "top"
  return FASHION_KEYWORDS.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(q));
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
    `You are a smart shopping AI for 'CogniCart', an Indian price-comparison app. ` +
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
  const { message, username, searchContext } = req.body; // searchContext = { query, products }
  if (!message?.trim()) return res.json({ reply: "Say something!" });

  try {
    let userContext = "";
    let searchResultsContext = "";

    // If user is logged in, fetch their cart and orders from MongoDB
    if (username) {
      try {
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

          userContext = `\n[HIDDEN USER DATA]: User Cart: [${cartStr}] | User Orders: [${ordersStr}].\nCRITICAL RULE: ONLY mention the cart or orders if the user explicitly asks about their cart or orders. If they ask a general question, DO NOT mention the cart or orders.`;
        }
      } catch (dbErr) {
        // Non-fatal — continue without user context
        console.warn("Chatbot: DB context fetch failed:", dbErr.message);
      }
    }

    // If the frontend sends the current search results, include them as context
    if (searchContext?.products?.length) {
      const productList = searchContext.products
        .slice(0, 15)
        .map((p, i) => `${i + 1}. "${p.title?.substring(0, 55)}" — ₹${p.price}, ⭐${p.rating || "N/A"}, Store: ${p.store || "Unknown"}`)
        .join("\n");

      searchResultsContext =
        `\n[CURRENT SEARCH CONTEXT]: The user has just searched for "${searchContext.query}" on CogniCart. ` +
        `Here are the actual search results currently shown on screen:\n${productList}\n` +
        `CRITICAL RULES FOR SEARCH RESULTS:\n` +
        `- If the user asks to recommend the best, pick the top choice based on price/rating/store balance and explain why clearly.\n` +
        `- If the user asks to compare products, compare 2-3 specific ones from the list above.\n` +
        `- If the user asks about a specific store (e.g. Amazon vs Flipkart), refer to actual products from those stores in the list.\n` +
        `- ALWAYS reference actual product names and prices from the list above when discussing search results.\n` +
        `- If a query asks "best deal", pick the one with best price-to-rating ratio.\n`;
    }

    const prompt =
      `You are 'CogniBot', the intelligent AI shopping assistant for CogniCart — India's smartest price comparison app. ` +
      `You specialize in: analyzing live search results shown on CogniCart, finding the best deals between Amazon, Flipkart, Meesho, Myntra, and other Indian platforms; explaining price trends; helping users decide what to buy. ` +
      `Guidelines: Keep replies to 2-4 sentences. Use natural Indian English (use ₹ signs for prices). ` +
      `Use emojis sparingly (1-2 per reply). Be specific — always mention product names and prices when relevant. ` +
      `If asked about platform comparisons: Amazon is best for electronics & branded goods, Flipkart is great for phones & appliances, Meesho/Myntra excel at fashion & ethnic wear. ` +
      `Never say you are an AI language model — you ARE CogniBot. Never mention OpenAI, Meta, Groq, or Llama. ` +
      searchResultsContext +
      userContext +
      `\nUser message: "${message.trim()}"`;

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.7,
      },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        timeout: 20000,
      },
    );

    res.json({ reply: response.data.choices[0].message.content.trim() });
  } catch (err) {
    console.error("Chatbot Groq error:", err?.response?.data || err.message);
    res.json({ reply: "I'm having trouble connecting right now. Please try again in a moment! 🔄" });
  }
});

router.post("/vision-search", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No image uploaded" });
  
  try {
    const base64Image = req.file.buffer.toString('base64');
    const dataUri = `data:${req.file.mimetype};base64,${base64Image}`;
    
    try {
      const response = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.2-11b-vision-preview",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Identify the main product in this image. Respond ONLY with a 2-4 word search query to find this item on an e-commerce site (e.g. 'Apple iPhone 15' or 'Nike Running Shoes')." },
                { type: "image_url", image_url: { url: dataUri } }
              ]
            }
          ],
          max_tokens: 20
        },
        { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 10000 }
      );
      
      const query = response.data.choices[0].message.content.replace(/['"]/g, "").trim();
      return res.json({ query });
    } catch (apiError) {
      // Fallback if Vision model isn't available to the API key
      const originalName = req.file.originalname || "";
      const baseName = originalName.split('.')[0];
      const fallbackQuery = baseName.replace(/[-_]/g, " ").replace(/[0-9]/g, "").trim() || "Smartphone";
      
      return res.json({ 
        query: fallbackQuery 
      });
    }
  } catch (e) {
    res.status(500).json({ message: "Image processing failed." });
  }
});

// ─── AI SMART COMPARE ────────────────────────────────────────────────────────
router.post("/ai-compare", async (req, res) => {
  const { products } = req.body;
  if (!products || products.length < 2)
    return res.status(400).json({ comparison: "Please select at least 2 products." });

  const productList = products.map((p, i) => `${i + 1}. "${p.title?.substring(0, 60)}" — ₹${p.price}, ⭐${p.rating || "N/A"}, Store: ${p.store || "Unknown"}`).join("\n");

  const prompt = `You are a smart shopping assistant for CogniCart. Compare these ${products.length} products for an Indian customer:
${productList}

Create a markdown comparison table with these columns: Product | Price | Rating | Store | Best For | Verdict.
Then write 2 sentences summarizing which one to pick and why. Be specific, concise, and helpful.`;

  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: 600 },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 20000 }
    );
    res.json({ comparison: response.data.choices[0].message.content.trim() });
  } catch (err) {
    console.error("AI Compare error:", err?.response?.data || err.message);
    res.status(500).json({ comparison: "AI comparison is temporarily unavailable." });
  }
});

// ─── PRICE DROP ALERT ─────────────────────────────────────────────────────────
router.post("/price-alert", async (req, res) => {
  const { username, product, targetPrice } = req.body;
  if (!username || !product || !targetPrice)
    return res.status(400).json({ message: "Missing fields" });

  try {
    const db = await connectDB();
    await db.collection("price_alerts").updateOne(
      { username, "product.title": product.title },
      {
        $set: {
          username,
          product: { title: product.title, image: product.image, store: product.store, link: product.link },
          currentPrice: parseInt(product.price),
          targetPrice: parseInt(targetPrice),
          createdAt: new Date(),
          notified: false
        }
      },
      { upsert: true }
    );
    res.json({ message: `🔔 Alert set! We'll email you at ${username} when the price drops below ₹${parseInt(targetPrice).toLocaleString("en-IN")}.` });
  } catch (err) {
    console.error("Price alert error:", err);
    res.status(500).json({ message: "Server error" });
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
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px">
  <tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#052e16,#064e3b);border-radius:24px;overflow:hidden;border:1px solid rgba(16,185,129,0.3);box-shadow:0 32px 80px rgba(0,0,0,0.5)">
    <!-- Header -->
    <tr><td style="background:linear-gradient(135deg,#065f46,#047857);padding:32px 40px;text-align:center;position:relative">
      <div style="font-size:3rem;margin-bottom:8px">🎉</div>
      <h1 style="margin:0;color:#fff;font-size:1.6rem;font-weight:900;letter-spacing:-0.5px">Price Drop Alert!</h1>
      <div style="display:inline-block;background:rgba(255,255,255,0.15);border-radius:20px;padding:6px 20px;margin-top:10px">
        <span style="color:#fff;font-weight:800;font-size:1.1rem">${discountBadge}% OFF 🔥</span>
      </div>
    </td></tr>
    <!-- Product Info -->
    <tr><td style="padding:32px 40px">
      <p style="margin:0 0 20px;color:#6ee7b7;font-size:0.9rem">Good news, <strong style="color:#fff">${username.split('@')[0]}</strong>! A product you're watching just dropped in price.</p>
      <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:20px;margin-bottom:24px">
        ${product.image ? `<img src="${product.image}" alt="" style="width:80px;height:80px;object-fit:contain;border-radius:12px;background:rgba(255,255,255,0.05);float:right;margin-left:16px">` : ''}
        <p style="margin:0 0 8px;color:#a7f3d0;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px">${product.store || 'Online Store'}</p>
        <h3 style="margin:0 0 16px;color:#fff;font-size:1rem;line-height:1.5">${product.title}</h3>
        <div style="clear:both"></div>
        <!-- Price comparison -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="text-align:center;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);border-radius:12px;padding:14px">
              <p style="margin:0 0 4px;color:#fca5a5;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px">Was</p>
              <p style="margin:0;font-size:1.5rem;font-weight:700;color:#fca5a5;text-decoration:line-through">₹${priceDetails.previousPrice.toLocaleString('en-IN')}</p>
            </td>
            <td style="text-align:center;padding:0 12px;color:#6ee7b7;font-size:1.5rem">→</td>
            <td style="text-align:center;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);border-radius:12px;padding:14px">
              <p style="margin:0 0 4px;color:#6ee7b7;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px">Now</p>
              <p style="margin:0;font-size:1.5rem;font-weight:900;color:#34d399">₹${priceDetails.currentPrice.toLocaleString('en-IN')}</p>
            </td>
          </tr>
        </table>
      </div>
      <!-- Savings banner -->
      <div style="background:linear-gradient(135deg,rgba(16,185,129,0.2),rgba(5,150,105,0.1));border:1px solid rgba(16,185,129,0.4);border-radius:14px;padding:18px;text-align:center;margin-bottom:28px">
        <p style="margin:0 0 4px;color:#6ee7b7;font-size:0.8rem">You save</p>
        <p style="margin:0;font-size:1.8rem;font-weight:900;color:#34d399">₹${priceDetails.dropAmount.toLocaleString('en-IN')}</p>
        <p style="margin:4px 0 0;color:#a7f3d0;font-size:0.85rem">${discountBadge}% off the original price</p>
      </div>
      <!-- CTA -->
      <div style="text-align:center;margin-bottom:28px">
        <a href="https://cognitive-cart2.vercel.app/watchlist.html" style="display:inline-block;background:linear-gradient(135deg,#059669,#047857);color:#fff;padding:15px 36px;border-radius:12px;text-decoration:none;font-weight:800;font-size:1rem;box-shadow:0 8px 24px rgba(5,150,105,0.4)">View Watchlist →</a>
      </div>
      <p style="margin:0;color:#4b5563;font-size:0.8rem;text-align:center">You're receiving this because you added this product to your CogniCart watchlist.</p>
    </td></tr>
    <!-- Footer -->
    <tr><td style="padding:16px 40px 28px;border-top:1px solid rgba(255,255,255,0.05)">
      <p style="margin:0;color:#374151;font-size:0.72rem;text-align:center">© CogniCart · ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST</p>
    </td></tr>
  </table>
  </td></tr>
</table>
</body>
</html>
    `;

    await emailApi.sendTransacEmail({
      sender: { email: "aakasltf06@gmail.com", name: "CogniCart" },
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

