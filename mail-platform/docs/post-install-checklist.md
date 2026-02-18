# Post Install Checklist

## Network and identity

- [ ] Hostname resolves: `mail.mailhost.com`
- [ ] PTR (rDNS) points to `mail.mailhost.com`
- [ ] Port 25 reachable from internet
- [ ] Ports 80/443 reachable (for ACME/UI)

## DNS for each mail domain

- [ ] MX points to `mail.mailhost.com`
- [ ] SPF published and aligned
- [ ] DKIM published and valid
- [ ] DMARC published: `p=quarantine`
- [ ] `autodiscover` and `autoconfig` published

## SMTP/IMAP security

- [ ] SMTP submission works on 587 with STARTTLS
- [ ] IMAPS works on 993
- [ ] TLS certificate valid on `mail.mailhost.com`
- [ ] Open relay test fails (as expected)
- [ ] Optional webmail (if installed) can authenticate via IMAP/SMTP

## Reputation controls

- [ ] Outbound limits active (`50/hour`, `200/day`)
- [ ] Warning/disable worker running
- [ ] Abuse mailbox disable and manual re-enable tested

## Time sync

- [ ] `chrony` or `chronyd` active
- [ ] System time in sync
