#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$SCRIPT_DIR"
SERVICE_NAME="mail-platform-panel"
SERVICE_USER="mailpanel"
SERVICE_GROUP="mailpanel"
SYSTEMD_UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
SUDOERS_PATH="/etc/sudoers.d/${SERVICE_USER}-rspamd"

log() { printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { printf '[%s] [ERROR] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: sudo ./install-panel-service.sh [options]

Options:
  --panel-dir <path>          Panel directory (default: script directory)
  --service-name <name>       systemd service name (default: mail-platform-panel)
  --service-user <user>       Service user (default: mailpanel)
  --service-group <group>     Service group (default: mailpanel)
  -h, --help                  Show this help
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --panel-dir) PANEL_DIR="$2"; shift 2 ;;
      --service-name) SERVICE_NAME="$2"; shift 2 ;;
      --service-user) SERVICE_USER="$2"; shift 2 ;;
      --service-group) SERVICE_GROUP="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown argument: $1" ;;
    esac
  done

  SYSTEMD_UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
  SUDOERS_PATH="/etc/sudoers.d/${SERVICE_USER}-rspamd"
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "Run as root: sudo ./install-panel-service.sh"
  fi
}

require_files() {
  [[ -d "$PANEL_DIR" ]] || die "Panel directory not found: $PANEL_DIR"
  [[ -f "$PANEL_DIR/package.json" ]] || die "package.json missing in $PANEL_DIR"
  [[ -f "$PANEL_DIR/server.js" ]] || die "server.js missing in $PANEL_DIR"
  [[ -f "$PANEL_DIR/.env" ]] || die ".env missing in $PANEL_DIR. Copy from .env.example first."

  if [[ "$PANEL_DIR" == /root/* && "$SERVICE_USER" != "root" ]]; then
    die "Panel directory is under /root and not readable by non-root services. Move project to /opt/mail-platform or run with --service-user root."
  fi
}

random_secret() {
  openssl rand -base64 48 | tr -d '\n' | tr '/+' 'AZ'
}

set_env_key() {
  local key="$1"
  local value="$2"
  local env_file="$PANEL_DIR/.env"
  if grep -qE "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf '\n%s=%s\n' "$key" "$value" >>"$env_file"
  fi
}

ensure_env_defaults() {
  local env_file="$PANEL_DIR/.env"
  local admin_password_file="/root/${SERVICE_NAME}-admin-password.txt"

  if grep -qE '^SESSION_SECRET=(replace-with-long-random-secret|change-this-session-secret)?$' "$env_file" || ! grep -q '^SESSION_SECRET=' "$env_file"; then
    set_env_key "SESSION_SECRET" "$(random_secret)"
    log "Generated SESSION_SECRET in .env"
  fi

  if grep -qE '^ADMIN_PASSWORD=(change-me-now)?$' "$env_file" || ! grep -q '^ADMIN_PASSWORD=' "$env_file"; then
    local generated_password
    generated_password="$(random_secret | cut -c1-20)"
    set_env_key "ADMIN_PASSWORD" "$generated_password"
    umask 077
    printf '%s\n' "$generated_password" >"$admin_password_file"
    log "Generated ADMIN_PASSWORD and wrote it to $admin_password_file"
  fi

  set_env_key "NODE_ENV" "production"
  set_env_key "VIEW_CACHE" "true"
  set_env_key "STATIC_MAX_AGE" "1h"
  set_env_key "TRUST_PROXY" "false"
  set_env_key "SESSION_COOKIE_NAME" "mailpanel.sid"
  set_env_key "SESSION_COOKIE_SECURE" "false"
  set_env_key "SESSION_COOKIE_SAMESITE" "lax"
  set_env_key "SESSION_COOKIE_MAX_AGE_MS" "28800000"
  set_env_key "RSPAMD_RELOAD_CMD" "sudo -n /bin/systemctl reload rspamd"
  set_env_key "SKIP_RSPAMD_RELOAD" "false"
}

ensure_os_packages() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
    return
  fi

  log "Installing runtime dependencies for panel service"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y nodejs npm sudo
}

ensure_service_identity() {
  if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    groupadd --system "$SERVICE_GROUP"
  fi

  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home "$PANEL_DIR" --shell /usr/sbin/nologin -g "$SERVICE_GROUP" "$SERVICE_USER"
  fi

  chown root:"$SERVICE_GROUP" "$PANEL_DIR/.env"
  chmod 0640 "$PANEL_DIR/.env"
}

ensure_rspamd_permissions() {
  mkdir -p /etc/rspamd/dkim
  touch /etc/rspamd/local.d/dkim_selectors.map

  chown root:"$SERVICE_GROUP" /etc/rspamd/dkim
  chmod 0770 /etc/rspamd/dkim

  chown root:"$SERVICE_GROUP" /etc/rspamd/local.d/dkim_selectors.map
  chmod 0660 /etc/rspamd/local.d/dkim_selectors.map

  cat >"$SUDOERS_PATH" <<EOF
${SERVICE_USER} ALL=(root) NOPASSWD: /bin/systemctl reload rspamd
EOF
  chmod 0440 "$SUDOERS_PATH"
}

install_panel_deps_and_init_db() {
  log "Installing npm dependencies"
  cd "$PANEL_DIR"
  npm ci --omit=dev

  log "Initializing database schema/admin"
  sudo -u "$SERVICE_USER" -g "$SERVICE_GROUP" /usr/bin/env bash -lc "cd '$PANEL_DIR' && npm run db:init"
}

write_systemd_unit() {
  local node_bin
  node_bin="$(command -v node)"
  [[ -n "$node_bin" ]] || die "node binary not found after package install"

  cat >"$SYSTEMD_UNIT_PATH" <<EOF
[Unit]
Description=Mail Platform Admin Panel
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$PANEL_DIR
ExecStart=$node_bin $PANEL_DIR/server.js
Restart=always
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/etc/rspamd/dkim /etc/rspamd/local.d
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
}

enable_service() {
  log "Enabling and starting systemd service: $SERVICE_NAME"
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
  systemctl is-active --quiet "$SERVICE_NAME" || die "Service failed to start: $SERVICE_NAME"
}

print_summary() {
  local panel_host panel_port
  panel_host="$(grep '^PANEL_HOST=' "$PANEL_DIR/.env" | cut -d= -f2)"
  panel_port="$(grep '^PANEL_PORT=' "$PANEL_DIR/.env" | cut -d= -f2)"

  cat <<EOF

Panel service installed.

Service:
  systemctl status $SERVICE_NAME --no-pager
  journalctl -u $SERVICE_NAME -f

Panel bind address:
  $panel_host:$panel_port

If you use SSH tunnel:
  ssh -L ${panel_port}:127.0.0.1:${panel_port} user@server

EOF
}

main() {
  parse_args "$@"
  require_root
  require_files
  ensure_os_packages
  ensure_env_defaults
  ensure_service_identity
  ensure_rspamd_permissions
  install_panel_deps_and_init_db
  write_systemd_unit
  enable_service
  print_summary
}

main "$@"
