# Run Commands

## CloudPanel deploy path (your site)

Use this exact path for your Node.js site user:

```bash
cd /home/mailbox/htdocs/mailbox.bidnsteal.com
```

## CloudPanel deploy commands (no Docker)

```bash
cd /home/mailbox/htdocs/mailbox.bidnsteal.com
mkdir -p app
cd app
git clone https://github.com/tufayel03/mailbox.git
cd mailbox/mail-platform/panel
cp .env.example .env
npm ci --omit=dev
npm run db:init
```

CloudPanel Node.js app settings:
- App root: `/home/mailbox/htdocs/mailbox.bidnsteal.com/app/mailbox/mail-platform/panel`
- App port: `3101`
- Start command: `npm start`

## Production VPS bootstrap (recommended)

```bash
cd /path/to/mail-platform
chmod +x setup-mailserver.sh
sudo ./setup-mailserver.sh \
  --hostname mail.mailhost.com \
  --timezone UTC \
  --admin-email you@example.com \
  --acme auto \
  --imap-starttls off \
  --install-panel-service on
```

## Optional setup flags

```bash
# bring stack up first and skip ACME issuance
sudo ./setup-mailserver.sh --hostname mail.mailhost.com --acme skip

# keep existing server hostname untouched
sudo ./setup-mailserver.sh --hostname mail.mailhost.com --no-hostname-change

# enable legacy IMAP STARTTLS port 143
sudo ./setup-mailserver.sh --hostname mail.mailhost.com --imap-starttls on

# do not auto-install panel systemd service
sudo ./setup-mailserver.sh --hostname mail.mailhost.com --install-panel-service off
```

## Panel service operations

```bash
sudo systemctl status mail-platform-panel --no-pager
sudo systemctl restart mail-platform-panel
sudo journalctl -u mail-platform-panel -f
curl -fsS http://127.0.0.1:3101/healthz
```

## Manual panel setup (if service install skipped)

```bash
cd /path/to/mail-platform/panel
cp .env.example .env
# edit .env values
npm ci --omit=dev
npm run db:init
npm start
```

## Install panel service manually

```bash
cd /path/to/mail-platform/panel
chmod +x install-panel-service.sh
sudo ./install-panel-service.sh
```

## Panel access

Panel bind is local-only by default:

```text
http://127.0.0.1:3101
```

SSH tunnel from your workstation:

```bash
ssh -L 3101:127.0.0.1:3101 user@your-server
```

## Core service checks

```bash
sudo systemctl status postfix dovecot rspamd redis-server postgresql nginx --no-pager
postconf -n | grep -E 'myhostname|virtual_mailbox_domains|smtpd_milters'
doveconf -n | grep -E 'mail_location|passdb|userdb|ssl'
tail -n 120 /var/log/rspamd/rspamd.log
sudo ufw status verbose
```
