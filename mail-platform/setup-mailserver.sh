#!/usr/bin/env bash
set -euo pipefail

HOSTNAME_FQDN="mail.mailhost.com"
TIMEZONE="UTC"
ADMIN_EMAIL=""
API_ALLOW_FROM="127.0.0.1,::1"
ACME_MODE="auto"
IMAP_STARTTLS="off"
NO_HOSTNAME_CHANGE="false"
INSTALL_PANEL_SERVICE="on"

# Compatibility flags retained from old Docker flow; ignored in native mode.
LEGACY_MAILCOW_DIR=""
LEGACY_MODE=""

PANEL_DB_NAME="mailpanel"
PANEL_DB_USER="mailpanel"
PANEL_DB_PASS=""
PANEL_DB_HOST="127.0.0.1"
PANEL_DB_PORT="5432"
PANEL_BIND_HOST="127.0.0.1"
PANEL_BIND_PORT="3001"

MAIL_UID="5000"
MAIL_GID="5000"
MAIL_VMAIL_USER="vmail"
MAIL_VMAIL_GROUP="vmail"
MAILBOX_BASE_DIR="/var/mail/vhosts"
DKIM_SELECTOR="${DKIM_SELECTOR:-mail}"
DKIM_KEY_DIR="/etc/rspamd/dkim"
DKIM_SELECTOR_MAP="/etc/rspamd/local.d/dkim_selectors.map"
RSPAMD_RATELIMIT_FILE="/etc/rspamd/local.d/ratelimit.conf"
RSPAMD_LOG_FILE="/var/log/rspamd/rspamd.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }
warn() { printf '[%s] [WARN] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }
die() { printf '[%s] [ERROR] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: sudo ./setup-mailserver.sh [options]

Options:
  --hostname <fqdn>               Mail host FQDN (default: mail.mailhost.com)
  --timezone <tz>                 System timezone (default: UTC)
  --admin-email <email>           Email used for ACME registration (required for --acme auto)
  --api-allow-from <csv>          Reserved compatibility option (default: 127.0.0.1,::1)
  --acme <auto|skip>              Let's Encrypt mode (default: auto)
  --imap-starttls <on|off>        Enable IMAP STARTTLS (143) in addition to IMAPS 993 (default: off)
  --no-hostname-change            Do not modify system hostname
  --install-panel-service <on|off>
                                  Install and enable panel as systemd service (default: on)
  --db-name <name>                PostgreSQL DB name for panel + mail backend (default: mailpanel)
  --db-user <user>                PostgreSQL DB user (default: mailpanel)
  --db-pass <password>            PostgreSQL DB password (default: random generated)
  --panel-host <ip>               Panel bind host (default: 127.0.0.1)
  --panel-port <port>             Panel bind port (default: 3001)

Compatibility no-op flags:
  --mailcow-dir <path>            Ignored in native mode
  --mode <template|interactive-generate>
                                  Ignored in native mode
  -h, --help                      Show this help
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --hostname) HOSTNAME_FQDN="$2"; shift 2 ;;
      --timezone) TIMEZONE="$2"; shift 2 ;;
      --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
      --api-allow-from) API_ALLOW_FROM="$2"; shift 2 ;;
      --acme) ACME_MODE="$2"; shift 2 ;;
      --imap-starttls) IMAP_STARTTLS="$2"; shift 2 ;;
      --no-hostname-change) NO_HOSTNAME_CHANGE="true"; shift ;;
      --install-panel-service) INSTALL_PANEL_SERVICE="$2"; shift 2 ;;
      --db-name) PANEL_DB_NAME="$2"; shift 2 ;;
      --db-user) PANEL_DB_USER="$2"; shift 2 ;;
      --db-pass) PANEL_DB_PASS="$2"; shift 2 ;;
      --panel-host) PANEL_BIND_HOST="$2"; shift 2 ;;
      --panel-port) PANEL_BIND_PORT="$2"; shift 2 ;;
      --mailcow-dir) LEGACY_MAILCOW_DIR="$2"; shift 2 ;;
      --mode) LEGACY_MODE="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown argument: $1" ;;
    esac
  done

  [[ "$ACME_MODE" == "auto" || "$ACME_MODE" == "skip" ]] || die "--acme must be auto or skip"
  [[ "$IMAP_STARTTLS" == "on" || "$IMAP_STARTTLS" == "off" ]] || die "--imap-starttls must be on or off"
  [[ "$INSTALL_PANEL_SERVICE" == "on" || "$INSTALL_PANEL_SERVICE" == "off" ]] || die "--install-panel-service must be on or off"
  [[ "$HOSTNAME_FQDN" == *.* ]] || die "--hostname must be a FQDN"
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "Run as root: sudo ./setup-mailserver.sh"
  fi
}

