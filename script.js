require("dotenv").config();

const otpStore = {}; // { username: { otp, expiry } }
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

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

const SibApiV3Sdk = require("sib-api-v3-sdk");

const client = SibApiV3Sdk.ApiClient.instance;
const apiKeyBrevo = client.authentications["api-key"];
apiKeyBrevo.apiKey = process.env.BREVO_API_KEY;

const emailApi = new SibApiV3Sdk.TransactionalEmailsApi();

async function sendEmailOTP(email, otp) {
    const sender = {
        email: "aakasltf06@gmail.com",
        name: "Cognitive Cart"
    };

    const receivers = [{ email }];

    const response = await emailApi.sendTransacEmail({
        sender,
        to: receivers,
        subject: "Your OTP Code",
        htmlContent: `
  <div style="font-family: Arial, sans-serif; background: #f4f6f8; padding: 20px;">
    
    <div style="max-width: 400px; margin: auto; background: white; padding: 25px; border-radius: 10px; text-align: center; box-shadow: 0 5px 15px rgba(0,0,0,0.1);">
      
      <h2 style="color: #4CAF50; margin-bottom: 10px;">🛒 CognitiveCart</h2>
      
      <p style="color: #555; font-size: 14px;">
        Use the following OTP to login to your account:
      </p>

      <div style="
  font-size: 28px;
  font-weight: bold;
  background: #f0f8ff;
  padding: 15px;
  border-radius: 8px;
  letter-spacing: 5px;
  color: #007BFF;
  margin: 20px 0;
">
  ${otp}
</div>

      <p style="font-size: 13px; color: #777;">
        This OTP is valid for <b>5 minutes</b>.
      </p>

      <hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;" />

      <p style="font-size: 12px; color: #aaa;">
        If you didn’t request this, you can ignore this email.
      </p>

    </div>

  </div>
`
    });

    console.log("BREVO RESPONSE:", response); // 🔥 ADD THIS
}

app.post("/send-otp", async (req, res) => {
    const { username } = req.body;

    if (!username) {
        return res.json({ message: "Username required" });
    }

    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username);

if (!isEmail) {
    return res.json({ message: "Enter valid email" });
}

    const otp = Math.floor(100000 + Math.random() * 900000);

    otpStore[username] = {
        otp: otp,
        expiry: Date.now() + 5 * 60 * 1000
    };

    try {
      await sendEmailOTP(username, otp);
      res.json({ message: "OTP sent successfully" });

    } catch (error) {
    console.error("FULL ERROR:", error.response?.body || error.message);
    res.json({ message: "Failed to send OTP" });
}
});

app.post("/verify-otp", (req, res) => {
    const { username, otp } = req.body;

    const record = otpStore[username];

    if (!record) {
        return res.json({ success: false, message: "No OTP found" });
    }

    if (Date.now() > record.expiry) {
        return res.json({ success: false, message: "OTP expired" });
    }

    if (parseInt(otp) !== record.otp) {
        return res.json({ success: false, message: "Invalid OTP" });
    }

    // OTP verified → register/login user
    let users = [];

    if (fs.existsSync("users.json")) {
        users = JSON.parse(fs.readFileSync("users.json"));
    }

    let user = users.find(u => u.username === username);

    if (!user) {
        // Register new user
        user = { username };
        users.push(user);
        fs.writeFileSync("users.json", JSON.stringify(users, null, 2));
    }

    delete otpStore[username];

    res.json({ success: true, message: "Login successful" });
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
  try {
    const { username, product } = req.body;

    console.log("BODY:", req.body);

    if (!username || !product) {
      return res.status(400).json({ message: "Invalid data" });
    }

    const users = readUsers();
    let user = users.find(u => u.username === username);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // 🔥 SAFETY INITIALIZATION (VERY IMPORTANT)
    if (!user.cart) user.cart = [];
    if (!user.orders) user.orders = [];
    if (!user.history) user.history = [];

    user.cart.push(product);

    saveUsers(users);

    res.json({ message: "Added to cart" });

  } catch (err) {
    console.error("ADD TO CART ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
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

  const python = spawn("python", ["product_scraper.py", query]);

  let data = "";
  let errorData = "";

  python.stdout.on("data", (chunk) => {
    data += chunk.toString();
  });

  python.stderr.on("data", (err) => {
    errorData += err.toString();
  });

  python.on("close", (code) => {
    if (errorData) {
      console.error("Python Error:", errorData);
    }

    try {
      const jsonStartIndex = data.indexOf("{");
      const cleanData = data.substring(jsonStartIndex);
      const parsed = JSON.parse(cleanData);

      res.json({
        product: query,
        lastUpdated: new Date().toLocaleString(),
        amazon: parsed.amazon || [],
        flipkart: parsed.flipkart || []
      });

    } catch (err) {
      console.error("Parse Error:", err);
      res.json({
        amazon: [],
        flipkart: [],
        error: "Scraper failed, showing fallback"
      });
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
