# Front-end developer notes

Everything under `Frontend/` is downloaded by every visitor, so the files there only keep short comments
about the page code itself. The notes that used to sit in those files — which API each page calls, how the
server behaves, which requirement a page covers — live here instead. This folder (`docs/`) is not served
by nginx.

Security never depends on the front end: every `/api/v1/admin/...` and `/api/admin/...` request is checked
on the server (`requireAdmin`), and every customer request with `requireAuth`. Anything the pages check
(admin role, form rules, stock) is only for instant feedback.

## Where the pages find the API (`JS/config.js`, `JS/api.js`)

- `config.js` (`window.BONGALINK_API_BASE_URL`) is normally blank. Blank means:
  - a page opened from a development server on port 5500 (VS Code Live Server, or Docker's `frontend`
    container) uses `http://localhost:4000/api`;
  - anywhere else, `/api` on the same site: the production setup in `DEPLOYMENT.md` section 8, where one
    HTTPS address serves the pages and nginx passes `/api` and `/uploads` to the Node API.
- Set it only when the API is on another address, e.g. `"https://api.example.com/api"`. That address must
  then also be in the API's `CORS_ORIGIN` and in the pages' Content-Security-Policy (`deploy/nginx`).
- `apiFetch()` adds the base URL, JSON handling and the login token. Every route in `Backend/routes/*.js`
  answers failures with `{ error: "..." }`, which becomes `err.message`; `err.status` and `err.code` let a
  page react to cases such as `EMAIL_NOT_VERIFIED` (checkout) or `WEAK_PASSWORD`.
- `ACCOUNT_SUSPENDED` / an ended session: `api.js` clears the login and sends the user to
  `login.html?ended=suspended|ended`.
- Timeouts: 20 s normally. Calls that wait on another service pass a longer `timeout`, always longer than
  the server's own limit for that service:
  - `API_TIMEOUT_LONG_MS` (45 s): shipping quote, place order, open PayMongo checkout, register / resend
    code / admin invite (they send an email);
  - `API_TIMEOUT_CHAT_MS` (60 s): chat message, booking a Lalamove rider.

## The login (`JS/api.js`, `JS/login.js`)

- `POST /api/auth/login { username, password }` returns `{ token, user: { role, username } }`. The server
  takes the role from the account, so customers and admins share one form.
- A normal login lives in `sessionStorage` (this tab only). "Remember me" uses `localStorage` for the 30
  days the server allows. The server still decides: suspension, a role or password change, or logging out
  ends the login on the next request.
- Log out calls `POST /api/auth/logout` to end this device's session on the server, then forgets the login
  locally (even offline).
- Forgot password: `POST /api/auth/forgot-password { email }`; the answer is the same whether or not the
  email has an account.

## Pages and the API calls they make

