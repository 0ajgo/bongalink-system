// Admin "Shipping rates": the J&T / LBC rate card used for zone + weight fees.
// Mounted at /api/v1/admin/shipping-rates (admin only).
//   GET    /         { rates: [...], last_updated: { JNT, LBC } }
//   POST   /         { courier, zone, max_weight_kg, fee }   add a weight bracket
//   PATCH  /:id      same fields, any subset
//   DELETE /:id
// A courier is offered for a parcel only if its zone has a bracket at least as heavy.
const router = require('express').Router();
const pool = require('../db');
const ah = require('../lib/asyncHandler');
const { requireAdmin } = require('../middleware/auth');

const COURIERS = ['JNT', 'LBC'];
const ZONES = ['NCR', 'LUZON', 'VISAYAS', 'MINDANAO', 'ISLAND_PROVINCE'];

router.use(requireAdmin);

async function listRates() {
  const [rates] = await pool.query(
    `SELECT rate_id, courier, zone, max_weight_kg, fee, updated_at FROM shipping_rates
      ORDER BY courier, FIELD(zone, 'NCR','LUZON','VISAYAS','MINDANAO','ISLAND_PROVINCE'), max_weight_kg`
  );
  const [updated] = await pool.query('SELECT courier, MAX(updated_at) AS last_updated FROM shipping_rates GROUP BY courier');
  return {
    rates: rates.map((r) => ({ ...r, max_weight_kg: Number(r.max_weight_kg), fee: Number(r.fee) })),
    last_updated: Object.fromEntries(COURIERS.map((c) => [c, updated.find((u) => u.courier === c)?.last_updated || null])),
  };
}

// Returns { values } or { error } for the fields present in body (all required when `partial` is false).
function readRate(body = {}, partial = false) {
  const values = {};
  if (!partial || body.courier !== undefined) {
    if (!COURIERS.includes(body.courier)) return { error: 'Courier must be J&T or LBC.' };
    values.courier = body.courier;
  }
  if (!partial || body.zone !== undefined) {
    if (!ZONES.includes(body.zone)) return { error: 'Choose a zone.' };
    values.zone = body.zone;
  }
  if (!partial || body.max_weight_kg !== undefined) {
    const w = Number(body.max_weight_kg);
    if (body.max_weight_kg === '' || !(w > 0 && w <= 999)) return { error: 'Weight limit must be more than 0 and at most 999 kg.' };
    values.max_weight_kg = Math.round(w * 100) / 100;
  }
  if (!partial || body.fee !== undefined) {
    const fee = Number(body.fee);
    if (body.fee === '' || !(fee >= 0 && fee <= 100000)) return { error: 'Fee must be a number from 0 to 100,000.' };
    values.fee = Math.round(fee * 100) / 100;
  }
  if (partial && !Object.keys(values).length) return { error: 'Nothing to update.' };
  return { values };
}

const duplicate = (res) => res.status(409).json({ error: 'That courier already has a bracket with this zone and weight limit.' });

router.get('/', ah(async (req, res) => res.json(await listRates())));

router.post('/', ah(async (req, res) => {
  const { values, error } = readRate(req.body);
  if (error) return res.status(400).json({ error });
  try {
    await pool.query('INSERT INTO shipping_rates (courier, zone, max_weight_kg, fee) VALUES (?, ?, ?, ?)',
      [values.courier, values.zone, values.max_weight_kg, values.fee]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return duplicate(res);
    throw e;
  }
  res.status(201).json(await listRates());
}));

router.patch('/:id', ah(async (req, res) => {
  const { values, error } = readRate(req.body, true);
  if (error) return res.status(400).json({ error });
  const cols = Object.keys(values);   // only names from readRate()
  let result;
  try {
    [result] = await pool.query(`UPDATE shipping_rates SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE rate_id = ?`,
      [...Object.values(values), req.params.id]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return duplicate(res);
    throw e;
  }
  if (!result.affectedRows) return res.status(404).json({ error: 'Rate not found.' });
  res.json(await listRates());
}));

router.delete('/:id', ah(async (req, res) => {
  const [result] = await pool.query('DELETE FROM shipping_rates WHERE rate_id = ?', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Rate not found.' });
  res.json(await listRates());
}));

module.exports = router;
