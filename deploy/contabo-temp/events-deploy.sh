#!/usr/bin/env bash
# Deploys the TEMPORARY events deployment on the shared Contabo VPS. One word: api | web.
#
# Installed as /usr/local/bin/events-deploy, owned by root and not writable by anyone else (README "Automatic
# deploys"). GitHub Actions reaches it through an SSH key that can run nothing but this script. Editing this
# file in the repo changes nothing on the server until it is installed again.
#
#   api  write secrets GitHub sent (below) into api.env, pull events-api, back up the database, build api, run
#        migrations, restart api (+ nginx config); rebuilds web too when deploy/contabo-temp/ changed
#   web  pull events-web, build web, restart web
#
# Secrets from GitHub: on `api`, lines of NAME=value on standard input (the SSH connection, never the command
# line) replace that one line in ~/events/api.env. Only the names in ALLOWED_SECRETS are accepted; an empty value
# changes nothing; values are never logged. A run from a terminal (sudo events-deploy api) skips this step.
set -euo pipefail

readonly OWNER=joedee
readonly BASE=/home/joedee/events
readonly API_REPO="$BASE/events-api"
readonly WEB_REPO="$BASE/events-web"
readonly DEPLOY_DIR="$API_REPO/deploy/contabo-temp"
readonly API_ENV="$BASE/api.env"
readonly BACKUP_DIR="$BASE/backups"
readonly KEEP_BACKUPS=20
readonly LOCK_FILE=/run/lock/events-deploy.lock
readonly ALLOWED_SECRETS=(PLATFORM_SMS_AFROMESSAGE_TOKEN)

log() { printf '[events-deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

target="${1:-}"
case "$target" in
  api | web) ;;
  *) echo "usage: events-deploy api|web" >&2; exit 64 ;;
esac
[[ $EUID -eq 0 ]] || fail "run with sudo"

# One deploy at a time: when both repos merge together, the second waits (up to 30 minutes).
exec 9>"$LOCK_FILE"
log "waiting for any running deploy to finish"
flock -w 1800 9 || fail "another deploy is still running"

as_owner() { sudo -u "$OWNER" -H "$@"; }
compose() { docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/docker-compose.yml" "$@"; }

pull() {
  local repo=$1
  as_owner git -C "$repo" pull --ff-only
  log "now at $(as_owner git -C "$repo" log --oneline -1)"
}

wait_for() {
  local url=$1
  for _ in $(seq 1 45); do
    if curl -fsS -o /dev/null "$url"; then return 0; fi
    sleep 2
  done
  fail "not answering after 90 seconds: $url (see: sudo docker compose logs --tail=100)"
}

is_allowed_secret() {
  local name=$1 allowed
  for allowed in "${ALLOWED_SECRETS[@]}"; do
    [[ $name == "$allowed" ]] && return 0
  done
  return 1
}

# Replaces one NAME=value line in api.env (other lines untouched), atomically, readable by joedee only.
set_api_env_value() {
  local name=$1 value=$2 tmp
  tmp=$(mktemp "$BASE/.api.env.XXXXXX")
  {
    grep -v "^${name}=" "$API_ENV" 2>/dev/null || true
    printf '%s=%s\n' "$name" "$value"
  } >"$tmp"
  chown "$OWNER:$OWNER" "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$API_ENV"
}

apply_secrets_from_stdin() {
  if [[ -t 0 ]]; then
    log "run from a terminal: api.env unchanged"
    return 0
  fi
  local line name value
  while true; do
    line=""
    # 5 seconds per line, so an open but silent input can't hold the deploy.
    if ! IFS= read -r -t 5 line; then
      [[ -n $line ]] || break
    fi
    [[ $line == *=* ]] || continue
    name=${line%%=*}
    value=${line#*=}
    if ! is_allowed_secret "$name"; then
      log "ignoring an input line that isn't an allowed secret"
      continue
    fi
    if [[ -z $value ]]; then
      log "$name was empty: api.env unchanged"
      continue
    fi
    [[ $value =~ ^[A-Za-z0-9._~+/=-]{1,4096}$ ]] || fail "$name has unexpected characters; api.env unchanged"
    set_api_env_value "$name" "$value"
    log "updated $name in api.env"
  done
}

backup_database() {
  install -d -m 700 -o "$OWNER" -g "$OWNER" "$BACKUP_DIR"
  local file
  file="$BACKUP_DIR/events-$(date -u +%Y%m%d-%H%M%S)-before-deploy.dump"
  if ! compose exec -T db pg_dump -U events -d events -Fc >"$file"; then
    rm -f "$file"
    fail "database backup"
  fi
  chown "$OWNER:$OWNER" "$file"
  chmod 600 "$file"
  log "backup: $file ($(du -h "$file" | cut -f1))"
  # Keep the newest backups only.
  ls -1t "$BACKUP_DIR"/events-*-before-deploy.dump 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f --
}

deploy_web() {
  log "building web"
  compose build web
  compose up -d web
  wait_for http://127.0.0.1:8080/
  log "web is up"
}

deploy_api() {
  local before after
  apply_secrets_from_stdin
  before=$(as_owner git -C "$API_REPO" rev-parse HEAD)
  pull "$API_REPO"
  after=$(as_owner git -C "$API_REPO" rev-parse HEAD)

  backup_database

  log "building api"
  compose build api
  log "running migrations"
  compose run --rm api node dist/scripts/migrate.js up
  compose up -d
  # nginx.conf is mounted from the repo; reload picks up a changed file without dropping connections.
  compose exec -T nginx nginx -s reload
  wait_for http://127.0.0.1:8080/api/health/ready
  log "api is up"

  if ! as_owner git -C "$API_REPO" diff --quiet "$before" "$after" -- deploy/contabo-temp/docker-compose.yml; then
    log "docker-compose.yml changed: rebuilding web as well"
    deploy_web
  fi
  if ! as_owner git -C "$API_REPO" diff --quiet "$before" "$after" -- deploy/contabo-temp/events-deploy.sh; then
    log "NOTE: events-deploy.sh changed in the repo; install it again (README \"Automatic deploys\")"
  fi
}

case "$target" in
  api) deploy_api ;;
  web)
    pull "$WEB_REPO"
    deploy_web
    ;;
esac
log "done: $target"
