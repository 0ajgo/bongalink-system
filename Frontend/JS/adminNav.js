/* =====================================================================
   adminNav.js — shared by the admin pages (inventory.html, deliveries.html)
   Requires api.js first.

   ORDERS TO SHIP — header badge with the number of paid orders that
   haven't shipped yet; it links to the Deliveries page. The shop also gets
   an email for each payment (ADMIN_ALERT_EMAIL); this badge is the
   on-screen alert. Polls GET /api/v1/admin/orders/to-ship every 30 s.
   ===================================================================== */

const TO_SHIP_POLL_MS = 30000;
const BASE_TITLE = document.title;

async function refreshToShipBadge() {
  const badge = document.getElementById("to-ship-badge");
  if (!badge) return;
  const { count } = await apiFetch("/v1/admin/orders/to-ship");
  badge.hidden = false;
  badge.className = `status-badge ${count > 0 ? "busy" : ""}`;
  badge.textContent = count === 1 ? "1 paid order to ship" : `${count} paid orders to ship`;
  // Count in the tab title too, so it shows while the admin is on another tab.
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
}

function startToShipBadge() {
  if (!isAdmin()) return;
  refreshToShipBadge().catch(() => {});
  setInterval(() => refreshToShipBadge().catch(() => {}), TO_SHIP_POLL_MS);
}

startToShipBadge();
