# Production Deployment (Ubuntu 24.04 VPS)

## 1) Clone and run server bootstrap

```bash
sudo mkdir -p /opt/mail-platform
sudo chown "$USER":"$USER" /opt/mail-platform
cd /opt/mail-platform
git clone https://github.com/tufayel03/mailbox.git
cd mailbox/mail-platform
chmod +x setup-mailserver.sh
sudo ./setup-mailserver.sh \
  --hostname mail.mailhost.com \
  --timezone UTC \
  --admin-email you@example.com \
  --acme auto \
  --imap-starttls off \
  --install-panel-service on
```

## 2) Verify service status

```bash
sudo systemctl status postfix dovecot rspamd redis-server postgresql nginx fail2ban chrony --no-pager
sudo systemctl status mail-platform-panel --no-pager
```

## 3) Verify panel health

```bash
curl -fsS http://127.0.0.1:3101/healthz
```

Expected output:

```json
{"status":"ok"}
```

## 4) Access panel securely (SSH tunnel)

On your local machine:

```bash
ssh -L 3101:127.0.0.1:3101 user@your-vps-ip
```

Open:

```text
http://127.0.0.1:3101/login
```

## 5) Locate generated admin password (if auto-generated)

If `.env` had placeholder admin password, installer writes the generated password to:

```bash
sudo cat /root/mail-platform-admin-password.txt
```

## 6) Production runtime commands

```bash
sudo systemctl restart mail-platform-panel
sudo systemctl stop mail-platform-panel
sudo systemctl start mail-platform-panel
sudo journalctl -u mail-platform-panel -f
```

## 7) Update deployment

```bash
cd ~/mailbox
git pull
cd mail-platform/panel
npm ci --omit=dev
npm run db:init
sudo systemctl restart mail-platform-panel
```

## 8) Required DNS and network checks

- `A` for `mail.mailhost.com` -> VPS public IP
- `PTR/rDNS` for VPS IP -> `mail.mailhost.com`
- Ports reachable: `25, 465, 587, 993, 80, 443, 4190` (`143` only if enabled)
- For each mailbox domain: publish MX/SPF/DKIM/DMARC/autodiscover/autoconfig from panel output

## 9) Backup essentials

Back up:

- PostgreSQL database `mailpanel`
- `/etc/postfix/`
- `/etc/dovecot/`
- `/etc/rspamd/`
- `/etc/letsencrypt/`
- `/var/mail/vhosts/`
- `mail-platform/panel/.env`
