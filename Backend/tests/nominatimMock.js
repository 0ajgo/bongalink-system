// Fake Nominatim: returns real-shaped /reverse answers for known test pins.
// Install with installNominatim(); every request is recorded in `requests`.

// Shapes copied from real Nominatim answers for Philippine pins (address fields only).
const PINS = {
  makati:          { lat: 14.5547, lng: 121.0244, address: { city: 'Makati', region: 'Metro Manila', 'ISO3166-2-lvl3': 'PH-00', postcode: '1226', quarter: 'Urdaneta', country_code: 'ph' } },
  calamba:         { lat: 14.2117, lng: 121.1653, address: { town: 'Calamba', state: 'Laguna', region: 'Calabarzon', 'ISO3166-2-lvl3': 'PH-40', postcode: '4027', country_code: 'ph' } },
  baguio:          { lat: 16.4023, lng: 120.5960, address: { city: 'Baguio', region: 'Cordillera Administrative Region', 'ISO3166-2-lvl3': 'PH-15', postcode: '2600', country_code: 'ph' } },
  cebu:            { lat: 10.3157, lng: 123.8854, address: { city: 'Cebu City', region: 'Central Visayas', 'ISO3166-2-lvl3': 'PH-07', postcode: '6000', suburb: 'Guadalupe', country_code: 'ph' } },
  bacolod:         { lat: 10.6765, lng: 122.9509, address: { city: 'Bacolod', region: 'Western Visayas', 'ISO3166-2-lvl3': 'PH-06', postcode: '6100', country_code: 'ph' } },
  davao:           { lat: 7.1907, lng: 125.4553, address: { city: 'Davao City', region: 'Davao Region', 'ISO3166-2-lvl3': 'PH-11', postcode: '8000', country_code: 'ph' } },
  puertoPrincesa:  { lat: 9.7392, lng: 118.7353, address: { city: 'Puerto Princesa', region: 'Mimaropa', 'ISO3166-2-lvl3': 'PH-41', postcode: '5300', suburb: 'San Miguel', country_code: 'ph' } },
  coron:           { lat: 11.9986, lng: 120.2043, address: { town: 'Coron', state: 'Palawan', region: 'Mimaropa', 'ISO3166-2-lvl3': 'PH-41', postcode: '5316', country_code: 'ph' } },
  jolo:            { lat: 6.0535, lng: 121.0011, address: { town: 'Jolo', state: 'Sulu', region: 'Bangsamoro', 'ISO3166-2-lvl3': 'PH-14', country_code: 'ph' } },
  siquijor:        { lat: 9.2139, lng: 123.5150, address: { town: 'Siquijor', state: 'Siquijor', region: 'Central Visayas', 'ISO3166-2-lvl3': 'PH-07', country_code: 'ph' } },
  kotaKinabalu:    { lat: 5.9804, lng: 116.0735, address: { city: 'Kota Kinabalu', state: 'Sabah', country_code: 'my' } },
};

const key = (lat, lng) => `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
const BY_KEY = Object.fromEntries(Object.values(PINS).map((p) => [key(p.lat, p.lng), p]));

function installNominatim({ down = false } = {}) {
  const requests = [];
  global.fetch = async (url, options = {}) => {
    if (!String(url).includes('nominatim')) throw new Error(`Network disabled in tests (tried ${url})`);
    const u = new URL(url);
    requests.push({ at: Date.now(), url: String(url), headers: options.headers || {} });
    if (down) return { ok: false, status: 503, json: async () => ({}) };
    const pin = BY_KEY[key(u.searchParams.get('lat'), u.searchParams.get('lon'))];
    const body = pin ? { display_name: `${pin.address.city || pin.address.town}, Philippines`, address: pin.address }
                     : { error: 'Unable to geocode' };
    return { ok: true, status: 200, json: async () => body };
  };
  return requests;
}

module.exports = { PINS, installNominatim };
