// server/ordersStore.js
// Replace with real DB (Postgres/Mongo/Firestore)
const orders = new Map(); // key: ourOrderId -> { amount, currency, razorpayOrderId, status, createdAt }

function createLocalOrder({ ourOrderId, amount, currency, razorpayOrderId }) {
  orders.set(ourOrderId, {
    amount,
    currency,
    razorpayOrderId,
    status: "pending", // pending / paid / failed
    createdAt: Date.now(),
  });
}

function setOrderStatus(ourOrderId, status) {
  const o = orders.get(ourOrderId);
  if (!o) return false;
  o.status = status;
  return true;
}

function getByRazorpayOrderId(rzpOrderId) {
  for (const [ourId, val] of orders.entries()) {
    if (val.razorpayOrderId === rzpOrderId) return { ourId, ...val };
  }
  return null;
}

function get(ourOrderId) {
  const val = orders.get(ourOrderId);
  if (!val) return null;
  return { ourId: ourOrderId, ...val };
}

module.exports = {
  createLocalOrder,
  setOrderStatus,
  get,
  getByRazorpayOrderId,
};
