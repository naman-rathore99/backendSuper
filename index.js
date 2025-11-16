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
const requiredEnvVars = ["RZP_KEY_ID", "RZP_KEY_SECRET", "RZP_WEBHOOK_SECRET"];
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
    if (!amount || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // Validate amount has max 2 decimal places
    if (Math.round(amount * 100) !== amount * 100) {
      return res.status(400).json({
        error: "Amount can have maximum 2 decimal places",
      });
    }

    // Validate currency
    const validCurrencies = ["INR", "USD", "EUR", "GBP"];
    if (!validCurrencies.includes(currency)) {
      return res.status(400).json({
        error: `Invalid currency. Must be one of: ${validCurrencies.join(
          ", "
        )}`,
      });
    }

    // Create a local order id (your system)
    const ourOrderId = `order_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    // Create Razorpay order (amount in paise)
    const options = {
      amount: Math.floor(amount * 100), // Use floor to avoid overcharging
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
      message: err.message,
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
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;

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
          ourOrderId: local.ourId,
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
// 10. Razorpay Webhook Endpoint
// ============================================
app.post("/razorpay-webhook", (req, res) => {
  try {
    const secret = process.env.RZP_WEBHOOK_SECRET;

    // Validate webhook secret is configured
    if (!secret) {
      console.error("RZP_WEBHOOK_SECRET not configured");
      return res.status(500).send("Server misconfiguration");
    }

    const signature = req.headers["x-razorpay-signature"];

    if (!signature) {
      console.warn("Webhook signature missing");
      return res.status(400).send("Missing signature");
    }

    // Verify signature using HMAC SHA256 of raw body
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(req.rawBody)
      .digest("hex");

    if (expectedSignature !== signature) {
      console.warn("Invalid webhook signature");
      return res.status(400).send("Invalid signature");
    }

    const event = req.body.event;
    const payload = req.body.payload;

    console.log(`Webhook received: ${event}`);

    // Handle different webhook events
    switch (event) {
      case "payment.captured":
      case "payment.authorized":
      case "order.paid":
        handleSuccessfulPayment(payload);
        break;

      case "payment.failed":
        handleFailedPayment(payload);
        break;

      case "payment.pending":
        handlePendingPayment(payload);
        break;

      case "refund.created":
        handleRefund(payload);
        break;

      default:
        console.log(`Unhandled webhook event: ${event}`);
    }

    // Acknowledge webhook quickly
    return res.json({ status: "ok" });
  } catch (err) {
    console.error("Webhook processing error:", err);
    // Still acknowledge to prevent retries
    return res.status(200).json({ status: "error", message: err.message });
  }
});

// ============================================
// 11. Webhook Handler Functions
// ============================================
function handleSuccessfulPayment(payload) {
  try {
    const paymentEntity = payload.payment?.entity;
    const orderEntity = payload.order?.entity;

    let rzpOrderId = paymentEntity?.order_id || orderEntity?.id;

    if (!rzpOrderId) {
      console.warn("No order ID found in webhook payload");
      return;
    }

    const local = getByRazorpayOrderId(rzpOrderId);

    if (!local) {
      console.warn(`Webhook order ID not found in local DB: ${rzpOrderId}`);
      return;
    }

    // Idempotency check
    if (local.status === "paid") {
      console.log(`Duplicate webhook for already paid order: ${local.ourId}`);
      return;
    }

    // Update order status
    setOrderStatus(local.ourId, "paid");
    console.log(`✅ Order marked as PAID: ${local.ourId}`);

    // TODO: Add your business logic here:
    // - Complete booking
    // - Send confirmation email
    // - Update inventory
    // - Trigger fulfillment
  } catch (err) {
    console.error("Error handling successful payment:", err);
  }
}

function handleFailedPayment(payload) {
  try {
    const paymentEntity = payload.payment?.entity;
    const rzpOrderId = paymentEntity?.order_id;

    if (rzpOrderId) {
      const local = getByRazorpayOrderId(rzpOrderId);
      if (local && local.status !== "failed") {
        setOrderStatus(local.ourId, "failed");
        console.log(`❌ Order marked as FAILED: ${local.ourId}`);

        // TODO: Send failure notification to customer
      }
    }
  } catch (err) {
    console.error("Error handling failed payment:", err);
  }
}

function handlePendingPayment(payload) {
  try {
    const paymentEntity = payload.payment?.entity;
    const rzpOrderId = paymentEntity?.order_id;

    if (rzpOrderId) {
      const local = getByRazorpayOrderId(rzpOrderId);
      if (local && local.status !== "pending") {
        setOrderStatus(local.ourId, "pending");
        console.log(`⏳ Order marked as PENDING: ${local.ourId}`);
      }
    }
  } catch (err) {
    console.error("Error handling pending payment:", err);
  }
}

function handleRefund(payload) {
  try {
    const refundEntity = payload.refund?.entity;
    const paymentId = refundEntity?.payment_id;

    console.log(`💰 Refund created for payment: ${paymentId}`);

    // TODO: Update order status to refunded
    // TODO: Notify customer about refund
  } catch (err) {
    console.error("Error handling refund:", err);
  }
}

// ============================================
// 12. Global Error Handler
// ============================================
app.use((err, req, res, next) => {
  console.error("Global error handler:", err);
  res.status(500).json({
    error: "Internal server error",
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// ============================================
// 13. 404 Handler
// ============================================
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ============================================
// 14. Start Server
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`🚀 Razorpay Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🔑 Razorpay Key ID: ${process.env.RZP_KEY_ID}`);
  console.log("=".repeat(50));
});
