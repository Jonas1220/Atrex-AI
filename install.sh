#!/usr/bin/env bash
set -euo pipefail

# ── Atrex AI Installer ────────────────────────────────────────────────────────
# curl -fsSL https://raw.githubusercontent.com/Jonas1220/atrex-ai/main/install.sh | bash

REPO_URL="https://github.com/Jonas1220/atrex-ai.git"
DEFAULT_INSTALL_DIR="$HOME/atrex-ai"
CONFIG_DIR="$HOME/.atrex"
CONFIG_FILE="$CONFIG_DIR/config"
MIN_NODE_VERSION=20

# ── Colors ────────────────────────────────────────────────────────────────────
BOLD='\033[1m'
DIM='\033[2m'
RED='\033[0;31m'
GREEN='\033[0;32m'
AMBER='\033[0;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

line()    { echo -e "${DIM}────────────────────────────────────────────────────${RESET}"; }
ok()      { echo -e "  ${GREEN}✓${RESET}  $1"; }
info()    { echo -e "  ${CYAN}→${RESET}  $1"; }
warn()    { echo -e "  ${AMBER}!${RESET}  $1"; }
error()   { echo -e "  ${RED}✗${RESET}  $1"; exit 1; }
heading() { echo -e "\n${BOLD}$1${RESET}"; line; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${AMBER}"
echo "    ___  ________________  __  ___    ____"
echo "   / _ | /_  __/ ___/ __/ | |/_/ |  / /  |"
echo "  / __ |  / / / /  / _/  _>  < | | / / /| |"
echo " /_/ |_| /_/ /_/  /___/ /_/|_| |_|/_/_/ |_|"
echo -e "${RESET}"
echo -e "  ${DIM}Autonomous Task Runner & Execution AI${RESET}"
echo ""

# ── Parse arguments ───────────────────────────────────────────────────────────
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
SKIP_PM2=false
PORT=$(( RANDOM % 55535 + 10000 ))

while [[ $# -gt 0 ]]; do
  case $1 in
    --dir)    INSTALL_DIR="$2"; shift 2 ;;
    --no-pm2) SKIP_PM2=true; shift ;;
    --port)   PORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# ── Check prerequisites ───────────────────────────────────────────────────────
heading "Checking prerequisites"

# Node.js
if ! command -v node &>/dev/null; then
  error "Node.js is not installed. Install Node.js >= ${MIN_NODE_VERSION} from https://nodejs.org"
fi

NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt "$MIN_NODE_VERSION" ]; then
  error "Node.js >= ${MIN_NODE_VERSION} required (found v${NODE_VERSION}). Update at https://nodejs.org"
fi
ok "Node.js $(node --version)"

# npm
if ! command -v npm &>/dev/null; then
  error "npm is not installed."
fi
ok "npm $(npm --version)"

# git
if ! command -v git &>/dev/null; then
  error "git is not installed. Install it with: sudo apt install git  (or brew install git)"
fi
ok "git $(git --version | awk '{print $3}')"

# PM2 (optional)
HAS_PM2=false
if command -v pm2 &>/dev/null; then
  HAS_PM2=true
  ok "pm2 $(pm2 --version 2>/dev/null | tail -1)"
elif [ "$SKIP_PM2" = false ]; then
  warn "pm2 not found — will install it (recommended for background process management)"
fi

# ── Install directory ─────────────────────────────────────────────────────────
heading "Install location"

if [ -d "$INSTALL_DIR" ]; then
  warn "Directory already exists: $INSTALL_DIR"
  echo -n "  Overwrite? [y/N] "
  read -r CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "  Aborted."
    exit 0
  fi
  rm -rf "$INSTALL_DIR"
fi

info "Installing to: ${BOLD}$INSTALL_DIR${RESET}"

# ── Clone ─────────────────────────────────────────────────────────────────────
heading "Cloning repository"

git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
ok "Repository cloned"

cd "$INSTALL_DIR"

# ── Write port to .env ────────────────────────────────────────────────────────
ENV_FILE="$INSTALL_DIR/.env"
if [ ! -f "$ENV_FILE" ] && [ -f "$INSTALL_DIR/.env.example" ]; then
  cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
fi

if grep -q "^WEB_ADMIN_PORT=" "$ENV_FILE" 2>/dev/null; then
  sed -i.bak "s/^WEB_ADMIN_PORT=.*/WEB_ADMIN_PORT=$PORT/" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
else
  echo "WEB_ADMIN_PORT=$PORT" >> "$ENV_FILE"
fi
ok "Dashboard port set to $PORT"

# ── Install dependencies ──────────────────────────────────────────────────────
heading "Installing dependencies"

npm install --silent
ok "npm install complete"

# ── Build ─────────────────────────────────────────────────────────────────────
heading "Building"

npm run build --silent
ok "Build complete"

# ── Install PM2 if needed ─────────────────────────────────────────────────────
if [ "$HAS_PM2" = false ] && [ "$SKIP_PM2" = false ]; then
  heading "Installing PM2"
  npm install -g pm2 --silent
  ok "PM2 installed"
  HAS_PM2=true
fi

# ── Register CLI ──────────────────────────────────────────────────────────────
heading "Installing CLI"

chmod +x bin/atrex
npm link --silent 2>/dev/null || {
  warn "npm link failed — trying with sudo"
  sudo npm link --silent
}
ok "atrex CLI installed"

# ── Save config ───────────────────────────────────────────────────────────────
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_FILE" << EOF
INSTALL_DIR=$INSTALL_DIR
HAS_PM2=$HAS_PM2
INSTALLED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF
ok "Config saved to $CONFIG_FILE"

# ── PM2 startup (optional) ────────────────────────────────────────────────────
if [ "$HAS_PM2" = true ]; then
  heading "PM2 startup"
  info "To auto-start Atrex AI on system boot, run:"
  echo -e "     ${AMBER}pm2 startup${RESET}   (generates the command for your system)"
  echo -e "     ${AMBER}pm2 save${RESET}       (after starting the agent)"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
line
echo -e "  ${GREEN}${BOLD}Atrex AI installed successfully!${RESET}"
line
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo ""
echo -e "  1. Complete setup:   ${AMBER}atrex setup${RESET}"
echo -e "     Opens the onboarding wizard at http://localhost:${PORT}"
echo ""
echo -e "  2. Start the agent:  ${AMBER}atrex start${RESET}"
echo ""
echo -e "  3. Check status:     ${AMBER}atrex status${RESET}"
echo ""
echo -e "  ${DIM}Run ${RESET}atrex help${DIM} to see all commands.${RESET}"
echo ""
