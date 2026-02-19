#!/usr/bin/env bash
set -euo pipefail

RELAY_HOST=""
RELAY_PORT="587"
RELAY_USER=""
RELAY_PASS=""
RELAY_PASS_FILE=""
FORCE_IPV4="on"

log() { printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { printf '[%s] [ERROR] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: sudo ./configure-relayhost.sh --host <smtp-host> --user <smtp-user> --pass <smtp-pass> [options]

Required:
  --host <smtp-host>             Relay SMTP host (example: smtp-relay.brevo.com)
  --user <smtp-user>             Relay SMTP username
  --pass <smtp-pass>             Relay SMTP password
  --pass-file <file>             Relay SMTP password file (first line), safer than --pass

Optional:
  --port <port>                  Relay SMTP port (default: 587)
  --force-ipv4 <on|off>          Postfix inet_protocols (default: on)
  -h, --help                     Show help
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --host) RELAY_HOST="$2"; shift 2 ;;
      --port) RELAY_PORT="$2"; shift 2 ;;
      --user) RELAY_USER="$2"; shift 2 ;;
      --pass) RELAY_PASS="$2"; shift 2 ;;
      --pass-file) RELAY_PASS_FILE="$2"; shift 2 ;;
      --force-ipv4) FORCE_IPV4="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown argument: $1" ;;
    esac
  done

  [[ -n "$RELAY_HOST" ]] || die "--host is required"
  [[ -n "$RELAY_USER" ]] || die "--user is required"
  if [[ -n "$RELAY_PASS_FILE" ]]; then
    [[ -f "$RELAY_PASS_FILE" ]] || die "--pass-file does not exist: $RELAY_PASS_FILE"
    RELAY_PASS="$(head -n1 "$RELAY_PASS_FILE")"
  fi
  [[ -n "$RELAY_PASS" ]] || die "--pass or --pass-file is required"
  [[ "$RELAY_PORT" =~ ^[0-9]+$ ]] || die "--port must be numeric"
  [[ "$FORCE_IPV4" == "on" || "$FORCE_IPV4" == "off" ]] || die "--force-ipv4 must be on or off"
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || die "Run as root with sudo"
}

backup_file_if_exists() {
  local file="$1"
  local backup_dir="/root/mail-platform-backups"
  mkdir -p "$backup_dir"
  if [[ -f "$file" ]]; then
    cp "$file" "$backup_dir/$(basename "$file").$(date +%Y%m%d%H%M%S).bak"
  fi
}

main() {
  parse_args "$@"
  require_root

  local relay_target="[${RELAY_HOST}]:${RELAY_PORT}"

  log "Checking relay endpoint reachability: ${RELAY_HOST}:${RELAY_PORT}"
  if ! timeout 10 bash -lc "cat < /dev/null > /dev/tcp/${RELAY_HOST}/${RELAY_PORT}" 2>/dev/null; then
    die "Cannot reach relay host ${RELAY_HOST}:${RELAY_PORT} from this server."
  fi

  backup_file_if_exists "/etc/postfix/main.cf"
  backup_file_if_exists "/etc/postfix/sasl_passwd"
  backup_file_if_exists "/etc/postfix/sasl_passwd.db"

  log "Writing /etc/postfix/sasl_passwd"
  printf '%s %s:%s\n' "$relay_target" "$RELAY_USER" "$RELAY_PASS" > /etc/postfix/sasl_passwd
  chmod 0600 /etc/postfix/sasl_passwd
  chown root:root /etc/postfix/sasl_passwd
  postmap /etc/postfix/sasl_passwd
  chmod 0600 /etc/postfix/sasl_passwd.db
  chown root:root /etc/postfix/sasl_passwd.db

  log "Configuring Postfix relayhost settings"
  postconf -e "relayhost = ${relay_target}"
  postconf -e "smtp_sasl_auth_enable = yes"
  postconf -e "smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd"
  postconf -e "smtp_sasl_security_options = noanonymous"
  postconf -e "smtp_sasl_tls_security_options = noanonymous"
  postconf -e "smtp_use_tls = yes"
  postconf -e "smtp_tls_security_level = encrypt"
  postconf -e "smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt"
  postconf -e "smtp_tls_note_starttls_offer = yes"

  if [[ "$FORCE_IPV4" == "on" ]]; then
    postconf -e "inet_protocols = ipv4"
  fi

  # Keep sender identity as the real authenticated mailbox. Do not force
  # envelope rewrites to the relay account user.
  postconf -X "sender_canonical_classes" || true
  postconf -X "sender_canonical_maps" || true

  log "Restarting Postfix"
  postfix check
  systemctl restart postfix

  cat <<EOF

Relayhost configured successfully.

Active relayhost:
  $(postconf -h relayhost)
Active sender rewrite:
  $(postconf -h sender_canonical_maps 2>/dev/null || true)

Next:
  sudo postqueue -f
  sudo postqueue -p
  sudo tail -n 80 /var/log/mail.log
EOF
}

main "$@"