| Page | Script | Calls |
|---|---|---|
| Homepage / catalog | `Homepage.js` | `GET /api/products` (stock = available stock), `GET /api/categories`; admin: `POST /api/products` (multipart), `DELETE /api/products/:id` |
| Product | `product.js` | `GET /api/products/:id` (hidden = 404), `GET /api/products?category=` (related) |
| Cart | `cart-page.js`, `cart.js` | `GET/POST/DELETE /api/cart`. Rows: `{ id, quantity, name, price, image, stock }`, `stock` = on hand minus unpaid reservations |
| Checkout | `checkout.js` | `GET /api/v1/account/addresses`, `POST /api/v1/geo/reverse`, `POST /api/v1/shipping/quote`, `POST /api/orders`, `POST /api/v1/payments/checkout`, `GET /api/v1/payments/orders/:id` |
| My orders | `orders.js` | `GET /api/orders`, `GET /api/v1/orders/:id/tracking`, `POST /api/v1/payments/checkout` |
| Profile | `profile.js` | `GET/PATCH /api/v1/account/me`, `POST /api/v1/account/password`, `/api/v1/account/addresses[...]`, `/api/v1/auth/verify-email/send|confirm`, `GET /api/orders` |
| Register | `register.js` | `POST /api/auth/register`, `POST /api/v1/auth/verify-email/confirm`, `/send` (60-second cooldown on the server) |
| Reset password | `reset-password.js` | `GET /api/auth/reset-password?token=` → `{ username }`, `POST /api/auth/reset-password { token, password }` (link works once, 30 minutes; every device is logged out afterwards) |
| Set password | `set-password.js` | `GET/POST /api/auth/set-password` (accounts created on Admin › Accounts; also verifies the email) |
| Chat widget | `chat.js` | `POST /api/v1/chat/messages { session_id, message, product_id? }` → `{ reply, products }` |
| Admin › Dashboard | `dashboard.js` | `GET /api/admin/ml/dashboard`, `/api/v1/admin/orders/to-ship`, `/api/admin/ml/status`, `/api/admin/ml/predictions`, `/api/v1/admin/chat/summary`, `/api/v1/admin/accounts/summary` |
| Admin › Inventory | `inventory.js`, `product-editor.js`, `ml-training.js` | `/api/admin/ml/*` (status polled every 5 s, predictions, events), `/api/products/*` (see below), `GET/POST /api/admin/ml/training` |
| Admin › Deliveries | `deliveries.js` | see "Deliveries" below |
| Admin › Rates | `rates.js` | `GET/POST /api/v1/admin/shipping-rates`, `PATCH/DELETE /api/v1/admin/shipping-rates/:id` |
| Admin › Chat & FAQs | `chat-admin.js` | `GET /api/v1/admin/chat/summary`, `/logs?view=&q=&days=&customer=&before=`, `/sessions/:id`, `PATCH /logs/:id { resolved }`, `GET/POST/PATCH/DELETE /api/v1/admin/faqs` |
| Admin › Accounts | `accounts.js` | `GET /api/v1/admin/accounts?q&role&status&verified&sort&dir&page`, `/summary`, `/:id`, `/audit-log`; `POST /api/v1/admin/accounts` (emails a set-password link); `POST /:id/suspend|unsuspend|role|resend-invite`; `DELETE /:id` (delete or anonymize) |
| Header bell (admins) | `ui.js` | `/api/v1/admin/notifications` (list, unread count, read, read-all, stream-ticket, stream) |

Product editor (`product-editor.js`): `PATCH /api/products/:id` (details, shown/hidden),
`POST /api/products/:id/image` (cover), `POST /api/products/:id/images` and
`DELETE /api/products/:id/images/:imageId` (gallery), `POST /api/products/:id/stock { change, reason, note }`
(never below reserved), `GET /api/products/:id/history`.

Requirement codes from the proposal: profile REQ05/06/09, product page REQ08, accounts REQ010/018/019/029,
deliveries REQ012–REQ016, chat REQ026, revenue REQ001, retraining REQ028, shipping fee REQ015.

## Checkout (`checkout.js`)

1. Loads the server cart (what `POST /api/orders` will order) and the customer's default saved address.
2. The map pin (`map-picker.js`) fills region / province / city; the server takes the shipping zone from
   where the pin is. Address lookups go to `POST /api/v1/geo/reverse`, which talks to Nominatim within its
   usage policy — never straight from the browser.
3. Shipping quote: `POST /api/v1/shipping/quote` for J&T / LBC (rate table) and Lalamove (live quote, only
   when the pin is in its service area). Each request has a sequence number so a slow, older answer can't
   overwrite a newer one. The order sends the fee shown (`expected_shipping_fee`), so the server refuses
   it (`409 SHIPPING_FEE_CHANGED`) if the fee changed.
4. `POST /api/orders` body: `{ contact, recipient, address, courier, payment, consent }`. Stock is
   reserved for 24 hours (`pending_payment`). A retry after a timeout gets `409 ORDER_ALREADY_PLACED` with
   the order id, so it is never placed twice.
5. `POST /api/v1/payments/checkout` sends the customer to PayMongo. Coming back
   (`?order=&payment=success|cancelled`), the page polls `GET /api/v1/payments/orders/:id`; the redirect
   alone is not proof of payment, so a still-pending order never offers to pay again after "success".
6. Checkout is blocked until the email is verified (`EMAIL_NOT_VERIFIED`); verifying retries the order.

## Deliveries and tracking

Admin › Deliveries (`deliveries.js`) has three tabs:

