# Delivery tracking — what changed and why

Branch: `feature/delivery-tracking-ui` · Date: 2026-10-26 · Scope: the approved proposal's REQ012–REQ016
(the admin views and manages deliveries, sends tracking information to customers, computes fees and tracks
outgoing deliveries; customers track their delivery's progress). Nothing outside that scope was added: no new
libraries, no build step, no maps, no live rider location.

## Summary

- **"Mark as packed" now exists.** The database already had a `packed` order status, but nothing ever set it.
  The admin can now mark a paid order as packed, and the time is saved (`orders.packed_at`, migration 013).
- **Admin › Deliveries is now three tabs:** *To pack* → *Ready to ship* → *Outgoing*, each with a count, laid
  out like the approved mockup. Each Ready-to-ship order shows **one** action that matches the courier the
  customer chose (J&T/LBC waybill form, or "Book Lalamove rider").
- **My orders shows progress inside each order card:** a plain one-line headline ("Packed — handing it to the
  courier soon"), a 4-step tracker (Paid → Packed → Shipped → Delivered) with dates, and a **Track** button
  that opens the courier details, the list of updates and the items — no separate page.
- **Tracking works before shipping.** The customer's tracking endpoint used to answer "404 no shipment yet"
  until the parcel was handed over; now it answers for the order's whole life (still only to its owner).
- **Front-end clean-up for the adviser's finding.** Comments in `Frontend/` that described the server (API
  lists, Gemini, database tables, requirement codes, backend file paths) were removed; the useful notes moved
  to `docs/frontend-notes.md`, which the web server does not serve.
- **Two small security fixes found during the check:** nginx now refuses to serve dotfiles (`.env`, `.git`)
  and notes/backups (`.md`, `.sql`, …) if one ever lands in `Frontend/`; and in production a PayMongo/Lalamove
  failure no longer repeats the provider's own error text to the browser (it could name a key or account).
- **New tests** for all of the above, including one that walks every admin API route and proves it refuses
  visitors (401) and customers (403).

## What was done and how

### Part 1 — "Mark as packed" (admin + database)

**Problem.** Orders went straight from *paid* to *shipped*. The shop had no way to record that a parcel was
boxed and waiting for the courier, and the customer saw nothing between "paid" and "shipped".

**What changed**

| File | Why |
|---|---|
| `Backend/database/migrations/013_order_packed_at.sql` (new) | Adds `orders.packed_at DATETIME NULL` after `paid_at`. Adds a column only; no existing row is changed. |
| `Backend/tests/globalSetup.js`, `docker-compose.yml`, `deploy/mysql/check_migrations.sql`, `DEPLOYMENT.md` §4, `Backend/README.md` | Every place that lists the migrations in order now includes 013 (the Docker comment now says 003-013). |
| `Backend/database/imports/README.md` | "this branch also needs 011, 012 and 013". |
| `Backend/routes/logistics.js` | New `POST /api/v1/admin/orders/:orderId/packed` (admin only); `awaiting-shipment` now also returns `packed_at` (and `ship_city`, for the To-pack table). |
| `Backend/tests/checkMigrations.test.js` | Expects 10 checked migrations instead of 9. |

**How it works now, step by step**

1. The admin clicks **Mark as packed** on an order in *To pack*.
2. The page sends `POST /api/v1/admin/orders/<id>/packed`. The server checks the admin login (`requireAdmin`).
3. The server runs one statement: `UPDATE orders SET status='packed', packed_at=NOW() WHERE order_id=? AND status='paid'`.
   Because the "is it paid?" check and the change happen in the same statement, two quick clicks can't both
   succeed.
4. If the order doesn't exist → **404 "Order not found"**. If it isn't *paid* (already packed, shipped,
   unpaid…) → **409**, e.g. "Order #142 is packed; only paid orders can be marked as packed". Otherwise →
   **200** with `{ order_id, status: "packed", packed_at }`.
5. The page shows "Order #142 packed — moved to Ready to ship." and reloads the lists; the order now appears
   under *Ready to ship*, and on the customer's My orders the tracker lights up **Packed** with the date.
6. No email is sent to the customer (as requested).

The shipping endpoints still accept both `paid` and `packed` orders, so nothing that worked before breaks;
only the new page limits shipping to packed orders.

**About the audit log.** The audit log from migration 008 (`admin_audit_log`) only records account actions,
retraining and password resets — shipping is not recorded there either (each shipment update keeps the admin's
id in `shipment_events.created_by` instead). Recording "packed" in it would mean changing that table's list
of allowed actions inside migration 013, and you asked for 013 to make no other change. So packing is **not**
written to the audit log. If you want it, it is a one-line addition to the migration plus one insert in the
endpoint — say so and I'll add it.

### Part 2 — Admin › Deliveries, new layout

**Problem.** One long list mixed every paid order with a shipping form and a Lalamove button, and the outgoing
table offered manual status updates even for Lalamove, whose updates come automatically.

**What changed**

| File | Why |
|---|---|
| `Frontend/Pages/Admin/deliveries.html` | Three tabs (an accessible tab list: arrow keys work, the selected tab is announced) and three panels; the J&T/LBC vs Lalamove info note kept. |
| `Frontend/JS/deliveries.js` | Splits the existing `awaiting-shipment` answer by status on the client (no new list endpoint); renders each tab; Mark as packed; one action box per courier. |
| `Frontend/CSS/admin.css` | Styles for the step tabs and the Ready-to-ship rows, from the design-system tokens; one column on phones. Removed the old `.ship-card`/`.ship-grid` styles. |
| `Frontend/CSS/design-system.css` | `.link-button` moved here from `admin.css`, because My orders' **Copy** button now uses it too. |

**How it works now**

1. **To pack** — orders with status *paid*, oldest payment first: order # and paid time, items, ship-to name
   and city, courier chosen, and **Mark as packed** (Part 1).
2. **Ready to ship** — orders with status *packed*: packed time, items, full ship-to, shipping fee paid, and
   one action box:
   - **J&T / LBC:** "J&T Express — book at the branch, then enter the waybill", a small courier select (J&T or
     LBC, preset to the customer's choice), the waybill field, **Fee paid to courier (optional)** (renamed
     from "Actual fee") and **Mark as shipped** (the existing manual endpoint; the customer is emailed as
     before).
   - **Lalamove, bookable:** **Book Lalamove rider** (the existing endpoint) and "Status updates arrive from
     Lalamove automatically." with a **Ship with J&T/LBC instead** link that reveals the J&T/LBC form.
   - **Lalamove, not bookable** (no map pin, or Lalamove not configured): the existing explanation ("Customer
     chose Lalamove, but the address has no map pin. Ship with J&T or LBC instead.") and the J&T/LBC form
     right away.
3. **Outgoing** — the existing table and status filter, unchanged, except Lalamove rows now say
   **"Updates automatically from Lalamove"** instead of the manual status form.

### Part 3 — My orders: tracking inside the card

**Problem.** The card only showed a status badge; the timeline appeared only once a courier had the parcel,
and only as raw courier events.

**What changed**

| File | Why |
|---|---|
| `Backend/routes/logistics.js` | `GET /api/v1/orders/:id/tracking` now works before shipping (see below). |
| `Backend/routes/orders.js` | `GET /api/orders` also returns `packed_at`, `shipped_at` (the shipment's first event), `delivered_at` and `shipment_courier` (the courier actually used), so the tracker can be drawn without a request per card. |
| `Frontend/JS/orders.js` | The new card: headline, meta line, tracker, one button, and the Track panel (loaded when opened). `orderCardMarkup()` still has a compact mode for the profile page. |
| `Frontend/Pages/COpage/orders.html` | Subtitle "Press “Track” on an order to see where it is."; a narrower column like the mockup. |
| `Frontend/CSS/shop.css` | Styles for the headline, tracker, courier box and updates list (replacing the old timeline styles). |

**The tracking endpoint, before and after.** It is still only for the order's owner: an order that isn't
yours (or doesn't exist) is **404 "Order not found"**. It now returns, for any of your orders:
`order_status, created_at, paid_at, packed_at, courier_chosen, courier_chosen_label, shipped` and — once a
courier is booked — `courier, courier_label, status, tracking_number, tracking_url, delivered_at, events`
(before that they are `null` and `events` is `[]`). Backward compatible: every field the old answer had keeps
its name and meaning (`status` is still the *shipment's* status; the order's is the new `order_status`). The
only behaviour change is that a not-yet-shipped order now gets **200** instead of **404**. Each event also
carries `source`, so the page can hide Lalamove's raw codes ("Lalamove: ON_GOING").

**How a card works now**

1. Order ref + status badge, then one plain headline:
   - *Waiting for payment:* "Pay to confirm your order" + **Pay now**; the meta line adds "unpaid orders
     cancel after 24 hours" — this matches the code: `Backend/jobs/expireOrders.js` (`HOLD_HOURS = 24`)
     expires unpaid orders after 24 hours and releases their stock.
   - *Paid:* "Payment received — we're packing your order"
   - *Packed:* "Packed — handing it to the courier soon"
   - *Shipped:* Lalamove "Your rider is on the way"; J&T/LBC "Your parcel is with J&T Express"
   - *Delivered:* "Delivered Oct 24"
   - *Expired / Cancelled:* only the badge, as before.
2. Meta line: placed date · item count · courier (the one actually used, once shipped).
3. The tracker **Paid → Packed → Shipped → Delivered**: finished steps green with their date, the current step
   ringed (and marked for screen readers). Hidden for unpaid, expired and cancelled orders.
4. Total + one button: **Track** (or **Details** when delivered). It opens a panel inside the card:
   - **Courier box** — Lalamove: **Open live tracking ↗** (the saved Lalamove share link). J&T/LBC: the
     tracking number, a **Copy** button, and **Track on J&T's site ↗** when a tracking link is set. Before
     shipping: "J&T Express · tracking number appears once shipped".
   - **Updates**, newest first, the newest in bold: order placed, paid, packed, then every shipment event.
   - **Items**.
5. The profile page's compact cards keep working; their **Track** link opens My orders with that card already
   expanded (`orders.html#order-<id>`).

### Part 4 — The adviser's finding: backend details in the front end

**Problem.** Everything in `Frontend/` is downloaded by every visitor, and comments there described the server:
API endpoint lists with request/response shapes, Gemini, how the chat is logged, database table and column
names, requirement codes, backend file paths, environment variable names.

**What changed**

1. **Every served file was checked** — all 28 JS files, 8 CSS files and 17 HTML pages (not `vendor/`). The
   comments were extracted with a real JavaScript parser so none could be missed, then 73 comments were
   removed or rewritten in 38 files: 22 JS files (`accounts`, `api`, `cart-page`, `cart`, `chat-admin`, `chat`,
   `checkout`, `config`, `forecast-ui`, `Homepage`, `inventory`, `login`, `map-picker`, `ml-training`,
   `product-editor`, `product`, `profile`, `rates`, `register`, `reset-password`, `set-password`, `ui`) and 16
   pages (`profile`, `accounts`, `chat`, `dashboard`, `inventory`, `rates`, `cart`, `checkout`, `homepage`,
   `login`, `privacy`, `product`, `register`, `reset-password`, `set-password`, `orders`). `deliveries.html`,
   `deliveries.js` and `orders.js` were rewritten for Parts 2–3 and written clean. What remains are short
   comments about the page code itself, e.g. "Runs an action with its button busy". The CSS comments were
   already only about layout and stayed.
2. **Nothing was lost:** the notes moved to **`docs/frontend-notes.md`** at the repository root — which API each
   page calls, the checkout steps, how the chat and the notification bell work, the requirement codes, the
   password rule. nginx serves only `Frontend/`, so `docs/` is never downloadable.
3. **Non-page files:** `Frontend/` had no README, markdown, tests, backups or source maps (only Leaflet's
   `LICENSE`, which its licence requires us to ship). Both nginx configs (`deploy/nginx/frontend.conf.template`
   for Docker and `production.conf.example`) would have served such a file if one appeared, so both now answer
   404 for dotfiles (`.env`, `.git`, …; `/.well-known/` stays open for certificate renewals) and for
   `.md .map .bak .orig .old .sql .log .zip .tgz`.
4. **Secrets:** none in `Frontend/` — no API keys, PayMongo/Lalamove keys, Google keys, private keys or `.env`
   values. (Checked, and now also checked by a test.)
5. **Error responses in production:** the API's error handler already sends a generic "Something went wrong."
   for every unexpected error and logs the details on the server (no stack traces or SQL reach the browser;
   `routeErrors.test.js` proves it). One gap was found and fixed: a **502** from PayMongo or Lalamove passed the
   provider's own error text to the browser. In production that text could name a key or account, so it is
   now replaced by "The payment service couldn't complete this. Please try again in a moment." (or "The
   courier service…") and the details stay in the server log. Our own messages ("PayMongo didn't answer in
   time") are still shown. Files: `Backend/server.js`, `Backend/services/paymongo.js`, `Backend/services/lalamove.js`.
6. **No minifier or bundler was added.** Every `/admin` API route was confirmed to require an admin login: three
   routers guard all their routes at once (`router.use(requireAdmin)`: forecasts, accounts, shipping rates),
   the others guard each admin route; the notification live stream is opened with a single-use ticket that only
   an admin-guarded route hands out. A new test now walks the API's route table and fails if any admin route
   ever answers a visitor or a customer.
7. Page tests were updated; none asserted on the removed comments.

**The answer you can give your adviser**

> "Yes, the browser downloads all of our front-end files — that is true of every website, and the JavaScript
> of the admin pages can be read by anyone. We removed every comment that described the server: the API lists,
> the AI provider, database table names, requirement codes and backend file paths. Those notes now live in
> `docs/frontend-notes.md`, which the web server does not serve. There were never any passwords or keys in the
> front end. The real protection is on the server: every admin request is checked for an admin login (an
> automated test proves every admin route refuses visitors and customers), errors in production show a generic
> message and are logged on the server, and nginx refuses to serve hidden files or notes even if one is copied
> into the web folder by mistake."

## Database change

**Migration 013** — `Backend/database/migrations/013_order_packed_at.sql`:

```sql
ALTER TABLE orders
  ADD COLUMN packed_at DATETIME NULL AFTER paid_at;
```

It only adds an empty column (NULL for every existing order), so it is safe on live data. Orders packed before
this change simply show the Packed step without a date.

**Applying it to an existing database** (as an admin account, never the app's):

1. Back up first (`DEPLOYMENT.md` §12):
   ```bash
   mysqldump -u root -p --single-transaction --routines --triggers --default-character-set=utf8mb4 \
     bongalink_real > backups/bongalink_real_$(date +%Y%m%d-%H%M).sql
   ```
2. See what's missing — 013 should be the only `MISSING` line:
   ```bash
   mysql -u root -p bongalink_real < deploy/mysql/check_migrations.sql
   ```
3. Apply it:
   ```bash
   mysql -u root -p bongalink_real < Backend/database/migrations/013_order_packed_at.sql
   ```
   Windows PowerShell: `cmd /c "mysql -u root -p bongalink_real < Backend\database\migrations\013_order_packed_at.sql"`.
   Docker: `docker compose exec -T mysql mysql -uroot -p"$DB_PASSWORD" bongalink_real < Backend/database/migrations/013_order_packed_at.sql`.
4. Run step 2 again: everything `applied`. Restart the API.

A fresh Docker volume and the test database get 013 automatically.

## The full delivery flow

| Step | Admin sees / does | Customer sees on My orders |
|---|---|---|
| Customer pays | PayMongo confirms → the order appears in **To pack** (and the "orders to ship" badge). | Badge *Paid*; "Payment received — we're packing your order"; tracker: **Paid** (date). |
| Packed | Admin boxes the items and clicks **Mark as packed** → the order moves to **Ready to ship**. | Badge *Packed*; "Packed — handing it to the courier soon"; **Paid ✓ Packed ✓**. Track: "J&T Express · tracking number appears once shipped". |
| Shipped — **J&T / LBC** | Admin books at the branch (or the courier's app), types the waybill (and optionally the fee paid to the courier), clicks **Mark as shipped** → the order moves to **Outgoing**; the customer is emailed the tracking number. | Badge *Shipped*; "Your parcel is with J&T Express"; **Shipped ✓**. Track: tracking number + **Copy** + **Track on J&T's site ↗**; updates "Handed to courier — Dropped off at J&T Express". |
| Shipped — **Lalamove** | Admin clicks **Book Lalamove rider** → the API books through Lalamove; the customer is emailed the live-tracking link; the order moves to **Outgoing**. | "Your rider is on the way"; Track: **Open live tracking ↗**; updates "Rider booked". |
| On the way — J&T / LBC | Admin updates the status by hand in **Outgoing** (In transit, Out for delivery, …, with an optional note). | Each update appears in **Updates**, newest first. |
| On the way — Lalamove | Nothing to do: Lalamove's webhook updates the status; the row says "Updates automatically from Lalamove". | Updates appear automatically ("Handed to courier", "In transit"). |
| Delivered | J&T/LBC: admin sets **Delivered** (confirmation asked). Lalamove: automatic. The customer is emailed. | Badge *Delivered*; "Delivered Oct 24"; all four steps green; the button reads **Details**. |

## Front-end clean-up

- **Files cleaned:** the 22 JS files and 16 HTML pages listed in Part 4 (the page and two scripts rewritten for
  Parts 2–3 were written clean from the start).
- **Removed:** API endpoint lists and request/response shapes; Gemini and how the chat is logged; database
  table/column names (`ml_events`, `consent_records`, `computed_at`, …); requirement codes (REQ05…REQ028);
  backend file paths (`Backend/routes/orders.js`, `Backend/lib/passwordRule.js`, …); environment variable names
  (`ADMIN_ALERT_EMAIL`, `CORS_ORIGIN`); server internals (requireAdmin middleware, bcrypt, Nominatim, the
  notification stream's ticket design). There were no TODOs.
- **Moved to:** `docs/frontend-notes.md`.
- **Kept on purpose:** the privacy page's visible sentence "Google (Gemini) receives your chat messages…" — it is
  page text, not a comment, and the Data Privacy Act requires telling customers who processes their data.
  Leaflet's own file (`vendor/leaflet/leaflet.js`) is untouched; its last line points to a `.map` file that was
  never shipped (harmless: the browser's developer tools just can't find it).
- **The answer for your adviser:** see the quote at the end of Part 4.

## Tests

Command: `cd Backend && npm test` (Jest, `--runInBand`, against the `bongalink_test` MySQL database).

**Result:** all **55 test suites passed, 650 tests passed, 0 failed** (433 s). After two last styling tweaks, the
page, front-end and admin-route suites were run again: 4 suites, 94 tests, all passed.

**New tests**

| File | What it proves |
|---|---|
| `tests/logistics.test.js` — "POST /api/v1/admin/orders/:orderId/packed" (4 tests) | paid → packed with `packed_at` set and listed as packed; already packed / shipped / unpaid → 409 and the first `packed_at` is kept; unknown → 404, visitor → 401, customer → 403 (nothing changed); a packed order can still be shipped. |
| `tests/logistics.test.js` — "tracking before shipping" (3 tests) | a paid order → 200 with its dates, courier chosen and no shipment; packed then shipped → the shipment fields and events; another customer's order or an unknown one → 404, no login → 401. |
| `tests/deliveriesApi.test.js` (1 new, 2 extended) | the order list carries `packed_at`, `shipped_at`, `delivered_at` and the courier actually used; awaiting-shipment returns `packed_at` and `ship_city`. |
| `tests/deliveryPages.test.js` (rewritten: 9 Deliveries + 8 My orders page tests) | the three tabs and counts, keyboard tabs, To pack row, Mark as packed, the J&T/LBC form (renamed fee label), Lalamove bookable / not bookable / "instead" link, Outgoing with Lalamove rows read-only; My orders headlines, meta line, tracker states and dates, Pay now / Track / Details, the Track panel for J&T (Copy, courier link), Lalamove (live link, raw codes hidden) and before shipping, a tracking error, and `#order-<id>` opening that card. |
| `tests/frontendSource.test.js` (new, 7 tests) | no `/api/`, `REQ0…`, `Backend/` or TODO in any served file; no comment names Gemini, a table, or server internals; Gemini only on the privacy page; only page assets served; no secrets; both nginx configs refuse dotfiles and notes. |
| `tests/adminRoutes.test.js` (new) | walks the API's route table: every `/admin` route (45 routes) answers 401 to a visitor and 403 to a customer. |
| `tests/payments.test.js` (1 new) | in production a PayMongo error's own text is not sent to the browser (and is logged). |

`tests/checkMigrations.test.js` now expects 10 migrations; `tests/pageHarness.js` gained a `scrollIntoView`
stub (jsdom doesn't have one; real browsers do).

**Screenshots** (`docs/reports/screenshots/`, headless Chrome with sample data from a stub API):

| File | Shows |
|---|---|
| `admin-deliveries-1-to-pack.png` | To pack tab |
| `admin-deliveries-2-ready-to-ship.png` | Ready to ship: J&T form, Lalamove bookable, Lalamove without a map pin |
| `admin-deliveries-2b-ready-to-ship-jnt-instead.png` | after "Ship with J&T/LBC instead" |
| `admin-deliveries-3-outgoing.png` | Outgoing, Lalamove row read-only |
| `admin-deliveries-phone.png` | Ready to ship at phone width (390 px) |
| `my-orders-all.png` | unpaid, paid, packed, shipped (Lalamove), shipped (J&T), delivered |
| `my-orders-jnt-expanded.png`, `my-orders-lalamove-expanded.png`, `my-orders-packed-expanded.png`, `my-orders-delivered-expanded.png` | each with its Track/Details panel open |
| `my-orders-phone.png` | My orders at phone width, J&T card open |

## What was NOT done / limits

- **Packing is not in the audit log** (reason in Part 1). One-line change if you want it.
- **The screenshots use sample data from a stub API, not the real API and database.** The real API's behaviour
  is covered by the Jest tests against MySQL; the pages' behaviour by the jsdom page tests. I did not click
  through the pages against the running API with a real login.
- **nginx was not run** (there is no nginx on this machine), so `nginx -t` wasn't run on the two edited
  configs. The new lines are standard nginx syntax; run `nginx -t` on the server after copying the config.
- **Docker was not run** (no Docker on this machine); `docker-compose.yml` only gained one mount line.
- **The migration was not applied to `bongalink_real`** — that's yours to do, after a backup (section above).
- The "24 hours" in "unpaid orders cancel after 24 hours" is written in `orders.js` as well as in the server
  (`HOLD_HOURS`); if the server's number ever changes, change both.
- **Not part of this work, but on this branch:** when the branch was created, the working tree already had
  uncommitted changes from `cleanup/pre-defense` (`.dockerignore`, `DEPLOYMENT.md` §14 edits, `ml/` files, and
  the **staged deletion of the legacy Rust code in `ml/backend/`**). They are still uncommitted. I will **not**
  include them in the commit unless you say so.

## How to try it yourself

1. Apply migration 013 to your development database (section "Database change") and start the API
   (`cd Backend && npm run dev`) and the pages (Live Server on port 5500).
2. As a customer: add a part to the cart, check out, pay with a PayMongo **test** method. (On your own computer
   the PayMongo webhook can't reach you; to mark it paid by hand: `UPDATE orders SET status='paid', paid_at=NOW() WHERE order_id=<id>;`.)
3. Open **My orders**: the order says "Payment received — we're packing your order", the tracker shows **Paid**.
   Press **Track**: "J&T Express · tracking number appears once shipped" and the updates.
4. Log in as the admin, open **Deliveries**. The order is in **To pack** (count 1). Click **Mark as packed** →
   toast, it moves to **Ready to ship**.
5. Back on My orders (refresh): **Packed** is green with today's date.
6. In **Ready to ship**, type a waybill such as `JT0001234567`, optionally the fee paid to the courier, click
   **Mark as shipped**. It moves to **Outgoing**.
7. My orders: "Your parcel is with J&T Express"; **Track** shows the number, **Copy**, and the courier link if
   `TRACKING_URL_JNT` is set.
8. In **Outgoing**, set **In transit** with a note, then **Delivered**. My orders shows the update, then
   "Delivered <date>", all four steps green, and the button reads **Details**.
9. From **My profile**, click **Track** on a recent order: My orders opens with that order expanded.

## Deployment readiness

Checked on 2026-10-26 against `DEPLOYMENT.md` §10 (Go-live), §13 (Security notes) and §14 (Open items), plus the
extra checks from Part 6. **✅ ready** = checked and fine · **⚠️ needs you** = something only you can do or check
(usually on the live server) · **❌ blocked** = waiting on something outside the project.

What this machine is: a development computer with the demo database `bongalink_real` (`NODE_ENV=development`,
PayMongo **test** key, Lalamove **sandbox**, database user `root`). There is no live server yet, so most
"settings" items below can only be done by you on the server.

### Database (done today)

- Backup before the change: `backups/bongalink_real_20261026-2127_before-013.sql` (31 tables, 7 triggers,
  ends with "Dump completed"). `backups/` is git-ignored.
- Migration 013 applied to `bongalink_real`. `deploy/mysql/check_migrations.sql` afterwards: **003–013 all
  `applied`**; triggers' definer `root@localhost`, 7 triggers, `account_exists = 1`. The 168 existing orders are
  unchanged (`packed_at` empty).

### §10 Go-live — settings

| Item | State | What to do |
|---|---|---|
| Encryption keys = the database's, saved in a password manager | ⚠️ needs you | The API starts with the local keys, so they match `bongalink_real`. Copy the **same two keys** into the server's `.env` and into a password manager (never with the backups). |
| `NODE_ENV=production`, `APP_URL`, `CORS_ORIGIN`, `TRUST_PROXY=1` | ⚠️ needs you | Set on the server. The startup check itself works: with sample go-live values it gives **no errors and no warnings**; with a short secret or missing addresses it refuses to start. |
| New random `JWT_SECRET` and `VERIFICATION_SECRET` | ⚠️ needs you | Generate new ones for the server (command in §3); don't reuse the development ones. |
| Database: every migration, least-privilege users, triggers' definer | ⚠️ needs you | Migrations ✅ and definer ✅ (above). The app still uses `root` locally — on the server run `deploy/mysql/create_app_users.sql` and use `bongalink_app` / `bongalink_ml` (§5). |
| Product photos copied | ⚠️ needs you | On the server or Docker volume (§6, the copy step). |
| PayMongo live key + live webhook + its `whsk_` secret | ⚠️ needs you | Local key is `sk_test_`. At go-live: live key, a **Live-mode** webhook to `https://<shop>/api/v1/webhooks/paymongo`, and its secret. |
| Lalamove (if used): production keys, webhook URL, store pin/address/phone | ⚠️ needs you | Local is sandbox. |
| Email: SMTP App Password, `MAIL_FROM`, `ADMIN_ALERT_EMAIL`, test it | ⚠️ needs you | Test "Forgot password" and a new sign-up on the server. |
| Chat: `GEMINI_API_KEY`, `STORE_EMAIL`, `STORE_PHONE`; `GEOCODER_CONTACT` | ⚠️ needs you | Server `.env`. |
| Every `RATE_LIMIT_*` blank | ✅ ready | None is set in `Backend/.env`. Keep them blank on the server outside a test session (§11). |
| Privacy policy contact details | ⚠️ needs you | `Frontend/Pages/Homepage/privacy.html` still shows the placeholder "[name, email and phone of the data protection officer]". Fill it in before go-live. |
| Startup log shows no `WARNING:` lines; ML worker running | ⚠️ needs you | Check after the server is configured. |
| Backups scheduled and one restore tested | ⚠️ needs you | One manual backup was made today; nothing is scheduled and no restore was tested. Schedule the daily `mysqldump` (§12) and test one restore into a scratch database. |

### §10 Go-live — tests

| Item | State | What to do |
|---|---|---|
| Live payment test (buy the hidden test product, refund, remove the order) | ⚠️ needs you | Needs the live keys on the server. Steps: `Backend/README.md` §8. |
| PayMongo "paid session" check (test keys, before go-live) | ⚠️ needs you | Needs one completed test payment on your computer (§10 has the 4 steps). |
| PayMongo retry check before `PAYMONGO_WEBHOOK_TOLERANCE_SECONDS` | ⚠️ needs you | Until it's done, leave that setting blank (it is). |
| Lalamove webhook signature | ❌ blocked | Lalamove hasn't documented how it signs webhooks. Meanwhile each update must carry our API key and the status is re-read from Lalamove, so a fake message can't change anything. |
| Header checks (`curl -I` ×3) | ⚠️ needs you | After nginx is set up. Also run `nginx -t`: the two configs gained a rule refusing dotfiles and notes (nginx wasn't available here to test it). |

### §13 Security notes

| Item | State | What to do |
|---|---|---|
| HTTPS only (nginx redirect + HSTS) | ⚠️ needs you | The config does it; confirm with the `curl -I` checks on the server. |
| Database not on the network | ✅ ready (Docker) / ⚠️ (no Docker) | Docker publishes MySQL on `127.0.0.1` only. On a server without Docker, keep MySQL bound to localhost and use the limited accounts (§5). |
| No demo data in production | ✅ ready | The demo-password query on `bongalink_real` returned **no rows** (no `demo_admin`, no old demo passwords). Accounts: 6 customers, 3 admins, all active. |
| Secrets not in git | ✅ ready | Only the three `.env.example` templates are tracked, with empty secret values; no `.env`, dumps, backups or keys are tracked (`backups/` and `.env` are git-ignored), and no key-like strings appear in any tracked file. The tracked `.sql` files are schema, migrations and scripts; `real_inventory.sql` holds products and stock movements only, no customer data. (The old demo seed is still in git *history*, as §13 says, which is why the demo check above matters.) |
| Rate limits at defaults | ✅ ready | All blank. |

### §14 Open items

| Item | State | What to do |
|---|---|---|
| Delete the legacy Rust ML code | ⚠️ needs you | Waiting for your adviser's confirmation. Your earlier work for it (the staged deletion of `ml/backend/src`, `Cargo.*`, and the matching README, `.dockerignore` and `DEPLOYMENT.md` edits) is still **uncommitted** in the working tree and was not touched. Commit it only after the adviser agrees. |
| Lalamove webhook signature | ❌ blocked | See above. |
| PayMongo webhook age limit | ⚠️ needs you | Stays off until the retry check. |
| PayMongo "paid session" check | ⚠️ needs you | See above. |
| First Docker build | ❌ blocked here | No Docker on this machine. On the first machine with Docker: `docker compose config`, then `docker compose up -d --build`, and confirm the API and the worker start. |

### Extra checks (Part 6)

| Check | State | Details / what to do |
|---|---|---|
| Migrations up to 013 listed everywhere | ✅ ready | `globalSetup.js`, `docker-compose.yml`, `check_migrations.sql`, `DEPLOYMENT.md` §4, `Backend/README.md`; the tests that compare these lists pass. Applied to `bongalink_real`. |
| `.env.example` files contain every variable the code reads | ✅ ready | API: every `process.env.X` in `Backend/` (including `TRACKING_URL_JNT`/`LBC`) is in `Backend/.env.example`. Worker: all 19 `DB_*`/`ML_*` settings are in `ml/worker/.env.example`. Docker: every `${VAR}` in `docker-compose.yml` is in the root `.env.example`. |
| `NODE_ENV=production` startup checks pass with sample values | ✅ ready | No errors and no warnings with go-live-style values (see the settings table). |
| No secrets, `.env`, backups or dumps tracked | ✅ ready | See §13. |
| **Shipping rates are still the placeholders** | ⚠️ **needs you** | All **30 of 30** J&T/LBC rows in `bongalink_real` are exactly the testing placeholders from migration 004, and the largest bracket is **5 kg**. For a parcel heavier than 5 kg the shop offers **no J&T/LBC option at all**. Enter Bongalink's real J&T and LBC rates in **Admin › Rates**, and add **10 kg and 20 kg brackets** for every zone. |
| **Products still on the 0.5 kg default weight** | ⚠️ **needs you** | **All 69** active products are at 0.5 kg, so every J&T/LBC fee is worked out as if each item weighed 0.5 kg. Enter real weights (Admin › Inventory: the weight column, or Edit part); Inventory already shows a notice for these. |
| Demo-account check (§13) | ✅ ready | No rows. |
| `docker compose config` is valid | ❌ blocked here | Docker isn't installed on this computer. The automated tests read `docker-compose.yml` and check its mounts and migration order (they pass), but only Docker itself can fully validate it. |
| Full test suite passes | ✅ ready | After the clean-up: **55 suites, 650 tests, all passed** (`cd Backend && npm test`). The ML worker's own tests (`ml/worker`, 30 tests) also pass. |
