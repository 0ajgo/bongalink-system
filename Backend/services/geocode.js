// Reverse geocoding (map pin -> region / province / city) with OpenStreetMap Nominatim.
// Called from the BACKEND only, following the Nominatim usage policy
// (https://operations.osmfoundation.org/policies/nominatim/):
//   - an identifying User-Agent (app name + contact address)
//   - at most 1 request per second (all requests go through one queue)
//   - results cached, so the same pin is never looked up twice
// The answer is mapped to our PSGC region codes and island-province list, so the
// shipping zone comes from where the pin actually is, not from a dropdown choice.
const { zoneFor } = require('./shippingRates');

class GeocodeError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

const BASE = () => process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const MIN_INTERVAL_MS = 1100;          // a little over 1 request per second
const LOOKUP_TIMEOUT_MS = 8000;        // per Nominatim request
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const CACHE_MAX = 5000;

// Contact for the User-Agent: GEOCODER_CONTACT, else the shop's alert inbox.
function userAgent() {
  const contact = process.env.GEOCODER_CONTACT || process.env.ADMIN_ALERT_EMAIL || '';
  return `Bongalink-Shop/1.0 (online ordering system${contact ? `; ${contact}` : ''})`;
}

/* ---------------------------------------------------------------- PSGC mapping */
// ISO 3166-2 region codes as returned in address["ISO3166-2-lvl3"].
const ISO_REGION = {
  'PH-00': 'NCR', 'PH-01': 'I', 'PH-02': 'II', 'PH-03': 'III', 'PH-05': 'V', 'PH-06': 'VI', 'PH-07': 'VII',
  'PH-08': 'VIII', 'PH-09': 'IX', 'PH-10': 'X', 'PH-11': 'XI', 'PH-12': 'XII', 'PH-13': 'XIII', 'PH-14': 'BARMM',
  'PH-15': 'CAR', 'PH-18': 'NIR', 'PH-40': 'IV-A', 'PH-41': 'IV-B',
};

// Region names as OSM writes them (address.region), lower-cased without punctuation.
const REGION_NAMES = {
  'metro manila': 'NCR', 'national capital region': 'NCR', ncr: 'NCR',
  'cordillera administrative region': 'CAR', car: 'CAR',
  'ilocos region': 'I', ilocos: 'I', 'cagayan valley': 'II', 'central luzon': 'III',
  calabarzon: 'IV-A', mimaropa: 'IV-B', 'southwestern tagalog region': 'IV-B', 'bicol region': 'V', bicol: 'V',
  'western visayas': 'VI', 'central visayas': 'VII', 'eastern visayas': 'VIII', 'negros island region': 'NIR',
  'zamboanga peninsula': 'IX', 'northern mindanao': 'X', 'davao region': 'XI', soccsksargen: 'XII', caraga: 'XIII',
  'bangsamoro autonomous region in muslim mindanao': 'BARMM', bangsamoro: 'BARMM', barmm: 'BARMM',
};

// Provinces that moved to the Negros Island Region (2024); OSM may still tag them VI/VII.
const NIR_PROVINCES = new Set(['negros occidental', 'negros oriental', 'siquijor']);

// Independent cities have no province in OSM. Their geographic province decides
// island rates (Puerto Princesa -> Palawan, Isabela City -> Basilan) and is shown to the customer.
const CITY_PROVINCE = {
  'puerto princesa': 'Palawan', 'isabela city': 'Basilan',
  'baguio': 'Benguet', 'angeles': 'Pampanga', 'olongapo': 'Zambales', 'lucena': 'Quezon', 'dagupan': 'Pangasinan',
  'santiago': 'Isabela', 'naga': 'Camarines Sur', 'bacolod': 'Negros Occidental', 'iloilo city': 'Iloilo',
  'cebu city': 'Cebu', 'lapu-lapu': 'Cebu', 'lapu lapu': 'Cebu', 'mandaue': 'Cebu', 'tacloban': 'Leyte',
  'ormoc': 'Leyte', 'zamboanga city': 'Zamboanga del Sur', 'cagayan de oro': 'Misamis Oriental',
  'iligan': 'Lanao del Norte', 'davao city': 'Davao del Sur', 'general santos': 'South Cotabato',
  'butuan': 'Agusan del Norte', 'cotabato city': 'Maguindanao del Norte',
};

