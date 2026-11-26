#!/usr/bin/env bash
# k3s spielt /var/lib/rancher/k3s/server/manifests auf der ersten Node bei jedem Neustart ein; ein kubectl apply an
# diesen Dateien vorbei geht dabei verloren. Die Dateien in infra/manifests sind Vorlagen (infra/render.sh).
# Ohne Argument nur vergleichen (Exit 1 bei Abweichung), mit --apply dorthin kopieren, k3s übernimmt sie dann sofort.
# Aufruf: infra/manifests-sync.sh [--apply] [node-ip]
set -euo pipefail
cd "$(dirname "$0")"
. ./env.sh
apply=0; [ "${1:-}" = --apply ] && { apply=1; shift; }
host=ubuntu@${1:-$first}
dir=/var/lib/rancher/k3s/server/manifests
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for f in manifests/*.yaml; do render "$f" > "$tmp/${f#manifests/}"; done

if [ $apply = 1 ]; then
  tar -C "$tmp" -c . | ssh -o BatchMode=yes "$host" "sudo install -d $dir && sudo tar -C $dir -x --no-same-owner"
  echo "Kopiert nach $host:$dir: $(cd "$tmp" && echo *.yaml)"
  exit 0
fi

same=0
for f in "$tmp"/*.yaml; do
  n=$(basename "$f")
  ssh -o BatchMode=yes "$host" "sudo cat $dir/$n" 2>/dev/null | diff -u --label "$host:$n" --label "repo:$n" - "$f" || same=1
done
[ $same = 0 ] && echo "$host hat denselben Stand wie infra/manifests"
exit $same
