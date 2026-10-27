# Deployment report: https://bongalink.tech

Date: 27 October 2026. The shop runs on a Hostinger VPS (179.197.250.37). The domain uses Hostinger's DNS
with no proxy in front: A `@` → 179.197.250.37, CNAME `www` → bongalink.tech. The code is commit `bab835e`.
No secret value appears in this report or was printed during the work.

## Summary

| | |
|---|---|
| Address | **https://bongalink.tech** (`http://` and `www` redirect here) |
| Server | Ubuntu 24.04.5 LTS, 2 CPUs, 7.8 GB RAM + 2 GB swap, 96 GB disk (10% used) |
| Runs | Docker: MySQL 8.4, the Node API, the Python ML worker. nginx on the host serves the pages and passes `/api` and `/uploads` to the API. |
| Integrations | PayMongo **LIVE**, Lalamove **PRODUCTION**, Gmail SMTP, Gemini, encryption, ML: all enabled. The start-up log has **no `WARNING:` lines**. |
| Database | `bongalink_real`: 31 tables, 96 products (69 active), 169 orders, migrations 003–013 all applied |
| HTTPS | Let's Encrypt certificate for `bongalink.tech` and `www.bongalink.tech`, valid until 2027-01-25, renewed automatically. Only TLS 1.2 and 1.3. |
| Backups | Daily at 03:30 Manila time: database, photos, ML models, kept 14 days. A test restore passed. |
| Login | `ssh bongalink@179.197.250.37` (your key; sudo). Root and password logins are off. |

## What was done, step by step

### 1. Secure the server
- **Updates:** all packages updated; automatic security updates are on.
- **Admin user `bongalink`:** logs in with your SSH key, with password-free sudo (`/etc/sudoers.d/90-bongalink`).
- **SSH (`/etc/ssh/sshd_config.d/00-bongalink-hardening.conf`):** root login and password login are turned off.
  - Before this was switched on, `bongalink`'s login and sudo were tested from a second session.
  - Afterwards: `bongalink` logs in; root and passwords are refused.
- **Firewall (ufw):** incoming traffic only on SSH (22), 80 and 443.
- **fail2ban:** bans an address for 1 hour after 5 failed SSH logins in 10 minutes (`/etc/fail2ban/jail.d/sshd.local`).
- **Swap:** a 2 GB swap file, so MySQL isn't killed if the ML worker's training needs memory.

### 2. Docker
Docker Engine 29.9.2 and Compose 5.6.1, from Docker's official repository. Docker starts at boot.

### 3. Code
`git clone` into `/opt/bongalink` (owner `bongalink`), at `bab835e`. The working tree is clean.

### 4. Settings
- **How the file was made:** `deploy/make-production-env.sh` wrote `/opt/bongalink/.env` (`chmod 600`, git-ignored) from the template and a copy of the local `Backend/.env`. The copy was shredded afterwards.
- **Generated new on the server:**
  - the MySQL root password, and the passwords of `bongalink_app` and `bongalink_ml`;
  - `JWT_SECRET` and `VERIFICATION_SECRET`.
- **Copied from the local `.env`:**
  - the encryption keys, PayMongo, Lalamove, SMTP, Gemini and `STORE_*`.
- **Fixed production values:**
  - `NODE_ENV=production`, `TRUST_PROXY=1`, `DB_NAME=bongalink_real`;
  - `APP_URL` and `CORS_ORIGIN` = `https://bongalink.tech`;
  - every rate limit at its default.
- **Webhook secret:** you added the PayMongo `whsk_` secret afterwards, then restarted the API.

### 5. Database
- **Load:**
  - A fresh dump of the local `bongalink_real` was loaded into the server's MySQL.
  - A root-only copy of that dump stays in `/var/backups/bongalink/`. The local copy is `backups/bongalink_real_20261027_for-server.sql` (git-ignored).
- **Users:** `bongalink_app` and `bongalink_ml` were created with `deploy/mysql/create_app_users.sql` (`@app_host = '%'`). The API connects as `bongalink_app@%`, not root.
- **`check_migrations.sql`:** 003–013 applied; the triggers' account (`root@localhost`) exists.
- **Files copied:**
  - 31 product photos, into the `uploads` volume;
  - the 6 ML model versions, into the `ml-models` volume. Without them the worker fell back to the older Colab model.

