# API settings check and the production .env

Date: 27 October 2026. Checked on the development machine against `Backend/.env`, which holds the LIVE
PayMongo key and the PRODUCTION Lalamove keys. No secret value appears in this report, in the
commands' output, or in the repository.

Rules followed:
- No real charge and no real rider: only a quotation, read-only calls and a login check.
- `Backend/.env` was backed up before it was changed, to `Backend/.env.backup-2026-10-27`. Both files are git-ignored.
- No application code was changed.

## 1. What was wrong in `Backend/.env`, and what was fixed

The file was checked line by line by a script that prints names and results, never values.

| Check | Result |
|---|---|
| Line endings | Every line ends the same way (Windows CRLF), no BOM. The app and Docker read this correctly. |
| Spaces around `=`, trailing spaces, `export`, lower-case names | None. The space after `GEMINI_API_KEY=` you mentioned is no longer there. |
| Hidden characters (non-breaking spaces, zero-width characters) | None. |
| Duplicate lines | None. |
| Misspelled or unknown names | None: every name in the file is in `Backend/.env.example`. |
| PayMongo public key (`pk_live_`) | Not present anywhere, so nothing to remove. |
| **Values with spaces and no quotes** | `SMTP_PASS` and `STORE_ADDRESS`. **Fixed:** both are now in double quotes. Node read them correctly already, but other readers (Docker, shell scripts) can cut them at the first space. The values themselves did not change: the file was parsed before and after and every value is identical. |

**Names in `.env.example` that are not in your `.env`.** These are all optional; a missing one means the default is used:
- `HOST`, `TRUST_PROXY`, `UPLOAD_DIR`;
- `DATA_ENCRYPTION_KEY_V1`, `PAYMONGO_WEBHOOK_TOLERANCE_SECONDS`;
- the eight `RATE_LIMIT_*`;
- `LALAMOVE_SERVICE_AREAS` (default NCR, Bulacan, Cavite, Laguna, Rizal);
- `GEOCODER_CONTACT` (defaults to `ADMIN_ALERT_EMAIL`), `NOMINATIM_URL`;
- `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`;
- `STORE_EMAIL`.

`STORE_EMAIL` is worth setting: the chat gives it to customers when it can't help.

**Value formats:**

| Setting | Result |
|---|---|
| `PAYMONGO_SECRET_KEY` | set ✓, starts with `sk_live_` |
| `PAYMONGO_WEBHOOK_SECRET` | set ✓, starts with `whsk_` |
| `LALAMOVE_ENV` | `production` ✓ |
| `LALAMOVE_API_KEY` / `LALAMOVE_API_SECRET` | set ✓, production format (`pk_prod_` / `sk_prod_`) |
| `STORE_LAT` / `STORE_LNG` | valid numbers inside Metro Manila ✓ (the map lookup places the pin in Taguig, below) |
| `STORE_PHONE` | a valid Philippine number ✓ |
| `JWT_SECRET` | set ✓, 32+ characters |
| `DATA_ENCRYPTION_KEY` / `DATA_INDEX_KEY` | set ✓, each 32 bytes of base64; the two are different |
| `VERIFICATION_SECRET` | set ✓, 32+ characters |
| `SMTP_PASS` | set ✓, a 16-letter Gmail App Password, written with its spaces. That works; quoting it was the fix. |
| `SMTP_USER`, `MAIL_FROM`, `ADMIN_ALERT_EMAIL` | set ✓ |
| `DB_NAME` | `bongalink_real` ✓ |
| `RATE_LIMIT_*` | all blank ✓ |
| `GEMINI_API_KEY` | set ✓, a Google AI Studio key (the newer `AQ.` format) |

## 2. Live API checks

Each check made one safe call through the app's own code (`Backend/services/…`).

