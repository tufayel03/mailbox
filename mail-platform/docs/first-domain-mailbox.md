# First Domain and Mailbox

## Add first domain

1. Login to panel at `http://127.0.0.1:3001`.
2. Open **Domains**.
3. Add domain (example: `domain1.com`).
4. Click **DNS JSON** and publish records at your DNS provider.
5. Click **Check DNS** until all required records pass.

## Add first mailbox

1. Open **Mailboxes**.
2. In **Create Mailbox** set:
   - local part: `admin`
   - domain: `domain1.com`
   - name: `Domain Admin`
   - password: strong random password
   - quota: e.g. `3072`
3. Submit.

Result mailbox: `admin@domain1.com`