// Shipping fee computation (REQ015, REQ034).
// J&T and LBC require a signed merchant agreement before API access, so provincial
// fees come from the admin-encoded rate table, as the paper's Limitations section allows.
const pool = require('../db');
const lalamove = require('./lalamove');

// PSGC regions -> courier rate zone
const ZONE_BY_REGION = {
  NCR: 'NCR',
  CAR: 'LUZON', I: 'LUZON', II: 'LUZON', III: 'LUZON', 'IV-A': 'LUZON', 'IV-B': 'LUZON', V: 'LUZON',
  VI: 'VISAYAS', VII: 'VISAYAS', VIII: 'VISAYAS', NIR: 'VISAYAS',
  IX: 'MINDANAO', X: 'MINDANAO', XI: 'MINDANAO', XII: 'MINDANAO', XIII: 'MINDANAO', BARMM: 'MINDANAO',
};
const REGIONS = Object.keys(ZONE_BY_REGION);

// Provinces billed at the ISLAND_PROVINCE rate regardless of region.
// Confirm this list with the client before going live.
const ISLAND_PROVINCES = [
  'Palawan', 'Romblon', 'Marinduque', 'Catanduanes', 'Masbate', 'Batanes', 'Siquijor',
  'Camiguin', 'Basilan', 'Sulu', 'Tawi-Tawi', 'Dinagat Islands',
];
// "tawi tawi", "Tawi-Tawi", "Dinagat" all match
const provinceKey = (p) => String(p || '').toLowerCase().replace(/\bislands?\b/g, '').replace(/[^a-z]/g, '');
const ISLAND_KEYS = new Set(ISLAND_PROVINCES.map(provinceKey));

const COURIER_LABEL = { LALAMOVE: 'Lalamove (same-day, Metro Manila)', JNT: 'J&T Express', LBC: 'LBC Express' };
const ETA = {
  NCR: '1-3 days', LUZON: '2-5 days', VISAYAS: '3-7 days', MINDANAO: '3-8 days', ISLAND_PROVINCE: '5-9 days',
};

const normRegion = (region) => String(region || '').toUpperCase().trim();

function zoneFor(region, province) {
  const zone = ZONE_BY_REGION[normRegion(region)];
  if (!zone) return null;
  return ISLAND_KEYS.has(provinceKey(province)) ? 'ISLAND_PROVINCE' : zone;
}

async function cartWeightKg(items) {
  const ids = items.map((i) => Number(i.product_id));
  const [rows] = await pool.query('SELECT product_id, weight_kg FROM products WHERE product_id IN (?)', [ids]);
  const byId = Object.fromEntries(rows.map((r) => [r.product_id, Number(r.weight_kg)]));
  return items.reduce((kg, i) => {
    const w = byId[Number(i.product_id)];
    if (w === undefined) throw Object.assign(new Error(`Unknown product ${i.product_id}`), { status: 400 });
    return kg + w * i.quantity;
  }, 0);
}

async function rateTableFee(courier, zone, weightKg) {
  const [[row]] = await pool.query(
    `SELECT fee FROM shipping_rates WHERE courier = ? AND zone = ? AND max_weight_kg >= ?
      ORDER BY max_weight_kg ASC LIMIT 1`,
    [courier, zone, weightKg]
  );
  return row ? Number(row.fee) : null; // null = heavier than the table covers
}

const storeLocation = () => ({
  lat: process.env.STORE_LAT, lng: process.env.STORE_LNG, address: process.env.STORE_ADDRESS,
});

// Returns every courier option for a cart + address { region, province?, line, lat?, lng? }.
// POST /api/orders calls this again to recompute the fee server-side - never trust the fee sent by the browser.
async function quoteOptions(items, address) {
  const zone = zoneFor(address.region, address.province);
  if (!zone) throw Object.assign(new Error('Unknown region'), { status: 400 });
  const weightKg = Math.round((await cartWeightKg(items)) * 1000) / 1000;

  const options = [];
  for (const courier of ['JNT', 'LBC']) {
    const fee = await rateTableFee(courier, zone, weightKg);
    if (fee !== null) options.push({ courier, label: COURIER_LABEL[courier], fee, eta: ETA[zone], source: 'rate_table' });
  }

  // Lalamove only for Metro Manila addresses with a map pin.
  if (zone === 'NCR' && lalamove.enabled() && address.lat && address.lng) {
    try {
      const q = await lalamove.getQuotation({
        pickup: storeLocation(),
        dropoff: { lat: address.lat, lng: address.lng, address: address.line },
      });
      options.push({ courier: 'LALAMOVE', label: COURIER_LABEL.LALAMOVE, fee: q.total, eta: 'Same day', source: 'live_quote' });
    } catch (e) {
      console.warn('Lalamove quote failed, offering J&T/LBC only:', e.message);
    }
  }
  return { zone, weight_kg: weightKg, options };
}

module.exports = { quoteOptions, zoneFor, storeLocation, COURIER_LABEL, REGIONS, ISLAND_PROVINCES };
