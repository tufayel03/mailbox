# Mail Platform Workspace

This repository contains a private multi-domain email platform with a native Ubuntu stack (no Docker).

## Main project

- `mail-platform/`

## Full usage guide

- `mail-platform/README.md` (complete setup + operations guide)
- `mail-platform/docs/run-commands.md`

## Quick flow

1. Install mail stack on Ubuntu:
   - `cd mail-platform`
   - `sudo ./setup-mailserver.sh --hostname mail.mailhost.com --timezone UTC --admin-email you@example.com --acme auto`
2. Start panel:
   - `cd mail-platform/panel`
   - `cp .env.example .env`
   - set `SESSION_SECRET`, `DATABASE_URL`, `ADMIN_PASSWORD`
   - `npm install && npm run db:init && npm run dev`
3. Login:
   - `http://127.0.0.1:3001/login`
4. Add domain:
   - `Domains -> Add Domain -> DNS JSON -> publish DNS -> Check DNS`
5. Create mailbox:
   - `Mailboxes -> Create Mailbox`
