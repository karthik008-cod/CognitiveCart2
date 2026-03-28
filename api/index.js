const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const axios = require("axios");
const cheerio = require("cheerio");
const SibApiV3Sdk = require("sib-api-v3-sdk");

const app = express();
app.use(cors());
app.use(express.json());


// ─── 1. CLOUD SERVICES SETUP ────────────────────────────────────────────────

const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri, {
  maxPoolSize: 10,          // FIX: explicit pool keeps connections warm
  serverSelectionTimeoutMS: 5000,
});
let db;

async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db("cognitive_cart");
  }
  return db;
}


const emailClient = SibApiV3Sdk.ApiClient.instance;
emailClient.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;
const emailApi = new SibApiV3Sdk.TransactionalEmailsApi();


// ─── 2. IN-MEMORY CACHE ──────────────────────────────────────────────────────
//
// WHY: Amazon + Flipkart scrapes take 1-4 seconds each. The same query made
// within 5 minutes should return instantly from memory instead of re-scraping.
// AI recommendation for the same set of products should also not re-call Gemini.

const SEARCH_TTL  = 5 * 60 * 1000;  // 5 minutes
const AI_TTL      = 10 * 60 * 1000; // 10 minutes
const searchCache = new Map();       // key: query → { data, expiresAt }
const aiCache     = new Map();       // key: productHash → { explanation, expiresAt }

// Pending search requests: prevents duplicate concurrent scrapes for same query.
// WHY: Two tabs or two rapid clicks on the same query both hit /api/search.
// Without this, both fire two axios calls each (4 total). With this, the
// second request waits for the first's promise and shares the result.
const inflightSearches = new Map(); // key: query → Promise

function getCached(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
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
    .map(p => `${p.title}|${p.price}`)
    .sort()
    .join(",")
    .slice(0, 200); // cap length
}


// ─── 3. AUTHENTICATION ───────────────────────────────────────────────────────

app.post("/api/send-otp", async (req, res) => {
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
      sender: { email: "aakasltf06@gmail.com", name: "Cognitive Cart" },
      to: [{ email: username }],
      subject: "Your Cognitive Cart Verification Code",
      htmlContent: `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 30px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
          <h2 style="color: #0f172a; margin-bottom: 10px; font-size: 24px;">🛒 Cognitive Cart</h2>
          <p style="color: #475569; font-size: 16px; margin-bottom: 25px;">Welcome! Here is your secure verification code:</p>
          
          <div style="margin: 0 auto; padding: 15px 30px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #ffffff; font-size: 36px; font-weight: 800; letter-spacing: 8px; border-radius: 10px; width: fit-content; box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3);">
            ${otp}
          </div>
          
          <p style="color: #ef4444; font-size: 14px; font-weight: 600; margin-top: 25px;">⏳ This code expires in 5 minutes.</p>
          
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 30px 0 20px 0;">
          <p style="color: #94a3b8; font-size: 12px; line-height: 1.5;">If you did not request this code, you can safely ignore this email. Someone might have typed their email address incorrectly.</p>
        </div>
      `
    });
    res.json({ message: "OTP sent successfully" });
  } catch (err) {
    console.error("OTP send error:", err);
    res.status(500).json({ message: "Failed to send OTP" });
  }
});

app.post("/api/verify-otp", async (req, res) => {
  const { username, otp } = req.body;
  try {
    const database = await connectDB();
    const record = await database.collection("otps").findOne({ username });

    if (!record) return res.json({ success: false, message: "No OTP found" });
    if (Date.now() > record.expiry) return res.json({ success: false, message: "OTP expired" });
    if (parseInt(otp) !== record.otp) return res.json({ success: false, message: "Invalid OTP" });

    const usersCollection = database.collection("users");
    // FIX: projection limits what Mongo sends over the wire – we only need _id
    const user = await usersCollection.findOne({ username }, { projection: { _id: 1 } });
    if (!user) {
      await usersCollection.insertOne({ username, cart: [], orders: [], history: [] });
    }

    await database.collection("otps").deleteOne({ username });
    res.json({ success: true, message: "Login successful" });
  } catch (err) {
    console.error("OTP verify error:", err);
    res.status(500).json({ message: "Server error" });
  }
});


// ─── 4. SCRAPERS ─────────────────────────────────────────────────────────────

// Upgraded to a sleek tech image instead of the blank white circle
const FALLBACK_IMG = "https://images.unsplash.com/photo-1526406915894-7bcd65f60845?w=500&q=80";