check_compat_flags() {
  if [[ -n "$LEGACY_MAILCOW_DIR" || -n "$LEGACY_MODE" ]]; then
    warn "Docker/Mailcow flags were provided but this script runs native (non-Docker) setup only."
  fi
  if [[ -n "$API_ALLOW_FROM" ]]; then
    warn "--api-allow-from is retained for compatibility and is not used by the native backend."
  fi
}

random_secret() {
  openssl rand -base64 30 | tr -d '\n' | tr '/+' 'AZ'
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >>"$file"
  fi
}

install_packages() {
  log "Installing required packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update

  echo "postfix postfix/mailname string $HOSTNAME_FQDN" | debconf-set-selections
  echo "postfix postfix/main_mailer_type string Internet Site" | debconf-set-selections

  apt-get install -y \
    ca-certificates curl jq unzip \
    sudo nodejs npm \
    ufw fail2ban chrony dnsutils netcat-openbsd \
    postgresql postgresql-contrib \
    postfix postfix-pgsql \
    dovecot-core dovecot-imapd dovecot-lmtpd dovecot-managesieved dovecot-pgsql dovecot-sieve \
    rspamd redis-server \
    nginx certbot python3-certbot-nginx \
    rsyslog openssl
}

set_timezone_and_hostname() {
  log "Setting timezone to $TIMEZONE"
  timedatectl set-timezone "$TIMEZONE"

  if [[ "$NO_HOSTNAME_CHANGE" == "false" ]]; then
    log "Setting hostname to $HOSTNAME_FQDN"
    hostnamectl set-hostname "$HOSTNAME_FQDN"
    if ! grep -qE "127\\.0\\.1\\.1\\s+$HOSTNAME_FQDN" /etc/hosts; then
      echo "127.0.1.1 $HOSTNAME_FQDN ${HOSTNAME_FQDN%%.*}" >> /etc/hosts
    fi
  else
    warn "Skipping hostname change (--no-hostname-change set)"
  fi
}

configure_time_sync() {
  log "Ensuring chrony is enabled"
  systemctl enable --now chrony
}

configure_ufw() {
  log "Configuring UFW rules"
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing

  for port in 22 25 80 443 465 587 993 4190; do
    ufw allow "${port}/tcp"
  done

  if [[ "$IMAP_STARTTLS" == "on" ]]; then
    ufw allow 143/tcp
  fi

  ufw --force enable
}

configure_fail2ban() {
  log "Configuring fail2ban (sshd only)"
  mkdir -p /etc/fail2ban/jail.d
  cat >/etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled = true
port = ssh
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  systemctl enable --now fail2ban
  fail2ban-client reload || true
}

ensure_postgres_db() {
  if [[ -z "$PANEL_DB_PASS" ]]; then
    PANEL_DB_PASS="$(random_secret)"
  fi

  log "Configuring PostgreSQL database and role"
  systemctl enable --now postgresql

  local esc_pass="${PANEL_DB_PASS//\'/''}"
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<EOF
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$PANEL_DB_USER') THEN
    EXECUTE 'CREATE ROLE $PANEL_DB_USER LOGIN PASSWORD ''$esc_pass''';
  ELSE
    EXECUTE 'ALTER ROLE $PANEL_DB_USER WITH LOGIN PASSWORD ''$esc_pass''';
  END IF;
END
\$\$;
EOF

  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$PANEL_DB_NAME'" | grep -q 1; then
    sudo -u postgres createdb -O "$PANEL_DB_USER" "$PANEL_DB_NAME"
  fi

  sudo -u postgres psql -d "$PANEL_DB_NAME" -v ON_ERROR_STOP=1 -c "GRANT ALL PRIVILEGES ON DATABASE \"$PANEL_DB_NAME\" TO \"$PANEL_DB_USER\";"
}

