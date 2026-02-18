# Run Commands

## 1) Native server setup (Ubuntu 24.04)

```bash
cd /path/to/mail-platform
chmod +x setup-mailserver.sh
sudo ./setup-mailserver.sh \
  --hostname mail.mailhost.com \
  --timezone UTC \
  --admin-email you@example.com \
  --acme auto \
  --imap-starttls off
```

### Optional flags

```bash
# bring stack up first and skip ACME issuance
sudo ./setup-mailserver.sh --hostname mail.mailhost.com --acme skip

# keep existing server hostname untouched
sudo ./setup-mailserver.sh --hostname mail.mailhost.com --no-hostname-change

# enable legacy IMAP STARTTLS port 143
sudo ./setup-mailserver.sh --hostname mail.mailhost.com --imap-starttls on
```

## 2) Internal panel

```bash
cd /path/to/mail-platform/panel
cp .env.example .env
# edit .env values
npm install
npm run db:init
npm start
```

Permission note:

- Domain add/remove triggers DKIM key write (`/etc/rspamd/dkim`) and `systemctl reload rspamd`.
- Run panel as a user with those permissions (root or tightly scoped sudo rule for `openssl` + `systemctl reload rspamd`).

Panel default bind:

- `http://127.0.0.1:3001`

SSH tunnel from your workstation:

```bash
ssh -L 3001:127.0.0.1:3001 user@your-server
```

## 3) Native service checks

```bash
systemctl status postfix dovecot rspamd redis-server postgresql nginx --no-pager
postconf -n | grep -E 'myhostname|virtual_mailbox_domains|smtpd_milters'
doveconf -n | grep -E 'mail_location|passdb|userdb|ssl'
tail -n 120 /var/log/rspamd/rspamd.log
sudo ufw status verbose
```
