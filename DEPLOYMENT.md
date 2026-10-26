# Deploying Bongalink

How to put the shop online, keep it running, back it up, and prepare a test session (UAT).
For running it on your own computer, see `Backend/README.md` and `ml/worker/README.md`.

**Contents**
1. [Read this first: the encryption keys](#1-read-this-first-the-encryption-keys)
2. [What runs where](#2-what-runs-where)
3. [Environment variables](#3-environment-variables)
4. [Database: migrations, in order](#4-database-migrations-in-order)
5. [Database users (least privilege)](#5-database-users-least-privilege)
6. [Running it with Docker](#6-running-it-with-docker)
7. [Running it without Docker](#7-running-it-without-docker)
8. [One HTTPS address for the pages and the API](#8-one-https-address-for-the-pages-and-the-api)
9. [Production settings the server checks](#9-production-settings-the-server-checks)
10. [Go-live](#10-go-live)
11. [UAT: raising the rate limits for a test session](#11-uat-raising-the-rate-limits-for-a-test-session)
12. [Backups and restore](#12-backups-and-restore)
13. [Security notes](#13-security-notes)
14. [Open items](#14-open-items)

---

## 1. Read this first: the encryption keys

> **`DATA_ENCRYPTION_KEY` and `DATA_INDEX_KEY` are the only way to read the customers' personal
> information.** Every email, name, phone number, address, map pin and chat message is stored
> encrypted with them (AES-256-GCM; emails are found by an HMAC "blind index" made with the index key).
>
> - **If they are lost, that information is gone for good.** No backup brings it back; a database
>   backup without its keys is unreadable.
> - **A database only works with the keys it was encrypted with.** When moving the shop to a new server,
>   or restoring a backup, copy the same two keys into the new `.env`. New keys on an existing database
>   make every login by email, every address and every order email fail.
> - **Keep them in a password manager, separately from the database backups**, never in the repository,
>   a chat, or the same folder as the dumps.
> - Generate them once, for a brand-new database only:
>   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` (once per key).
> - Key rotation: give the new encryption key a higher `DATA_ENCRYPTION_KEY_VERSION` and keep the old one
>   as `DATA_ENCRYPTION_KEY_V<old version>`, so existing values still decrypt. `DATA_INDEX_KEY` can't be
>   rotated without re-indexing every email.

The server refuses to start without working keys.

## 2. What runs where

| Part | What it is | Talks to |
|---|---|---|
| **MySQL 8.4** | the shop's database (`bongalink_real`) | — |
| **API** (`Backend/`, Node 20+) | everything the pages do; the PayMongo and Lalamove webhooks | MySQL, PayMongo, Lalamove, Gmail SMTP, Gemini, OpenStreetMap |
| **ML worker** (`ml/worker/`, Python 3.12 + TensorFlow) | a long-running process: forecasts and trends, retrains on its own | MySQL only |
| **Pages** (`Frontend/`) | static HTML/CSS/JS | the API |

In production, **one HTTPS address** (e.g. `https://shop.example.com`) serves the pages and passes
`/api` and `/uploads` to the API (section 8). The API and MySQL are not reachable from outside.

## 3. Environment variables

Settings live in `.env` files, which are git-ignored; only the `.env.example` templates are committed.

- **Without Docker:** `Backend/.env` for the API, `ml/worker/.env` for the worker.
- **With Docker:** one `.env` next to `docker-compose.yml`, which passes the values to the containers.

The same names are used everywhere. "Blank" means the default. Restart the API or the worker after
changing anything.

### API (`Backend/.env`)

| Variable | Required | Default | What it does / production value |
|---|---|---|---|
| `NODE_ENV` | yes | `development` | `production` on the server: turns on HSTS and the startup checks (section 9). |
| `PORT` | | `4000` | Port the API listens on (only nginx reaches it). |
| `HOST` | | `127.0.0.1` | Address the API listens on: this machine only, so the internet can't reach port 4000 around nginx. Docker sets `0.0.0.0` inside its container (its port is published on `127.0.0.1` only). |
| `CORS_ORIGIN` | in production | — | Comma-separated browser origins allowed to call the API. Production: the shop's address, e.g. `https://shop.example.com`. |
| `APP_URL` | in production | — | The shop's address as customers see it; PayMongo sends them back to `APP_URL/Pages/COpage/checkout.html`. Production: `https://shop.example.com`. |
| `TRUST_PROXY` | behind nginx | blank (no proxy) | Number of proxies in front of the API (usually `1`) or their addresses. Without it, every visitor shares the proxy's IP in the rate limits. Never `true`. |
| `UPLOAD_DIR` | | `Backend/uploads` | Where product photos are stored; served at `/uploads/<file>`. |
| `DB_HOST`, `DB_PORT` | yes | `127.0.0.1`, `3306` | MySQL server. |
| `DB_USER`, `DB_PASSWORD` | yes | — | Production: `bongalink_app` and its password (section 5), not root. |
| `DB_NAME` | yes | — | `bongalink_real` for the shop's data. |
| `DATA_ENCRYPTION_KEY`, `DATA_INDEX_KEY` | yes | — | **Section 1.** 32 random bytes each, base64. |
| `DATA_ENCRYPTION_KEY_VERSION` | | `1` | Version of `DATA_ENCRYPTION_KEY` (rotation only). |
| `DATA_ENCRYPTION_KEY_V1` (`_V2`, …) | | — | Previous keys after a rotation, so older values still decrypt. |
| `JWT_SECRET` | yes | — | Signs login tokens. 32+ random characters (production refuses less): `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`. Changing it logs everyone out. |
| `JWT_EXPIRES_IN` | | `7d` | How long a normal login lasts. "Remember me" lasts 30 days. |
| `RATE_LIMIT_*` (8 settings) | | see section 11 | Per-IP and per-account limits. Leave blank except during a test session (section 11). |
| `SMTP_HOST`, `SMTP_PORT` | for email | `smtp.gmail.com`, `465` | Mail server. |
| `SMTP_USER`, `SMTP_PASS` | for email | — | The shop's Gmail address and an **App Password** (Google account > Security > 2-Step Verification > App passwords). Blank = no email: no verification codes, password resets or order alerts. |
| `MAIL_FROM` | | — | Sender shown to customers, e.g. `"Bongalink <shop@gmail.com>"`. |
| `ADMIN_ALERT_EMAIL` | | — | Shop inbox that gets an email for every paid order. |
| `VERIFICATION_SECRET` | for email | — | Hashes the 6-digit email codes. A long random string. |
| `PAYMONGO_SECRET_KEY` | for payments | — | `sk_test_…` while testing, `sk_live_…` at go-live. The key decides test or live mode, also for the webhook. |
| `PAYMONGO_WEBHOOK_SECRET` | for payments | — | `whsk_…` of the webhook for **that** mode (PayMongo > Developers > Webhooks). |
| `PAYMONGO_METHODS` | | `gcash,qrph,dob,dob_ubp` | Payment methods offered on PayMongo's page. |
| `PAYMONGO_WEBHOOK_TOLERANCE_SECONDS` | | blank (off) | Refuse webhook signatures older than this. Off until the retry check in section 10 is done. |
| `LALAMOVE_ENV` | | `sandbox` | `production` at go-live (real riders). |
| `LALAMOVE_API_KEY`, `LALAMOVE_API_SECRET` | for Lalamove | — | Partner Portal > Developers. Blank = J&T and LBC only. Webhook updates must carry this API key. |
| `LALAMOVE_SERVICE_TYPE` | | `MOTORCYCLE` | Vehicle type. |
| `LALAMOVE_SERVICE_AREAS` | | `NCR,Bulacan,Cavite,Laguna,Rizal` | Where Lalamove is offered (regions or provinces). |
| `STORE_LAT`, `STORE_LNG`, `STORE_ADDRESS` | for Lalamove | — | The shop's pickup pin and address. |
| `STORE_CONTACT_NAME`, `STORE_PHONE` | | `Bongalink`, — | Sender details for Lalamove; also in the chat's fallback answer. |
| `STORE_EMAIL` | | — | Shown by the chat when it can't help. |
| `GEOCODER_CONTACT` | | `ADMIN_ALERT_EMAIL` | Contact in the User-Agent of map-pin lookups (OpenStreetMap's policy asks for one). |
| `NOMINATIM_URL` | | public server | Map-pin lookup server. |
| `GEMINI_API_KEY` | for the chat | — | Google AI Studio key. Blank = the chat gives the shop's contact details instead. |
| `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | | `gemini-3.8-flash`, `gemini-3.5-flash-lite` | The chat's model, and the one tried once when it is busy. |
| `TRACKING_URL_JNT`, `TRACKING_URL_LBC` | | — | Courier tracking page templates, `{tn}` = tracking number. Blank = show the number only. |

### ML worker (`ml/worker/.env`)

| Variable | Default | What it does |
|---|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME` | `127.0.0.1`, `3306`, `bongalink` | **The same database as the API** (`bongalink_real`). |
| `DB_USER`, `DB_PASSWORD` | `root`, — | Production: `bongalink_ml` (section 5). |
| `ML_POLL_SECONDS` | `5` | How often it looks for product changes. |
| `ML_QUIET_SECONDS`, `ML_MAX_WAIT_SECONDS` | `10`, `60` | Batches edits: waits until edits stop, or at most this long. |
| `ML_FULL_REFRESH_MINUTES` | `60` | Re-scores everything this often (new orders change demand). |
| `ML_RETRY_SECONDS` | `30` | Wait after a failed refresh. |
| `ML_COLD_START_DAYS` | `28` | Products newer than this show their category's average forecast. |
| `ML_TREND_MIN_SALE_DAYS` | `8` | Sale days needed before a trend is shown. |
| `ML_RETRAIN_HOUR` | `2` | Nightly retraining hour (local time), or `off`. |
| `ML_RETRAIN_NEW_ORDERS`, `ML_RETRAIN_STOCK_CHANGES` | `50`, `100` | Also retrain after this many new paid orders / stock changes, or `off`. |
| `ML_TRAINER` | `tensorflow` | `auto` falls back to least squares when TensorFlow is missing. |
| `ML_MODELS_DIR`, `ML_BOOTSTRAP_DIR` | `models`, `../backend/models` | Trained model versions; the starting model. |
| `ML_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING` or `ERROR`. |

### Docker only (the root `.env`)

Everything above, plus:

| Variable | Default | What it does |
|---|---|---|
| `DB_PASSWORD` | required | The MySQL container's **root** password. |
| `DB_NAME` | `bongalink` | Database both containers use; `bongalink_real` for the shop's data. |
| `API_DB_USER`, `API_DB_PASSWORD` | root, `DB_PASSWORD` | The API's database account (production: `bongalink_app`). |
| `ML_DB_USER`, `ML_DB_PASSWORD` | root, `DB_PASSWORD` | The worker's database account (production: `bongalink_ml`). |
| `API_ORIGIN` | `http://localhost:4000` | Where the browser reaches the API, for the pages' Content-Security-Policy in the `frontend` container. |

The pages themselves have one setting, `Frontend/JS/config.js` (`BONGALINK_API_BASE_URL`), normally
blank: on port 5500 (Live Server, Docker) the pages use `http://localhost:4000/api`, anywhere else
`/api` on their own address. Set it only if the API is on a different address; that address must then
also be in `CORS_ORIGIN` and in the pages' Content-Security-Policy.

## 4. Database: migrations, in order

A database is the schema plus every migration, **in number order**. Each migration says what it needs
and none can be skipped. The same list is in `Backend/tests/globalSetup.js` and `docker-compose.yml`.

| Order | File | Adds |
|---|---|---|
| 1 | `Backend/database/bongalink_schema.sql` | the tables (already includes 002) |
| 2 | `migrations/003_ml_sync.sql` | soft delete, ML tables and triggers |
| 3 | `migrations/004_api_integrations.sql` | email verification, PayMongo, deliveries |
| 4 | `migrations/005_product_history.sql` | product change history, extra photos |
| 5 | `migrations/006_chatbot.sql` | FAQs and the chat log |
| 6 | `migrations/007_faq_no_repairs.sql` | corrects two starter FAQs (data only) |
| 7 | `migrations/008_admin_accounts.sql` | account status, audit log |
| 8 | `migrations/009_encrypt_personal_data.sql` | room for encrypted values, the email blind index |
| 9 | `migrations/010_ml_training_runs.sql` | retraining runs |
| 10 | `migrations/011_auth_recovery.sql` | password reset, "Remember me" sessions |
| 11 | `migrations/012_admin_notifications.sql` | the admin bell |
| 12 | `migrations/013_order_packed_at.sql` | when an order was packed (Admin > Deliveries) |

Then `Backend/database/seed_data.sql` on a **fresh** database: the six categories and the hidden test
products for the live payment test. A fresh schema has **no categories** without it. It is safe to run twice.

**An existing database:** back it up first (section 12), then see what it is missing:
```bash
mysql -u root -p bongalink_real < deploy/mysql/check_migrations.sql
```
Apply only the `MISSING` ones, in order: `mysql -u root -p bongalink_real < Backend/database/migrations/0NN_….sql`.
If 009 was missing and the database already had customers or orders, encrypt those rows once afterwards,
from `Backend/`: `node scripts/encrypt-personal-data.js` (a plan, writes nothing), then
`node scripts/encrypt-personal-data.js --apply --database bongalink_real`.

The same script also checks the triggers' definer (next section).

Migrations, backups and the import scripts use an **admin** account (root), never the app's.

## 5. Database users (least privilege)

The API and the worker never change the schema, so they get their own accounts with only what they use.

1. Edit the four values at the top of `deploy/mysql/create_app_users.sql`:
   - the database (`bongalink_real`);
   - the host they connect from: `localhost` on one machine, `%` in Docker;
   - two different passwords of 20+ characters.

   The script refuses to run with the placeholders.
2. Run it once as root:
   ```bash
   mysql -u root -p < deploy/mysql/create_app_users.sql
   # Docker:
   docker compose exec -T mysql mysql -uroot -p"$DB_PASSWORD" < deploy/mysql/create_app_users.sql
   ```
   It prints the grants it made. They are:
   ```sql
   -- API: reads and writes the shop's data; no schema changes, no other database.
   GRANT SELECT, INSERT, UPDATE, DELETE ON `bongalink\_real`.* TO 'bongalink_app'@'localhost';
   -- ML worker: reads products and sales, writes only its own tables.
   GRANT SELECT ON bongalink_real.products         TO 'bongalink_ml'@'localhost';
   GRANT SELECT ON bongalink_real.categories       TO 'bongalink_ml'@'localhost';
   GRANT SELECT ON bongalink_real.orders           TO 'bongalink_ml'@'localhost';
   GRANT SELECT ON bongalink_real.order_items      TO 'bongalink_ml'@'localhost';
   GRANT SELECT, UPDATE ON bongalink_real.ml_events         TO 'bongalink_ml'@'localhost';
   GRANT SELECT, UPDATE ON bongalink_real.ml_status         TO 'bongalink_ml'@'localhost';
   GRANT SELECT, INSERT, UPDATE ON bongalink_real.ml_training_runs  TO 'bongalink_ml'@'localhost';
   GRANT SELECT, INSERT, UPDATE ON bongalink_real.ml_model_versions TO 'bongalink_ml'@'localhost';
   GRANT SELECT, INSERT, UPDATE, DELETE ON bongalink_real.ml_predictions TO 'bongalink_ml'@'localhost';
   ```
   (`\_` because `_` is a wildcard in a database-wide grant.)
3. Put them in the settings and restart both:
   - without Docker: `DB_USER`/`DB_PASSWORD` in `Backend/.env` (`bongalink_app`) and in `ml/worker/.env` (`bongalink_ml`);
   - with Docker: `API_DB_USER`/`API_DB_PASSWORD` and `ML_DB_USER`/`ML_DB_PASSWORD` in the root `.env`.

   The API's startup log stops warning "DB_USER is root".
4. **Check that the triggers' account still exists.** The ML-sync and product-history triggers run as
   the account that created them, usually `root@localhost`. If that account is removed or renamed, every
   product change fails. `deploy/mysql/check_migrations.sql` shows it; `account_exists` must be `1`:
   ```sql
   SELECT t.DEFINER, COUNT(*) AS triggers,
          (SELECT COUNT(*) FROM mysql.user u WHERE CONCAT(u.User, '@', u.Host) = t.DEFINER) AS account_exists
     FROM information_schema.TRIGGERS t WHERE t.TRIGGER_SCHEMA = 'bongalink_real' GROUP BY t.DEFINER;
   ```

`ml/worker/import_sales.py` (the sales-sheet import) creates databases, so it keeps using root.

## 6. Running it with Docker

`docker-compose.yml` runs MySQL, the API, the ML worker and an nginx for the pages. Each restarts
automatically if it stops (`restart: unless-stopped`). MySQL (3307) and the API (4000) listen on
this machine only.

1. Copy `.env.example` (next to `docker-compose.yml`) to `.env` and fill it in. Required:
   `DB_PASSWORD`, `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `DATA_INDEX_KEY`. For an existing database, use
   **the keys it was encrypted with** (section 1).
2. `docker compose up -d --build`
3. Pages: `http://localhost:5500/Pages/Homepage/homepage.html`; API: `http://localhost:4000/api/health`.

A new, empty volume gets the schema and every migration automatically (section 4). MySQL runs those
only on an empty volume; for an existing one, apply missing migrations yourself.

**The shop's data in Docker.** Load a backup of `bongalink_real` (section 12) into the container, then
point both services at it:
```bash
docker compose exec -T mysql mysql -uroot -p"$DB_PASSWORD" -e "CREATE DATABASE bongalink_real CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
docker compose exec -T mysql mysql -uroot -p"$DB_PASSWORD" bongalink_real < backups/bongalink_real_<date>.sql
# in .env: DB_NAME=bongalink_real
docker compose up -d api worker
```

**Copy the product photos into the uploads volume** (needed once per new volume). The imported
products' photos are in the repository (`Backend/database/imports/photos/`) and in the API image, but the
API serves `/uploads` from the `uploads` volume, which starts empty. Without this step the shop shows
the "no photo" placeholder:
```bash
docker compose run --rm --no-deps api sh -c "cp -n database/imports/photos/* uploads/ && ls uploads | wc -l"
```
`-n` never overwrites a file already there. Photos added later from Admin > Inventory are stored only in
the volume: back it up (section 12). For a server without Docker, copy the same folder into
`Backend/uploads/` (or `UPLOAD_DIR`).

**Docker in production:** put nginx on the host in front (section 8), with `/api` and `/uploads` going
to `127.0.0.1:4000`, the pages served from the repository's `Frontend/` folder (not the `frontend`
container), and `TRUST_PROXY=1`. Set the least-privilege accounts (section 5).

The ML worker image installs the package versions in `ml/worker/requirements.lock` (audited with
pip-audit). To upgrade them, update `ml/worker/.venv`, run the tests and pip-audit, and regenerate the lock.

## 7. Running it without Docker

On a Linux server (paths below: the repository at `/opt/bongalink`, a `bongalink` system user that owns it).

**API**
```bash
cd /opt/bongalink/Backend
npm ci --omit=dev
cp .env.example .env     # fill it in: NODE_ENV=production, section 3
node server.js           # once by hand: read the startup log (section 9), then Ctrl+C
sudo cp ../deploy/systemd/bongalink-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now bongalink-api
journalctl -u bongalink-api -f
```
systemd restarts it 5 seconds after any stop. The API stops itself if MySQL can't be reached at start,
so after a reboot it simply retries until MySQL is up.

**ML worker** (a long-running process)
```bash
cd /opt/bongalink/ml/worker
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt -c requirements.lock
cp .env.example .env     # same database as the API, section 3
.venv/bin/python -m bongalink_ml --once     # one update by hand, to check the settings
sudo cp ../../deploy/systemd/bongalink-ml-worker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now bongalink-ml-worker
journalctl -u bongalink-ml-worker -f
```
Inside its loop the worker survives errors (it retries after `ML_RETRY_SECONDS`). systemd starts it
again 15 seconds after the process itself stops, for example when MySQL isn't reachable at boot. Admin >
Inventory shows "worker not running" when its heartbeat is older than 2 minutes.

**Pages:** nothing to build. nginx serves `/opt/bongalink/Frontend` (section 8).

On a Windows server instead of Linux, run the same two commands (`node server.js`,
`.venv\Scripts\python -m bongalink_ml`) as services that restart on failure, for example with
Task Scheduler ("If the task fails, restart every 1 minute") or NSSM.

## 8. One HTTPS address for the pages and the API

Serving the pages and the API from the same HTTPS address keeps everything simple:
- no cross-origin calls;
- one certificate;
- `Frontend/JS/config.js` stays blank;
- the strictest Content-Security-Policy.

1. Copy `deploy/nginx/production.conf.example` to `/etc/nginx/sites-available/bongalink`.
2. Replace `shop.example.com` (4 places) and the paths, then enable it:
   `ln -s ../sites-available/bongalink /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx`.
3. Get the certificate: `certbot --nginx -d shop.example.com`.
4. In `Backend/.env`, set the following, then restart the API:
   ```
   NODE_ENV=production
   TRUST_PROXY=1
   APP_URL=https://shop.example.com
   CORS_ORIGIN=https://shop.example.com
   ```

What the config does:
- Redirects `http://` to `https://`.
- Sends HSTS: browsers remember to use HTTPS only.
- Serves `Frontend/`, and passes `/api/` and `/uploads/` to `127.0.0.1:4000`, adding the visitor's address
  (`X-Forwarded-For`). This is why `TRUST_PROXY=1` is needed.
- Keeps the admin bell's live stream unbuffered.
- Allows 6 MB request bodies, so 5 MB photo uploads fit.
- Gives the pages the same security headers as Docker's frontend:
  - scripts only from the site;
  - styles and fonts from the site and Google Fonts;
  - images from the site, OpenStreetMap tiles and `data:`;
  - no framing.

  A new outside source (another CDN, a widget) must be added to that policy, or browsers block it.

**Check it:**
- `curl -I https://shop.example.com/Pages/Homepage/homepage.html` shows `Strict-Transport-Security` and
  `Content-Security-Policy`.
- `curl -I https://shop.example.com/api/health` shows the API's own headers and no `X-Powered-By`.
- `curl -I http://shop.example.com` answers `301`.

## 9. Production settings the server checks

With `NODE_ENV=production`, the API checks its settings at every start (`Backend/lib/productionChecks.js`).

It **refuses to start** when:
- `JWT_SECRET` has fewer than 32 characters;
- `CORS_ORIGIN` is empty;
- `APP_URL` is empty.

It **warns** when:
- `APP_URL` or `CORS_ORIGIN` has an address that isn't `https://`;
- PayMongo is in test mode (an `sk_test_` key);
- Lalamove is in sandbox mode;
- `DB_USER` is root;
- `TRUST_PROXY` is blank.

In every environment, it also warns while any rate limit is raised above its default (section 11).

It also stops, with a clear message, if the encryption keys are missing or wrong (section 1), or if MySQL
can't be reached. Docker or systemd then starts it again.

**At go-live the startup log should show no `WARNING:` lines.**

## 10. Go-live

### Settings

Every key and secret to enter on the server, and where each one comes from. Never put them in the
repository, a chat or a document; keep a copy in a password manager.

| Setting | Where to get it |
|---|---|
| `DATA_ENCRYPTION_KEY`, `DATA_INDEX_KEY` | **The ones the database was encrypted with** (your password manager). Only for a brand-new, empty database: generate with the command in section 1. |
| `JWT_SECRET`, `VERIFICATION_SECRET` | Generate new ones on the server: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` (once each). |
| `DB_PASSWORD` (API: `bongalink_app`), worker `DB_PASSWORD` (`bongalink_ml`); Docker: `DB_PASSWORD` (root), `API_DB_PASSWORD`, `ML_DB_PASSWORD` | You choose them (20+ characters) when running `deploy/mysql/create_app_users.sql` (section 5). |
| `PAYMONGO_SECRET_KEY` | PayMongo Dashboard, **Live mode** > Developers > API keys: the `sk_live_…` secret key. |
| `PAYMONGO_WEBHOOK_SECRET` | PayMongo Dashboard, **Live mode** > Developers > Webhooks: create the webhook (URL `https://<domain>/api/v1/webhooks/paymongo`, event `checkout_session.payment.paid`) and copy its `whsk_…`. |
| `LALAMOVE_API_KEY`, `LALAMOVE_API_SECRET` (if Lalamove is used) | Lalamove Partner Portal, **production** account > Developers. There, also set the webhook URL `https://<domain>/api/v1/webhooks/lalamove`. With `LALAMOVE_ENV=production`. |
| `SMTP_USER`, `SMTP_PASS` | The shop's Gmail address, and an **App Password** for it: Google Account > Security > 2-Step Verification > App passwords. |
| `GEMINI_API_KEY` | Google AI Studio > Get API key. |

The other settings (`APP_URL`, `CORS_ORIGIN`, `MAIL_FROM`, `ADMIN_ALERT_EMAIL`, `STORE_*`, `GEOCODER_CONTACT`,
`TRACKING_URL_*`) are not secret: they're the shop's own addresses and details (section 3).

- [ ] **Encryption keys:** the same `DATA_ENCRYPTION_KEY` / `DATA_INDEX_KEY` as the database, saved in a password manager (section 1).
- [ ] `NODE_ENV=production`; `APP_URL` and `CORS_ORIGIN` = `https://shop.example.com`; `TRUST_PROXY=1` (section 8).
  With Docker, set `APP_URL`, `CORS_ORIGIN` (and `API_ORIGIN`, if the `frontend` container is used) in the root `.env`: missing, they fall back to `localhost` addresses.
- [ ] A new random `JWT_SECRET` (32+ characters) and `VERIFICATION_SECRET`, not the development ones.
- [ ] Database: `bongalink_real`, with every migration (`deploy/mysql/check_migrations.sql`), the least-privilege users (section 5), and the triggers' definer present.
- [ ] Product photos in place (section 6, the copy step).
- [ ] **PayMongo live:**
  - `PAYMONGO_SECRET_KEY=sk_live_…` (PayMongo > Developers > API keys, Live mode).
  - Add a **Live-mode** webhook in PayMongo > Developers > Webhooks:
    - URL `https://shop.example.com/api/v1/webhooks/paymongo`
    - event `checkout_session.payment.paid`
  - `PAYMONGO_WEBHOOK_SECRET` = that webhook's `whsk_…`. A test-mode webhook's secret doesn't work with a live key.
- [ ] **Lalamove**, if used:
  - production keys, and `LALAMOVE_ENV=production`;
  - in the Partner Portal, the webhook URL `https://shop.example.com/api/v1/webhooks/lalamove`;
  - the shop's `STORE_LAT`, `STORE_LNG`, `STORE_ADDRESS`, `STORE_PHONE`.
- [ ] **Email:**
  - `SMTP_USER` / `SMTP_PASS` (a Gmail App Password), `MAIL_FROM`, `ADMIN_ALERT_EMAIL`;
  - test it: "Forgot password" on the login page sends a link; a new account gets its 6-digit code.
- [ ] Chat: `GEMINI_API_KEY`, and `STORE_EMAIL`, `STORE_PHONE` for its fallback answer. `GEOCODER_CONTACT` for map pins.
- [ ] Every `RATE_LIMIT_*` blank (section 11).
- [ ] The privacy policy's contact details filled in (`Frontend/Pages/Homepage/privacy.html`, the highlighted placeholder).
- [ ] The API restarted; its startup log shows no `WARNING:` lines and every integration as enabled. The ML worker is running (Admin > Inventory).
- [ ] Backups scheduled and one restore tested (section 12).

### Go-live tests
- [ ] **Live payment test**: one real purchase of the hidden test product, then refund it and remove the
  test order. The steps are in `Backend/README.md`, section 8.
- [ ] **PayMongo "paid session" check** (before go-live, with **test** keys, on your own computer). When a
  customer pays but PayMongo's webhook hasn't reached us yet, "Pay now" must not open a second payment.
  The code reads the session from PayMongo (`getCheckoutSession` in `services/paymongo.js`) and treats
  it as paid when `payments` is not empty or `paid_at` is set. The sandbox has confirmed the unpaid and
  expired shapes; the paid one needs a completed test payment. On your computer the webhook can't reach
  `localhost`, which is exactly that situation:
  1. With `sk_test_` keys, place an order and complete the payment on PayMongo's **test** page
     (choose the test method's "authorize"/success option).
  2. The order stays "Pending payment" (no webhook). On My Orders, press "Pay now" for it: the answer must
     be that it is already paid (409), with **no** new PayMongo page.
  3. Optionally confirm the shape: `GET https://api.paymongo.com/v1/checkout_sessions/<id>` with the test
     key shows `data.attributes.payments` not empty (or `paid_at` set).
  4. Remove that test order afterwards (`remove_live_test_order.sql`, after a backup), or let it be:
     unpaid orders expire after 24 hours and release their stock.
  During the live payment test, the PayMongo dashboard (Live mode) should show the same payment fields.
- [ ] **PayMongo retry check, before turning on `PAYMONGO_WEBHOOK_TOLERANCE_SECONDS`:**
  1. Make the webhook fail once: in the sandbox, stop the API for a moment during a test payment.
  2. When PayMongo retries, compare the `t=` in the retried `Paymongo-Signature` header with the first one.
  3. Only if retries carry a **new** timestamp, set `PAYMONGO_WEBHOOK_TOLERANCE_SECONDS=300`.

  Otherwise leave it blank, because a retried payment would be refused. Repeated events are harmless
  either way: each is processed once.
- [ ] **Lalamove webhook signature.** Lalamove's documentation doesn't say how its webhooks are signed. For
  now each update must carry our API key, and the API re-reads the real status from Lalamove instead of
  trusting the message. When Lalamove documents the signature, or their support confirms it, add the check
  in `routes/logistics.js` and test it with a sandbox delivery.
- [ ] **Headers:** the three `curl -I` checks in section 8.

## 11. UAT: raising the rate limits for a test session

The API limits how often one IP address may try some things, to stop password guessing, spam sign-ups
and chat abuse. In a test session where many people share **one public IP** (a school lab, one Wi-Fi),
everyone counts as one visitor, and the limits would block the group within minutes. Raise the per-IP
limits for the session, and put them back right after.

**Limits that never change:**
- 10 failed logins per username from one IP, in 15 minutes: it still stops guessing one person's password;
- 3 password-reset emails per email address per hour;
- 8 chat messages per chat per minute.

### Before the session

1. Estimate the peak: how many participants, and how many sign-ups, logins and chat messages each might do.
2. Set these in `Backend/.env` (with Docker: the root `.env`). The suggested values are for about
   40 people on one IP for a few hours; scale them with the group.

   | Setting | Default | Suggested for UAT | What it limits (per IP) |
   |---|---|---|---|
   | `RATE_LIMIT_LOGIN_PER_IP` | 50 / 15 min | `500` | failed logins, across all usernames |
   | `RATE_LIMIT_REGISTER_PER_IP_HOUR` | 5 / hour | `100` | new accounts (each sends an email) |
   | `RATE_LIMIT_REGISTER_PER_IP_DAY` | 20 / day | `200` | new accounts |
   | `RATE_LIMIT_VERIFY_EMAIL_PER_IP` | 20 / 15 min | `400` | email-code requests and guesses |
   | `RATE_LIMIT_FORGOT_PASSWORD_PER_IP` | 10 / 15 min | `100` | password-reset requests |
   | `RATE_LIMIT_CHAT_PER_IP_MINUTE` | 20 / min | `200` | chat messages |
   | `RATE_LIMIT_CHAT_PER_IP_DAY` | 300 / day | `3000` | chat messages (each costs a Gemini request) |
   | `RATE_LIMIT_ACCOUNT_PER_USER` | 10 / 15 min | leave blank | failed email/password changes, per account (not per IP) |

3. Behind nginx, `TRUST_PROXY=1` must already be set. Otherwise the whole internet counts as one IP,
   not just the lab.
4. **Restart the API.** Its startup log lists each raised limit as a `WARNING:`. That's expected during
   the session.
5. Decide which keys the session uses:
   - **PayMongo test keys** (`sk_test_…` with the test webhook's secret): participants can "pay" with
     PayMongo's test methods, and no money moves;
   - **Lalamove sandbox**: no real rider comes.

   With live keys, every checkout is a real payment.
6. Expect real emails: every sign-up sends a verification code from the shop's Gmail. Gmail limits how
   many an account sends per day (about 500 for a normal account).

### After the session

1. Set every `RATE_LIMIT_*` from the table back to **blank**, in the same `.env`.
2. **Restart the API.** The counters live in memory, so a restart also clears them. The startup log must
   no longer list any raised limit.
3. If the session used test keys on the live server, put the live `PAYMONGO_SECRET_KEY` and live webhook
   secret back, and set `LALAMOVE_ENV=production`. Restart.
4. Remove the test accounts and orders the session created, if they shouldn't count as sales:
   - back up first (section 12);
   - orders: `Backend/database/imports/remove_live_test_order.sql`, one order at a time;
   - accounts: Admin > Accounts > Delete.

## 12. Backups and restore

**What to back up**

| What | How | Where it must NOT go |
|---|---|---|
| The database | `mysqldump`, below | — |
| `DATA_ENCRYPTION_KEY`, `DATA_INDEX_KEY` (and any `_V*` keys) | once, into a password manager | not with the dumps (section 1) |
| `Backend/.env`, `ml/worker/.env` (or the root `.env`) | a copy in the password manager / a safe place | not in the repository |
| Product photos | `Backend/uploads/` or the Docker `uploads` volume | — |
| ML model files (optional; they can be retrained) | `ml/worker/models/` or the `ml-models` volume | — |

**Database backup** (an admin account; `--single-transaction` gives a consistent copy without stopping the shop):
```bash
mysqldump -u root -p --single-transaction --routines --triggers --default-character-set=utf8mb4 \
  bongalink_real > backups/bongalink_real_$(date +%Y%m%d-%H%M).sql
# Docker:
docker compose exec -T mysql mysqldump -uroot -p"$DB_PASSWORD" --single-transaction --routines --triggers \
  --default-character-set=utf8mb4 bongalink_real > backups/bongalink_real_$(date +%Y%m%d-%H%M).sql
```
- Schedule it daily (cron: `30 3 * * * …`, an hour after the nightly retraining), and before every
  migration, import or clean-up script.
- Keep at least 14 days, and a copy off the server.
- The dumps hold personal data (encrypted) and password hashes: store them like the data itself.

**Photos (Docker volume):**
```bash
docker run --rm -v "$(basename "$PWD")_uploads":/u -v "$PWD/backups":/b alpine tar czf /b/uploads_$(date +%Y%m%d).tgz -C /u .
```
The volume name is `<folder>_uploads`; `docker volume ls` shows it.

**Restore**
1. Stop the API and the worker, so nothing writes meanwhile.
   (`systemctl stop bongalink-api bongalink-ml-worker`, or `docker compose stop api worker`.)
2. Into an empty database, as root: the triggers in the dump are created with their definer (`root@localhost`):
   ```bash
   mysql -u root -p -e "CREATE DATABASE bongalink_real CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
   mysql -u root -p --default-character-set=utf8mb4 bongalink_real < backups/bongalink_real_<date>.sql
   ```
   To replace a damaged database, restore under a new name first, check it, then switch `DB_NAME`.
3. `mysql -u root -p bongalink_real < deploy/mysql/check_migrations.sql`: everything `applied`, `account_exists = 1`.
4. If it's a new MySQL server, create the database users again (section 5).
5. Restore the photos (`tar xzf` into the uploads folder or volume). Use **the same encryption keys** in `.env`.
6. Start the API and the worker. Log in as an admin, and open a customer's order to see their address
   decrypted. A wrong key shows up here.

**Test a restore** every few months, and before go-live: restore the latest dump into a scratch database
on another machine, and run steps 3 and 6 against it.

## 13. Security notes

- **HTTPS only.** Logins, tokens and payments must never travel over plain http:
  - nginx redirects http and sends HSTS (section 8);
  - the API sends HSTS in production and warns about `http://` addresses (section 9).
- **The database is not on the network.** MySQL listens on this machine only (Docker publishes 3307 on
  127.0.0.1). The app and the worker use their own limited accounts (section 5).
- **No demo data in production.** An old demo seed (`ml/worker/seed_demo.py`, added in commit `8dab944`,
  removed on 2026-10-12 in `7568477`; still in the git history) created `demo_admin` and 40 customers
  `customer01`…`customer41`, with passwords written in the file:
  - never run a demo or test seed against `bongalink_real`;
  - before go-live, check that no account uses those passwords; this should return nothing:
    ```sql
    SELECT username, role FROM users
     WHERE password_hash IN ('$2a$10$ebMSCsQT9yuaOFoeNm574.cvxtDjbuHUHq/sX2hUw/XWqG3pfOfBS',
                             '$2a$10$wWHv2Mq7mUMMkDUjKdrY2u.nLLqqHL4MxQdd.lyJMI51SmnIDF2n2')
        OR username = 'demo_admin';
    ```
    If it returns anything, delete or reset those accounts.
- **Secrets:**
  - only the `.env.example` templates are in the repository;
  - `.env` files, `backups/`, `imports/` and logs are git-ignored and kept out of Docker images;
  - the API's startup log names integrations, never values.
- **Rate limits** protect logins, sign-ups, password resets, email codes, the chat and the webhooks. Keep
  them at their defaults outside a test session (section 11).

## 14. Open items

Decisions and checks still to do. Tick them off here as they're done.

- [ ] **Lalamove webhook signature**: add the check once Lalamove documents it (section 10).
- [ ] **PayMongo webhook age limit**: `PAYMONGO_WEBHOOK_TOLERANCE_SECONDS` stays off until the retry check
  in section 10 shows retries carry a new timestamp.
- [ ] **PayMongo "paid session" check** with test keys (section 10).
- [ ] **First Docker build**: the Docker files were checked by tests here, but no image was built on the
  development machine (it has no Docker). On the first `docker compose up --build`, confirm the API and the
  worker start, and that the per-service database settings (`API_DB_USER`, `ML_DB_USER`, blank by default)
  fall back to root.
