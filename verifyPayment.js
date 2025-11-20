// verifyPayment.js
const express = require('express');
const crypto = require('crypto');
const { getByRazorpayOrderId, setOrderStatus } = require('./ordersStore');

const router = express.Router();

router.post('/verify-payment', express.json(), (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'missing fields' });
  }

  // Build payload exactly as Razorpay expects: order_id|payment_id
  const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(payload)
    .digest('hex');

  if (expected !== razorpay_signature) {
    console.warn('Invalid payment signature', { razorpay_order_id });
    return res.status(400).json({ error: 'invalid signature' });
  }

  const local = getByRazorpayOrderId(razorpay_order_id);
  if (!local) {
    console.warn('Verify called for unknown order', razorpay_order_id);
    return res.status(404).json({ error: 'order_not_found' });
  }

  const ok = setOrderStatus(local.ourId, 'paid', { paymentId: razorpay_payment_id });
  if (!ok) {
    return res.status(500).json({ error: 'failed_to_update_order' });
  }

  return res.json({ ok: true, ourOrderId: local.ourId });
});

module.exports = router;
