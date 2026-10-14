// Map pin lookups for the address forms (checkout, profile). Mounted at /api/v1/geo.
// The browser never calls Nominatim itself: requests go through services/geocode.js,
// which identifies the shop, keeps to 1 request per second and caches results.
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const ah = require('../lib/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const geocode = require('../services/geocode');

// Per visitor on top of the global 1/s queue: dragging a pin around shouldn't flood it.
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 30, message: { error: 'Too many map lookups. Please wait a minute.' } });

// POST /reverse { lat, lng } -> { region, province, city, barangay, postcode, zone, display_name }
router.post('/reverse', requireAuth, limiter, ah(async (req, res) => {
  const { lat, lng } = req.body || {};
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)) || lat === null || lng === null) {
    return res.status(400).json({ error: 'Pin coordinates are missing.' });
  }
  try {
    res.json(await geocode.reverse(Number(lat), Number(lng)));
  } catch (e) {
    if (e instanceof geocode.GeocodeError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

module.exports = router;
