# Mail Platform Workspace

This repository contains a private multi-domain email platform with a native Ubuntu stack (no Docker).

## Main project

- `mail-platform/`

## Full usage guide

- `mail-platform/README.md` (complete setup + operations guide)
- `mail-platform/docs/run-commands.md`
- `mail-platform/docs/production-deploy.md`

## Quick flow

1. Install mail stack on Ubuntu:
   - `cd mail-platform`
   - `sudo ./setup-mailserver.sh --hostname mail.mailhost.com --timezone UTC --admin-email you@example.com --acme auto --install-panel-service on`
2. Start panel:
   - `sudo systemctl status mail-platform-panel --no-pager`
   - `curl -fsS http://127.0.0.1:3001/healthz`
3. Login:
   - `http://127.0.0.1:3001/login`
4. Add domain:
   - `Domains -> Add Domain -> DNS JSON -> publish DNS -> Check DNS`
5. Create mailbox:
   - `Mailboxes -> Create Mailbox`

## CloudPanel Node.js Site (Current)

- Domain: `mailbox.bidnsteal.com`
- Node.js: `Node 22 LTS`
- App Port: `3101`
- Site User: `mailbox`
- Site password: saved in local file `mail-platform/docs/cloudpanel-credentials.local.md` (gitignored)
