#!/usr/bin/env bash
# ChillWithSyd Server Manager v1.1 — Linux Installer
set -e

APPNAME="ChillWithSyd Server Manager"
VERSION="1.2"
SERVICE_NAME="chillwithsyd"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

header() {
  echo ""
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║   ChillWithSyd Server Manager  v${VERSION}         ║${NC}"
  echo -e "${BOLD}${CYAN}║   Soulmask Dedicated Server Panel           ║${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}"
  echo ""
}
info()  { echo -e "${GREEN}  ✓${NC}  $1"; }
warn()  { echo -e "${YELLOW}  ⚠${NC}  $1"; }
error() { echo -e "${RED}  ✗${NC}  $1"; }
step()  { echo -e "${BOLD}──${NC} $1"; }

header

HAS_SUDO=false
if [ "$EUID" -eq 0 ]; then HAS_SUDO=true
elif sudo -n true 2>/dev/null; then HAS_SUDO=true; fi

step "Install location"
echo ""
if $HAS_SUDO; then
  echo "  Recommended: /opt/chillwithsyd  (system-wide, requires sudo)"
  echo "  Alternative: $HOME/chillwithsyd  (current user only)"
  echo ""
  read -p "  Install path [/opt/chillwithsyd]: " INSTALL_DIR
  INSTALL_DIR="${INSTALL_DIR:-/opt/chillwithsyd}"
else
  warn "sudo not available — installing to home directory"
  INSTALL_DIR="$HOME/chillwithsyd"
  echo "  Install path: $INSTALL_DIR"
fi
echo ""

step "Manager port"
echo ""
read -p "  Manager port [3000]: " CWS_PORT
CWS_PORT="${CWS_PORT:-3000}"
echo ""

UPGRADING=false
if [ -f "$INSTALL_DIR/server.js" ]; then
  warn "Existing installation found at $INSTALL_DIR"
  echo "  Your servers.json and backups will be preserved."
  echo ""
  read -p "  Continue with upgrade? [Y/n]: " CONFIRM
  [ "${CONFIRM:-Y}" != "Y" ] && [ "${CONFIRM:-Y}" != "y" ] && { echo "Cancelled."; exit 0; }
  UPGRADING=true
fi

step "Checking Node.js"
echo ""
NODE_OK=false
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
  if [ "$NODE_VER" -ge 16 ] 2>/dev/null; then
    info "Node.js v$(node --version | tr -d v) found"
    NODE_OK=true
  else
    warn "Node.js v$(node --version | tr -d v) is too old — need v16+"
  fi
else
  warn "Node.js not found"
fi

if ! $NODE_OK; then
  echo "  Attempting to install Node.js..."
  if command -v apt-get &>/dev/null && $HAS_SUDO; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null || true
    sudo apt-get install -y nodejs
  elif command -v dnf &>/dev/null && $HAS_SUDO; then
    sudo dnf install -y nodejs
  elif command -v pacman &>/dev/null && $HAS_SUDO; then
    sudo pacman -Sy --noconfirm nodejs npm
  else
    error "Cannot auto-install Node.js. Please install Node.js 20 LTS from https://nodejs.org/en/download"
    exit 1
  fi
  command -v node &>/dev/null && info "Node.js $(node --version) installed" || { error "Installation failed."; exit 1; }
fi
echo ""

step "Installing files"
echo ""