### 6. Start the app
`docker compose up -d` starts `mysql`, `api` and `worker`. Each restarts on its own after a crash or reboot.
- MySQL is published on `127.0.0.1:3307` only, and the API on `127.0.0.1:4000` only.
- The optional `frontend` container is **not** used. Its port 5500 would be published on every address, and Docker's published ports bypass ufw.

### 7. HTTPS
- nginx (`/etc/nginx/sites-available/bongalink`) is made from `deploy/nginx/production.conf.example`, with three changes:
  - **`www` and `http://` redirect to `https://bongalink.tech`.** The shop has one address, the one in `APP_URL` and `CORS_ORIGIN`.
  - **Certificate renewal uses a webroot** (`/var/www/letsencrypt`), served before the http→https redirect. Renewals don't depend on certbot editing nginx.
  - **HTTP/2 is turned on in the `listen` line.** Ubuntu's nginx 1.24 doesn't know the newer `http2 on;`.
- **Certificate:** certbot (webroot). Its renewal timer is on, and a test renewal (`certbot renew --dry-run`) succeeded. A hook reloads nginx after each renewal.
- **Webhooks, set by you:**
  - **PayMongo:** a Live webhook at `https://bongalink.tech/api/v1/webhooks/paymongo` (enabled), and the ngrok one disabled.
  - **Lalamove:** its webhook is at `https://bongalink.tech/api/v1/webhooks/lalamove`.

### 8. Checks

**From outside (from the development PC):**

| Check | Result |
|---|---|
| `http://bongalink.tech/…`, `http://www…`, `https://www…` | 301 to `https://bongalink.tech/…` ✅ |
| `https://bongalink.tech/` | 302 to the homepage; homepage 200 ✅ |
| `/api/health` | 200 `{"status":"ok"}` ✅ |
| A product photo (`/uploads/…jpg`) | 200 `image/jpeg` ✅ |
| `/.env`, `/.git/config`, `/../.env`, `/Pages/`, `/JS/`, `/README.md`, `/docs/frontend-notes.md`, `/backups/x.sql`, `/package.json`, `/CSS/admin.css.map` | all 404 ✅ |
| Page headers | HSTS, Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` ✅ |
| API headers | helmet's own headers, HSTS, no `X-Powered-By` ✅ |
| TLS | 1.2 and 1.3 accepted; 1.0 and 1.1 refused by the server ("protocol version") ✅. HTTP/2 negotiated ✅ |
| Certificate | Let's Encrypt, `bongalink.tech` + `www.bongalink.tech`, until 2027-01-25 ✅ |
| PayMongo webhook with a fake signature | 401 (refused) ✅ |
| Lalamove webhook with a wrong key | 401 (refused); its portal's test ping gets 200 ✅ |
| CORS | `Origin: https://bongalink.tech` allowed; any other origin gets no `Access-Control-Allow-Origin` ✅ |
| An admin API without logging in | 401 ✅ |
| Open ports | 22, 80, 443 only. 3306, 3307, 4000 and 5500 are closed ✅ |
| SSH as root | refused ✅ |

**On the server:**

