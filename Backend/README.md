# Bongalink API — Setup

This connects your frontend (`homepage.html`, `login.html`, `register.html`)
to a real MySQL database using the schema in
`database/bongalink_schema.sql`. Same code runs locally now and on
Hostinger/AWS later — only `.env` changes.

## 1. Install prerequisites

- **Node.js** (v18+): https://nodejs.org
- **MySQL**, locally, via one of:
  - Standalone MySQL Server / MySQL Workbench
  - XAMPP (easiest — includes MySQL + phpMyAdmin in one installer)

## 2. Create the database

Using the MySQL CLI:
```bash
mysql -u root -p < database/bongalink_schema.sql
```
Or, if using XAMPP/phpMyAdmin: open phpMyAdmin → Import →
select `database/bongalink_schema.sql` → Go. This creates the
`bongalink` database and all tables (users, categories, products,
carts, cart_items, orders, order_items) with the seeded categories.

Then apply the migration that adds soft delete (`products.is_active`),
the product change log and the ML tables/triggers:
```bash
mysql -u root -p bongalink < database/migrations/003_ml_sync.sql
```
Then apply the migration for email verification, PayMongo payments
and courier logistics (see "7. Email, payment and logistics APIs"):
```bash
mysql -u root -p bongalink < database/migrations/004_api_integrations.sql
```
The admin **Inventory & Forecasts** page (`Pages/Admin/inventory.html`)
reads what the Python ML worker writes. See `ml/worker/README.md` to
run it. Removing a product now hides it (`is_active = 0`) instead of
deleting the row, so order history and sales trends stay intact.

**Create your first admin account** (registration only creates
regular users, by design — admins are provisioned directly):
```sql
USE bongalink;
INSERT INTO users (username, email, password_hash, role)
VALUES ('admin', 'admin@bongalink.local',
        '$2a$10$PLACEHOLDER', 'admin');
```
Then generate a real bcrypt hash and update that row — easiest way,
from the `backend/` folder after `npm install`:
```bash
node -e "console.log(require('bcryptjs').hashSync('YourAdminPassword123', 10))"
```
Copy the printed hash into `password_hash` for that row.

## 3. Configure the backend

```bash
cd backend
cp .env.example .env
```
Open `.env` and fill in your local MySQL credentials (defaults match
a fresh XAMPP install: host `localhost`, user `root`, empty password).

## 4. Install dependencies and run

```bash
npm install
npm run dev
```
You should see: `Bongalink API running on http://localhost:4000`

Check it's alive: open `http://localhost:4000/api/health` in a
browser — should return `{"status":"ok"}`.

## 5. Point the frontend at it

