#!/usr/bin/env bash
# Shipli auf Proxmox. In der Shell eines Proxmox-Hosts als root:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/lueli11/shipli/main/install/proxmox.sh)"
# Fragt ein paar Werte ab, legt 1 VM oder 3 VMs (HA, je eine pro Proxmox-Host) an und installiert k3s, Longhorn,
# cert-manager, zot und Shipli. Der Rechner, auf dem das Skript läuft, muss die VMs per SSH erreichen. Geht das vom
# Proxmox-Host nicht (getrennte Netze), läuft es auf einem anderen Linux-Rechner mit root-SSH zu den Hosts:
# SHIPLI_PVE_HOSTS="<host1> <host2> <host3>" setzen. Danach gibt es den Befehl `shipli`:
#   shipli update [version]   neue Version ausrollen (Standard: neuestes Release)
#   shipli add-node           von 1 auf 3 Nodes (HA)
#   shipli add-disk <GB>      jeder Node eine Disk dieser Grösse für Longhorn anhängen
# Alles ist erneut aufrufbar: fertige Schritte werden übersprungen. Ohne Fragen: Werte als SHIPLI_* setzen und SHIPLI_YES=1.
set -euo pipefail
REPO=${SHIPLI_REPO:-lueli11/shipli}
cmd=${1:-install}
die() { echo "Fehler: $*" >&2; exit 1; }
command -v qm >/dev/null && { [ "$(id -u)" = 0 ] || die "auf dem Proxmox-Host als root ausführen"; }
for c in curl perl openssl ssh base64; do command -v $c >/dev/null || die "$c fehlt"; done

# Per curl gestartet (kein Pfad) oder update: Repo in der gewünschten Version holen und das Skript von dort starten
if [ -z "${BASH_SOURCE[0]:-}" ] || { [ "$cmd" = update ] && [ -z "${SHIPLI_FETCHED:-}" ]; }; then
  version=${2:-${SHIPLI_VERSION:-}}
  [ -n "$version" ] || version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
  [ -n "$version" ] || die "keine Version gefunden (SHIPLI_VERSION setzen, z. B. main)"
  dir=$HOME/shipli/$version
  rm -rf "$dir.part" && mkdir -p "$dir.part"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$version" | tar -xz -C "$dir.part" --strip-components=1
  rm -rf "$dir" && mv "$dir.part" "$dir"
  SHIPLI_FETCHED=1 SHIPLI_VERSION=$version exec bash "$dir/install/proxmox.sh" "$@"
fi
src=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export SHIPLI_VERSION=${SHIPLI_VERSION:-main}
export SHIPLI_ENV=${SHIPLI_ENV:-$HOME/.config/shipli/shipli.env}
state=$(dirname "$SHIPLI_ENV")
mkdir -p "$state" && chmod 700 "$state"

# --- Fragen ----------------------------------------------------------------------------------------------------------

# ask VAR "Frage" [Vorgabe]: bleibt, wenn VAR schon gesetzt ist (Umgebung oder bestehende Konfiguration)
ask() {
  local var=$1 q=$2 def=${3:-} v
  [ -n "${!var:-}" ] && return 0
  if [ -n "${SHIPLI_YES:-}" ]; then v=$def
  elif command -v whiptail >/dev/null; then v=$(whiptail --title Shipli --inputbox "$q" 14 76 "$def" 3>&1 1>&2 2>&3) || die "abgebrochen"
  else read -rp "$q [$def]: " v; v=${v:-$def}; fi
  [ -n "$v" ] || [ "${4:-}" = optional ] || die "$var fehlt"
  printf -v "$var" %s "$v"
}
yesno() {
  [ -n "${SHIPLI_YES:-}" ] && return "${2:-0}"
  if command -v whiptail >/dev/null; then whiptail --title Shipli --yesno "$1" 14 76
  else local a; read -rp "$1 [j/n]: " a; [[ $a = [jJyY]* ]]; fi
}
pve_local() { command -v qm >/dev/null; }
# Proxmox-Hosts im Cluster, die laufen, dieser zuerst (ohne Cluster nur dieser; nicht auf einem Proxmox-Host: keine)
pve_hosts() {
  pve_local || return 0
  hostname
  pvesh get /nodes --output-format json | perl -MJSON::PP -0777 -ne 'print "$_\n" for sort map { $_->{node} } grep { $_->{status} eq "online" } @{decode_json($_)}' | grep -vx "$(hostname)" || true
}
pve_ip() { pvesh get /cluster/status --output-format json | perl -MJSON::PP -0777 -ne 'for (@{decode_json($_)}) { print $_->{ip} if ($_->{name} // "") eq "'"$1"'" && $_->{type} eq "node" }'; }
# Ziel für Befehle auf einem Proxmox-Host: local, die IP eines Cluster-Nodes oder der Name selbst (SSH als root)
target() {
  if pve_local && [ "$1" = "$(hostname)" ]; then echo local; return; fi
  local ip=""; pve_local && ip=$(pve_ip "$1"); echo "${ip:-$1}"
}
# on_host <host> [args] <<<'skript': bash-Skript auf einem Proxmox-Host (ssh setzt argv zusammen, darum %q)
on_host() {
  local t; t=$(target "$1"); shift
  if [ "$t" = local ]; then bash -s -- "$@"; else ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$t" "bash -s -- $(printf '%q ' "$@")"; fi
}
vm_name() { on_host "$1" "$2" <<<'qm config "$1" 2>/dev/null | sed -n "s/^name: //p"'; }
# freie VM-ID auf dem Host (im Cluster clusterweit), ohne die schon gewählten
free_vmid() { local h=$1; shift; on_host "$h" "$@" <<<'id=$(pvesh get /cluster/nextid); while printf "%s\n" "$@" | grep -qx "$id" || ! pvesh get /cluster/nextid --vmid "$id" >/dev/null 2>&1; do id=$((id + 1)); done; echo "$id"'; }
# nächste IP im selben /24: next_ip 10.0.0.11 2 -> 10.0.0.13
next_ip() { echo "${1%.*}.$(( ${1##*.} + $2 ))"; }