apply_schema_if_present() {
  local schema_file="$SCRIPT_DIR/panel/db.sql"
  if [[ -f "$schema_file" ]]; then
    log "Applying schema from $schema_file"
    PGPASSWORD="$PANEL_DB_PASS" psql \
      "host=$PANEL_DB_HOST port=$PANEL_DB_PORT dbname=$PANEL_DB_NAME user=$PANEL_DB_USER sslmode=disable" \
      -v ON_ERROR_STOP=1 \
      -f "$schema_file"
  else
    warn "panel/db.sql not found; database schema was not applied."
  fi
}

configure_vmail_user() {
  log "Ensuring vmail user/group and mailbox path"
  if ! getent group "$MAIL_VMAIL_GROUP" >/dev/null 2>&1; then
    groupadd -g "$MAIL_GID" "$MAIL_VMAIL_GROUP"
  fi
  if ! id "$MAIL_VMAIL_USER" >/dev/null 2>&1; then
    useradd -g "$MAIL_VMAIL_GROUP" -u "$MAIL_UID" -d "$MAILBOX_BASE_DIR" -m -s /usr/sbin/nologin "$MAIL_VMAIL_USER"
  fi
  mkdir -p "$MAILBOX_BASE_DIR"
  chown -R "$MAIL_VMAIL_USER:$MAIL_VMAIL_GROUP" "$MAILBOX_BASE_DIR"
  chmod 0770 "$MAILBOX_BASE_DIR"
}

write_postfix_pgsql_maps() {
  log "Writing Postfix PostgreSQL map files"
  install -m 0640 -o root -g postfix /dev/null /etc/postfix/pgsql-virtual-mailbox-domains.cf
  install -m 0640 -o root -g postfix /dev/null /etc/postfix/pgsql-virtual-mailbox-maps.cf
  install -m 0640 -o root -g postfix /dev/null /etc/postfix/pgsql-virtual-alias-maps.cf

  cat >/etc/postfix/pgsql-virtual-mailbox-domains.cf <<EOF
hosts = $PANEL_DB_HOST
user = $PANEL_DB_USER
password = $PANEL_DB_PASS
dbname = $PANEL_DB_NAME
query = SELECT 1 FROM mail_domains WHERE domain_name='%s' AND active = true
EOF

  cat >/etc/postfix/pgsql-virtual-mailbox-maps.cf <<EOF
hosts = $PANEL_DB_HOST
user = $PANEL_DB_USER
password = $PANEL_DB_PASS
dbname = $PANEL_DB_NAME
query = SELECT 1 FROM mail_users WHERE email='%s' AND active = true
EOF

  cat >/etc/postfix/pgsql-virtual-alias-maps.cf <<EOF
hosts = $PANEL_DB_HOST
user = $PANEL_DB_USER
password = $PANEL_DB_PASS
dbname = $PANEL_DB_NAME
query = (
  SELECT destination FROM mail_aliases WHERE source='%s' AND active = true
) UNION (
  SELECT email FROM mail_users WHERE email='%s' AND active = true
) LIMIT 1
EOF
}

set_tls_paths() {
  TLS_CERT_FILE="/etc/ssl/certs/ssl-cert-snakeoil.pem"
  TLS_KEY_FILE="/etc/ssl/private/ssl-cert-snakeoil.key"
  if [[ -s "/etc/letsencrypt/live/$HOSTNAME_FQDN/fullchain.pem" && -s "/etc/letsencrypt/live/$HOSTNAME_FQDN/privkey.pem" ]]; then
    TLS_CERT_FILE="/etc/letsencrypt/live/$HOSTNAME_FQDN/fullchain.pem"
    TLS_KEY_FILE="/etc/letsencrypt/live/$HOSTNAME_FQDN/privkey.pem"
  fi
}

