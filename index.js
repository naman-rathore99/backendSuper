// server/index.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const {
  createLocalOrder,
  setOrderStatus,
  get,
  getByRazorpayOrderId,
} = require("./ordersStore.js");

const app = express();

// ============================================
// 1. Validate Environment Variables at Startup
// ============================================
const requiredEnvVars = ["RZP_KEY_ID", "RZP_KEY_SECRET"];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`Missing required env vars: ${missingVars.join(", ")}`);
  process.exit(1);
}

// ============================================
// 2. CORS Configuration
// ============================================
const corsOptions = {
  origin: process.env.CLIENT_URL || "http://localhost:5173", // Adjust to your frontend URL
  credentials: true,
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

// ============================================
// 3. Body Parser Middleware
// ============================================
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      // Keep raw body for signature verification
      req.rawBody = buf.toString();
    },
  })
);

// ============================================
// 4. Request Logging Middleware
// ============================================
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================
// 5. Initialize Razorpay
// ============================================
const rzp = new Razorpay({
  key_id: process.env.RZP_KEY_ID,
  key_secret: process.env.RZP_KEY_SECRET,
});

// ============================================
// 6. Health Check Endpoint
// ============================================
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============================================
// 7. Create Order Endpoint
// ============================================
app.post("/create-order", async (req, res) => {
  try {
    const { amount, currency = "INR", metadata } = req.body;

    // Enhanced validation
// Validate amount
if (!amount || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
  return res.status(400).json({ error: "Invalid amount" });
}

// Convert to paise safely
const paise = Math.round(amount * 100);

// Ensure amount didn't have more than 2 decimal places (tolerant to float precision)
if (Math.abs(paise / 100 - amount) > 0.001) {
  return res.status(400).json({
    error: "Amount can have maximum 2 decimal places",
  });
}


    // Validate currency
    const validCurrencies = ["INR", "USD", "EUR", "GBP"];
    if (!validCurrencies.includes(currency)) {
      return res.status(400).json({ 
        error: `Invalid currency. Must be one of: ${validCurrencies.join(", ")}` 
      });
    }

    // Create a local order id (your system)
    const ourOrderId = `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Create Razorpay order (amount in paise)
    const options = {
      amount: paise, // Use floor to avoid overcharging
      currency,
      receipt: `rcpt_${ourOrderId}`,
      payment_capture: 1, // Auto capture. Use 0 for manual capture
      notes: metadata || {},
    };

    const order = await rzp.orders.create(options);

    // Save mapping in DB
    createLocalOrder({
      ourOrderId,
      amount,
      currency,
      razorpayOrderId: order.id,
    });

    console.log(`Order created: ${ourOrderId} -> ${order.id}`);

    return res.json({
      ourOrderId,
      razorpayOrderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RZP_KEY_ID, // Send key_id for frontend
    });
  } catch (err) {
    console.error("Create order error:", err);
    return res.status(500).json({ 
      error: "Failed to create order",
      message: err.message 
    });
  }
});

// ============================================
// 8. Order Status Endpoint
// ============================================
app.get("/order-status/:ourOrderId", (req, res) => {
  try {
    const ourId = req.params.ourOrderId;
    
    if (!ourId) {
      return res.status(400).json({ error: "Order ID required" });
    }

    const order = get(ourId);
    
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    return res.json({
      ourOrderId: order.ourId,
      status: order.status,
      razorpayOrderId: order.razorpayOrderId,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    console.error("Order status error:", err);
    return res.status(500).json({ error: "Failed to fetch order status" });
  }
});

// ============================================
// 9. Payment Verification Endpoint (Client-side)
// ============================================
app.post("/verify-payment", async (req, res) => {
  try {
    const { 
      razorpay_order_id, 
      razorpay_payment_id, 
      razorpay_signature 
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Verify signature
    const text = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RZP_KEY_SECRET)
      .update(text)
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      // Update order status
      const local = getByRazorpayOrderId(razorpay_order_id);
      
      if (local) {
        if (local.status !== "paid") {
          setOrderStatus(local.ourId, "paid");
          console.log(`Payment verified: ${local.ourId}`);
        }
        
        return res.json({ 
          success: true, 
          message: "Payment verified successfully",
          ourOrderId: local.ourId 
        });
      } else {
        return res.status(404).json({ error: "Order not found" });
      }
    } else {
      console.warn("Invalid payment signature");
      return res.status(400).json({ error: "Invalid signature" });
    }
  } catch (err) {
    console.error("Payment verification error:", err);
    return res.status(500).json({ error: "Verification failed" });
  }
});

// ============================================
// 10. Note: Webhooks removed (no domain yet)
// ============================================
// TODO: Add webhook endpoint when you have a production domain
// Webhook URL will be: https://yourdomain.com/razorpay-webhook
// For now, we rely on client-side verification via /verify-payment

// ============================================
// 11. Global Error Handler
// ============================================
app.use((err, req, res, next) => {
  console.error("Global error handler:", err);
  res.status(500).json({ 
    error: "Internal server error",
    message: process.env.NODE_ENV === "development" ? err.message : undefined
  });
});

// ============================================
// 12. 404 Handler
// ============================================
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ============================================
// 13. Start Server
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`🚀 Razorpay Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🔑 Razorpay Key ID: ${process.env.RZP_KEY_ID}`);
  console.log("=".repeat(50));
});
