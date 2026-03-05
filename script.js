require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { exec } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());

/* ================= SERVE FRONTEND ================= */
// Serve static files (like style.css, images) from the current folder
app.use(express.static(__dirname));

// Send the index.html file when someone visits http://localhost:3000
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ================= USERS FILE ================= */
const USERS_FILE = path.join(__dirname, "users.json");

if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, "[]");
}

const readUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
const saveUsers = (data) => fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));

/* ================= AUTH ================= */
app.post("/signup", (req, res) => {
  const { username, password } = req.body;
  const users = readUsers();

  if (users.find(u => u.username === username)) {
    return res.json({ message: "Username already exists" });
  }

  users.push({
    username,
    password,
    cart: [],
    orders: [],
    history: []
  });

  saveUsers(users);
  res.json({ message: "Signup successful" });
});

app.post("/signin", (req, res) => {
  const { username, password } = req.body;
  const users = readUsers();

  const user = users.find(
    u => u.username === username && u.password === password
  );

  if (!user) return res.json({ message: "Invalid credentials" });
  res.json({ message: "Login successful" });
});

/* ================= CART ================= */
app.post("/add-to-cart", (req, res) => {
  const { username, product } = req.body;
  const users = readUsers();
  const user = users.find(u => u.username === username);

  if (!user) return res.json({ message: "User not found" });

  user.cart.push(product);
  saveUsers(users);
  res.json({ message: "Added to cart" });
});

app.get("/cart/:username", (req, res) => {
  const users = readUsers();
  const user = users.find(u => u.username === req.params.username);
  res.json(user?.cart || []);
});

/* ================= ORDERS ================= */
app.post("/place-order", (req, res) => {
  const { username, paymentMethod } = req.body;
  const users = readUsers();
  const user = users.find(u => u.username === username);

  if (!user || !user.cart.length) {
    return res.json({ message: "Cart empty" });
  }

  user.orders.push({
    items: [...user.cart],
    paymentMethod,
    orderDate: new Date().toLocaleString()
  });

  user.cart = [];
  saveUsers(users);
  res.json({ message: "Order placed successfully" });
});

app.get("/orders/:username", (req, res) => {
  const users = readUsers();
  const user = users.find(u => u.username === req.params.username);
  res.json(user?.orders || []);
});

/* ================= HISTORY ================= */
app.post("/add-history", (req, res) => {
  const { username, searchQuery } = req.body;
  const users = readUsers();
  const user = users.find(u => u.username === username);

  if (!user) return res.json({ message: "User not found" });

  user.history.push({
    searchQuery,
    time: new Date().toLocaleString()
  });

  saveUsers(users);
  res.json({ message: "History saved" });
});

app.get("/history/:username", (req, res) => {
  const users = readUsers();
  const user = users.find(u => u.username === req.params.username);
  res.json(user?.history || []);
});

/* ================= PRODUCT SEARCH (Python Scraper) ================= */
/* ================= PRODUCT SEARCH (Python Scraper) ================= */
app.get("/search", (req, res) => {
  const query = req.query.q;

  // 1. Increased timeout to 45 seconds (45000 ms) because Selenium Chrome can be slow
  exec(`python product_scraper.py "${query}"`, { timeout: 45000 }, (error, stdout, stderr) => {
    
    // 2. Only fail if there is an error AND Python didn't send us any data back
    if (error && !stdout.trim()) {
      console.error("Python timeout or crash:", error.message);
      return res.status(500).json({ error: "Scraper took too long to respond." });
    }

    try {
      // 3. Selenium sometimes prints weird warnings (like "DevTools listening..."). 
      // This trick finds exactly where your JSON data starts so it doesn't break.
      const jsonStartIndex = stdout.indexOf('{');
      const cleanData = stdout.substring(jsonStartIndex);
      
      const data = JSON.parse(cleanData);
      
      res.json({
        product: query,
        lastUpdated: new Date().toLocaleString(),
        amazon: data.amazon || [],
        flipkart: data.flipkart || []
      });

    } catch (parseError) {
      console.error("JSON Parse Error:", parseError);
      console.log("Raw Python Output:", stdout);
      res.status(500).json({ error: "Received invalid data from scraper." });
    }
  });
});