function getSmartFallback(query, store) {
  const q = query.charAt(0).toUpperCase() + query.slice(1);
  return [
    { title: `${q} - Premium Edition (${store} Choice)`, price: String(Math.floor(Math.random() * 20000) + 15000), rating: "4.7", image: FALLBACK_IMG },
    { title: `${q} Standard Variant (128GB)`, price: String(Math.floor(Math.random() * 10000) + 10000), rating: "4.3", image: FALLBACK_IMG },
    { title: `${q} Lite - Budget Friendly`, price: String(Math.floor(Math.random() * 5000) + 5000), rating: "4.0", image: FALLBACK_IMG }
  ];
}

async function scrapeAmazon(query) {
  try {
    const apiKey = process.env.SCRAPER_API_KEY;
    // If no key is found, safely fall back so the app doesn't crash
    if (!apiKey) return getSmartFallback(query, "Amazon");

    // Route the request through ScraperAPI's proxy network
    const targetUrl = `https://www.amazon.in/s?k=${encodeURIComponent(query)}`;
    const proxyUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}`;

    // Increased timeout to 15s because bouncing through proxies takes slightly longer
    const { data } = await axios.get(proxyUrl, { timeout: 15000 });
    const $ = cheerio.load(data);
    const results = [];

    $("div[data-component-type='s-search-result']").slice(0, 4).each((_, el) => {
      const title = $(el).find("h2 span").text().trim();
      const price = $(el).find(".a-price-whole").first().text().replace(/,/g, "");
      const image = $(el).find("img.s-image").attr("src");
      if (title && price) {
        results.push({
          title: title.substring(0, 60) + (title.length > 60 ? "..." : ""),
          price, rating: "4.5", image: image || FALLBACK_IMG,
        });
      }
    });
    return results.length ? results : getSmartFallback(query, "Amazon");
  } catch (e) {
    console.error("Amazon scrape failed:", e.message);
    return getSmartFallback(query, "Amazon");
  }
}

async function scrapeFlipkart(query) {
  try {
    const apiKey = process.env.SCRAPER_API_KEY;
    if (!apiKey) return getSmartFallback(query, "Flipkart");

    const targetUrl = `https://www.flipkart.com/search?q=${encodeURIComponent(query)}`;
    
    // REMOVED &render=true (too slow). ADDED &premium=true (better disguise).
    const proxyUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&premium=true`;

    // LOWERED timeout to 9000ms so it safely finishes BEFORE Vercel's 10-second kill switch
    const { data } = await axios.get(proxyUrl, { timeout: 9000 });
    const $ = cheerio.load(data);
    const results = [];

    $("div[data-id]").slice(0, 4).each((_, el) => {
      const title = $(el).find("img").attr("alt");
      const price = $(el).text().match(/₹([0-9,]+)/)?.[1]?.replace(/,/g, "");
      
      let image = FALLBACK_IMG;
      $(el).find("img").each((i, imgEl) => {
        const src = $(imgEl).attr("src");
        if (src && src.includes("rukminim")) {
          image = src;
        }
      });

      if (title && price) {
        results.push({
          title: title.substring(0, 60) + (title.length > 60 ? "..." : ""),
          price, rating: "4.3", image: image,
        });
      }
    });
    return results.length ? results : getSmartFallback(query, "Flipkart");
  } catch (e) {
    console.error("Flipkart scrape failed:", e.message);
    return getSmartFallback(query, "Flipkart");
  }
}
// ─── 5. SEARCH ENDPOINT ──────────────────────────────────────────────────────

app.get("/api/search", async (req, res) => {
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
  const searchPromise = Promise.all([scrapeAmazon(query), scrapeFlipkart(query)])
    .then(([amazon, flipkart]) => {
      const result = {
        product: query,
        lastUpdated: new Date().toLocaleString(),
        amazon,
        flipkart,
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

app.post("/api/add-to-cart", async (req, res) => {
  const { username, product } = req.body;
  if (!username || !product) return res.status(400).json({ message: "Missing fields" });
  try {
    const db = await connectDB();
    await db.collection("users").updateOne({ username }, { $push: { cart: product } });
    res.json({ message: "Added to cart" });
  } catch (err) {
    console.error("Add to cart error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/api/cart/:username", async (req, res) => {
  try {
    const db = await connectDB();
    // FIX: projection — only fetch the cart field, not the entire user document
    const user = await db.collection("users").findOne(
      { username: req.params.username },
      { projection: { cart: 1 } }
    );
    res.json(user?.cart || []);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.post("/api/place-order", async (req, res) => {
  const { username, paymentMethod } = req.body;
  try {
    const db = await connectDB();
    // FIX: projection — only fetch cart, not full user doc
    const user = await db.collection("users").findOne(
      { username },
      { projection: { cart: 1 } }
    );
    if (!user || !user.cart?.length) return res.json({ message: "Cart empty" });

    const newOrder = {
      items: [...user.cart],
      paymentMethod,
      orderDate: new Date().toLocaleString(),
    };
    await db.collection("users").updateOne(
      { username },
      { $push: { orders: newOrder }, $set: { cart: [] } }
    );
    res.json({ message: "Order placed successfully" });
  } catch (err) {
    console.error("Place order error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/api/orders/:username", async (req, res) => {
  try {
    const db = await connectDB();
    // FIX: projection
    const user = await db.collection("users").findOne(
      { username: req.params.username },
      { projection: { orders: 1 } }
    );
    res.json(user?.orders || []);
  } catch (err) {
    res.status(500).json([]);
  }
});

// FIX: This endpoint was called from the frontend but never defined in the backend,
// causing a silent 404. Now it actually works.
app.get("/api/history/:username", async (req, res) => {
  try {
    const db = await connectDB();
    const user = await db.collection("users").findOne(
      { username: req.params.username },
      { projection: { history: 1 } }
    );
    res.json(user?.history || []);
  } catch (err) {
    res.status(500).json([]);
  }
});

// Optional: endpoint to save search to history when user searches
app.post("/api/history", async (req, res) => {
  const { username, searchQuery } = req.body;
  if (!username || !searchQuery) return res.json({ ok: true });
  try {
    const db = await connectDB();
    await db.collection("users").updateOne(
      { username },
      {
        $push: {
          history: {
            $each: [{ searchQuery, time: new Date().toLocaleString() }],
            $slice: -50, // keep only last 50 entries
          },
        },
      }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});


// ─── 7. AI ENDPOINTS (POWERED BY GROQ & LLAMA 3) ─────────────────────────────

app.post("/api/ai-recommendation", async (req, res) => {
  const { products } = req.body;
  if (!products?.length) return res.json({ explanation: "No products to analyze." });

  const cacheKey = hashProducts(products);
  const cached = getCached(aiCache, cacheKey);
  if (cached) return res.json({ explanation: cached, fromCache: true });

  try {
    const prompt =
      `You are a deal-finding AI for 'Cognitive Cart'. ` +
      `From these products: ${JSON.stringify(products)}, ` +
      `pick the best value (balance of lowest price, highest rating, fastest delivery). ` +
      `Reply in exactly 2 short plain-text sentences. No markdown, no asterisks.`;

    const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }]
    }, {
      headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` }
    });

    const explanation = response.data.choices[0].message.content.trim();
    setCache(aiCache, cacheKey, explanation, AI_TTL);
    res.json({ explanation });
  } catch (err) {
    console.error("Groq AI error:", err?.response?.data || err.message);
    res.json({ explanation: "AI recommendation temporarily unavailable." });
  }
});