| Check | Result |
|---|---|
| Start-up log | 0 `WARNING:` lines. PayMongo LIVE, Lalamove PRODUCTION, Email, Gemini, Encryption and ML enabled ✅ |
| PayMongo webhooks (read with the live key) | `https://bongalink.tech/api/v1/webhooks/paymongo` enabled, live, its secret matches the server `.env` ✅. The ngrok one is disabled ✅ |
| MySQL, as the API's user | `bongalink_app@%` on `bongalink_real`, 69 active products ✅ |
| Lalamove, production quotation (no order) | PHP 92.00, store pin to Ayala Ave, Makati, 8.5 km ✅ |
| Gmail SMTP | login accepted (verify only, no email sent) ✅ |
| Map pin lookup | store pin is in NCR / Taguig ✅ |
| PayMongo live key | accepted (read-only call) ✅ |
| Gemini, through the chatbot | answered ✅, by the backup model `gemini-3.5-flash-lite`, in 16 s: the main model `gemini-3.8-flash` was busy again. The test chat row was removed. |
| Starts at boot | docker, nginx, fail2ban, certbot.timer, unattended-upgrades, bongalink-backup.timer ✅ |
| Container restart policy | mysql, api and worker: `unless-stopped` ✅ (MySQL's was fixed during this check, below) |
| Pending security updates | 0 ✅ |

**Problems found and fixed during the checks:**
1. **MySQL would not have come back after a reboot.**
   - The cause: `docker-compose.yml` gives `api` and `worker` `restart: unless-stopped`, but `mysql` gets no `restart` line.
   - The fix: `/opt/bongalink/docker-compose.override.yml` (server-only, git-ignored) adds it. MySQL was then recreated, with its data kept in the volume.
2. **The optional `frontend` container was started by mistake.** A plain `docker compose up -d`, run while applying fix 1, started it.
   - It published port 5500 to the internet for about a minute. It served the same public pages as the site; the API, the database and `.env` were never reachable through it.
   - It was removed. The same override now puts it in a profile (`docker-frontend`), so a plain `docker compose up -d` starts only `mysql`, `api` and `worker`.
   - Port 5500 was checked closed from outside.

**Problems during the setup itself:**
1. **The first database-load script stopped after its first command.** `docker compose exec` read the rest of the script as its own input. Its only effect was creating the empty database. The script was re-run from a file, with a guard against loading over existing tables.
2. **The ML worker started without its model files.** They're git-ignored, so the new volume was empty. The 6 versions were copied in, and the worker now uses the active model `v20261026-160829-168` with no error.

### 9. Backups and a test restore
- **Script:** `/usr/local/sbin/bongalink-backup`, run by `bongalink-backup.timer` daily at **03:30 Manila time** (an hour after the nightly retraining). It catches up after downtime.
- **Writes to** `/var/backups/bongalink/` (root only, `chmod 600`), kept **14 days**:
  - `bongalink_real_<stamp>.sql.gz`: the database dump. It is kept only if it ends with mysqldump's "Dump completed" line.
  - `uploads_<stamp>.tgz`: the product photos.
  - `models_<stamp>.tgz`: the ML model versions.
- **Not backed up there:** `.env` and the encryption keys. They belong in a password manager, separately from the dumps.
- **First run (20261027-1017):** database 48 KB, photos 2.1 MB, models 4 KB.
- **Test restore**, of the newest dump into a scratch database `bongalink_restore_test` on the server:
  - Row counts: all 31 tables, 1,145 rows, **0 differences** from the live database.
  - `check_migrations.sql` on the copy: all applied, and the triggers' account exists. All 7 triggers restored.
  - **5 of 5 customer emails decrypted correctly** with the server's keys (the values weren't shown). This proves the keys and the dumps belong together.
  - The photo archive (32 files, the same as the volume) and the model archive (6 versions) are complete and readable.
  - The scratch database was dropped afterwards.

**Backup verification** (a second restore of the same backup set, `20261027-1017`):
- **The dump is complete:** it ends with "Dump completed on 2026-10-27 10:17:58".
- **Live vs restored:**

  | | Live | Restored |
  |---|---|---|
  | products | 96 | 96 |
  | orders | 169 | 169 |
  | users | 9 | 9 |
  | triggers | 7 | 7 (same names) |

