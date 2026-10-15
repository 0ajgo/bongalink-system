// Shipping fee computation (REQ015, REQ034).
// J&T and LBC require a signed merchant agreement before API access, so provincial
// fees come from the admin-encoded rate table, as the paper's Limitations section allows.
const pool = require('../db');
const lalamove = require('./lalamove');
const { logError } = require('../lib/pii');

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

const COURIER_LABEL = { LALAMOVE: 'Lalamove (same-day)', JNT: 'J&T Express', LBC: 'LBC Express' };
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

const ZONE_LABEL = { NCR: 'Metro Manila', LUZON: 'Luzon', VISAYAS: 'Visayas', MINDANAO: 'Mindanao', ISLAND_PROVINCE: 'island province' };

// Smallest weight bracket that fits the parcel; null = heavier than the table covers.
async function rateTableFee(courier, zone, weightKg) {
  const [[row]] = await pool.query(
    `SELECT fee, max_weight_kg FROM shipping_rates WHERE courier = ? AND zone = ? AND max_weight_kg >= ?
      ORDER BY max_weight_kg ASC LIMIT 1`,
    [courier, zone, weightKg]
  );
  return row ? { fee: Number(row.fee), bracket: Number(row.max_weight_kg) } : null;
}

const storeLocation = () => ({
  lat: process.env.STORE_LAT, lng: process.env.STORE_LNG, address: process.env.STORE_ADDRESS,
});

// Where Lalamove can deliver from the shop: region codes and/or province names,
// e.g. LALAMOVE_SERVICE_AREAS=NCR,Bulacan,Cavite,Laguna,Rizal (the default).
function inLalamoveArea({ region, province }) {
  const areas = (process.env.LALAMOVE_SERVICE_AREAS || 'NCR,Bulacan,Cavite,Laguna,Rizal')
    .split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
  return areas.includes(String(region || '').toLowerCase()) || areas.includes(String(province || '').toLowerCase());
}

// Straight-line distance, used only when Lalamove's quote doesn't include its route distance.
function haversineKm(a, b) {
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

const fmtKg = (kg) => `${Math.round(kg * 100) / 100} kg`;
const validPin = (a) => a.lat !== null && a.lat !== undefined && a.lng !== null && a.lng !== undefined &&
  Number.isFinite(Number(a.lat)) && Number.isFinite(Number(a.lng));

// Where the parcel goes. With a map pin, the region/province (and so the zone) come
// from reverse-geocoding the pin, so a wrong dropdown choice can't change the fee.
// Without a pin, or if the map lookup is down, the region typed in the form is used.
async function resolveLocation(address) {
  if (validPin(address)) {
    const geocode = require('./geocode');   // lazy: geocode.js uses zoneFor from this file
    try {
      const g = await geocode.reverse(address.lat, address.lng);
      return { source: 'pin', region: g.region, province: g.province, city: g.city, zone: g.zone,
               lat: Number(address.lat), lng: Number(address.lng) };
    } catch (e) {
      if (e.status === 400) throw e;   // outside the Philippines
      logError('Pin lookup failed, using the typed region', e);
    }
  }
  const zone = zoneFor(address.region, address.province);
  if (!zone) throw Object.assign(new Error('Unknown region'), { status: 400 });
  return { source: 'typed', region: normRegion(address.region), province: address.province || null,
           city: address.city || null, zone, lat: validPin(address) ? Number(address.lat) : null,
           lng: validPin(address) ? Number(address.lng) : null };
}

// Returns every courier option for a cart + address { region, province?, city?, line, lat?, lng? }:
//   { zone, weight_kg, location, options: [{ courier, label, fee, eta, source, basis, distance_km? }] }
// `basis` says how the fee was worked out. POST /api/orders calls this again to recompute the
// fee server-side - never trust the fee sent by the browser.
async function quoteOptions(items, address) {
  const location = await resolveLocation(address);
  const { zone } = location;
  const weightKg = Math.round((await cartWeightKg(items)) * 1000) / 1000;

  const options = [];
  for (const courier of ['JNT', 'LBC']) {
    const rate = await rateTableFee(courier, zone, weightKg);
    if (rate) {
      const name = courier === 'JNT' ? 'J&T' : 'LBC';
      options.push({
        courier, label: COURIER_LABEL[courier], fee: rate.fee, eta: ETA[zone], source: 'rate_table',
        basis: `${name} ${ZONE_LABEL[zone]} rate, ${fmtKg(weightKg)} (up to ${fmtKg(rate.bracket)})`,
      });
    }
  }

  // Lalamove: live quote from the shop's pin to the customer's pin, only inside its service area.
  if (location.lat !== null && lalamove.enabled() && inLalamoveArea(location)) {
    try {
      const q = await lalamove.getQuotation({
        pickup: storeLocation(),
        dropoff: { lat: location.lat, lng: location.lng, address: address.line },
      });
      const store = storeLocation();
      const km = q.distanceKm ?? (store.lat && store.lng ? haversineKm(store, location) : null);
      const distance = km === null ? null : Math.round(km * 10) / 10;
      options.push({
        courier: 'LALAMOVE', label: COURIER_LABEL.LALAMOVE, fee: q.total, eta: 'Same day', source: 'live_quote',
        distance_km: distance,
        basis: distance === null ? 'Live Lalamove quote' : `Live Lalamove quote, ${distance} km${q.distanceKm == null ? ' (straight line)' : ''}`,
      });
    } catch (e) {
      logError('Lalamove quote failed or out of service area, offering J&T/LBC only', e);
    }
  }
  return { zone, weight_kg: weightKg, location, options };
}

module.exports = { quoteOptions, zoneFor, storeLocation, inLalamoveArea, COURIER_LABEL, ZONE_LABEL, REGIONS, ISLAND_PROVINCES };
