#!/usr/bin/env bash
# Für Entwickler: baut Shipli aus dem Arbeitsbaum, schiebt das Image nach zot im eigenen Cluster und rollt es aus.
# Installationen ohne eigenen Build nehmen install/update.sh (Image von ghcr.io).
# Aufruf (mit kubectl auf den Cluster): deploy/release.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG=${KUBECONFIG:-$HOME/.kube/shipli.yaml}
. infra/env.sh
ZOT=$first:30500
# Konto "release" (scripts/zot-sync.ts), darf als einziges nach shipli/**
ZOT_AUTH="release:$(secret zot-release)"
tag=$(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo -dirty)

docker build -q -t "shipli-app:$tag" . >/dev/null
# skopeo statt docker push: zot spricht nur HTTP, und der Docker-Daemon soll dafür nicht umkonfiguriert werden
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
docker save -o "$tmp/image.tar" "shipli-app:$tag"
docker run --rm -v "$tmp:/work:ro" quay.io/skopeo/stable:v1.20.0 \
  copy --dest-tls-verify=false --dest-creds "$ZOT_AUTH" docker-archive:/work/image.tar "docker://$ZOT/shipli/app:$tag" >/dev/null
digest=$(curl -fsSI -u "$ZOT_AUTH" -H 'Accept: application/vnd.oci.image.manifest.v1+json' -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
  "http://$ZOT/v2/shipli/app/manifests/$tag" | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}' | tr -d '\r')

infra/rollout.sh "localhost:30500/shipli/app@$digest"