configure_postfix() {
  log "Configuring Postfix"
  set_tls_paths

  postconf -e "myhostname = $HOSTNAME_FQDN"
  postconf -e "myorigin = /etc/mailname"
  postconf -e "mydestination = localhost"
  postconf -e "inet_interfaces = all"
  postconf -e "inet_protocols = all"
  postconf -e "smtpd_banner = \$myhostname ESMTP"
  postconf -e "append_dot_mydomain = no"
  postconf -e "biff = no"
  postconf -e "readme_directory = no"
  postconf -e "compatibility_level = 3.6"
  postconf -e "disable_vrfy_command = yes"
  postconf -e "strict_rfc821_envelopes = yes"
  postconf -e "smtpd_helo_required = yes"
  postconf -e "smtpd_helo_restrictions = permit_mynetworks,permit_sasl_authenticated,reject_non_fqdn_helo_hostname,reject_invalid_helo_hostname"
  postconf -e "smtpd_recipient_restrictions = permit_sasl_authenticated,permit_mynetworks,reject_unauth_destination"
  postconf -e "smtpd_relay_restrictions = permit_mynetworks,permit_sasl_authenticated,reject_unauth_destination"

  postconf -e "virtual_mailbox_domains = pgsql:/etc/postfix/pgsql-virtual-mailbox-domains.cf"
  postconf -e "virtual_mailbox_maps = pgsql:/etc/postfix/pgsql-virtual-mailbox-maps.cf"
  postconf -e "virtual_alias_maps = pgsql:/etc/postfix/pgsql-virtual-alias-maps.cf"
  postconf -e "virtual_transport = lmtp:unix:private/dovecot-lmtp"
  postconf -e "virtual_mailbox_base = $MAILBOX_BASE_DIR"
  postconf -e "virtual_minimum_uid = $MAIL_UID"
  postconf -e "virtual_uid_maps = static:$MAIL_UID"
  postconf -e "virtual_gid_maps = static:$MAIL_GID"

  postconf -e "smtpd_sasl_auth_enable = yes"
  postconf -e "smtpd_sasl_type = dovecot"
  postconf -e "smtpd_sasl_path = private/auth"
  postconf -e "smtpd_sasl_security_options = noanonymous"
  postconf -e "broken_sasl_auth_clients = yes"

  postconf -e "smtpd_tls_cert_file = $TLS_CERT_FILE"
  postconf -e "smtpd_tls_key_file = $TLS_KEY_FILE"
  postconf -e "smtpd_tls_security_level = may"
  postconf -e "smtpd_tls_auth_only = yes"
  postconf -e "smtpd_tls_received_header = yes"
  postconf -e "smtp_tls_security_level = may"
  postconf -e "smtp_tls_loglevel = 1"
  postconf -e "tls_preempt_cipherlist = yes"

  postconf -e "milter_default_action = accept"
  postconf -e "milter_protocol = 6"
  postconf -e "smtpd_milters = inet:127.0.0.1:11332"
  postconf -e "non_smtpd_milters = inet:127.0.0.1:11332"

  sed -i '/# MAIL-PLATFORM-BEGIN/,/# MAIL-PLATFORM-END/d' /etc/postfix/master.cf
  cat >>/etc/postfix/master.cf <<'EOF'
# MAIL-PLATFORM-BEGIN
submission inet n       -       y       -       -       smtpd
  -o syslog_name=postfix/submission
  -o smtpd_tls_security_level=encrypt
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_relay_restrictions=permit_sasl_authenticated,reject
  -o milter_macro_daemon_name=ORIGINATING

smtps     inet n       -       y       -       -       smtpd
  -o syslog_name=postfix/smtps
  -o smtpd_tls_wrappermode=yes
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_relay_restrictions=permit_sasl_authenticated,reject
  -o milter_macro_daemon_name=ORIGINATING
# MAIL-PLATFORM-END
EOF
}