Open `js/api.js` and confirm:
```js
const API_BASE_URL = "http://localhost:4000/api";
```
Then open `homepage.html` from a local web server (not `file://` —
use VS Code's "Live Server" extension, or `npx serve`, etc.), and
make sure that URL is in `CORS_ORIGIN` inside `.env`.

At this point: registration writes to the real `users` table, admin
product listings write to the real `products` table, cart/checkout
read and write `carts`/`cart_items`/`orders`/`order_items` — nothing
is in `localStorage` anymore except the JWT session token.

## 6. Moving to Hostinger / AWS later

Nothing in the code changes. You only:

1. Create a MySQL database on the host (Hostinger's hPanel → Databases,
   or an AWS RDS MySQL instance) and import
   `database/bongalink_schema.sql` the same way as step 2.
2. On the server, create a new `.env` with that host's DB credentials
   and a real `JWT_SECRET`, and add your live frontend URL to
   `CORS_ORIGIN`.
3. Deploy this `backend/` folder (Hostinger Node.js hosting, or an
   AWS EC2/Elastic Beanstalk instance) and run `npm install && npm start`.
4. Update `API_BASE_URL` in `js/api.js` to your live API URL
   (e.g. `https://api.bongalink.com/api`).

That's the entire migration — same schema, same routes, same
frontend logic.

## 7. Email, payment and logistics APIs

Fill in the new keys in `.env` (listed in `.env.example`):

| Key | Where to get it |
|---|---|
| `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Shop Gmail → turn on 2-Step Verification → Security → App passwords |
| `ADMIN_ALERT_EMAIL` | Shop inbox that gets an email for every paid order (products, quantities, courier, address) |
| `VERIFICATION_SECRET` | Any long random string: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PAYMONGO_SECRET_KEY` | PayMongo dashboard → Developers → API keys (`sk_test_...`) |
| `PAYMONGO_WEBHOOK_SECRET` | PayMongo → Developers → Webhooks → add `https://<public-url>/api/v1/webhooks/paymongo`, event `checkout_session.payment.paid` (`whsk_...`) |
| `LALAMOVE_API_KEY`, `LALAMOVE_API_SECRET` | Lalamove Partner Portal → Developers → Sandbox keys. Webhook URL: `https://<public-url>/api/v1/webhooks/lalamove`. Leave blank to offer J&T/LBC only. |
| `APP_URL` | Full URL of the `Frontend/` folder: `http://localhost:5500/Frontend` with VS Code Live Server opened on the repo, `http://localhost:5500` with Docker. PayMongo returns the customer to `APP_URL/Pages/COpage/checkout.html` — open that address in the browser to check it. |
| `STORE_*` | The shop's pickup pin, address and phone (Lalamove) |

Webhooks need a public HTTPS URL; for local testing run `ngrok http 4000`.

On startup the server prints one status line per service (names only, never values):

```
Integrations (from .env; restart after changing it):
  Lalamove: enabled (sandbox; areas NCR, Bulacan, Cavite, Laguna, Rizal)
  PayMongo: incomplete, not set: PAYMONGO_WEBHOOK_SECRET
  Email:    off, keys not set (SMTP_USER, SMTP_PASS, MAIL_FROM, VERIFICATION_SECRET)
```

`.env` is only read at startup: **restart the backend after changing it.**

How an order flows:

1. Register → a 6-digit code is emailed. Checkout is blocked until it's confirmed.
2. Checkout asks `POST /api/v1/shipping/quote` for J&T / LBC (rate table) and
   Lalamove (Metro Manila, only with a map pin). `POST /api/orders` recomputes the
   fee on the server, **reserves** stock (`products.reserved`) and creates the
   order as `pending_payment`.
3. The customer pays on PayMongo's page (GCash, QR Ph, online banking). The
   webhook marks the order `paid` and turns the reservation into a real
   `stock_quantity` deduction.
4. Orders unpaid after 24 hours are set to `expired` and their stock is released
   (`jobs/expireOrders.js`, runs every 5 minutes).
5. On the admin **Deliveries** page (`Pages/Admin/deliveries.html`) the admin ships
   each paid order: enters the J&T/LBC waybill number, or books a Lalamove rider
   (offered only when Lalamove is configured and the address has a map pin), then
   updates the status as the parcel moves. The customer sees the courier, tracking
   number/link and timeline on **My Orders** (`Pages/COpage/orders.html`).

The shop is alerted to each paid order by email (`ADMIN_ALERT_EMAIL`) and by a
"paid orders to ship" badge on the admin Inventory page (polls
`GET /api/v1/admin/orders/to-ship` every 30 seconds). The catalog shows
**available** stock (on hand minus units held by unpaid orders).

### Shipping fees from map pins

Checkout and saved addresses have a map (Leaflet + OpenStreetMap tiles, bundled in
`Frontend/vendor/leaflet`). The pin is reverse-geocoded **by the backend** with
OpenStreetMap Nominatim (`services/geocode.js`: identifying User-Agent with
`GEOCODER_CONTACT`, max 1 request/second, results cached) and mapped to the PSGC
region, province and the island-province list. The server takes the shipping zone
from the pin, so a wrong region choice can't change the fee. Without a pin (or if
Nominatim is down) the region typed in the form is used.

- **J&T / LBC:** zone + parcel weight from the rate card. Edit it on the admin
  **Rates** page (`Pages/Admin/rates.html`). The `shipping_rates` seeded by
  migration 004 are **placeholders** — enter the real rate cards.
- **Lalamove:** live quote from the shop pin (`STORE_LAT`/`STORE_LNG`) to the
  customer's pin, only inside `LALAMOVE_SERVICE_AREAS`; shows the route distance.
- **Weights:** set each part's packed weight on the Inventory page. Parts still on
  the 0.5 kg default are flagged.
- Each courier option shows how its fee was calculated, and the order sends the fee
  the customer saw: if the recomputed fee differs, the order is refused with the new
  fee (409 `SHIPPING_FEE_CHANGED`) instead of charging something else.
Island provinces billed at the `ISLAND_PROVINCE` rate are listed in
`services/shippingRates.js`.

Endpoints are in `postman/bongalink-apis.json`. Run the tests with
`npm test` — they build a throwaway `bongalink_test` database on the MySQL
server in `.env` (and drop it afterwards); PayMongo, Lalamove and email are mocked.
