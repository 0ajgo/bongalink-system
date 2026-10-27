#!/usr/bin/env bash
# =====================================================================
# Makes the production .env for docker compose, ON THE SERVER, from
# deploy/production.env.template and a copy of your local Backend/.env.
#
#   scp Backend/.env root@<server>:/root/local.env          (from your computer)
#   bash deploy/make-production-env.sh /root/local.env       (on the server, in /opt/bongalink)
#   shred -u /root/local.env                                 (then delete the copy)
#
# Optional second argument: the file to write (default /opt/bongalink/.env).
# It asks for the domain, generates the new secrets, copies the rest, and writes the
# file with chmod 600. It prints names and what happened to each, never a value.
# Run again later: generated values and the webhook secret already in the file are kept
# (the old file is backed up first), so the MySQL root password never changes under a volume.
# =====================================================================
set -euo pipefail
umask 077

SOURCE="${1:-}"
OUT="${2:-/opt/bongalink/.env}"
TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/production.env.template"

die() { echo "Error: $*" >&2; exit 1; }
[ -n "$SOURCE" ] || die "usage: bash deploy/make-production-env.sh <copy of local Backend/.env> [output, default /opt/bongalink/.env]"
[ -f "$SOURCE" ] || die "$SOURCE not found."
[ -f "$TEMPLATE" ] || die "$TEMPLATE not found."
[ "$(realpath "$SOURCE")" != "$(realpath -m "$OUT")" ] || die "the source and the output are the same file."

# Reads KEY=value lines the way dotenv does (first one wins, quotes removed), without running them.
declare -A LOCAL=() EXISTING=()
read_env() {
  local -n into=$1
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    key="${BASH_REMATCH[2]}"
    val="${BASH_REMATCH[3]}"
    if [[ "$val" =~ ^\"(.*)\"[[:space:]]*(#.*)?$ || "$val" =~ ^\'(.*)\'[[:space:]]*(#.*)?$ ]]; then
      val="${BASH_REMATCH[1]}"
    else
      val="${val%%#*}"
      val="${val%"${val##*[![:space:]]}"}"
    fi
    [ -n "${into[$key]+set}" ] || into[$key]="$val"
  done < "$2"
}
read_env LOCAL "$SOURCE"
[ -f "$OUT" ] && read_env EXISTING "$OUT"

read -r -p "The shop's domain (e.g. shop.example.com): " DOMAIN
DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed -E 's#^[a-z]+://##; s#/.*$##; s/[[:space:]]//g')"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "\"$DOMAIN\" isn't a domain name."

random_hex()    { head -c "$1" /dev/urandom | od -An -v -tx1 | tr -d ' \n'; }
random_base64() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }

# The value as docker compose reads it: plain when safe, otherwise in single quotes (taken literally).
quote() {
  local v="$1"
  if [[ "$v" =~ ^[A-Za-z0-9_./:@,+=-]*$ ]]; then printf '%s' "$v"
  elif [[ "$v" != *"'"* ]]; then printf "'%s'" "$v"
  elif [[ "$v" != *'$'* && "$v" != *'"'* ]]; then printf '"%s"' "$v"
  else return 1
  fi
}

TMP="$(mktemp "$(dirname "$OUT")/.env.new.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
declare -a REPORT=()
declare -A RESULT=()

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  line="${line//<DOMAIN>/$DOMAIN}"
  if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then printf '%s\n' "$line" >> "$TMP"; continue; fi
  key="${BASH_REMATCH[1]}"
  spec="${BASH_REMATCH[2]}"
  case "$spec" in
    "<COPY>")
      val="${LOCAL[$key]:-}"
      if [ -n "$val" ]; then how="copied"; else how="blank (not in your local .env: the default is used)"; fi ;;
    "<GENERATE hex "*">"|"<GENERATE base64 "*">")
      if [ -n "${EXISTING[$key]:-}" ]; then val="${EXISTING[$key]}"; how="kept from the existing file"
      else
        read -r _ kind bytes <<< "${spec//[<>]/}"
        if [ "$kind" = hex ]; then val="$(random_hex "$bytes")"; else val="$(random_base64 "$bytes")"; fi
        how="generated"
      fi ;;
    "<NEW_WEBHOOK>")
      if [ -n "${EXISTING[$key]:-}" ]; then val="${EXISTING[$key]}"; how="kept from the existing file"
      else val=""; how="BLANK: create the PayMongo webhook for https://$DOMAIN and paste its whsk_ (see the file)"; fi ;;
    *)
      val="$spec"; if [ -n "$val" ]; then how="fixed"; else how="blank (default)"; fi ;;
  esac
  quoted="$(quote "$val")" || die "$key holds both ' and \$ or \": docker compose can't read it safely. Change that value."
  printf '%s=%s\n' "$key" "$quoted" >> "$TMP"
  RESULT[$key]="$val"
  REPORT+=("$(printf '  %-36s %s' "$key" "$how")")
done < "$TEMPLATE"

# Checks on what was written (results only, never values).
declare -a PROBLEMS=()
b64_32() { [ "$(printf '%s' "$1" | base64 -d 2>/dev/null | wc -c)" -eq 32 ]; }
b64_32 "${RESULT[DATA_ENCRYPTION_KEY]}" || PROBLEMS+=("DATA_ENCRYPTION_KEY is missing or not 32 bytes of base64: the API won't start.")
b64_32 "${RESULT[DATA_INDEX_KEY]}"      || PROBLEMS+=("DATA_INDEX_KEY is missing or not 32 bytes of base64: the API won't start.")
[[ "${RESULT[PAYMONGO_SECRET_KEY]}" == sk_live_* ]] || PROBLEMS+=("PAYMONGO_SECRET_KEY isn't a live key (sk_live_).")
[ "${RESULT[LALAMOVE_ENV]}" = production ]           || PROBLEMS+=("LALAMOVE_ENV isn't production.")
for k in LALAMOVE_API_KEY LALAMOVE_API_SECRET SMTP_USER SMTP_PASS GEMINI_API_KEY STORE_LAT STORE_LNG STORE_PHONE; do
  [ -n "${RESULT[$k]}" ] || PROBLEMS+=("$k is blank.")
done

if [ -f "$OUT" ]; then
  BACKUP="$OUT.backup-$(date +%Y%m%d-%H%M%S)"
  cp -p "$OUT" "$BACKUP" && chmod 600 "$BACKUP"
  echo "The old file was backed up to $BACKUP"
fi
chmod 600 "$TMP"
mv "$TMP" "$OUT"
trap - EXIT

echo
echo "Wrote $OUT (chmod 600) for https://$DOMAIN:"
printf '%s\n' "${REPORT[@]}"
echo
if [ ${#PROBLEMS[@]} -gt 0 ]; then
  echo "Check these:"
  printf '  ! %s\n' "${PROBLEMS[@]}"
  echo
fi
cat <<EOF
Next:
  1. Delete the copied file:  shred -u $SOURCE
  2. Database users: put API_DB_PASSWORD and ML_DB_PASSWORD from $OUT into
     deploy/mysql/create_app_users.sql (@app_host = '%') and run it (DEPLOYMENT.md, section 5).
  3. docker compose up -d --build
  4. Once https://$DOMAIN works: create the PayMongo Live webhook
     https://$DOMAIN/api/v1/webhooks/paymongo, put its whsk_ in PAYMONGO_WEBHOOK_SECRET,
     run: docker compose up -d api, and disable the old development webhook.
  5. Lalamove Partner Portal > Developers: webhook https://$DOMAIN/api/v1/webhooks/lalamove
  6. docker compose logs api | head -20: no WARNING lines.
EOF
