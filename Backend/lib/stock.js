// Low stock = 1..LOW_STOCK units available (on hand minus what unpaid orders hold).
// Same threshold as the storefront's "Low stock" badge (Frontend/JS/ui.js), the admin
// Dashboard's low-stock tile (routes/ml.js) and the bell's low-stock alert (services/notifications.js).
module.exports = { LOW_STOCK: 3 };