configure_dovecot() {
  log "Configuring Dovecot"
  set_tls_paths

  cat >/etc/dovecot/dovecot-sql.conf.ext <<EOF
driver = pgsql
connect = host=$PANEL_DB_HOST port=$PANEL_DB_PORT dbname=$PANEL_DB_NAME user=$PANEL_DB_USER password=$PANEL_DB_PASS
default_pass_scheme = BLF-CRYPT
password_query = SELECT email as user, password_hash as password FROM mail_users WHERE email = '%u' AND active = true
user_query = SELECT '/var/mail/vhosts/%d/%n' AS home, 'maildir:/var/mail/vhosts/%d/%n' AS mail, 5000 AS uid, 5000 AS gid, CONCAT('*:storage=', quota_mb, 'M') AS quota_rule FROM mail_users WHERE email = '%u' AND active = true
iterate_query = SELECT email AS user FROM mail_users WHERE active = true
EOF
  chmod 0600 /etc/dovecot/dovecot-sql.conf.ext
  chown root:root /etc/dovecot/dovecot-sql.conf.ext

  sed -i "s/^#\(!include auth-sql.conf.ext\)/\1/" /etc/dovecot/conf.d/10-auth.conf || true
  sed -i "s/^!include auth-system.conf.ext/#!include auth-system.conf.ext/" /etc/dovecot/conf.d/10-auth.conf || true
  sed -i "s/^#disable_plaintext_auth = yes/disable_plaintext_auth = yes/" /etc/dovecot/conf.d/10-auth.conf || true
  sed -i "s/^auth_mechanisms = .*/auth_mechanisms = plain login/" /etc/dovecot/conf.d/10-auth.conf || true

  cat >/etc/dovecot/conf.d/99-mail-platform.conf <<EOF
mail_location = maildir:/var/mail/vhosts/%d/%n
mail_uid = $MAIL_UID
mail_gid = $MAIL_GID
first_valid_uid = $MAIL_UID

ssl = required
ssl_cert = <$TLS_CERT_FILE
ssl_key = <$TLS_KEY_FILE

namespace inbox {
  inbox = yes
}

service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }
}

service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}

plugin {
  quota = maildir:User quota
  quota_rule = *:storage=3072M
  sieve = file:~/sieve;active=~/.dovecot.sieve
}

protocol lmtp {
  mail_plugins = \$mail_plugins quota sieve
  postmaster_address = postmaster@$HOSTNAME_FQDN
}

protocol imap {
  mail_plugins = \$mail_plugins imap_quota
}
EOF

  local imap_port="0"
  if [[ "$IMAP_STARTTLS" == "on" ]]; then
    imap_port="143"
  fi
  cat >/etc/dovecot/conf.d/99-mail-platform-ports.conf <<EOF
service imap-login {
  inet_listener imap {
    port = $imap_port
  }
  inet_listener imaps {
    port = 993
    ssl = yes
  }
}

service managesieve-login {
  inet_listener sieve {
    port = 4190
  }
}
EOF
}

