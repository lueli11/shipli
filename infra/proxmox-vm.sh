#!/usr/bin/env bash
# Legt auf einem Proxmox-Host eine Shipli-Node aus dem Ubuntu-Cloud-Image an und startet sie.
# Aufruf: infra/proxmox-vm.sh <proxmox-host|local> <vmid> <name> <ip> <datei-mit-ssh-keys>
# Netz und Grösse aus der Konfiguration (infra/env.sh): SHIPLI_GATEWAY, SHIPLI_PREFIX (24), SHIPLI_BRIDGE (vmbr0),
# SHIPLI_VLAN (leer = ohne), SHIPLI_STORAGE (local-lvm), SHIPLI_DNS (Gateway), SHIPLI_VM_CORES/MEMORY/DISK (4, 8192, 40G).
# Gibt es die VM-ID schon, bricht das Skript ab, ohne etwas anzufassen.
set -euo pipefail
host=$1 vmid=$2 name=$3 ip=$4 keys=$5
. "$(dirname "$0")/env.sh"
args=("$vmid" "$name" "$ip/${SHIPLI_PREFIX:-24}" "$SHIPLI_GATEWAY" "${SHIPLI_DNS:-$SHIPLI_GATEWAY}" "${SHIPLI_BRIDGE:-vmbr0}" "${SHIPLI_VLAN:-}"
  "${SHIPLI_STORAGE:-local-lvm}" "${SHIPLI_VM_CORES:-4}" "${SHIPLI_VM_MEMORY:-8192}" "${SHIPLI_VM_DISK:-40G}")
# ssh setzt die Argumente zu einer Zeile zusammen, darum %q (sonst fiele ein leeres VLAN weg)
on() { if [ "$host" = local ]; then bash -s -- "$@"; else ssh -o BatchMode=yes "root@$host" "bash -s -- $(printf '%q ' "$@")"; fi; }

# Public Keys sind nicht geheim, sie dürfen als Argument mit
on "${args[@]}" "$(cat "$keys")" <<'REMOTE'
set -euo pipefail
vmid=$1 name=$2 cidr=$3 gw=$4 dns=$5 bridge=$6 vlan=$7 storage=$8 cores=$9 memory=${10} disk=${11} keys=${12}
if qm status "$vmid" >/dev/null 2>&1; then echo "VM $vmid gibt es schon" >&2; exit 1; fi
keyfile=$(mktemp)
trap 'rm -f "$keyfile"' EXIT
printf '%s\n' "$keys" > "$keyfile"

dir=/var/lib/vz/template/iso img=noble-server-cloudimg-amd64.img
mkdir -p "$dir"; cd "$dir"
curl -fsSL -o SHA256SUMS.noble https://cloud-images.ubuntu.com/noble/current/SHA256SUMS
want=$(awk -v f="*$img" '$2==f{print $1}' SHA256SUMS.noble)
if [ "$(sha256sum "$img" 2>/dev/null | cut -d' ' -f1)" != "$want" ]; then
  curl -fsSL -o "$img.part" "https://cloud-images.ubuntu.com/noble/current/$img"
  [ "$(sha256sum "$img.part" | cut -d' ' -f1)" = "$want" ] || { echo "Prüfsumme des Cloud-Images falsch" >&2; exit 1; }
  mv "$img.part" "$img"
fi

net="virtio,bridge=$bridge"; [ -n "$vlan" ] && net="$net,tag=$vlan"
qm create "$vmid" --name "$name" --memory "$memory" --cores "$cores" --cpu host --ostype l26 \
  --net0 "$net" --scsihw virtio-scsi-single --agent 1 \
  --serial0 socket --vga serial0 --onboot 1 --tags shipli
qm set "$vmid" --scsi0 "$storage:0,import-from=$dir/$img,discard=on,ssd=1,iothread=1" >/dev/null
qm resize "$vmid" scsi0 "$disk"
qm set "$vmid" --ide2 "$storage:cloudinit" --boot order=scsi0 >/dev/null
qm set "$vmid" --ciuser ubuntu --sshkeys "$keyfile" --ipconfig0 "ip=$cidr,gw=$gw" --nameserver "$dns" >/dev/null
qm start "$vmid"
echo "VM $vmid $name gestartet ($cidr)"
REMOTE
