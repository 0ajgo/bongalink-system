/* =====================================================================
   map-picker.js — delivery pin on an OpenStreetMap map (Leaflet).
   Requires vendor/leaflet/leaflet.js + leaflet.css, api.js, icons.js,
   ui.js and cart.js (PSGC_REGIONS).

     const picker = createMapPicker(container, {
       onLocation(location, pin) {},   // after the pin is looked up: { region, province, city,
                                       //   barangay, postcode, zone, display_name }
       onClear() {},                   // pin removed
       onError(message, pin) {}        // lookup failed; the pin is kept, fields stay editable
     });
     picker.setPin({ lat, lng }, { lookup: false })   // e.g. from a saved address
     picker.getPin() / picker.clear() / picker.refresh()  (call refresh() after showing a hidden map)

   Click the map or drag the marker to place the pin; "Use my location"
   asks the browser. Address lookups go through the shop's server.
   ===================================================================== */

const PH_CENTER = [12.3, 122.6];          // whole country in view until a pin is set
const ZONE_RATE_LABEL = {
  NCR: "Metro Manila rates", LUZON: "Luzon rates", VISAYAS: "Visayas rates",
  MINDANAO: "Mindanao rates", ISLAND_PROVINCE: "island-province rates"
};
const regionName = (code) => {
  const r = (typeof PSGC_REGIONS !== "undefined" ? PSGC_REGIONS : []).find(x => x.code === code);
  return r ? r.label.replace(/^.*?— /, "") : code;
};

function createMapPicker(container, { onLocation = () => {}, onClear = () => {}, onError = () => {} } = {}) {
  container.classList.add("map-picker");
  container.innerHTML = `
    <div class="map-picker__toolbar">
      <button class="btn btn--secondary btn--sm" type="button" data-locate>${icon("map-pin", { size: 16 })} Use my location</button>
      <button class="btn btn--ghost btn--sm" type="button" data-clear hidden>Remove pin</button>
      <span class="hint">Click the map or drag the pin to your exact door.</span>
    </div>
    <div class="map-picker__map" role="application" aria-label="Map. Click to place your delivery pin."></div>
    <p class="map-picker__status" aria-live="polite"></p>`;

  const status = container.querySelector(".map-picker__status");
  const clearBtn = container.querySelector("[data-clear]");
  const map = L.map(container.querySelector(".map-picker__map"), { scrollWheelZoom: false }).setView(PH_CENTER, 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

  let marker = null;
  let seq = 0;

  // The text is wrapped in one span so it flows as a single line next to the icon on phones.
  function setStatus(html, tone = "", iconName = null) {
    status.className = `map-picker__status${tone ? ` map-picker__status--${tone}` : ""}`;
    status.innerHTML = `${iconName ? icon(iconName, { size: 16 }) : ""}<span>${html}</span>`;
  }

  async function lookup(pin) {
    const mine = ++seq;
    setStatus(`Finding the address for your pin…`, "", "loader-circle");
    try {
      const location = await apiFetch("/v1/geo/reverse", { method: "POST", timeout: API_TIMEOUT_LONG_MS, body: JSON.stringify(pin) });
      if (mine !== seq) return;
      const where = [location.city, location.province, regionName(location.region)].filter(Boolean).join(", ");
      setStatus(`Pinned: <strong>${escapeHTML(where)}</strong> · ${ZONE_RATE_LABEL[location.zone] || ""}`, "ok", "check");
      onLocation(location, pin);
    } catch (err) {
      if (mine !== seq) return;
      setStatus(`${escapeHTML(err.message)} You can fill in the address yourself.`, "warn", "triangle-alert");
      onError(err.message, pin);
    }
  }

  function setPin(pin, { lookup: doLookup = true, zoom = 16 } = {}) {
    const latlng = [Number(pin.lat), Number(pin.lng)];
    if (!marker) {
      marker = L.marker(latlng, { draggable: true, autoPan: true, keyboard: true, title: "Delivery pin (drag to adjust)" }).addTo(map);
      marker.on("dragend", () => {
        const p = marker.getLatLng();
        lookup({ lat: round(p.lat), lng: round(p.lng) });
      });
    } else {
      marker.setLatLng(latlng);
    }
    map.setView(latlng, Math.max(map.getZoom(), zoom));
    clearBtn.hidden = false;
    if (doLookup) lookup({ lat: round(latlng[0]), lng: round(latlng[1]) });
    else setStatus(`Saved pin.`, "ok", "check");
  }

  function clear() {
    seq++;
    if (marker) { map.removeLayer(marker); marker = null; }
    clearBtn.hidden = true;
    setStatus("No pin yet. Shipping uses the region you choose below.");
    onClear();
  }

  const round = (v) => Math.round(v * 1e6) / 1e6;

  map.on("click", (e) => setPin({ lat: round(e.latlng.lat), lng: round(e.latlng.lng) }));
  clearBtn.addEventListener("click", clear);
  container.querySelector("[data-locate]").addEventListener("click", () => {
    if (!navigator.geolocation) return setStatus("This browser can't share your location. Click the map instead.", "warn");
    setStatus(`Finding your location…`, "", "loader-circle");
    navigator.geolocation.getCurrentPosition(
      (pos) => setPin({ lat: round(pos.coords.latitude), lng: round(pos.coords.longitude) }),
      () => setStatus("Location wasn't shared. Click the map to place your pin instead.", "warn"),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });

  setStatus("No pin yet. Shipping uses the region you choose below.");
  return {
    setPin,
    clear,
    getPin: () => (marker ? { lat: round(marker.getLatLng().lat), lng: round(marker.getLatLng().lng) } : null),
    refresh: () => map.invalidateSize()
  };
}