if [[ "$INSTALL_DIR" == /opt/* ]] && $HAS_SUDO; then
  sudo mkdir -p "$INSTALL_DIR"
  sudo chown "$USER:$USER" "$INSTALL_DIR" 2>/dev/null || true
else
  mkdir -p "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR/backups"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for f in server.js index.html "ChillWithSyd-Server-Manager-Manual.pdf"; do
  if [ -f "$SCRIPT_DIR/$f" ]; then
    cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f" && info "Installed $f"
  else
    warn "Not found alongside installer: $f"
  fi
done

echo "CWS_PORT=$CWS_PORT" > "$INSTALL_DIR/config.env"
info "Written config.env (port $CWS_PORT)"

cat > "$INSTALL_DIR/start.sh" << STARTEOF
#!/usr/bin/env bash
cd "\$(dirname "\$0")"
[ -f config.env ] && export \$(grep -v '^#' config.env | xargs)
export CWS_PORT=\${CWS_PORT:-3000}
echo "Starting ChillWithSyd on port \$CWS_PORT..."
node server.js &
echo \$! > .pid
sleep 2
echo "Open http://localhost:\$CWS_PORT in your browser"
STARTEOF
chmod +x "$INSTALL_DIR/start.sh"

cat > "$INSTALL_DIR/stop.sh" << STOPEOF
#!/usr/bin/env bash
cd "\$(dirname "\$0")"
if [ -f .pid ]; then
  kill \$(cat .pid) 2>/dev/null && echo "ChillWithSyd stopped" || echo "Not running"
  rm -f .pid
else
  pkill -f "node.*server.js" && echo "ChillWithSyd stopped" || echo "Not running"
fi
STOPEOF
chmod +x "$INSTALL_DIR/stop.sh"
info "Written start.sh and stop.sh"

if $HAS_SUDO; then
  sudo tee "/usr/local/bin/chillwithsyd" > /dev/null << HELPEREOF
#!/usr/bin/env bash
INSTALL="$INSTALL_DIR"
case "\$1" in
  start)  bash "\$INSTALL/start.sh" ;;
  stop)   bash "\$INSTALL/stop.sh" ;;
  status) systemctl status $SERVICE_NAME 2>/dev/null || (pgrep -f "node.*server.js" && echo "Running" || echo "Stopped") ;;
  log)    journalctl -u $SERVICE_NAME -f 2>/dev/null || echo "Use: journalctl -u $SERVICE_NAME" ;;
  *)      echo "Usage: chillwithsyd {start|stop|status|log}" ;;
esac
HELPEREOF
  sudo chmod +x "/usr/local/bin/chillwithsyd"
  info "Helper command: chillwithsyd start/stop/status/log"
fi

echo ""
step "Setting up systemd service"
echo ""
NODE_PATH=$(command -v node)
if $HAS_SUDO && command -v systemctl &>/dev/null; then
  sudo tee "/etc/systemd/system/$SERVICE_NAME.service" > /dev/null << SVCEOF
[Unit]
Description=ChillWithSyd Soulmask Server Manager v${VERSION}
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=-$INSTALL_DIR/config.env
ExecStart=$NODE_PATH $INSTALL_DIR/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=chillwithsyd

[Install]
WantedBy=multi-user.target
SVCEOF
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"
  info "systemd service installed and enabled (auto-starts on boot)"
  echo ""
  read -p "  Start ChillWithSyd now? [Y/n]: " START_NOW
  if [ "${START_NOW:-Y}" == "Y" ] || [ "${START_NOW:-Y}" == "y" ]; then
    sudo systemctl start "$SERVICE_NAME"
    sleep 2
    systemctl is-active --quiet "$SERVICE_NAME" && info "ChillWithSyd is running" || warn "Check: journalctl -u $SERVICE_NAME"
  fi
else
  warn "systemd not available — use $INSTALL_DIR/start.sh to start manually"
fi

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║   Installation complete!                     ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Manager URL:${NC}  http://localhost:$CWS_PORT"
echo -e "  ${BOLD}Install dir:${NC}  $INSTALL_DIR"
echo -e "  ${BOLD}Manual:${NC}       $INSTALL_DIR/ChillWithSyd-Server-Manager-Manual.pdf"
echo ""
if $HAS_SUDO && command -v systemctl &>/dev/null; then
  echo "  Commands: chillwithsyd start/stop/status/log"
  echo "  Or:       sudo systemctl start|stop|status $SERVICE_NAME"
else
  echo "  To start: bash $INSTALL_DIR/start.sh"
  echo "  To stop:  bash $INSTALL_DIR/stop.sh"
fi
echo ""
echo -e "  ${YELLOW}Note: servers.json and backups are never deleted on upgrade or uninstall.${NC}"
echo ""