configure_rspamd() {
  log "Configuring Rspamd (DKIM + ratelimit)"

  mkdir -p /etc/rspamd/local.d "$DKIM_KEY_DIR" "$(dirname "$RSPAMD_LOG_FILE")"
  chmod 0750 "$DKIM_KEY_DIR"

  cat >/etc/rspamd/local.d/redis.conf <<'EOF'
servers = "127.0.0.1:6379";
EOF

  cat >/etc/rspamd/local.d/logging.inc <<EOF
type = "file";
filename = "$RSPAMD_LOG_FILE";
level = "info";
EOF

  cat >/etc/rspamd/local.d/dkim_signing.conf <<EOF
enabled = true;
sign_authenticated = true;
allow_hdrfrom_mismatch = false;
use_domain = "header";
use_esld = false;
selector = "$DKIM_SELECTOR";
path = "$DKIM_KEY_DIR/\$domain.\$selector.key";
selector_map = "$DKIM_SELECTOR_MAP";
try_fallback = true;
EOF

  local backup=""
  if [[ -f "$RSPAMD_RATELIMIT_FILE" ]]; then
    backup="${RSPAMD_RATELIMIT_FILE}.bak.$(date +%s)"
    cp "$RSPAMD_RATELIMIT_FILE" "$backup"
  fi

  cat >"$RSPAMD_RATELIMIT_FILE" <<'EOF'
enabled = true;

rates {
  user_hour = {
    selector = "user.lower";
    bucket = "user";
    rate = "50 / 1h";
    burst = 10;
    symbol = "RATELIMIT_USER_HOUR";
  }

  user_day = {
    selector = "user.lower";
    bucket = "user";
    rate = "200 / 1d";
    burst = 20;
    symbol = "RATELIMIT_USER_DAY";
  }
}
EOF

  if ! rspamadm configtest >/tmp/rspamadm-configtest.log 2>&1; then
    warn "Rspamd configtest failed. Restoring previous ratelimit config."
    if [[ -n "$backup" && -f "$backup" ]]; then
      cp "$backup" "$RSPAMD_RATELIMIT_FILE"
    fi
    cat /tmp/rspamadm-configtest.log >&2 || true
    die "Rspamd configuration invalid."
  fi

  systemctl enable --now rspamd
  systemctl restart rspamd
  sleep 12

  if ! systemctl is-active --quiet rspamd; then
    if [[ -n "$backup" && -f "$backup" ]]; then
      cp "$backup" "$RSPAMD_RATELIMIT_FILE"
      systemctl restart rspamd || true
    fi
    die "Rspamd is not active after restart."
  fi

  local logs
  logs="$(journalctl -u rspamd --since "-3 min" --no-pager 2>/dev/null || true)"
  if echo "$logs" | grep -Eiq "cannot parse|syntax error|config error"; then
    if [[ -n "$backup" && -f "$backup" ]]; then
      cp "$backup" "$RSPAMD_RATELIMIT_FILE"
      systemctl restart rspamd || true
    fi
    die "Rspamd logs show parse/config errors after restart."
  fi
}

configure_nginx() {
  log "Configuring Nginx host for ACME/TLS endpoint"
  mkdir -p /var/www/mailhost
  cat >/var/www/mailhost/index.html <<EOF
mail host: $HOSTNAME_FQDN
EOF

  cat >/etc/nginx/sites-available/mail-platform.conf <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $HOSTNAME_FQDN;
  root /var/www/mailhost;

  location / {
    try_files \$uri /index.html;
  }
}
EOF

  ln -snf /etc/nginx/sites-available/mail-platform.conf /etc/nginx/sites-enabled/mail-platform.conf
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
}

acme_prereq_warnings() {
  log "Checking ACME prerequisites"
  local public_ip dns_a listeners
  public_ip="$(curl -4fsS --max-time 5 https://api.ipify.org || true)"
  dns_a="$(dig +short A "$HOSTNAME_FQDN" | head -n1 || true)"
  listeners="$(ss -ltnp '( sport = :80 or sport = :443 )' | awk 'NR>1 {print $4" "$NF}')"

  if [[ -z "$public_ip" ]]; then
    warn "No public IPv4 detected. ACME HTTP-01 may fail."
  fi
  if [[ -n "$public_ip" && -n "$dns_a" && "$public_ip" != "$dns_a" ]]; then
    warn "A record for $HOSTNAME_FQDN ($dns_a) does not match detected public IP ($public_ip)."
    warn "If Cloudflare proxy is enabled (orange cloud), HTTP-01 validation commonly fails."
  fi
  if [[ -n "$listeners" ]]; then
    warn "Current listeners on 80/443:"
    echo "$listeners" >&2
  fi
}

configure_acme() {
  if [[ "$ACME_MODE" == "skip" ]]; then
    warn "Skipping Let's Encrypt (--acme skip). Ports 80/443 stay open."
    return
  fi

  [[ -n "$ADMIN_EMAIL" ]] || die "--admin-email is required when --acme auto"
  acme_prereq_warnings

  log "Requesting TLS certificate via certbot"
  certbot --nginx --non-interactive --agree-tos -m "$ADMIN_EMAIL" -d "$HOSTNAME_FQDN" --redirect
  set_tls_paths
}

