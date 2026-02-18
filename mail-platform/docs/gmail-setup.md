# Gmail / Client Setup

Use **Other** account type (IMAP).

## Incoming (IMAP)

- Server: `mail.mailhost.com`
- Port: `993`
- Security: SSL/TLS
- Username: full email address (example: `admin@domain1.com`)
- Password: mailbox password

## Outgoing (SMTP)

- Server: `mail.mailhost.com`
- Port: `587` (STARTTLS) or `465` (SSL/TLS)
- Username: full email address
- Password: mailbox password
- Authentication: required

## Webmail

This build manages accounts only. Use any IMAP webmail client you install separately (for example Roundcube).