const clean = (s) => String(s || '').toLowerCase().replace(/\bcity of\b/g, '').replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();

// Nominatim `address` object -> { region, province, city, barangay, postcode, zone }.
function mapToPsgc(address = {}) {
  if (String(address.country_code || '').toLowerCase() !== 'ph') {
    throw new GeocodeError('That pin is outside the Philippines. We only deliver within the Philippines.', 400);
  }
  const city = address.city || address.town || address.municipality || address.village || null;
  let province = address.province || address.state || address.county || null;
  if (!province && city) {
    const key = clean(city);
    province = CITY_PROVINCE[key] || CITY_PROVINCE[`${key} city`] || null;
  }

  let region = ISO_REGION[address['ISO3166-2-lvl3']] || REGION_NAMES[clean(address.region)] || null;
  if (province && NIR_PROVINCES.has(clean(province))) region = 'NIR';
  if (!region) throw new GeocodeError("We couldn't tell which region that pin is in. Please choose the region yourself.", 422);
  if (region === 'NCR') province = null;   // Metro Manila has no province

  return {
    region,
    province,
    city,
    barangay: address.quarter || address.suburb || address.village || address.neighbourhood || null,
    postcode: /^\d{4}$/.test(address.postcode || '') ? address.postcode : null,
    zone: zoneFor(region, province),
  };
}

/* ---------------------------------------------------------------- rate limit + cache */
const cache = new Map();   // "lat,lng" (4 decimals ≈ 11 m) -> { at, value } ; Map keeps insertion order
let queue = Promise.resolve();
let lastRequestAt = 0;

const cacheKey = (lat, lng) => `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;

// Runs fn after the previous request, at least MIN_INTERVAL_MS apart.
function throttled(fn) {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

async function fetchNominatim(lat, lng) {
  const url = `${BASE()}/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}`;
  let res;
  try {
    // A hung request would hold up every lookup queued behind it, so it gives up after LOOKUP_TIMEOUT_MS.
    res = await fetch(url, { headers: { 'User-Agent': userAgent(), 'Accept-Language': 'en', Accept: 'application/json' },
                             signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  } catch (e) {
    throw new GeocodeError('The map lookup service is unreachable right now.');
  }
  if (!res.ok) throw new GeocodeError(`The map lookup service answered ${res.status}.`);
  const json = await res.json().catch(() => ({}));
  if (json.error || !json.address) throw new GeocodeError("We couldn't find an address at that pin.", 422);
  return json;
}

// { lat, lng } -> { region, province, city, barangay, postcode, zone, display_name }
async function reverse(lat, lng) {
  lat = Number(lat);
  lng = Number(lng);
  if (!(lat >= 4 && lat <= 22 && lng >= 116 && lng <= 127)) {
    throw new GeocodeError('That pin is outside the Philippines. We only deliver within the Philippines.', 400);
  }
  const key = cacheKey(lat, lng);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const value = hit && hit.pending ? await hit.pending : await (async () => {
    const pending = throttled(() => fetchNominatim(lat, lng)).then((json) => ({
      ...mapToPsgc(json.address), display_name: json.display_name || null,
    }));
    cache.set(key, { at: 0, pending });            // concurrent lookups of the same pin share one request
    try {
      return await pending;
    } catch (e) {
      cache.delete(key);
      throw e;
    }
  })();

  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

function clearCache() {
  cache.clear();
  lastRequestAt = 0;
}

module.exports = { reverse, mapToPsgc, userAgent, clearCache, GeocodeError, MIN_INTERVAL_MS };
