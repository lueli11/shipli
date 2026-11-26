#!/usr/bin/env bash
# Legt die Secrets an, die deploy/shipli.yaml braucht. Wiederholbar: shipli-db und shipli-admin nur, wenn sie fehlen
# (Postgres behält sein erstes Passwort), zot-konten und zot-read immer aus dem Konfig-Ordner (infra/env.sh).
# Werte nur per stdin an kubectl, nie in argv.
set -euo pipefail
. "$(dirname "$0")/env.sh"
# sec <name> <namespace> key=wert...
sec() {
  printf 'apiVersion: v1\nkind: Secret\nmetadata: { name: %s, namespace: %s }\ndata:\n' "$1" "$2"; shift 2
  for kv in "$@"; do printf '  %s: %s\n' "${kv%%=*}" "$(printf %s "${kv#*=}" | base64 -w0)"; done
}
missing() { ! k -n "$2" get secret "$1" >/dev/null 2>&1; }

for ns in shipli-system shipli-builds; do k get ns "$ns" >/dev/null 2>&1 || k create ns "$ns" >/dev/null; done
{
  if missing shipli-db shipli-system; then sec shipli-db shipli-system "password=$(openssl rand -hex 24)"; echo ---; fi
  if [ -n "${SHIPLI_ADMIN_EMAIL:-}" ] && missing shipli-admin shipli-system; then
    sec shipli-admin shipli-system "email=$SHIPLI_ADMIN_EMAIL" "password=$(secret admin-password)"; echo ---
  fi
  sec zot-konten shipli-system "release=$(secret zot-release)" "puller=$(secret zot-puller)"; echo ---
  # Shipli liest damit die Imagegrösse für „Nutzung“
  sec zot-read shipli-system "auth=puller:$(secret zot-puller)"
} | k apply -f - >/dev/null
echo "Secrets in shipli-system aktuell"
