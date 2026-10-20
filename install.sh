#!/usr/bin/env bash
# FeedHost installer for Ubuntu (22.04, 24.04, 26.04) and Debian.
#
#   curl -fsSL https://raw.githubusercontent.com/rgblack316/podcast-feed-import-and-host/main/install.sh | sudo bash
#
# It installs Docker (if needed), downloads FeedHost to /opt/feedhost, asks a
# few questions, and starts it. Answers can also be given as environment
# variables for an unattended install:
#
#   FEEDHOST_URL=https://podcasts.example.com   public web address
#   FEEDHOST_PORT=8080                         local port (127.0.0.1 only)
#   FEEDHOST_TUNNEL_TOKEN=eyJ...               Cloudflare Tunnel token (optional)
#   FEEDHOST_DIR=/opt/feedhost                 where to install
#   FEEDHOST_BRANCH=main                       git branch to install
#   FEEDHOST_NONINTERACTIVE=1                  never prompt; use the values above or defaults
#
# Running it again on a server that already has FeedHost runs the updater instead.

set -Eeuo pipefail

REPO_URL="${FEEDHOST_REPO:-https://github.com/rgblack316/podcast-feed-import-and-host.git}"
BRANCH="${FEEDHOST_BRANCH:-main}"
DIR="${FEEDHOST_DIR:-/opt/feedhost}"

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'; reset=$'\033[0m'
[ -t 1 ] || { bold=''; dim=''; red=''; green=''; reset=''; }
say()  { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
ok()   { printf '%s ✓%s %s\n' "$green" "$reset" "$*"; }
warn() { printf '%s !%s %s\n' "$red" "$reset" "$*" >&2; }
die()  { printf '%sError:%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }
trap 'die "Installation stopped at line $LINENO. Fix the problem above and run the install command again; it picks up where it left off."' ERR

# Prompt on the terminal even when this script is piped from curl.
can_prompt() { [ -z "${FEEDHOST_NONINTERACTIVE:-}" ] && { : < /dev/tty; } 2>/dev/null; }
ask() { # ask VAR "Question" "default"
  local var=$1 question=$2 default=${3:-} answer=''
  if [ -n "${!var:-}" ]; then return; fi
  if can_prompt; then
    read -r -p "$question${default:+ [$default]}: " answer < /dev/tty || true
  fi
  printf -v "$var" '%s' "${answer:-$default}"
}

# ───────────── checks ─────────────

[ "$(id -u)" -eq 0 ] || die "Run this as root: put sudo before bash, as in the README:  curl -fsSL …/install.sh | sudo bash"

[ -r /etc/os-release ] || die "Can't tell which Linux this is (no /etc/os-release)."
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) case " ${ID_LIKE:-} " in
       *" ubuntu "*|*" debian "*) ;;
       *) die "This installer supports Ubuntu and Debian. Found: ${PRETTY_NAME:-unknown}." ;;
     esac ;;
esac
# Docker publishes separate repositories for Ubuntu and Debian; derivatives use their parent's.
DOCKER_DISTRO=debian
case "${ID:-} ${ID_LIKE:-}" in *ubuntu*) DOCKER_DISTRO=ubuntu ;; esac

if [ -f "$DIR/.env" ] && [ -x "$DIR/update.sh" ]; then
  say "FeedHost is already installed in $DIR, so updating it instead."
  exec "$DIR/update.sh" "$@"
fi

printf '\n%sFeedHost installer%s\n%s%s%s\n\n' "$bold" "$reset" "$dim" "Installs into $DIR from $REPO_URL ($BRANCH)" "$reset"

# ───────────── packages ─────────────

export DEBIAN_FRONTEND=noninteractive
say "Installing prerequisites (git, curl, openssl)…"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl >/dev/null
ok "Prerequisites installed"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker is already installed ($(docker --version | sed 's/,.*//'))"
else
  say "Installing Docker from Docker's official repository…"
  # Remove distribution packages that conflict with Docker's own (as Docker's install guide advises).
  for pkg in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
    if dpkg -s "$pkg" >/dev/null 2>&1; then apt-get remove -y -qq "$pkg" >/dev/null; fi
  done
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$DOCKER_DISTRO/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  if [ "$DOCKER_DISTRO" = ubuntu ]; then SUITE="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
  else SUITE="${DEBIAN_CODENAME:-$VERSION_CODENAME}"; fi
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$DOCKER_DISTRO
Suites: $SUITE
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
  ok "Docker installed ($(docker --version | sed 's/,.*//'))"
fi
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Try: systemctl start docker"

# ───────────── download ─────────────

if [ -d "$DIR/.git" ]; then
  say "Updating the existing download in $DIR…"
  git -C "$DIR" fetch -q origin "$BRANCH"
  git -C "$DIR" checkout -q "$BRANCH"
  git -C "$DIR" merge -q --ff-only "origin/$BRANCH"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR already exists and isn't a FeedHost download. Move it aside, or set FEEDHOST_DIR to another folder."
else
  say "Downloading FeedHost to $DIR…"
  git clone -q --branch "$BRANCH" "$REPO_URL" "$DIR"
