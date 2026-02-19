# Run Commands

## CloudPanel PM2 Runtime (your current VPS)

Current live runtime:
- PM2 startup service: `pm2-mailbox`
- PM2 app: `mailbox-panel`
- Panel URL: `https://mailbox.bidnsteal.com/login`

After each `git push`, run:

```bash
sudo -u mailbox -H bash -lc '
set -e
export NVM_DIR="/home/mailbox/.nvm"
. /home/mailbox/.nvm/nvm.sh
nvm use 22 >/dev/null
cd /home/mailbox/htdocs/mailbox.bidnsteal.com/app/mailbox
git pull --ff-only origin main
cd mail-platform/panel
npm ci --omit=dev
npm run db:init
pm2 describe mailbox-panel >/dev/null 2>&1 || pm2 start server.js --name mailbox-panel --update-env
pm2 restart mailbox-panel --update-env
pm2 save
pm2 status
'
curl -fsS http://127.0.0.1:3101/healthz
```

Quick checks:

```bash
sudo systemctl status pm2-mailbox --no-pager
sudo -u mailbox -H bash -lc 'export NVM_DIR="/home/mailbox/.nvm"; . /home/mailbox/.nvm/nvm.sh; nvm use 22 >/dev/null; pm2 status'
```

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

## Gmail connection failed (quick triage)

```bash
# On VPS: required mail ports listening
ss -ltnp | egrep ':25|:465|:587|:993|:4190'

# On VPS: host firewall allows mail ports
sudo ufw status numbered

# From your local machine: public reachability
Test-NetConnection mail.bidnsteal.com -Port 993
Test-NetConnection mail.bidnsteal.com -Port 587
Test-NetConnection mail.bidnsteal.com -Port 465
```

If local tests fail but VPS listens, open cloud firewall/security-list ports:
- TCP `25,465,587,993,4190` (and `143` only if needed).

## Outbound blocked on OCI Free Trial (relay workaround)

If outbound `25` is blocked, route outgoing mail through relay SMTP on `587`.

```bash
cd /path/to/mail-platform
chmod +x configure-relayhost.sh
sudo ./configure-relayhost.sh \
  --host smtp-relay.example.com \
  --port 587 \
  --user your-relay-username \
  --pass 'your-relay-password'
```

Then flush queue:

```bash
sudo postqueue -f
sudo postqueue -p
```

If applying relay from panel UI (`Security -> SMTP Relay Settings`), allow the panel user to run relay script without password:

```bash
sudo tee /etc/sudoers.d/mailbox-relay >/dev/null <<'EOF'
mailbox ALL=(root) NOPASSWD: /home/mailbox/htdocs/mailbox.bidnsteal.com/app/mailbox/mail-platform/configure-relayhost.sh
mailbox ALL=(root) NOPASSWD: /usr/sbin/postqueue
EOF
sudo chmod 0440 /etc/sudoers.d/mailbox-relay
sudo visudo -cf /etc/sudoers.d/mailbox-relay
```