- **Decryption check** (customer #3, from the restored copy):
  - the email is stored encrypted;
  - with the server's keys it decrypts to a valid email address;
  - that address is the same as in the live database.
- **Photos:** the archive holds 31 images, plus `.gitkeep`, the same as the volume. The database refers to 31 distinct photo files (products' main photos and gallery photos), and none is missing from the archive.
- **Models:** the archive is 2,044 bytes compressed and 7,421 bytes unpacked. The six versions are near-identical JSON files of about 1.2 KB each, so they compress well:
  - `stock_lr_v20261023-170737-374.json`
  - `stock_lr_v20261023-211749-938.json`
  - `stock_lr_v20261024-020002-562.json`
  - `stock_lr_v20261025-212250-348.json`
  - `stock_lr_v20261026-160829-168.json` (active)
  - `stock_lr_v20261027-052043-475.json`

  Their checksums are identical to the live `ml-models` volume, and each file is valid JSON.

## Files on the server that are not in the repository

| File | What |
|---|---|
| `/opt/bongalink/.env` | the production settings (`chmod 600`) |
| `/opt/bongalink/docker-compose.override.yml` | MySQL restart policy; `frontend` only by profile |
| `/etc/nginx/sites-available/bongalink` | the shop's nginx (from `deploy/nginx/production.conf.example`, changes above) |
| `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` | reloads nginx after a certificate renewal |
| `/usr/local/sbin/bongalink-backup`, `/etc/systemd/system/bongalink-backup.{service,timer}` | the daily backup |
| `/etc/ssh/sshd_config.d/00-bongalink-hardening.conf`, `/etc/fail2ban/jail.d/sshd.local`, `/etc/sudoers.d/90-bongalink` | SSH and access |

## Day-to-day commands (as `bongalink`, in `/opt/bongalink`)

```bash
sudo docker compose ps                                    # what runs
sudo docker compose logs --tail 50 api                    # API log (worker: ... worker)
sudo docker compose restart api                           # after changing .env
git pull && sudo docker compose up -d --build             # deploy a new version from GitHub (main)
sudo systemctl start bongalink-backup                     # a backup now, e.g. before a migration
sudo ls -l /var/backups/bongalink                         # the backups
```

**Restore** (DEPLOYMENT.md, section 12). Restore under a new name first, check it, then switch:
```bash
sudo docker compose stop api worker
export MYSQL_PWD="$(sudo grep -m1 '^DB_PASSWORD=' .env | cut -d= -f2-)"
sudo -E docker compose exec -T -e MYSQL_PWD mysql mysql -uroot \
  -e "CREATE DATABASE bongalink_restored CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
sudo zcat /var/backups/bongalink/bongalink_real_<stamp>.sql.gz \
  | sudo -E docker compose exec -T -e MYSQL_PWD mysql mysql -uroot --default-character-set=utf8mb4 bongalink_restored
sudo -E docker compose exec -T -e MYSQL_PWD mysql mysql -uroot bongalink_restored < deploy/mysql/check_migrations.sql
# then DB_NAME=bongalink_restored in .env (and re-run create_app_users.sql with @db = 'bongalink_restored'),
# or rename it back; then: sudo docker compose up -d api worker
```

## Still to do

**Before customers use the shop:**
- [ ] **Live payment test.** One real purchase of the hidden test product with GCash, then refund it and remove the test order (`Backend/README.md`, section 8). This is the only way to prove the PayMongo webhook end to end, so the order must turn "Paid" on its own.
- [ ] **Real shipping rates.** All 30 J&T/LBC rates are still placeholders, and the largest bracket is 5 kg (Admin › Rates).
- [ ] **Real product weights.** Every product is on the 0.5 kg default.
- [ ] **The privacy page's DPO contact** (`Frontend/Pages/Homepage/privacy.html`).
- [ ] **Password manager:** save `/opt/bongalink/.env`, or at least the encryption keys and the database passwords, separately from the backups.

**Soon:**
- [ ] **An off-server copy of the backups,** for example weekly to your PC or cloud storage. Right now they live only on the VPS. To copy them over SSH, give `bongalink` read access to `/var/backups/bongalink`, or copy them with `sudo` into its home folder first.
- [ ] **A reboot test:** `sudo reboot`, then check that the site and the start-up log come back on their own. Everything is enabled and has a restart policy, but a reboot proves it. It takes about one minute of downtime.
- [ ] **Gemini's main model** (`gemini-3.8-flash`) was busy at every check today, so each chat answer waits about 15 s for the backup model. If that continues, set `GEMINI_MODEL=gemini-3.5-flash-lite` in `/opt/bongalink/.env`, then `sudo docker compose up -d api`. This is a setting, not code.
- [ ] **`TRACKING_URL_JNT` / `TRACKING_URL_LBC`** are blank, so customers see the tracking number without a "Track on the courier's site" button.

**Open items from before (DEPLOYMENT.md, section 10):** the PayMongo retry check (before turning on
`PAYMONGO_WEBHOOK_TOLERANCE_SECONDS`), and the Lalamove webhook signature (blocked on Lalamove's documentation).

**Suggested repository changes** (not made; they need your OK):
- `docker-compose.yml`: give `mysql` `restart: unless-stopped`, and put `frontend` behind a profile, as the server's override does.
- `deploy/nginx/production.conf.example`: the `www` redirect, the webroot renewal location, and a note on HTTP/2 for nginx older than 1.25.
