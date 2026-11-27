# Shipli

A small, self-hosted platform like Vercel or Netlify. You run it on your own Proxmox servers, invite your friends, they connect a GitHub repo, add their own domain, and a few minutes later their site is live with HTTPS.

The interface is in German.

## What it does

- Invite-only sign-up; every user works in their own isolated namespace
- Connect a GitHub repo (private ones too), deploy on every push, no Dockerfile needed (Railpack), or build your own Dockerfile with path, context and stage
- Per project: run it single (one pod) or in cluster mode (two pods on different nodes, survives a node outage and redeploys without downtime, no persistent folder)
- Custom domains: Shipli shows the DNS records, checks them and gets the certificate itself, also behind the Cloudflare proxy (orange cloud, SSL mode "Full (strict)")
- Redirect between `www` and the apex domain with one click
- Google Search Console verification by uploading the HTML file
- CPU, RAM, storage and project limits per user, monitoring for the admin, usage page for each user
- An MCP server, so Claude Code or Codex can create projects, deploy and read logs with a user's token

Not included on purpose: databases as a service, billing, open registration, CDN, preview deployments, teams.

## Install on Proxmox

Run this in the shell of a Proxmox host as root:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/lueli11/shipli/main/install/proxmox.sh)"
```

It asks a few questions, then:

1. creates **one VM** or **three VMs (HA)** from the Ubuntu 24.04 cloud image. In HA mode each VM goes to a different Proxmox host of your cluster.
2. installs k3s with embedded etcd, kube-vip, Longhorn, cert-manager and zot.
3. deploys Shipli and prints the URL and the admin's initial password.

You need:

- Proxmox VE 8 or newer
- 4 cores, 8 GB RAM and 60 GB disk per VM (override with `SHIPLI_VM_CORES`, `SHIPLI_VM_MEMORY`, `SHIPLI_VM_DISK`; below 40 GB Longhorn has no room for the registry)
- one free static IP per VM, plus two more IPs in the same network: one for the Kubernetes API and one for ingress
- a public IPv4 address

The machine running the installer must reach the VMs over SSH. If your Proxmox hosts cannot reach the VM network (separate VLANs with a firewall), run the same command on any Linux machine that can, with root SSH access to the Proxmox hosts, and name them: `SHIPLI_PVE_HOSTS="pve1 pve2 pve3"`. That also works for Proxmox hosts that are not in a cluster.

Every step is idempotent. If the installer stops, run it again and it continues where it stopped. To skip the questions, set the values as `SHIPLI_*` environment variables (see [`install/shipli.env.example`](install/shipli.env.example)) and add `SHIPLI_YES=1`.

The single-node setup can grow into the HA setup later.

### Network: two ways in

Port 80 and 443 have to reach the ingress IP.

- **Alone on 80/443:** forward TCP 80 and 443 on your router to the ingress IP. This is the default.
- **Behind an existing reverse proxy:** your proxy keeps its own domains and passes everything else through without terminating TLS (SNI passthrough). Shipli trusts the client IP only from the proxy IPs you enter. Examples: [Traefik](examples/traefik-sni-passthrough.yaml), [HAProxy](examples/haproxy-sni-passthrough.cfg).

Then point an A record for the Shipli host to your public IP. The certificate follows by itself.

### After the install

| Command | What it does |
|---|---|
| `shipli update [version]` | rolls out a new release (default: the latest), waits for running builds first |
| `shipli add-node` | grows a single node to three (HA) and moves Longhorn to three replicas |
| `shipli add-disk <GB>` | attaches a disk of that size to every node and adds it to Longhorn |

Configuration and secrets (k3s token, registry passwords, initial admin password) live in `~/.config/shipli/` on the machine where you ran the installer. Back that folder up.

Once you are logged in, go to "Neues Projekt" and create your GitHub App (one per user, private). Then invite friends under "User".

## How it works

- **Builds** run as Kubernetes jobs in `shipli-builds` with rootless BuildKit and Railpack, and push to zot. Each user has their own zot account that can only write `<user>/**`. `scripts/zot-sync.ts` maintains these accounts under its own service account.
- **Apps** run in `shipli-u-<user>` with Pod Security `restricted`, a ResourceQuota and a NetworkPolicy. Apps cannot reach other users, the nodes, the Kubernetes API or private networks.
- **Shipli itself** may only write into `shipli-u-*` and `shipli-builds`, enforced by a ValidatingAdmissionPolicy. It cannot read any secret. `infra/isolation-test.sh <user> <project>` checks all of this from inside a user's namespace.
- **The UI** is Next.js with Postgres, both in `shipli-system`, stored on Longhorn.

## Development

Needs Docker, k3d and Node 24.

```sh
k3d registry create shipli-registry --port 127.0.0.1:5111 --image ghcr.io/project-zot/zot:v2.1.22
k3d cluster create shipli --registry-use k3d-shipli-registry:5111 -p "8080:80@loadbalancer"
docker run -d --name shipli-dev-db -p 127.0.0.1:5433:5432 -e POSTGRES_USER=shipli -e POSTGRES_PASSWORD=shipli -e POSTGRES_DB=shipli postgres:17-alpine
printf 'DATABASE_URL=postgres://shipli:shipli@127.0.0.1:5433/shipli\nSHIPLI_HTTP_PORT=8080\n' > .env.local
npm install
npm run db:init
npm run invite -- <email> <username>   # prints the invite link
# builds mount their user's push secret; the k3d registry does not check the password
kubectl create ns shipli-builds; kubectl -n shipli-builds create secret docker-registry zot-push-<username> --docker-server=k3d-shipli-registry:5000 --docker-username=x --docker-password=x
npm run dev                            # http://localhost:3000
npm test
```

Apps must listen on `$PORT` (3000).

If you run your own cluster from a workstation, put your values in `~/.config/shipli/shipli.env` (template: `install/shipli.env.example`).

| Script | What it does |
|---|---|
| `deploy/release.sh` | builds the working tree, pushes the image to the cluster's zot and rolls it out |
| `infra/manifests-sync.sh [--apply]` | compares or copies the rendered `infra/manifests/` to the first node. k3s re-applies them on every restart, so never `kubectl apply` them yourself. |

## The name

**Shipli** = English *ship* + Swiss German *-li*.

- *Ship* is what you do with software ("ship it").
- *-li* is the Swiss German diminutive, as in Müesli.

So Shipli is "the little shipping thing": small, friendly, self-hosted, from Switzerland. It is pronounced "Ship-lee".

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Parts of the monitoring UI come from [Dokploy](https://github.com/Dokploy/dokploy).
