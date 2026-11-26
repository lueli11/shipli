#!/usr/bin/env bash
# Installiert k3s (HA, eingebettetes etcd) auf einer Shipli-Node.
# Aufruf: infra/k3s-node.sh <ip> init   (erste Node, bringt die Manifeste mit)
#         infra/k3s-node.sh <ip> join   (weitere Nodes)
# Werte aus der Konfiguration (infra/env.sh). Erneut aufrufbar: k3s läuft danach mit derselben Konfiguration weiter.
set -euo pipefail
ip=$1 mode=$2
K3S_VERSION=v1.36.6+k3s1
cd "$(dirname "$0")"
. ./env.sh
run() { ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "ubuntu@$ip" "$@"; }

# Token nur per stdin, nie in argv oder Logs
secret k3s-token | run 'sudo install -d -m 700 /etc/rancher/k3s && sudo tee /etc/rancher/k3s/token >/dev/null && sudo chmod 600 /etc/rancher/k3s/token'

{
  echo "node-ip: $ip"
  echo "tls-san: [$SHIPLI_API_VIP]"
  # Pods eines toten Nodes nach 30 s statt 5 min woanders neu starten (alles läuft nur einmal)
  echo "kube-apiserver-arg: [default-not-ready-toleration-seconds=30, default-unreachable-toleration-seconds=30]"
  echo "disable: [servicelb, local-storage]"   # LoadBalancer-IPs vergibt kube-vip, Speicher kommt von Longhorn
  echo 'write-kubeconfig-mode: "0600"'
  echo "token-file: /etc/rancher/k3s/token"
  if [ "$mode" = init ]; then echo "cluster-init: true"; else echo "server: https://$SHIPLI_API_VIP:6443"; fi
} | run 'sudo tee /etc/rancher/k3s/config.yaml >/dev/null'

# containerd holt die App-Images über den NodePort von zot, als puller (Konten: scripts/zot-sync.ts)
run 'sudo tee /etc/rancher/k3s/registries.yaml >/dev/null && sudo chmod 600 /etc/rancher/k3s/registries.yaml' <<YAML
mirrors:
  "localhost:30500":
    endpoint: ["http://localhost:30500"]
configs:
  "localhost:30500":
    auth: { username: puller, password: "$(secret zot-puller)" }
YAML

if [ "$mode" = init ]; then ./manifests-sync.sh --apply "$ip"; fi

run bash -s <<REMOTE
set -euo pipefail
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq qemu-guest-agent open-iscsi nfs-common >/dev/null
sudo systemctl start qemu-guest-agent || true
sudo systemctl enable --now iscsid
# Longhorn: multipathd darf die Longhorn-Geräte nicht übernehmen
if systemctl list-unit-files multipathd.service >/dev/null 2>&1; then
  printf 'blacklist {\n  devnode "^sd[a-z0-9]+"\n}\n' | sudo tee /etc/multipath.conf >/dev/null
  sudo systemctl restart multipathd || true
fi
curl -sfL https://get.k3s.io | sudo INSTALL_K3S_VERSION=$K3S_VERSION sh -s - server
REMOTE
echo "k3s auf $ip ($mode) installiert"
