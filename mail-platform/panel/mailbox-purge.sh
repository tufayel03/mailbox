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
  # If storage is not created yet, purge is a no-op.
  printf '{"ok":true,"deletedFiles":0,"deletedBytes":0,"path":"%s","maildirExists":false}\n' \
    "$(json_escape "$MAILDIR")"
  exit 0
fi

DELETED_FILES=0
DELETED_BYTES=0

while IFS= read -r -d '' dir; do
  while IFS= read -r -d '' file; do
    FILE_SIZE="$(stat -c '%s' "$file" 2>/dev/null || echo 0)"
    rm -f -- "$file"
    DELETED_FILES=$((DELETED_FILES + 1))
    DELETED_BYTES=$((DELETED_BYTES + FILE_SIZE))
  done < <(find "$dir" -maxdepth 1 -type f -print0)
done < <(find "$MAILDIR" -type d \( -name cur -o -name new \) -print0)

printf '{"ok":true,"deletedFiles":%s,"deletedBytes":%s,"path":"%s"}\n' \
  "$DELETED_FILES" \
  "$DELETED_BYTES" \
  "$(json_escape "$MAILDIR")"