| API | Result | Details |
|---|---|---|
| **PayMongo** (live key, `GET /v1/webhooks`, read-only) | ✅ works | The live key is accepted. One Live-mode webhook exists: **enabled**, event `checkout_session.payment.paid`, URL **`https://impromptu-wifi-country.ngrok-free.dev/api/v1/webhooks/paymongo`** (your ngrok development tunnel). `PAYMONGO_WEBHOOK_SECRET` is set ✓ and matches that webhook. |
| **Lalamove** (production, quotation only, no order) | ✅ works | From the store pin to Ayala Avenue, Makati: **PHP 92.00, route 8.5 km**, motorcycle. A quotation books nothing and expires after about 5 minutes. |
| **Gemini** (one test message through `services/chatbot.js`) | ✅ answered (by the backup model) | The main model, `gemini-3.8-flash`, was busy: two 503s ("overloaded") and three timeouts in five tries. The backup model, `gemini-3.5-flash-lite`, answered every time (in 0.7 to 4 s). Customers still get answers, but they wait up to 15 s longer while the main model is busy. The test chat rows were deleted afterwards, so they don't count in the chat statistics. |
| **Gmail SMTP** (nodemailer `verify()`) | ✅ works | Gmail accepted the login (smtp.gmail.com:465). No email was sent. |
| **Map pin lookup** (Nominatim, reverse lookup of the store pin) | ✅ works | Region **NCR**, city **Taguig**, barangay Pinagsama (Masayahin Street, Enlisted Personnel Village Phase 1). The request carries a contact email, as Nominatim's rules ask. |
| **MySQL** (`deploy/mysql/check_migrations.sql`) | ✅ works | Connected to `bongalink_real`. Migrations 003 to 013 all **applied**. The 7 triggers' account (`root@localhost`) exists. |

**Start-up log** (the API started once, on a spare port, and was stopped after 12 seconds):

```
Integrations (from .env; restart after changing it):
  Lalamove:   enabled (PRODUCTION; areas NCR, Bulacan, Cavite, Laguna, Rizal)
  PayMongo:   enabled (LIVE mode; methods gcash,qrph,dob,dob_ubp)
  Email:      enabled (smtp.gmail.com:465; shop alerts on)
  Gemini:     enabled (model gemini-3.8-flash, fallback gemini-3.5-flash-lite)
  Encryption: enabled (AES-256-GCM, key v1)
  ML:         worker not running (last seen 2026-10-27 12:59; …). Start it: cd ml/worker, …
Bongalink API running on http://127.0.0.1:4100
```

In development mode the log has no `WARNING:` lines. "ML: worker not running" is information only: the
ML worker wasn't started on this machine.

The API was then started once more with `NODE_ENV=production`, to see what the server would say with
these settings. That run added four warnings. All four disappear with the production `.env` (section 3):

| WARNING | Why | On the server |
|---|---|---|
| `APP_URL has an address that isn't https://` | Locally it's a `http://localhost` address. | The template sets `https://<domain>`. |
| `CORS_ORIGIN has an address that isn't https://` | Same reason. | The template sets `https://<domain>`. |
| `DB_USER is root` | Locally the API uses MySQL's root account. | The API uses `bongalink_app` (`API_DB_USER`). |
| `TRUST_PROXY is blank` | Locally nothing sits in front of the API. | The template sets `TRUST_PROXY=1` (nginx). |

## 3. How the server's `.env` will be made

Two new files in `deploy/`:
- **`production.env.template`** (committed, no real values). It lists every variable the Docker root `.env` needs, in three groups:
  - **Fixed production values:**
    - `NODE_ENV=production`, `DB_NAME=bongalink_real`, `TRUST_PROXY=1`;
    - `APP_URL`, `CORS_ORIGIN` and `API_ORIGIN` = `https://<DOMAIN>`;
    - `API_DB_USER=bongalink_app`, `ML_DB_USER=bongalink_ml`;
    - every `RATE_LIMIT_*` and ML tuning value blank.
  - **Generated new on the server**, with the command for each in the template:
    - `DB_PASSWORD`, `API_DB_PASSWORD`, `ML_DB_PASSWORD`: `openssl rand -hex 24`;
    - `JWT_SECRET`: `openssl rand -base64 48`;
    - `VERIFICATION_SECRET`: `openssl rand -hex 32`.
  - **Copied from your local `Backend/.env`:**
    - the encryption keys;
    - PayMongo's live key and payment methods;
    - Lalamove;
    - SMTP and email addresses;
    - Gemini;
    - map lookup;
    - `STORE_*`;
    - tracking links.
  - **Left blank on purpose: `PAYMONGO_WEBHOOK_SECRET`.** A webhook secret belongs to one webhook URL, and your current one is for the ngrok address. The template explains how to create the new one.
