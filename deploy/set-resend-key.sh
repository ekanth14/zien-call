#!/bin/bash
# Zien Call: store the Resend API key for email verification (input is hidden, never echoed or logged).
set -e
cd /opt/private-call
read -rsp 'Paste your Resend API key (starts with re_): ' KEY; echo
case "$KEY" in re_*) ;; *) echo 'That does not look like a Resend key (it should start with re_). Nothing changed.'; exit 1 ;; esac
CUR=$(grep '^MAIL_FROM=' .env | cut -d= -f2- || true)
DEF=${CUR:-Zien Call <no-reply@zienorganisation.online>}
read -rp "Send emails from [$DEF]: " FROM; FROM=${FROM:-$DEF}
umask 077
grep -v -e '^RESEND_API_KEY=' -e '^MAIL_FROM=' -e '^SMTP_USER=' -e '^SMTP_PASS=' .env > .env.tmp || true
printf 'RESEND_API_KEY=%s\nMAIL_FROM=%s\n' "$KEY" "$FROM" >> .env.tmp
chown --reference=.env .env.tmp 2>/dev/null || true
mv .env.tmp .env && chmod 600 .env
unset KEY
docker compose up -d --force-recreate webapp >/dev/null 2>&1
sleep 6
docker compose logs --tail=6 webapp | grep -iE 'resend|email' || true
echo 'Saved. Now open https://call.zienorganisation.online/admin and press "Send test email".'