| Tab | Data | Action |
|---|---|---|
| To pack | `GET /api/v1/admin/orders/awaiting-shipment`, status `paid` | `POST /api/v1/admin/orders/:orderId/packed` |
| Ready to ship | the same list, status `packed` | J&T/LBC: `POST /api/v1/admin/shipments/:orderId/manual { courier, tracking_number, fee_actual? }`; Lalamove: `POST /api/v1/admin/shipments/:orderId/lalamove` |
| Outgoing | `GET /api/v1/admin/shipments?status=` | J&T/LBC: `PATCH /api/v1/admin/shipments/:deliveryId/status { status, note? }`; Lalamove updates arrive through its webhook |

The header's "orders to ship" badge polls `GET /api/v1/admin/orders/to-ship` every 30 seconds (the shop
also gets an email per payment, `ADMIN_ALERT_EMAIL`).

My orders (`orders.js`): `GET /api/orders` gives each order with `paid_at`, `packed_at`, `shipped_at`
(the shipment's first event), `delivered_at` and `shipment_courier`, enough for the 4-step tracker.
"Track" loads `GET /api/v1/orders/:id/tracking` (works before shipping too):
`{ order_status, created_at, paid_at, packed_at, courier_chosen, shipped, courier, status, tracking_number,
tracking_url, delivered_at, events: [{ status, note, source, created_at }] }`.
Notes on `courier_webhook` events are Lalamove's raw status codes, so the page shows only the status label.

## Chat widget (`chat.js`)

- Answers come from Gemini on the server, using live stock, shipping rates, FAQs and (when logged in) the
  customer's own orders.
- The conversation is kept in `sessionStorage` for this tab, with the same session id the server logs.
- Bot replies are plain text; the only links allowed are product links `[Name](product:ID)`, written by
  the bot and checked by the server.
- Admin › Chat & FAQs is the loop for the paper's "progressively improve": the bot marks what it couldn't
  answer → it shows up there → "Turn into FAQ" → active FAQs go to the chatbot with every message.

## Admin notification bell (`ui.js`)

- Sales, payments to review, expired orders, shipments, low and out of stock, new customers and chat
  questions the assistant couldn't answer (`Backend/routes/notifications.js`, migration 012).
- New ones arrive live over a Server-Sent Events stream, opened with a single-use ticket
  (`POST .../stream-ticket`) so the login token never goes in a URL. If the stream can't connect or drops,
  the unread count is polled every 30 seconds while the stream is retried after 2 s, 4 s, 8 s … up to a
  minute.
- One stream per browser, not per tab: browsers open at most 6 connections to one host. The tabs elect one
  holder with the Web Locks API; it passes each notification to the other tabs over a BroadcastChannel.
  Browsers without those APIs give each tab its own stream, closed while the tab is hidden.
- Notification links are pages under `Pages/` written by the server; anything else is ignored.

## Forecasts (`inventory.js`, `forecast-ui.js`, `ml-training.js`)

- Display only: every number comes as-is from `GET /api/admin/ml/predictions`, which the Python ML worker
  writes. Rows the worker hasn't scored yet (no `computed_at`) are in no status group. In stock but no
  expected sales: the worker leaves `days_until_stockout` empty (or 0).
- "Update forecasts & trends": `POST /api/admin/ml/training` queues a retrain (409 if one is running); the
  worker trains; the page polls every 3 s while a run is queued or training, every 30 s otherwise.

## Passwords (`ui.js`)

The length rule matches `Backend/lib/passwordRule.js` (10 characters, at most 72 UTF-8 bytes because bcrypt
ignores the rest). The server also refuses well-known passwords (`WEAK_PASSWORD`). Logging in never checks it.

## Privacy page

`Pages/Homepage/privacy.html`: the notice required by the Data Privacy Act of 2012 (RA 10173). Customers
accept it at registration and invited users at account setup; `consent_records` keeps the version. When the
text changes in substance, change `PRIVACY_POLICY_VERSION` in `Backend/lib/privacy.js` and the version on
the page. The highlighted contact details must be filled in by the shop.

## Dashboard

The Integrated Dashboard (Sprint 3 "ERP Dashboard") is read-only. Revenue uses Philippine dates and weeks
from Monday, each compared with the previous whole day / week / month. Total, average and best period are
worked out in the browser from the chart's own bars.