reload_mail_services() {
  log "Reloading Postfix, Dovecot, and Nginx"
  set_tls_paths

  postconf -e "smtpd_tls_cert_file = $TLS_CERT_FILE"
  postconf -e "smtpd_tls_key_file = $TLS_KEY_FILE"
  postconf -e "smtpd_tls_security_level = may"

  # keep Dovecot TLS paths in managed file in sync
  sed -i "s|^ssl_cert = <.*|ssl_cert = <$TLS_CERT_FILE|" /etc/dovecot/conf.d/99-mail-platform.conf
  sed -i "s|^ssl_key = <.*|ssl_key = <$TLS_KEY_FILE|" /etc/dovecot/conf.d/99-mail-platform.conf

  postfix check
  doveconf -n >/tmp/doveconf-effective.conf
  nginx -t

  systemctl enable --now redis-server postgresql postfix dovecot rspamd nginx fail2ban chrony
  systemctl restart redis-server postgresql postfix dovecot rspamd nginx
}

health_checks() {
  log "Running service health checks"
  local service
  for service in redis-server postgresql postfix dovecot rspamd nginx fail2ban chrony; do
    systemctl is-active --quiet "$service" || die "Service not active: $service"
  done

  if ! ss -ltn | grep -q ':25 '; then
    die "SMTP port 25 is not listening"
  fi
  if ! ss -ltn | grep -q ':587 '; then
    die "SMTP submission port 587 is not listening"
  fi
  if ! ss -ltn | grep -q ':465 '; then
    warn "SMTPS 465 not listening; verify master.cf smtps service."
  fi
  if ! ss -ltn | grep -q ':993 '; then
    die "IMAPS 993 is not listening"
  fi
}

configure_panel_env() {
  local panel_dir="$SCRIPT_DIR/panel"
  local env_example="$panel_dir/.env.example"
  local env_file="$panel_dir/.env"
  local generated_admin_password_file="/root/mail-platform-admin-password.txt"

  [[ -d "$panel_dir" ]] || return 0

  if [[ ! -f "$env_file" && -f "$env_example" ]]; then
    cp "$env_example" "$env_file"
  fi

  if [[ -f "$env_file" ]]; then
    set_env_value "$env_file" "NODE_ENV" "production"
    set_env_value "$env_file" "PANEL_HOST" "$PANEL_BIND_HOST"
    set_env_value "$env_file" "PANEL_PORT" "$PANEL_BIND_PORT"
    set_env_value "$env_file" "DATABASE_URL" "postgres://$PANEL_DB_USER:$PANEL_DB_PASS@$PANEL_DB_HOST:$PANEL_DB_PORT/$PANEL_DB_NAME"
    set_env_value "$env_file" "ADMIN_USER" "admin"
    set_env_value "$env_file" "MAIL_HOSTNAME" "$HOSTNAME_FQDN"
    set_env_value "$env_file" "MAIL_DB_URL" "postgres://$PANEL_DB_USER:$PANEL_DB_PASS@$PANEL_DB_HOST:$PANEL_DB_PORT/$PANEL_DB_NAME"
    set_env_value "$env_file" "DKIM_SELECTOR" "$DKIM_SELECTOR"
    set_env_value "$env_file" "DKIM_KEYS_DIR" "$DKIM_KEY_DIR"
    set_env_value "$env_file" "DKIM_SELECTOR_MAP" "$DKIM_SELECTOR_MAP"
    set_env_value "$env_file" "RSPAMD_LOG_PATH" "$RSPAMD_LOG_FILE"
    set_env_value "$env_file" "RSPAMD_RELOAD_CMD" "sudo -n /bin/systemctl reload rspamd"
    set_env_value "$env_file" "SKIP_RSPAMD_RELOAD" "false"
    set_env_value "$env_file" "TRUST_PROXY" "false"
    set_env_value "$env_file" "SESSION_COOKIE_NAME" "mailpanel.sid"
    set_env_value "$env_file" "SESSION_COOKIE_SECURE" "false"
    set_env_value "$env_file" "SESSION_COOKIE_SAMESITE" "lax"
    set_env_value "$env_file" "SESSION_COOKIE_MAX_AGE_MS" "28800000"
    set_env_value "$env_file" "VIEW_CACHE" "true"
    set_env_value "$env_file" "STATIC_MAX_AGE" "1h"

    if ! grep -qE '^SESSION_SECRET=' "$env_file" || grep -qE '^SESSION_SECRET=(replace-with-long-random-secret|change-this-session-secret)?$' "$env_file"; then
      set_env_value "$env_file" "SESSION_SECRET" "$(random_secret)"
    fi

    if ! grep -qE '^ADMIN_PASSWORD=' "$env_file" || grep -qE '^ADMIN_PASSWORD=(change-me-now)?$' "$env_file"; then
      local generated_password
      generated_password="$(random_secret | cut -c1-20)"
      set_env_value "$env_file" "ADMIN_PASSWORD" "$generated_password"
      umask 077
      printf '%s\n' "$generated_password" >"$generated_admin_password_file"
      log "Generated panel admin password and stored at $generated_admin_password_file"
    fi

    chown root:root "$env_file"
    chmod 0600 "$env_file"
  fi
}

