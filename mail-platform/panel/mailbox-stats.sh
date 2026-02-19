#!/usr/bin/env bash
set -euo pipefail

EMAIL="${1:-}"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

fail() {
  local msg
  msg="$(json_escape "$1")"
  printf '{"ok":false,"error":"%s"}\n' "$msg"
  exit 1
}

extract_home_path() {
  local email="$1"
  local line=""
  line="$(doveadm user -u "$email" -f home 2>/dev/null | awk -F'\t' 'NR==1 { print $2 }')"
  if [[ -n "$line" ]]; then
    printf '%s\n' "$line"
    return 0
  fi

  line="$(doveadm user -u "$email" 2>/dev/null | tr ' ' '\n' | sed -n 's/^home=//p' | head -n1)"
  if [[ -n "$line" ]]; then
    printf '%s\n' "$line"
    return 0
  fi

  return 1
}

[[ -n "$EMAIL" ]] || fail "Missing mailbox email argument"
if [[ ! "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  fail "Invalid mailbox email format"
fi

command -v doveadm >/dev/null 2>&1 || fail "doveadm command not found"

HOME_DIR="$(extract_home_path "$EMAIL" || true)"
if [[ -z "$HOME_DIR" ]]; then
  DOMAIN="${EMAIL##*@}"
  LOCAL="${EMAIL%@*}"
  HOME_DIR="/var/mail/vhosts/${DOMAIN}/${LOCAL}"
fi

MAILDIR="$HOME_DIR"
if [[ -d "$HOME_DIR/Maildir" ]]; then
  MAILDIR="$HOME_DIR/Maildir"
fi

if [[ ! -d "$MAILDIR" ]]; then
  # New mailboxes may not have materialized on disk yet.
  printf '{"ok":true,"usedBytes":0,"inboxCount":0,"sentCount":0,"path":"%s","maildirExists":false}\n' \
    "$(json_escape "$MAILDIR")"
  exit 0
fi

USED_BYTES="$(du -sb "$MAILDIR" 2>/dev/null | awk '{print $1}' | head -n1)"
if [[ -z "$USED_BYTES" ]]; then
  USED_KB="$(du -sk "$MAILDIR" 2>/dev/null | awk '{print $1}' | head -n1)"
  USED_BYTES=$(( ${USED_KB:-0} * 1024 ))
fi

INBOX_COUNT="$(doveadm mailbox status -u "$EMAIL" messages INBOX 2>/dev/null | sed -n 's/.*messages=\([0-9][0-9]*\).*/\1/p' | head -n1)"
INBOX_COUNT="${INBOX_COUNT:-0}"

SENT_BOX="$(doveadm mailbox list -u "$EMAIL" 2>/dev/null | grep -Eim1 '^(Sent|Sent Messages|Sent Items|INBOX\.Sent|INBOX\.Sent Messages|INBOX\.Sent Items)$' || true)"
if [[ -z "$SENT_BOX" ]]; then
  SENT_BOX="$(doveadm mailbox list -u "$EMAIL" 2>/dev/null | grep -Eim1 'sent' || true)"
fi

SENT_COUNT="0"
if [[ -n "$SENT_BOX" ]]; then
  SENT_COUNT="$(doveadm mailbox status -u "$EMAIL" messages "$SENT_BOX" 2>/dev/null | sed -n 's/.*messages=\([0-9][0-9]*\).*/\1/p' | head -n1)"
  SENT_COUNT="${SENT_COUNT:-0}"
fi

printf '{"ok":true,"usedBytes":%s,"inboxCount":%s,"sentCount":%s,"path":"%s"}\n' \
  "${USED_BYTES:-0}" \
  "${INBOX_COUNT:-0}" \
  "${SENT_COUNT:-0}" \
  "$(json_escape "$MAILDIR")"
