#!/usr/bin/env bash
# Prüft die Abschottung eines Users so, wie es eine präparierte App sähe: Netz aus einem Pod in shipli-u-<user>
# (gleich nach dem Start und nach 30 s, weil kube-router neue Pods verzögert erfasst), Admission (PSA, Policies
# in shipli-builds) und die Rechte des Service-Accounts von Shipli. Der User braucht ein deploytes Projekt.
# Nur lesend bzw. --dry-run=server, der Test-Pod wird am Ende gelöscht. Exit 1, wenn etwas nicht wie erwartet ist.
# Aufruf (mit kubectl auf den Cluster): infra/isolation-test.sh <user> <projekt>
set -euo pipefail
[ $# = 2 ] || { echo "Aufruf: infra/isolation-test.sh <user> <projekt>" >&2; exit 2; }
user=$1 project=$2 ns=shipli-u-$1
export KUBECONFIG=${KUBECONFIG:-$HOME/.kube/shipli.yaml}
. "$(dirname "$0")/env.sh"
# weitere Ziele, die zu sein müssen, eine Zeile „name ip port“ pro Ziel (z. B. Rechner im LAN), aus der Konfiguration
extra_check=$(while read -r n ip port; do if [ -n "$n" ]; then echo "check zu $n $ip $port"; fi; done <<<"${SHIPLI_ISOLATION_EXTRA:-}")
sa=system:serviceaccount:shipli-system:shipli
fail=0

kubectl -n "$ns" get svc "$project" >/dev/null || { echo "Projekt $project von $user hat keinen Service, zuerst deployen" >&2; exit 2; }
# irgendeine App eines anderen Users, gegen die der Test-Pod nicht ankommen darf
other=$(kubectl get svc -A -l shipli/project -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}' \
  | grep '^shipli-u-' | grep -v "^$ns/" | head -1 || true)
other_check=""
if [ -n "$other" ]; then
  other_ip=$(kubectl -n "${other%/*}" get pod -l "shipli/project=${other#*/}" -o jsonpath='{.items[0].status.podIP}')
  other_check="check zu anderer-user-svc ${other#*/}.${other%/*}.svc.cluster.local 80
  check zu anderer-user-pod $other_ip 3000"
else
  echo "Hinweis: kein Projekt eines anderen Users gefunden, Abschottung zwischen Usern nicht geprüft"
fi

tmp=$(mktemp -d)
cleanup() {
  kubectl -n "$ns" delete pod isolation-test --ignore-not-found --wait=false >/dev/null
  kubectl -n "$ns" delete configmap isolation-test --ignore-not-found >/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT

cat > "$tmp/t.sh" <<EOF
check() {
  if nc -z -w 2 "\$3" "\$4" 2>/dev/null; then got=offen; else got=zu; fi
  [ "\$got" = "\$1" ] && r=ok || r=FEHLER
  echo "\$r  \$got  \$2 (\$3:\$4)"
}
run() {
  echo "== \$1"
  check offen eigene-app $project.$ns.svc.cluster.local 80
  check offen internet 1.1.1.1 443
  check offen internet-dns example.com 443
  check zu gateway $SHIPLI_GATEWAY 443
  check zu lan-router 192.168.1.1 443
  $extra_check
  check zu node-ssh $first 22
  check zu kubelet $first 10250
  check zu k8s-api-vip $SHIPLI_API_VIP 6443
  check zu k8s-api-node ${nodes[-1]} 6443
  check zu k8s-api-svc 10.43.0.1 443
  check zu zot-svc zot.zot.svc.cluster.local 5000
  check zu zot-nodeport ${nodes[-1]} 30500
  check zu postgres postgres.shipli-system.svc.cluster.local 5432
  check zu shipli-ui shipli.shipli-system.svc.cluster.local 80
  $other_check
}
run sofort
sleep 30
run "nach 30 s"
EOF
kubectl -n "$ns" create configmap isolation-test --from-file=t.sh="$tmp/t.sh" >/dev/null
kubectl -n "$ns" apply -f - >/dev/null <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: isolation-test }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
  volumes: [{ name: t, configMap: { name: isolation-test } }]
  containers:
    - name: t
      image: alpine:3.22
      command: [sh, /t/t.sh]
      resources: { requests: { cpu: 50m, memory: 32Mi }, limits: { cpu: 100m, memory: 64Mi } }
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      volumeMounts: [{ name: t, mountPath: /t }]
EOF
kubectl -n "$ns" wait --for=jsonpath='{.status.phase}'=Succeeded pod/isolation-test --timeout=240s >/dev/null
out=$(kubectl -n "$ns" logs isolation-test)
echo "$out"
grep -q '^FEHLER' <<<"$out" && fail=1

echo "== Admission und Rechte"
muss_scheitern() {
  local what=$1 out; shift
  # der Grund steht dabei, damit ein Tippfehler im Befehl nicht als „abgelehnt“ durchgeht
  if out=$("$@" 2>&1); then echo "FEHLER  ging durch  $what"; fail=1; else echo "ok  abgelehnt  $what: $(tail -1 <<<"$out" | cut -c1-140)"; fi
}
muss_scheitern "privilegierter Pod in $ns" kubectl -n "$ns" run evil --image=alpine:3.22 --privileged --dry-run=server
muss_scheitern "hostPath-Pod in shipli-builds" kubectl -n shipli-builds run evil --image=alpine:3.22 --dry-run=server \
  --overrides='{"spec":{"volumes":[{"name":"h","hostPath":{"path":"/"}}],"containers":[{"name":"evil","image":"alpine:3.22","volumeMounts":[{"name":"h","mountPath":"/h"}]}]}}'
muss_scheitern "privilegierter Pod in shipli-builds" kubectl -n shipli-builds run evil --image=alpine:3.22 --privileged --dry-run=server
muss_scheitern "Shipli-SA: Secrets in kube-system auflisten" kubectl auth can-i list secrets -n kube-system --as="$sa" --quiet
muss_scheitern "Shipli-SA: Secret in shipli-system lesen" kubectl auth can-i get secrets -n shipli-system --as="$sa" --quiet
muss_scheitern "Shipli-SA: Secret in shipli-system anlegen" kubectl -n shipli-system create secret generic evil --from-literal=a=b --as="$sa" --dry-run=server
muss_scheitern "Shipli-SA: Namespace evil anlegen" kubectl create ns evil --as="$sa" --dry-run=server
muss_scheitern "Shipli-SA: shipli-u-Namespace ohne PSA anlegen" kubectl create ns shipli-u-isolationsprobe --as="$sa" --dry-run=server
muss_scheitern "Shipli-SA: Namespace zot löschen" kubectl delete ns zot --as="$sa" --dry-run=server
muss_scheitern "Shipli-SA: zot-Konten ändern" kubectl auth can-i update secret/zot-zugang -n zot --as="$sa" --quiet
muss_scheitern "zot-sync: Secrets in shipli-system lesen" kubectl auth can-i get secrets -n shipli-system --as=system:serviceaccount:shipli-system:zot-sync --quiet
muss_scheitern "zot-sync: andere Secrets in zot ändern" kubectl auth can-i update secret/evil -n zot --as=system:serviceaccount:shipli-system:zot-sync --quiet

[ $fail = 0 ] && echo "Alles wie erwartet" || echo "Abweichungen gefunden (FEHLER oben)" >&2
exit $fail
