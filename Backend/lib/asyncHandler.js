// Lets async route handlers pass errors to Express's error handler (Express 4).
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
