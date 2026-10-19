#!/usr/bin/env bash
# Update FeedHost to the latest version.
#
#   cd /opt/feedhost && sudo ./update.sh
#
# Backs up the database, downloads the new version, rebuilds the app and
# restarts it. Database changes are applied automatically when the app starts.
#
# Options:
#   --yes         don't ask for confirmation
#   --no-backup   skip the database backup
#   --force       rebuild and restart even if there's nothing new
#   --check       only show whether an update is available

set -Eeuo pipefail

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'; reset=$'\033[0m'
[ -t 1 ] || { bold=''; dim=''; red=''; green=''; reset=''; }
say()  { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
ok()   { printf '%s ✓%s %s\n' "$green" "$reset" "$*"; }
warn() { printf '%s !%s %s\n' "$red" "$reset" "$*" >&2; }
die()  { printf '%sError:%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }

YES=''; BACKUP=1; FORCE=''; CHECK=''
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    --no-backup) BACKUP='' ;;
    -f|--force) FORCE=1 ;;
    --check) CHECK=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg (try --help)" ;;
  esac
done

DIR="${FEEDHOST_DIR:-$(cd "$(dirname "${FEEDHOST_UPDATE_ORIGIN:-$0}")" && pwd)}"

# git pull may rewrite this very file while bash is reading it, so run from a copy.
if [ -z "${FEEDHOST_UPDATE_REEXEC:-}" ]; then
  tmp="$(mktemp "${TMPDIR:-/tmp}/feedhost-update.XXXXXX")"
  cp "$0" "$tmp"
  FEEDHOST_UPDATE_REEXEC="$tmp" FEEDHOST_DIR="$DIR" exec bash "$tmp" "$@"
fi
trap 'rm -f "$FEEDHOST_UPDATE_REEXEC"' EXIT

cd "$DIR"
[ -f docker-compose.yml ] && [ -d .git ] || die "$DIR doesn't look like a FeedHost install (no docker-compose.yml or .git)."
[ -f .env ] || die "No .env in $DIR. Run install.sh first."
if [ "$(id -u)" -ne 0 ] && ! docker info >/dev/null 2>&1; then
  die "Can't reach Docker. Run with sudo:  sudo ./update.sh"
fi

env_get() { sed -n "s/^$1=//p" .env | tail -n1; }
env_set() { # env_set KEY VALUE (replace or append, keeping file permissions)
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
PORT="$(env_get FEEDHOST_PORT)"; PORT="${PORT:-8080}"

healthy() { curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; }
wait_healthy() {
  for _ in $(seq 1 90); do healthy && return 0; sleep 2; done
  return 1
}

# ───────────── what's new ─────────────

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != HEAD ] || die "The download isn't on a branch (detached HEAD). Run: git checkout main"
say "Checking for updates on $BRANCH…"
git fetch -q origin "$BRANCH"
OLD="$(git rev-parse --short HEAD)"
NEW="$(git rev-parse --short "origin/$BRANCH")"
COUNT="$(git rev-list --count "HEAD..origin/$BRANCH")"

if [ "$COUNT" -eq 0 ]; then
  ok "Already up to date (version $OLD)"
  [ -n "$CHECK" ] && exit 0
  [ -n "$FORCE" ] || { printf '%sUse --force to rebuild and restart anyway.%s\n' "$dim" "$reset"; exit 0; }
else
  printf '\n%s%s new change(s)%s, %s → %s:\n' "$bold" "$COUNT" "$reset" "$OLD" "$NEW"
  git --no-pager log --no-merges --format='  • %s' "HEAD..origin/$BRANCH" | head -n 30
  echo
  [ -n "$CHECK" ] && exit 0
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no
  die "Files that came with FeedHost were edited (listed above). Undo them with 'git checkout -- <file>' (or 'git stash'), then run the update again. Your settings in .env are not affected."
fi

if [ -z "$YES" ] && { : < /dev/tty; } 2>/dev/null; then
  read -r -p "Update now? The app is briefly unavailable while it restarts. [Y/n] " reply < /dev/tty || true
  case "${reply:-y}" in [Yy]*) ;; *) echo "Cancelled."; exit 0 ;; esac
fi

# ───────────── backup ─────────────

BACKUP_FILE=''
if [ -n "$BACKUP" ]; then
  say "Backing up the database…"
  mkdir -p backups
  BACKUP_FILE="backups/db-$(date +%Y%m%d-%H%M%S)-$OLD.sql.gz"
  if docker compose exec -T db pg_dump -U feedhost -d feedhost --clean --if-exists | gzip > "$BACKUP_FILE" \
     && [ "$(gzip -dc "$BACKUP_FILE" | head -c 1 | wc -c)" -eq 1 ]; then
    chmod 600 "$BACKUP_FILE"
    ok "Saved $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
    # Keep the 10 most recent backups.
    ls -1t backups/db-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
  else
    rm -f "$BACKUP_FILE"
    die "The database backup failed, so nothing was changed. Is the database running? (docker compose ps). To update without a backup, use --no-backup."
  fi
fi

# ───────────── update ─────────────

if [ "$COUNT" -gt 0 ]; then
  say "Downloading version $NEW…"
  git merge -q --ff-only "origin/$BRANCH" || die "Couldn't apply the update (your copy has diverged from $BRANCH). Nothing was changed."
fi
chmod +x install.sh update.sh upgrade.sh 2>/dev/null || true
VERSION="$(git rev-parse --short HEAD)"
env_set FEEDHOST_VERSION "$VERSION"

say "Rebuilding the app…"
docker compose build --pull app
say "Restarting…"
docker compose up -d --remove-orphans

if wait_healthy; then
  ok "FeedHost is running version $VERSION"
  docker image prune -f >/dev/null 2>&1 || true
else
  docker compose logs --tail 40 app || true
  warn "FeedHost didn't come back after the update. The log above should say why."
  cat >&2 <<EOF

  To go back to the previous version ($OLD):
    cd $DIR
    sudo git reset --hard $OLD
    sudo sed -i 's/^FEEDHOST_VERSION=.*/FEEDHOST_VERSION=$OLD/' .env
EOF
  if [ -n "$BACKUP_FILE" ]; then cat >&2 <<EOF
    gunzip -c $BACKUP_FILE | sudo docker compose exec -T db psql -U feedhost -d feedhost
EOF
  fi
  cat >&2 <<EOF
    sudo docker compose up -d --build

EOF
  exit 1
fi