install_panel_service() {
  if [[ "$INSTALL_PANEL_SERVICE" != "on" ]]; then
    warn "Skipping panel systemd installation (--install-panel-service off)."
    return
  fi

  local installer="$SCRIPT_DIR/panel/install-panel-service.sh"
  if [[ ! -f "$installer" ]]; then
    warn "Panel service installer missing: $installer"
    return
  fi

  chmod +x "$installer"
  log "Installing panel systemd service"
  "$installer" --panel-dir "$SCRIPT_DIR/panel" --service-name "mail-platform-panel" --service-user "mailpanel" --service-group "mailpanel"
}

print_summary() {
  set_tls_paths
  cat <<EOF

Native mail stack setup complete.

Key outputs:
  Hostname: $HOSTNAME_FQDN
  TLS cert: $TLS_CERT_FILE
  DB URL: postgres://$PANEL_DB_USER:<redacted>@$PANEL_DB_HOST:$PANEL_DB_PORT/$PANEL_DB_NAME
  Panel bind: http://$PANEL_BIND_HOST:$PANEL_BIND_PORT
  Panel service install: $INSTALL_PANEL_SERVICE

Run panel:
  systemctl status mail-platform-panel --no-pager
  journalctl -u mail-platform-panel -f
  curl -fsS http://127.0.0.1:$PANEL_BIND_PORT/healthz

Recommended next checks:
  systemctl status postfix dovecot rspamd nginx --no-pager
  postconf -n | grep -E 'myhostname|virtual_mailbox_domains|smtpd_milters'
  doveconf -n | grep -E 'mail_location|passdb|userdb|ssl'
  tail -n 100 $RSPAMD_LOG_FILE

Remember:
  - Set PTR/rDNS of server IP to $HOSTNAME_FQDN.
  - Publish SPF, DKIM, DMARC for each mailbox domain from panel output.
  - Keep panel access through SSH tunnel only.
EOF

  if [[ -f /root/mail-platform-admin-password.txt ]]; then
    printf '  - Initial admin password file: /root/mail-platform-admin-password.txt\n'
  fi
}

main() {
  parse_args "$@"
  require_root
  check_compat_flags

  install_packages
  set_timezone_and_hostname
  configure_time_sync
  configure_ufw
  configure_fail2ban
  ensure_postgres_db
  apply_schema_if_present
  configure_vmail_user
  write_postfix_pgsql_maps
  configure_postfix
  configure_dovecot
  configure_rspamd
  configure_nginx
  configure_acme
  reload_mail_services
  health_checks
  configure_panel_env
  install_panel_service
  print_summary
}

main "$@"
