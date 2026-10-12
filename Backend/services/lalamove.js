// Lalamove API v3 client (Philippines). Sandbox keys come from the Lalamove Partner Portal.
// Auth: HMAC-SHA256 over "time\r\nMETHOD\r\nPATH\r\n\r\nBODY".
const crypto = require('crypto');

class LogisticsError extends Error {}

const baseUrl = () =>
  process.env.LALAMOVE_ENV === 'production' ? 'https://rest.lalamove.com' : 'https://rest.sandbox.lalamove.com';

const enabled = () => Boolean(process.env.LALAMOVE_API_KEY && process.env.LALAMOVE_API_SECRET);

async function request(method, path, payload) {
  const time = Date.now().toString();
  const body = payload ? JSON.stringify(payload) : '';
  const raw = `${time}\r\n${method}\r\n${path}\r\n\r\n${body}`;
  const signature = crypto.createHmac('sha256', process.env.LALAMOVE_API_SECRET).update(raw).digest('hex');

  const res = await fetch(baseUrl() + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `hmac ${process.env.LALAMOVE_API_KEY}:${time}:${signature}`,
      Market: 'PH',
      'Request-ID': crypto.randomUUID(),
    },
    body: body || undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.errors?.[0]?.message || json.errors?.[0]?.id || `Lalamove error ${res.status}`;
    throw new LogisticsError(msg);
  }
  return json.data;
}

// "09171234567" -> "+639171234567"
function toE164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('63')) return `+${d}`;
  if (d.startsWith('0')) return `+63${d.slice(1)}`;
  return `+63${d}`;
}

const stop = (p) => ({ coordinates: { lat: String(p.lat), lng: String(p.lng) }, address: p.address });

// Quotations are valid for about 5 minutes, so re-quote right before booking.
async function getQuotation({ pickup, dropoff }) {
  const data = await request('POST', '/v3/quotations', {
    data: {
      serviceType: process.env.LALAMOVE_SERVICE_TYPE || 'MOTORCYCLE',
      language: 'en_PH',
      stops: [stop(pickup), stop(dropoff)],
    },
  });
  return {
    quotationId: data.quotationId,
    total: Number(data.priceBreakdown.total),
    currency: data.priceBreakdown.currency,
    stops: data.stops, // [{ stopId, ... }] pickup first, dropoff second
    expiresAt: data.expiresAt,
  };
}

async function placeOrder({ quotation, sender, recipient, remarks }) {
  const data = await request('POST', '/v3/orders', {
    data: {
      quotationId: quotation.quotationId,
      sender: { stopId: quotation.stops[0].stopId, name: sender.name, phone: toE164(sender.phone) },
      recipients: [
        { stopId: quotation.stops[1].stopId, name: recipient.name, phone: toE164(recipient.phone), remarks },
      ],
      isPODEnabled: true,
    },
  });
  return { orderId: data.orderId, shareLink: data.shareLink, status: data.status };
}

const getOrder = (orderId) => request('GET', `/v3/orders/${encodeURIComponent(orderId)}`);
const cancelOrder = (orderId) => request('DELETE', `/v3/orders/${encodeURIComponent(orderId)}`);

// Lalamove status -> deliveries.status
const STATUS_MAP = {
  ASSIGNING_DRIVER: 'BOOKED',
  ON_GOING: 'PICKED_UP',
  PICKED_UP: 'OUT_FOR_DELIVERY',
  COMPLETED: 'DELIVERED',
  CANCELED: 'FAILED',
  REJECTED: 'FAILED',
  EXPIRED: 'FAILED',
};

module.exports = { enabled, getQuotation, placeOrder, getOrder, cancelOrder, STATUS_MAP, LogisticsError };
