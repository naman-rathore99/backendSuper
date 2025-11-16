require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors");

const {
  createLocalOrder,
  setOrderStatus,
  get,
  getByRazorpayOrderId,
} = require("./ordersStore.js");

const app = express();
app.use(cors());   // 🔥 VERY IMPORTANT

app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

const rzp = new Razorpay({
  key_id: process.env.RZP_KEY_ID,
  key_secret: process.env.RZP_KEY_SECRET,
});