fi
cd "$DIR"
chmod +x install.sh update.sh upgrade.sh 2>/dev/null || true
VERSION="$(git rev-parse --short HEAD)"
ok "Downloaded version $VERSION"

# ───────────── questions ─────────────

printf '\n%sA few questions%s (press Enter to accept the suggestion in brackets)\n\n' "$bold" "$reset"

while :; do
  ask FEEDHOST_URL "Public web address for your podcasts, e.g. https://podcasts.example.com" "http://localhost:8080"
  FEEDHOST_URL="${FEEDHOST_URL%/}"
  if [[ "$FEEDHOST_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then break; fi
  warn "Enter just the address, starting with https:// and without a path (you entered: $FEEDHOST_URL)"
  if ! can_prompt; then die "FEEDHOST_URL must look like https://podcasts.example.com"; fi
  FEEDHOST_URL=''
done

while :; do
  ask FEEDHOST_PORT "Local port for the app (only reachable from this server)" "8080"
  if [[ "$FEEDHOST_PORT" =~ ^[0-9]+$ ]] && [ "$FEEDHOST_PORT" -ge 1 ] && [ "$FEEDHOST_PORT" -le 65535 ]; then break; fi
  warn "The port must be a number between 1 and 65535"
  if ! can_prompt; then die "FEEDHOST_PORT must be a number"; fi
  FEEDHOST_PORT=''
done

if [ -z "${FEEDHOST_TUNNEL_TOKEN+set}" ] && can_prompt; then
  printf '\n%sCloudflare Tunnel (optional).%s Paste a tunnel token to have Docker run the tunnel too.\n' "$bold" "$reset"
  printf '%sCreate one at Cloudflare Zero Trust → Networks → Tunnels; the token is in the install command.%s\n' "$dim" "$reset"
fi
ask FEEDHOST_TUNNEL_TOKEN "Tunnel token (leave blank to skip)" ""

# ───────────── configuration ─────────────

say "Writing settings to $DIR/.env…"
umask 077
DB_PASSWORD="$(openssl rand -hex 24)"
PROFILES=''
[ -n "$FEEDHOST_TUNNEL_TOKEN" ] && PROFILES='tunnel'
cat > .env <<EOF
# FeedHost settings, written by install.sh on $(date -u +%Y-%m-%d). Keep this file private.
POSTGRES_PASSWORD=$DB_PASSWORD
PUBLIC_BASE_URL=$FEEDHOST_URL
FEEDHOST_PORT=$FEEDHOST_PORT
FEEDHOST_DATA_DIR=./data
CLOUDFLARE_TUNNEL_TOKEN=$FEEDHOST_TUNNEL_TOKEN
COMPOSE_PROFILES=$PROFILES
SITE_NAME=FeedHost
ALLOW_REGISTRATION=false
FEEDHOST_VERSION=$VERSION
EOF
chmod 600 .env
umask 022
mkdir -p data/media data/site backups
chown -R 1000:1000 data   # the app runs as the "node" user (uid 1000) inside its container
ok "Settings saved (database password generated)"

# ───────────── start ─────────────

say "Building and starting FeedHost (the first build takes a few minutes)…"
docker compose up -d --build

say "Waiting for FeedHost to answer…"
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$FEEDHOST_PORT/healthz" >/dev/null 2>&1; then
    ok "FeedHost is running (version $VERSION)"
    break
  fi
  sleep 2
done
if ! curl -fsS "http://127.0.0.1:$FEEDHOST_PORT/healthz" >/dev/null 2>&1; then
  docker compose logs --tail 40 app || true
  die "FeedHost didn't start. The log above should say why. After fixing it, run: cd $DIR && docker compose up -d"
fi

# ───────────── next steps ─────────────

cat <<EOF

${green}${bold}FeedHost is installed.${reset}

  ${bold}Next:${reset}
EOF
if [ -n "$FEEDHOST_TUNNEL_TOKEN" ]; then
  cat <<EOF
  1. In Cloudflare Zero Trust → Networks → Tunnels → your tunnel → Public Hostname,
     point your hostname at the service ${bold}http://app:8080${reset}
  2. Open ${bold}$FEEDHOST_URL${reset} and create the first account (it becomes the admin).
EOF
else
  cat <<EOF
  1. Open the dashboard. From another computer, forward the port first:
       ssh -L $FEEDHOST_PORT:localhost:$FEEDHOST_PORT $(logname 2>/dev/null || echo you)@$(hostname -I 2>/dev/null | awk '{print $1}')
     then browse to ${bold}http://localhost:$FEEDHOST_PORT${reset}
  2. Create the first account (it becomes the admin).
  3. To go public, set up a Cloudflare Tunnel to http://127.0.0.1:$FEEDHOST_PORT
     (see "Cloudflare Tunnel" in the README), or re-run with FEEDHOST_TUNNEL_TOKEN.
EOF
fi
cat <<EOF
  •  In ${bold}Site settings${reset}: site name, logo, web address, media storage, email.

  ${bold}Handy commands${reset} (run in $DIR):
     sudo ./update.sh                   update to the latest version (backs up the database first)
     sudo docker compose logs -f app    follow the app's log
     sudo docker compose restart app    restart the app
  Media is stored in $DIR/data; database backups go to $DIR/backups.

EOF