# fragt die Nodes ab Nummer $1 bis $2 ab (IP, Proxmox-Host, VM-ID) und hängt sie an
ask_nodes() {
  local from=$1 to=$2 hosts add ip host i
  mapfile -t hosts < <(pve_hosts)
  # ohne Fragen: Proxmox-Hosts der neuen VMs, z. B. SHIPLI_ADD_PVE_HOSTS="pve2 pve3"
  read -ra add <<<"${SHIPLI_ADD_PVE_HOSTS:-}"
  for ((i = from; i <= to; i++)); do
    ip="" host=""
    ask ip "IP der VM $SHIPLI_NAME-$i (frei, statisch)" "$( [ "$i" -gt 1 ] && next_ip "${nodes[0]}" $((i - 1)) )"
    ask host "Proxmox-Host für $SHIPLI_NAME-$i${hosts[*]:+ (im Cluster: ${hosts[*]})}" "${add[i - from]:-${hosts[$(( (i - 1) % (${#hosts[@]} > 0 ? ${#hosts[@]} : 1) ))]:-}}"
    on_host "$host" <<<'command -v qm >/dev/null' || die "$host ist kein erreichbarer Proxmox-Host (root-SSH?)"
    nodes+=("$ip") pve+=("$host") vmids+=("$(free_vmid "$host" "${vmids[@]}")")
  done
}