/* ================= AI RECOMMENDATION (OpenRouter) ================= */
app.post("/ai-recommendation", async (req, res) => {
  const { products } = req.body;

  if(!products || products.length === 0){
    return res.json({ explanation: "No products available." });
  }

  try {
    const prompt = `
    You are a shopping assistant.
    Products: ${JSON.stringify(products, null, 2)}
    Recommend the best product based on: lowest price, highest rating, fastest delivery. Answer in 2-3 lines.`;

    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "meta-llama/llama-3-8b-instruct",
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers:{
          "Authorization": `Bearer ${process.env.OPENROUTER_KEY}`,
          "Content-Type":"application/json"
        }
      }
    );

    const text = response?.data?.choices?.[0]?.message?.content;
    if(text) return res.json({ explanation: text });

  } catch(err){
    console.log("AI failed, using fallback recommendation");
  }

  /* ===== FALLBACK RECOMMENDATION ===== */
  const bestProduct = products.reduce((best, p) => {
    const rating = parseFloat(p.rating) || 0;
    const price = parseFloat(String(p.price).replace(/[^\d.]/g, "")) || 999999;
    const delivery = p.deliveryDays || 5;
    const score = rating * 5 - price / 1000 - delivery;

    if (!best || score > best.score) return { product: p, score };
    return best;
  }, null);

  if(!bestProduct){
    return res.json({ explanation: "Unable to determine best product." });
  }

  const p = bestProduct.product;
  const explanation = `${p.title} is recommended because it offers a good balance of price (₹${p.price}), rating (${p.rating}), and delivery time (${p.deliveryDays || 3} days).`;
  
  res.json({ explanation });
});

/* ================= CHATBOT ================= */
app.post("/chatbot", async (req, res) => {
  const { message, username } = req.body;
  const msg = message.toLowerCase();
  const users = readUsers();
  const user = users.find(u => u.username === username);

  if (msg.includes("order")) {
    if (!user || !user.orders.length) return res.json({ reply: "You have no orders yet." });
    let reply = "📦 Your Orders:\n";
    user.orders.forEach((order, i) => {
      reply += `\nOrder ${i+1} (${order.orderDate})\n`;
      order.items.forEach(item => { reply += `• ${item.title} - ₹${item.price}\n`; });
    });
    return res.json({ reply });
  }

  if (msg.includes("cart")) {
    if (!user || !user.cart.length) return res.json({ reply: "Your cart is empty." });
    let reply = "🛒 Items in your cart:\n";
    user.cart.forEach(item => { reply += `• ${item.title} - ₹${item.price}\n`; });
    return res.json({ reply });
  }

  if (msg.includes("history") || msg.includes("search history") || msg.includes("my searches")) {
    if (!user || !user.history.length) return res.json({ reply: "You have no search history yet." });
    let reply = "🕘 Your Search History:\n";
    user.history.forEach((h, i) => { reply += `\n${i+1}. ${h.searchQuery} (${h.time})`; });
    return res.json({ reply });
  }

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "meta-llama/llama-3-8b-instruct",
        messages: [{ role: "user", content: message }]
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    const text = response.data.choices[0].message.content;
    res.json({ reply: text });

  } catch (err) {
    console.error("Chatbot error:", err.message);
    res.json({ reply: "AI assistant is temporarily unavailable." });
  }
});
 
/* ================= START SERVER ================= */
app.listen(3000, () => {
  console.log("🔥 Cognitive Cart backend running on port 3000");
  console.log("👉 Open http://localhost:3000 in your browser!");
});