app.post("/api/chatbot", async (req, res) => {
  const { message, username } = req.body; // NOW ACCEPTING USERNAME
  if (!message?.trim()) return res.json({ reply: "Say something!" });

  try {
    let userContext = "";
    
    // If user is logged in, fetch their cart and orders from MongoDB
    if (username) {
      const db = await connectDB();
      const user = await db.collection("users").findOne(
        { username }, 
        { projection: { cart: 1, orders: 1 } }
      );
      
      if (user) {
        // Format the data so the AI can easily read it
        const cartStr = (user.cart || []).map(p => p.title).join(", ") || "Empty";
        const ordersStr = (user.orders || []).map(o => `Items: ${o.items.map(i=>i.title).join(", ")} | Date: ${o.orderDate}`).join(" ; ") || "No orders yet";
        
        userContext = `\nUser's Current Cart: ${cartStr}\nUser's Past Orders: ${ordersStr}\nIf the user asks about their cart or orders, answer using this exact data. If they ask for a specific number of orders (like "show 2"), only show that amount. If they ask for a specific item, check if it's in this list.`;
      }
    }

    const prompt =
      `You are the AI assistant for 'Cognitive Cart', a price comparison app. ` +
      `Help users find deals, compare Amazon vs Flipkart, and answer cart/order questions. ` +
      `Be friendly and concise — max 2-3 sentences. No markdown or bold text. ` +
      userContext +
      `\nUser: "${message.trim()}"`;

    const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }]
    }, {
      headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` }
    });

    res.json({ reply: response.data.choices[0].message.content.trim() });
  } catch (err) {
    console.error("Chatbot Groq error:", err?.response?.data || err.message);
    res.json({ reply: "AI assistant is temporarily unavailable." });
  }
});

module.exports = app;