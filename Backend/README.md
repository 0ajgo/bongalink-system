# Bongalink API — Setup

The Node API behind the shop's pages (`Frontend/`), on MySQL. This file is for
running it **on your own computer**. Putting it on a server, the go-live steps,
backups and the test-session (UAT) settings are in [`../DEPLOYMENT.md`](../DEPLOYMENT.md).

## 1. Install prerequisites

- **Node.js 20 or newer**: https://nodejs.org
- **MySQL 8.4** (the shop uses the standalone MySQL84 server / MySQL Workbench)
- For the forecasts: **Python 3.12** for the ML worker (`ml/worker/README.md`)

## 2. Create the database

From the repository root, the schema and then **every** migration, in number order
(002 is already in the schema; this is the same list as `tests/globalSetup.js` and
`docker-compose.yml`):
```bash
mysql -u root -p -e "CREATE DATABASE bongalink CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
mysql -u root -p bongalink < Backend/database/bongalink_schema.sql
for m in 003_ml_sync 004_api_integrations 005_product_history 006_chatbot 007_faq_no_repairs \
         008_admin_accounts 009_encrypt_personal_data 010_ml_training_runs 011_auth_recovery \
         012_admin_notifications; do
  mysql -u root -p bongalink < Backend/database/migrations/$m.sql
done
```
(Windows PowerShell: run the same `mysql ... < file` line once per migration, e.g. with
`cmd /c "mysql -u root -p bongalink < Backend\database\migrations\003_ml_sync.sql"`.)
To see what an existing database is missing: `mysql -u root -p <db> < deploy/mysql/check_migrations.sql`.

The schema has no categories: after the first admin account (step 4), load
`database/seed_data.sql` for the six categories and the hidden test products used by the
live payment test (section 8). It can be run twice safely.

The admin **Inventory & Forecasts** page reads what the Python ML worker writes; see
`ml/worker/README.md` to run it. Removing a product hides it (`is_active = 0`) instead of
deleting the row, so order history and sales trends stay intact.

## 3. Configure the backend

```bash
cd Backend
cp .env.example .env
```
Fill in `.env`: the database (`DB_*`), and the three values the server needs to start,
`DATA_ENCRYPTION_KEY`, `DATA_INDEX_KEY` and `JWT_SECRET` (`.env.example` shows how to
generate each). Everything else turns a feature on; the startup log lists which are on.
For local work keep `NODE_ENV=development` and
`CORS_ORIGIN=http://localhost:5500,http://127.0.0.1:5500`.

## 4. Install dependencies and run

```bash
npm install
npm run dev        # restarts on file changes
npm test           # the test suite (builds its own bongalink_test database)
```
You should see `Bongalink API running on http://localhost:4000`, and
`http://localhost:4000/api/health` answers `{"status":"ok"}`.

**First admin account.** Sign-up only makes customer accounts, by design. Register one
on the shop's sign-up page (so its email is stored encrypted the way the app expects),
then make it an admin:
```sql
UPDATE users SET role = 'admin' WHERE username = 'your-username';
```
After that, more accounts (admins or customers) are created from Admin > Accounts,
which emails each one a link to set their password.

## 5. Open the shop

Serve `Frontend/` from a local web server on **port 5500** (VS Code "Live Server" opened
on the repository, or the Docker setup), not `file://`. On port 5500 the pages call the
API at `http://localhost:4000/api` by themselves; `Frontend/JS/config.js` is only for an
API somewhere else. The page's address must be in `CORS_ORIGIN`.

## 6. Putting it online

See [`../DEPLOYMENT.md`](../DEPLOYMENT.md): one HTTPS address for the pages and the API
(nginx), `NODE_ENV=production` (the server then refuses to start without its essential
settings), least-privilege database users, the ML worker as a service, live keys and
webhooks, backups, and the go-live tests.

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
`GET /api/v1/admin/orders/to-ship` every 30 seconds). The bell in the admin header
(migration 012, `routes/notifications.js`) lists sales, payments to review, expired
orders, shipments booked/delivered/failed, low and out of stock parts, new customers
and unanswered chats, live over Server-Sent Events. The catalog shows
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

## 8. Live payment test

One real purchase after go-live proves the whole chain: the live PayMongo keys, the
webhook, the "paid" status, the stock deduction, the bell and the shop's email alert.
It uses a hidden test product, so customers never see it: on `bongalink_real` that's
**Yosi** (product 73, 3 in stock); a fresh install gets **Camel** and three others from
`database/seed_data.sql`. Do it with the live keys and the webhook already set up
(DEPLOYMENT.md, go-live steps).

1. **Show the test product.** Admin > Inventory > Hidden parts > the product > Edit
   part > switch it to shown. (It needs a price above ₱0 and stock; Yosi has both.)
2. **Buy it.** Log in as a customer account with a verified email (not the admin), add
   1 to the cart, check out with J&T or LBC, and pay with GCash or QR Ph on the PayMongo
   page. This charges real money: the item plus the shipping fee.
3. **Confirm PayMongo marked it paid.** Within a minute:
   - the checkout page confirms the payment, and My Orders shows the order with a
     "Paid" date;
   - Admin > Deliveries lists it under "Paid orders to ship", the bell shows
     "New sale" and the shop inbox (`ADMIN_ALERT_EMAIL`) gets the order alert;
   - the PayMongo dashboard (Live mode) shows the payment.
   If the order stays unpaid although PayMongo shows the payment, the webhook isn't reaching the server:
   check its URL and `PAYMONGO_WEBHOOK_SECRET` (PayMongo > Developers > Webhooks).
4. **Hide the product again.** Inventory > the product > Edit part > hidden.
5. **Refund the payment** in the PayMongo dashboard (Payments > the payment > Refund),
   if you don't want to keep the money.
6. **Take the test order out of the sales**, so the dashboard and the forecasts only
   count real sales: back up the database, put the order number in
   `database/imports/remove_live_test_order.sql` and run it
   (`mysql -u root -p bongalink_real < database/imports/remove_live_test_order.sql`).
   It refuses an order that has any part still shown in the shop, deletes only that
   order and what depends on it, and leaves the stock alone (the unit stays sold;
   adjust it in Inventory if you want it back). It works like
   `database/imports/remove_test_orders.sql`, which removed the earlier checkout tests.