configure() {
  nodes=() pve=() vmids=()
  local mode=${SHIPLI_MODE:-}
  if [ -z "$mode" ]; then
    if [ -n "${SHIPLI_YES:-}" ]; then mode=1
    else mode=$(whiptail --title Shipli --menu "Wie viele VMs?" 14 76 2 1 "Eine VM (einfach, kein Ausfallschutz)" 3 "Drei VMs, HA (je eine pro Proxmox-Host)" 3>&1 1>&2 2>&3) || die "abgebrochen"; fi
  fi
  ask SHIPLI_NAME "Name der VMs (es werden <name>-1, -2, -3)" shipli
  if [ -n "${SHIPLI_NODES:-}" ]; then
    # ohne Fragen: SHIPLI_NODES, dazu optional SHIPLI_PVE_HOSTS (sonst alle hier) und SHIPLI_VMIDS (sonst frei)
    read -ra nodes <<<"$SHIPLI_NODES"; read -ra pve <<<"${SHIPLI_PVE_HOSTS:-}"; read -ra vmids <<<"${SHIPLI_VMIDS:-}"
    mode=${#nodes[@]}
    for i in "${!nodes[@]}"; do
      pve[i]=${pve[i]:-$(pve_local && hostname)}; [ -n "${pve[i]}" ] || die "SHIPLI_PVE_HOSTS fehlt"
      vmids[i]=${vmids[i]:-$(free_vmid "${pve[i]}" "${vmids[@]}")}
    done
  else
    ask_nodes 1 "$mode"
  fi
  [ "$mode" = 3 ] && [ "$(printf '%s\n' "${pve[@]}" | sort -u | wc -l)" -lt 3 ] && \
    { yesno "Die 3 VMs liegen nicht auf 3 verschiedenen Proxmox-Hosts. Fällt ein Host aus, ist Shipli trotzdem weg. Weiter?" || die "abgebrochen"; }
  ask SHIPLI_PREFIX "Netzmaske der VMs (Präfix)" 24
  ask SHIPLI_GATEWAY "Gateway der VMs" "${nodes[0]%.*}.1"
  ask SHIPLI_API_VIP "Freie IP für die Kubernetes-API (bleibt erreichbar, wenn eine VM ausfällt)" "$(next_ip "${nodes[-1]}" 1)"
  ask SHIPLI_INGRESS_IP "Freie IP für den Eingang (Port 80/443 kommen hier an)" "$(next_ip "${nodes[-1]}" 2)"
  ask SHIPLI_BRIDGE "Netzwerk-Bridge" vmbr0
  ask SHIPLI_VLAN "VLAN-Tag (leer = ohne)" "" optional
  ask SHIPLI_STORAGE "Proxmox-Storage für die Disks (auf jedem gewählten Host)" local-lvm
  ask SHIPLI_HOST "Adresse der Oberfläche, z. B. shipli.example.com" ""
  ask SHIPLI_ADMIN_EMAIL "E-Mail des Admins (Login)" ""
  ask SHIPLI_PUBLIC_IP "Öffentliche IPv4 (darauf zeigen die DNS-Einträge)" "$(curl -fsS -m 5 https://api.ipify.org || true)"
  ask SHIPLI_DOMAIN "Basis der App-Adressen (<projekt>--<user>.<basis>)" "${SHIPLI_PUBLIC_IP//./-}.sslip.io"
  local parent=$SHIPLI_HOST; [ "$(tr -cd . <<<"$SHIPLI_HOST" | wc -c)" -ge 2 ] && parent=${SHIPLI_HOST#*.}
  ask SHIPLI_BLOCKED_DOMAINS "Eigene Domains, die User nicht eintragen dürfen (mit Komma)" "$parent"
  if [ -z "${SHIPLI_TRUSTED_IPS:-}" ]; then
    if yesno "Läuft vor Shipli schon ein Reverse-Proxy auf Port 80/443 (SNI-Passthrough, siehe examples/)?" 1; then
      local ips=""; ask ips "IPs des Proxys (mit Leerzeichen), nur ihnen glaubt Traefik die Absender-IP" ""
      SHIPLI_TRUSTED_IPS="[$(for i in $ips; do printf '"%s", ' "$i"; done | sed 's/, $//')]"
    else SHIPLI_TRUSTED_IPS="[]"; fi
  fi
  ask SHIPLI_SSH_KEY "Eigener SSH-Public-Key für die VMs (leer = nur dieser Proxmox-Host)" "" optional
  SHIPLI_IMAGE=${SHIPLI_IMAGE:-ghcr.io/$REPO:$SHIPLI_VERSION}
  SHIPLI_NODES=${nodes[*]} SHIPLI_PVE_HOSTS=${pve[*]} SHIPLI_VMIDS=${vmids[*]}

  yesno "Shipli $SHIPLI_VERSION installieren?

VMs:        $(for i in "${!nodes[@]}"; do printf '%s-%s (%s) auf %s, ' "$SHIPLI_NAME" $((i + 1)) "${nodes[i]}" "${pve[i]}"; done | sed 's/, $//')
Je VM:      ${SHIPLI_VM_CORES:-4} Kerne, ${SHIPLI_VM_MEMORY:-8192} MB RAM, ${SHIPLI_VM_DISK:-60G} Disk
API / Eingang: $SHIPLI_API_VIP / $SHIPLI_INGRESS_IP
Oberfläche: https://$SHIPLI_HOST (Admin $SHIPLI_ADMIN_EMAIL)" || die "abgebrochen"
  save
}

save() {
  local v
  (umask 077
   echo "# Shipli-Installation, geschrieben von install/proxmox.sh. Vorlage und Erklärung: install/shipli.env.example"
   for v in SHIPLI_VERSION SHIPLI_IMAGE SHIPLI_NAME SHIPLI_NODES SHIPLI_PVE_HOSTS SHIPLI_VMIDS SHIPLI_PREFIX SHIPLI_GATEWAY \
     SHIPLI_API_VIP SHIPLI_INGRESS_IP SHIPLI_BRIDGE SHIPLI_VLAN SHIPLI_STORAGE SHIPLI_HOST SHIPLI_ADMIN_EMAIL SHIPLI_PUBLIC_IP \
     SHIPLI_DOMAIN SHIPLI_BLOCKED_DOMAINS SHIPLI_TRUSTED_IPS SHIPLI_SSH_KEY SHIPLI_VM_CORES SHIPLI_VM_MEMORY SHIPLI_VM_DISK; do
     [ -n "${!v:-}" ] && printf '%s=%q\n' "$v" "${!v}"
   done
   true) > "$SHIPLI_ENV.part" && mv "$SHIPLI_ENV.part" "$SHIPLI_ENV"
}

load() {
  # shellcheck disable=SC1090
  . "$src/infra/env.sh"
  read -ra pve <<<"$SHIPLI_PVE_HOSTS"
  read -ra vmids <<<"$SHIPLI_VMIDS"
}

# --- Schritte (jeder überspringt, was schon fertig ist) -------------------------------------------------------------

vssh() { local ip=$1; shift; ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "ubuntu@$ip" "$@"; }

create_vms() {
  [ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C "shipli@$(hostname)"
  { cat ~/.ssh/id_ed25519.pub; [ -n "${SHIPLI_SSH_KEY:-}" ] && echo "$SHIPLI_SSH_KEY"; true; } > "$state/ssh-keys"
  local i name have
  for i in "${!nodes[@]}"; do
    name=$SHIPLI_NAME-$((i + 1)) have=$(vm_name "${pve[i]}" "${vmids[i]}")
    if [ "$have" = "$name" ]; then echo "VM ${vmids[i]} $name gibt es schon"; continue; fi
    [ -z "$have" ] || die "VM-ID ${vmids[i]} gehört schon zu $have"
    ssh-keygen -q -R "${nodes[i]}" >/dev/null 2>&1 || true
    "$src/infra/proxmox-vm.sh" "$(target "${pve[i]}")" "${vmids[i]}" "$name" "${nodes[i]}" "$state/ssh-keys"
  done
  for i in "${!nodes[@]}"; do
    echo "Warte auf ${nodes[i]} (SSH, cloud-init) …"
    for _ in $(seq 1 100); do vssh "${nodes[i]}" 'cloud-init status --wait >/dev/null 2>&1; true' 2>/dev/null && continue 2; sleep 6; done
    die "VM ${nodes[i]} ist nach 10 min per SSH nicht erreichbar (Netz, VLAN, Gateway prüfen)"
  done
}

install_k3s() {
  local i
  vssh "$first" systemctl is-active -q k3s || "$src/infra/k3s-node.sh" "$first" init
  echo "Warte auf die API-Adresse $SHIPLI_API_VIP …"
  for _ in $(seq 1 60); do [ "$(curl -sk -o /dev/null -w '%{http_code}' -m 3 "https://$SHIPLI_API_VIP:6443/" || true)" != 000 ] && break; sleep 5; done
  for i in "${!nodes[@]}"; do
    [ "$i" = 0 ] && continue
    vssh "${nodes[i]}" systemctl is-active -q k3s || "$src/infra/k3s-node.sh" "${nodes[i]}" join
  done
  k wait --for=condition=Ready node --all --timeout=600s >/dev/null
  "$src/infra/manifests-sync.sh" --apply >/dev/null
  echo "Warte auf Longhorn, cert-manager, zot und Traefik (beim ersten Mal 5 bis 10 min) …"
  for _ in $(seq 1 120); do
    k get crd clusterissuers.cert-manager.io ingressroutes.traefik.io >/dev/null 2>&1 && k get ns zot >/dev/null 2>&1 \
      && k get storageclass longhorn >/dev/null 2>&1 && break
    sleep 10
  done
  k -n cert-manager rollout status deploy/cert-manager-webhook --timeout=600s >/dev/null
}

finish() {
  ln -sfn "$src" "$HOME/shipli/current"
  if [ -w /usr/local/bin ]; then ln -sf "$HOME/shipli/current/install/proxmox.sh" /usr/local/bin/shipli
  else mkdir -p ~/.local/bin && ln -sf "$HOME/shipli/current/install/proxmox.sh" ~/.local/bin/shipli; fi
  cat <<EOF

Shipli $SHIPLI_VERSION läuft.

  Oberfläche:   https://$SHIPLI_HOST
  Login:        $SHIPLI_ADMIN_EMAIL
  Passwort:     $(cat "$state/admin-password")   (Start-Passwort, unter „Konto“ ändern)

Noch zu tun, damit es von aussen geht:
  1. DNS: A-Eintrag $SHIPLI_HOST -> $SHIPLI_PUBLIC_IP
  2. $( [ "$SHIPLI_TRUSTED_IPS" = "[]" ] && echo "Router: TCP 80 und 443 an $SHIPLI_INGRESS_IP weiterleiten" || echo "Proxy: SNI-Passthrough an $SHIPLI_INGRESS_IP (Beispiele in $src/examples/)")
  Das Zertifikat kommt von selbst, sobald beides stimmt. Danach unter „Neues Projekt“ die GitHub App anlegen
  und unter „User“ Freunde einladen.

Verwalten mit: shipli update | shipli add-node | shipli add-disk <GB>
Konfiguration und Geheimnisse liegen in $state/, diesen Ordner sichern.
EOF
}

case $cmd in
  install)
    if [ -f "$SHIPLI_ENV" ]; then
      # eine von Hand geschriebene Konfiguration (eigener Cluster) soll der Installer nicht als seine nehmen
      grep -q '^SHIPLI_VMIDS=' "$SHIPLI_ENV" || die "$SHIPLI_ENV stammt nicht vom Installer (SHIPLI_ENV auf eine neue Datei setzen)"
      echo "Bestehende Konfiguration $SHIPLI_ENV, setze die Installation fort"
    else configure; fi
    load
    create_vms
    install_k3s
    SHIPLI_ROLLOUT_TIMEOUT=900s "$src/infra/rollout.sh" "$SHIPLI_IMAGE"
    finish
    ;;
  update)
    # die Konfiguration nennt noch die alte Version
    new=$SHIPLI_VERSION
    load
    SHIPLI_VERSION=$new SHIPLI_IMAGE=ghcr.io/$REPO:$new
    "$src/infra/manifests-sync.sh" --apply >/dev/null
    "$src/infra/rollout.sh" "$SHIPLI_IMAGE"
    save
    ln -sfn "$src" "$HOME/shipli/current"
    ;;
  add-node)
    load
    [ "${#nodes[@]}" = 1 ] || die "geht nur von 1 auf 3 Nodes (jetzt ${#nodes[@]})"
    ask_nodes 2 3
    SHIPLI_NODES=${nodes[*]} SHIPLI_PVE_HOSTS=${pve[*]} SHIPLI_VMIDS=${vmids[*]}
    save
    load
    create_vms
    install_k3s
    # Longhorn: neue Volumes bekommen 3 Kopien über die Vorlage, bestehende hier
    for v in $(k -n longhorn-system get volumes.longhorn.io -o name); do
      k -n longhorn-system patch "$v" --type merge -p '{"spec":{"numberOfReplicas":3}}' >/dev/null
    done
    echo "Shipli läuft jetzt auf 3 Nodes: $SHIPLI_NODES"
    ;;
  add-disk)
    load
    size=${2:-}; [[ $size =~ ^[0-9]+$ ]] || die "Aufruf: shipli add-disk <GB>"
    for i in "${!nodes[@]}"; do
      # freien scsi-Platz suchen, Disk mit Seriennummer anhängen (darüber findet die VM sie)
      n=$(on_host "${pve[i]}" "${vmids[i]}" <<<'qm config "$1" | sed -n "s/^scsi\([0-9]*\):.*/\1/p" | sort -n | tail -1')
      n=$((n + 1))
      on_host "${pve[i]}" "${vmids[i]}" "$n" "$SHIPLI_STORAGE" "$size" <<<'qm set "$1" --scsi"$2" "$3:$4,serial=shipli$2,discard=on,ssd=1,iothread=1" >/dev/null'
      vssh "${nodes[i]}" bash -s -- "$n" <<'REMOTE'
set -euo pipefail
n=$1 dir=/var/lib/longhorn-disk$1
for _ in $(seq 1 30); do dev=$(lsblk -dno PATH,SERIAL | awk -v s="shipli$n" '$2==s{print $1}'); [ -n "$dev" ] && break; sleep 2; done
[ -n "$dev" ] || { echo "Disk shipli$n taucht in der VM nicht auf" >&2; exit 1; }
sudo mkfs.ext4 -q "$dev"
sudo mkdir -p "$dir"
echo "UUID=$(sudo blkid -s UUID -o value "$dev") $dir ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab >/dev/null
sudo mount "$dir"
REMOTE
      node=$(vssh "${nodes[i]}" hostname)
      k -n longhorn-system patch nodes.longhorn.io "$node" --type merge \
        -p "{\"spec\":{\"disks\":{\"disk$n\":{\"path\":\"/var/lib/longhorn-disk$n\",\"allowScheduling\":true,\"diskType\":\"filesystem\",\"storageReserved\":0,\"tags\":[]}}}}" >/dev/null
      echo "$node: ${size} GB als disk$n in Longhorn"
    done
    ;;
  *) die "unbekannter Befehl $cmd (install, update, add-node, add-disk)" ;;
esac
