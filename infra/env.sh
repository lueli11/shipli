# shellcheck shell=bash
# Wird von den Skripten in infra/ und install/ eingebunden: lädt die Konfiguration und leitet Werte daraus ab.
# Konfiguration: $SHIPLI_ENV, sonst ~/.config/shipli/shipli.env (Vorlage install/shipli.env.example).
# Im selben Ordner liegen die Geheimnisse (k3s-token, zot-release, zot-puller), nur dort und nie im Repo.
SHIPLI_ENV=${SHIPLI_ENV:-$HOME/.config/shipli/shipli.env}
[ -f "$SHIPLI_ENV" ] || { echo "Konfiguration $SHIPLI_ENV fehlt (Vorlage: install/shipli.env.example)" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$SHIPLI_ENV"
set +a
state=$(dirname "$SHIPLI_ENV")
read -ra nodes <<<"$SHIPLI_NODES"
first=${nodes[0]}
# Longhorn: eine Kopie pro Node, höchstens 3
export SHIPLI_REPLICAS=$(( ${#nodes[@]} < 3 ? ${#nodes[@]} : 3 ))
render() { "$(dirname "${BASH_SOURCE[0]}")/render.sh" "$1"; }
# Geheimnis aus dem Konfig-Ordner, beim ersten Mal zufällig erzeugt
secret() { [ -s "$state/$1" ] || (umask 077; openssl rand -hex 24 > "$state/$1"); cat "$state/$1"; }
# kubectl: lokal, wenn KUBECONFIG gesetzt ist (Entwickler), sonst per SSH auf der ersten Node (Proxmox-Host)
k() {
  if [ -n "${KUBECONFIG:-}" ]; then kubectl "$@"
  else ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "ubuntu@$first" "sudo k3s kubectl $(printf '%q ' "$@")"; fi
}
