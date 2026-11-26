#!/usr/bin/env bash
# Rollt Shipli mit einem Image aus: Secrets, deploy/shipli.yaml, warten, bis Oberfläche und zot antworten.
# Aufruf: infra/rollout.sh <image>   (von deploy/release.sh, install/proxmox.sh install und update)
set -euo pipefail
cd "$(dirname "$0")/.."
. infra/env.sh
# Tag -> Digest für Images von ghcr.io: k3s holt ein vorhandenes Tag (main, latest) sonst nie neu
pin() {
  case $1 in *@*) echo "$1"; return ;; ghcr.io/*:*) ;; *) echo "$1"; return ;; esac
  local repo=${1%:*} path tag=${1##*:} tok digest
  path=${repo#ghcr.io/}
  tok=$(curl -fsS "https://ghcr.io/token?scope=repository:$path:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  digest=$(curl -fsSI -H "Authorization: Bearer $tok" -H 'Accept: application/vnd.oci.image.index.v1+json' \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json' "https://ghcr.io/v2/$path/manifests/$tag" \
    | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}' | tr -d '\r')
  [ -n "$digest" ] || { echo "Image $1 nicht gefunden" >&2; exit 1; }
  echo "$repo@$digest"
}
image=$(pin "$1")
manifest=$(SHIPLI_IMAGE=$image infra/render.sh deploy/shipli.yaml)
infra/secrets.sh

# Ein Neustart von Shipli bricht laufende Deploys ab (sie laufen im Prozess von Next.js), also erst warten
running() {
  k -n shipli-system exec postgres-0 -- psql -U shipli -d shipli -tAc \
    "SELECT count(*) FROM deployments WHERE status = 'building' AND created_at > now() - interval '20 minutes'" 2>/dev/null || echo 0
}
for i in $(seq 1 120); do
  n=$(running)
  [ "$n" = 0 ] && break
  [ "$i" = 1 ] && echo "Warte auf $n laufende(n) Deploy(s), höchstens 20 min …"
  [ "$i" = 120 ] && { echo "Abbruch: nach 20 min laufen noch $n Deploy(s), nichts ausgerollt" >&2; exit 1; }
  sleep 10
done
k apply -f - <<<"$manifest" | grep -v unchanged || true
# beim ersten Mal kommen Longhorn-Volume und Image dazu, das dauert länger
k -n shipli-system rollout status deploy/shipli --timeout="${SHIPLI_ROLLOUT_TIMEOUT:-300s}"
k -n shipli-system rollout status deploy/zot-sync --timeout=120s
# zot startet erst, wenn zot-sync sein Secret zot-zugang angelegt hat
k -n zot rollout status statefulset/zot --timeout="${SHIPLI_ROLLOUT_TIMEOUT:-300s}"
# -k: das Zertifikat gibt es erst, wenn DNS und Portweiterleitung stehen. Traefik lädt den neuen Pod erst nach ein
# paar Sekunden (davor 503), darum bis 60 s warten
for _ in $(seq 1 12); do
  ui=$(curl -sk -o /dev/null -w '%{http_code}' -m 10 --resolve "$SHIPLI_HOST:443:$SHIPLI_INGRESS_IP" "https://$SHIPLI_HOST/login" || true)
  [ "$ui" = 200 ] && break; sleep 5
done
zot=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://$first:30500/v2/" || true)
[ "$ui" = 200 ] && [ "$zot" = 401 ] || { echo "Nach dem Rollout: Oberfläche $ui (soll 200), zot ohne Login $zot (soll 401)" >&2; exit 1; }
echo "Shipli läuft mit $image"
