// server/index.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const {
  createLocalOrder,
  setOrderStatus,
  get,
  getByRazorpayOrderId,
} = require("./ordersStore.js");

const app = express();
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      // keep raw body for signature verification
      req.rawBody = buf.toString();
    },
  })
);

const rzp = new Razorpay({
  key_id: process.env.RZP_KEY_ID,
  key_secret: process.env.RZP_KEY_SECRET,
});

// Create-order: called by client before opening checkout
app.post("/create-order", async (req, res) => {
  try {
    const { amount, currency = "INR", metadata } = req.body;
    // Basic validation
    if (!amount || amount <= 0)
      return res.status(400).json({ error: "invalid amount" });

    // Create a local order id (your system)
    const ourOrderId = `order_${Date.now()}`;

    // Create Razorpay order (amount in paise)
    const options = {
      amount: Math.round(amount * 100), // paise
      currency,
      receipt: `rcpt_${ourOrderId}`,
      payment_capture: 1, // auto capture. Use 0 if you want manual capture
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

    return res.json({
      ourOrderId,
      razorpayOrderId: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    console.error("create-order err", err);
    return res.status(500).json({ error: "create order failed" });
  }
});

// Simple endpoint to check order status (client polling)
app.get("/order-status/:ourOrderId", (req, res) => {
  const ourId = req.params.ourOrderId;
  const o = get(ourId);
  if (!o) return res.status(404).json({ error: "not found" });
  return res.json({ status: o.status, razorpayOrderId: o.razorpayOrderId });
});

// Webhook: Razorpay posts here when payment events occur
app.post("/razorpay-webhook", (req, res) => {
  const secret = process.env.RZP_WEBHOOK_SECRET;
  const signature = req.headers["x-razorpay-signature"];

  // Verify signature using HMAC SHA256 of raw body
  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex");

  if (expected !== signature) {
    console.warn("Invalid webhook signature");
    return res.status(400).send("invalid signature");
  }

  const event = req.body.event;
  const payload = req.body.payload;

  // Example: payment.captured
  if (
    event === "payment.captured" ||
    event === "payment.authorized" ||
    event === "order.paid"
  ) {
    // Extract razorpay order id (depends on payload structure)
    const paymentEntity = payload.payment ? payload.payment.entity || {} : null;
    const orderEntity = payload.order ? payload.order.entity || {} : null;
    let rzpOrderId = null;
    if (paymentEntity && paymentEntity.order_id)
      rzpOrderId = paymentEntity.order_id;
    if (!rzpOrderId && orderEntity && orderEntity.id)
      rzpOrderId = orderEntity.id;

    if (rzpOrderId) {
      const local = getByRazorpayOrderId(rzpOrderId);
      if (local) {
        // idempotency: ensure we don't process same payment multiple times
        if (local.status !== "paid") {
          setOrderStatus(local.ourId, "paid");
          // TODO: do booking completion, send email, etc.
          console.log("Order marked paid:", local.ourId);
        } else {
          console.log("Webhook arrived but already processed for", local.ourId);
        }
      } else {
        console.warn(
          "Webhook rzpOrderId not mapped to any local order:",
          rzpOrderId
        );
      }
    }
  }

  // Acknowledge quickly
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