- **`make-production-env.sh`**, run on the server:
  ```bash
  scp Backend/.env root@<server>:/root/local.env          # from your computer
  cd /opt/bongalink && bash deploy/make-production-env.sh /root/local.env
  shred -u /root/local.env                                 # delete the copy
  ```
  What it does:
  - Asks for the domain, and writes `/opt/bongalink/.env` with `chmod 600`.
  - Prints each setting's name and what happened to it (copied, generated, fixed, blank), never a value.
  - Checks the encryption keys (32 bytes), the live PayMongo key, the production Lalamove settings, and that the SMTP, Gemini and store settings are filled in.
  - Reads your `.env` as text and never runs it, so a value can't execute anything.
  - Writes values with spaces, `<`, `#` or `$` in single quotes, so Docker reads them literally.
  - **Run again,** it backs up the old file, and keeps the generated passwords and the webhook secret already in it. This matters because the MySQL data volume keeps the first root password for good.

  Test on this machine: the script was run on your real `.env`, writing to a temporary folder. All 32 copied values were identical to `Backend/.env`, and the generated values had the right length and format. The temporary file was then deleted.

## 4. What you still need to do

On the server, in this order:
1. **Copy `Backend/.env` to the server, run the script, and delete the copy** (the commands in section 3).
2. **Database users:**
   - Put `API_DB_PASSWORD` and `ML_DB_PASSWORD` from `/opt/bongalink/.env` into `deploy/mysql/create_app_users.sql`, with `@app_host = '%'` for Docker.
   - Run it (DEPLOYMENT.md, section 5).
3. **Start:** `docker compose up -d --build`, then load the `bongalink_real` backup and copy the photos (DEPLOYMENT.md, section 6).
4. **HTTPS:** the domain uses Hostinger's DNS with no proxy in front (A `@` and CNAME `www` to the server), so nginx sees each visitor's own address and `TRUST_PROXY=1` is right. certbot on the server issues and renews the certificate (DEPLOYMENT.md, section 8).
5. **New PayMongo webhook, once `https://<domain>` works:**
   - Create it: PayMongo Dashboard, **Live mode** > Developers > Webhooks > Create, URL `https://<domain>/api/v1/webhooks/paymongo`, event `checkout_session.payment.paid`.
   - Put its `whsk_…` in `PAYMONGO_WEBHOOK_SECRET` in `/opt/bongalink/.env`, then `docker compose up -d api`.
   - **Disable the ngrok webhook**: while it is enabled, PayMongo keeps sending live payment events to your development tunnel.

   Until the new webhook is in place, paid orders are not marked paid.
6. **Lalamove:** in the Partner Portal > Developers, change the webhook to `https://<domain>/api/v1/webhooks/lalamove`.
7. **Check the start-up log:** `docker compose logs api | head -20` must show no `WARNING:` lines.

Not blocking, but recommended:
- **`STORE_EMAIL`**: add it to your local `.env` before copying it; the chat's fallback answer uses it.
- **`TRACKING_URL_JNT` / `TRACKING_URL_LBC`**: blank, so customers see the J&T/LBC tracking number without a "Track on the courier's site" button.
- **Gemini main model:** `gemini-3.8-flash` was busy throughout today's checks. If that continues, set `GEMINI_MODEL=gemini-3.5-flash-lite` so customers don't wait for the timeout. This is a setting, not a code change; for now the backup model covers it.
- **Earlier open items**, from the delivery tracking report:
  - the real J&T/LBC rates, with 10 and 20 kg brackets;
  - the product weights;
  - the privacy page's DPO contact;
  - scheduled backups;
  - the live payment test.
