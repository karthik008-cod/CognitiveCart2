require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

// Allow Live Server (5500/5501), local Node (3000), and Vercel deployments
const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:5501",
  "http://127.0.0.1:5501",
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, Vercel server-side)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.endsWith(".vercel.app")) {
      callback(null, true);
    } else {
      callback(new Error("CORS: origin not allowed – " + origin));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());

// Serve static frontend assets
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Mount the MongoDB-backed API router
app.use("/api", require("./api"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 CogniCart backend running on port ${PORT}`);
  console.log(`👉 Open http://localhost:${PORT} in your browser!`);
});
