import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  BatchV1Api,
  CoreV1Api,
  AppsV1Api,
  KubeConfig,
  KubernetesObjectApi,
  Log,
  PatchStrategy,
  type KubernetesObject,
  type V1Pod,
  type V1ResourceQuotaStatus,
} from '@kubernetes/client-node';
import { quotaManifests, type Limits } from './limits.ts';
import { parseQuantity } from './metrics.ts';

const registryPush = process.env.SHIPLI_REGISTRY_PUSH ?? process.env.SHIPLI_REGISTRY ?? 'k3d-shipli-registry:5000';
const config = {
  // BuildKit schiebt aus dem Pod (Service-Name), containerd holt über den NodePort; in k3d ist beides gleich
  registryPush,
  registryPull: process.env.SHIPLI_REGISTRY_PULL ?? registryPush,
  domain: process.env.SHIPLI_DOMAIN ?? '127.0.0.1.sslip.io',
  buildNamespace: 'shipli-builds',
  railpackVersion: 'v0.43.0',
  buildkitImage: 'moby/buildkit:v0.35.0-rootless',
};

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/; // kein "--", damit "<projekt>--<user>" eindeutig bleibt
const REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// diese Namen setzt Shipli selbst im Build- oder App-Container
const RESERVED_ENV = new Set(['PORT', 'REPO', 'SHA', 'RAILPACK_VERSION', 'SHIPLI_ENV_KEYS', 'SHIPLI_GIT_TOKEN', 'BUILDKITD_FLAGS']);
const PORT = 3000;
// Schritt-Zeilen von Shipli; die normale Log-Ansicht zeigt nur diese, Fehler und was vor einem Fehler kam
export const STEP = '▸ ';
export const FAIL = '✖ ';

export type DeployInput = {
  user: string;
  project: string;
  repo: string;
  sha?: string; // vom Webhook; sonst der aktuelle Stand des Standard-Branch
  gitToken?: string; // Installation-Token der GitHub App, für private Repos
  env?: Record<string, string>;
  limits: Limits; // ResourceQuota und LimitRange des Namespace
  volume?: { path: string; mib: number }; // dauerhafter Ordner, sonst nur Wegwerf-Dateisystem
};

export function validateName(what: string, v: string): void {
  if (v.length > 20 || !NAME.test(v)) throw new Error(`${what} "${v}": nur a-z, 0-9 und einzelne Bindestriche, höchstens 20 Zeichen`);
}

/** „Jass App“ → „jass-app“: aus dem Namen wird ein Teil der Adresse. */
export const toName = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function validateEnvKey(key: string): void {
  if (!ENV_KEY.test(key) || key.length > 100) throw new Error(`Variable "${key}": nur Buchstaben, Ziffern und _, nicht mit einer Ziffer am Anfang`);
  if (RESERVED_ENV.has(key)) throw new Error(`Variable "${key}" setzt Shipli selbst`);
}

// Ordner über diesen Pfaden machen den Container kaputt; /app ist der Code aus dem Image
const SYSTEM_PATHS = ['/app', '/proc', '/sys', '/dev', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/run', '/var/run'];

export function validateVolumePath(path: string): void {
  const parts = path.split('/').slice(1);
  if (path.length > 200 || !/^(\/[A-Za-z0-9._-]+)+$/.test(path) || parts.some((p) => p === '.' || p === '..')) {
    throw new Error(`Pfad "${path}": absolut, z. B. /app/data, nur Buchstaben, Ziffern, . _ -`);
  }
  const hit = SYSTEM_PATHS.find((s) => path === s || (s !== '/app' && path.startsWith(`${s}/`)));
  if (hit) throw new Error(`Pfad "${path}" geht nicht, ${hit === '/app' ? 'dort liegt der Code der App. Nimm z. B. /app/data' : `${hit} braucht der Container selbst`}`);
}

export function validate({ user, project, repo, env = {} }: Omit<DeployInput, 'limits'>): void {
  validateName('User', user);
  validateName('Projekt', project);
  if (!REPO.test(repo)) throw new Error(`Repo "${repo}": nur https://github.com/<owner>/<repo>`);
  Object.keys(env).forEach(validateEnvKey);
}

export const namespaceOf = (user: string) => `shipli-u-${user}`;
export const hostOf = (user: string, project: string) => `${project}--${user}.${config.domain}`;
const imageOf = (registry: string, user: string, project: string, sha: string) => `${registry}/${user}/${project}:${sha}`;
const cacheOf = (user: string, project: string) => `${config.registryPush}/${user}/${project}:buildcache`;
const envSecretOf = (project: string) => `${project}-env`;
const volumeOf = (project: string) => `${project}-data`;
export const envHash = (env: Record<string, string>) =>
  createHash('sha256').update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');

export const labels = (user: string, project?: string) => ({
  'app.kubernetes.io/managed-by': 'shipli',
  'shipli/user': user,
  ...(project && { 'shipli/project': project }),
});

const PREPARE = `
apk add --no-cache git curl >/dev/null
# shortcut: nur x86_64, für arm64-Nodes die Architektur aus uname ableiten
curl -fsSL "https://github.com/railwayapp/railpack/releases/download/$RAILPACK_VERSION/railpack-$RAILPACK_VERSION-x86_64-unknown-linux-musl.tar.gz" | tar -xz -C /usr/local/bin railpack
git init -q /work/src && cd /work/src
if [ -n "\${SHIPLI_GIT_TOKEN:-}" ]; then
  git config http.extraHeader "Authorization: Basic $(printf 'x-access-token:%s' "$SHIPLI_GIT_TOKEN" | base64 | tr -d '\\n')"
fi
git fetch -q --depth 1 "$REPO" "$SHA" && git checkout -q FETCH_HEAD
# .git enthält Zeitstempel (und den Token) und würde sonst bei jedem Build den Cache für "copy /app" brechen
rm -rf .git
mkdir -p /work/plan
set --
for k in $SHIPLI_ENV_KEYS; do set -- "$@" --env "$k=$(printenv "$k")"; done
railpack prepare /work/src --plan-out /work/plan/railpack-plan.json "$@"
`;

export function buildJob(input: DeployInput, sha: string, secrets: { env: string; git?: string }) {
  const { user, project, repo, env = {} } = input;
  const keys = Object.keys(env).sort();
  const envFrom = [{ secretRef: { name: secrets.env } }];
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { generateName: `build-${project}--${user}-`, namespace: config.buildNamespace, labels: labels(user, project) },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 900,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: labels(user, project) },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          volumes: [
            { name: 'work', emptyDir: { sizeLimit: '2Gi' } },
            { name: 'buildkit', emptyDir: { sizeLimit: '10Gi' } },
            // zot-Konto des Users (scripts/zot-sync.ts), darf nur <user>/** schreiben: ein präparierter Build kann
            // es lesen, kommt damit aber nicht an Images und Build-Cache anderer User
            { name: 'zot', secret: { secretName: `zot-push-${user}`, items: [{ key: '.dockerconfigjson', path: 'config.json' }] } },
          ],
          initContainers: [{
            name: 'prepare',
            image: 'alpine:3.22',
            command: ['sh', '-euc', PREPARE],
            resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '512Mi' } },
            envFrom,
            // Werte nur als Env, nie ins Skript eingesetzt: keine Shell-Injection über Repo-URL oder Variablen
            env: [
              { name: 'REPO', value: repo },
              { name: 'SHA', value: sha },
              { name: 'RAILPACK_VERSION', value: config.railpackVersion },
              { name: 'SHIPLI_ENV_KEYS', value: keys.join(' ') },
              ...(secrets.git ? [{ name: 'SHIPLI_GIT_TOKEN', valueFrom: { secretKeyRef: { name: secrets.git, key: 'token' } } }] : []),
            ],
            volumeMounts: [{ name: 'work', mountPath: '/work' }],
          }],
          containers: [{
            name: 'build',
            image: config.buildkitImage,
            // Shipli liest den Digest aus der Termination-Message, damit ein überschriebener Tag keine laufende App
            // austauscht; buildctl schreibt atomar über eine Temp-Datei, das geht in /dev nicht
            command: ['sh', '-c', 'buildctl-daemonless.sh "$@" --metadata-file /tmp/meta.json && cat /tmp/meta.json > /dev/termination-log', 'sh'],
            args: [
              'build',
              '--frontend=gateway.v0',
              '--opt', `source=ghcr.io/railwayapp/railpack-frontend:${config.railpackVersion}`,
              '--local', 'context=/work/src',
              '--local', 'dockerfile=/work/plan',
              ...keys.flatMap((k) => ['--secret', `id=${k},env=${k}`]),
              // ohne Hash baut Railpack bei geänderten Werten nicht neu
              ...(keys.length ? ['--opt', `build-arg:secrets-hash=${envHash(env)}`] : []),
              // shortcut: registry.insecure erlaubt HTTP, nötig für zot ohne TLS; mit TLS-zot entfernen
              '--output', `type=image,name=${imageOf(config.registryPush, user, project, sha)},push=true,registry.insecure=true`,
              // BuildKit-State ist ein emptyDir, also Cache pro Projekt in zot; mode=max behält auch die Zwischenschritte (yarn install)
              '--export-cache', `type=registry,ref=${cacheOf(user, project)},mode=max,registry.insecure=true`,
              '--import-cache', `type=registry,ref=${cacheOf(user, project)},registry.insecure=true`,
            ],
            resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '2', memory: '3Gi' } },
            // der Git-Token bleibt draussen: ohne Prozess-Sandbox könnten Build-Schritte die Umgebung von buildkitd lesen
            envFrom,
            env: [{ name: 'BUILDKITD_FLAGS', value: '--oci-worker-no-process-sandbox' }],
            // rootless BuildKit braucht Unconfined, deshalb laufen Builds im eigenen Namespace statt beim User
            securityContext: {
              runAsUser: 1000,
              runAsGroup: 1000,
              seccompProfile: { type: 'Unconfined' },
              appArmorProfile: { type: 'Unconfined' },
            },
            volumeMounts: [
              { name: 'work', mountPath: '/work', readOnly: true },
              { name: 'buildkit', mountPath: '/home/user/.local/share/buildkit' },
              { name: 'zot', mountPath: '/home/user/.docker', readOnly: true },
            ],
          }],
        },
      },
    },
  };
}

// Apps eines Users erreichen sich gegenseitig, aber nichts im Cluster oder im LAN ausser DNS
const PRIVATE_NETS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'];

/** Namespace des Users samt Grenzen; Shipli legt ihn bei jedem Deploy und jeder Domain neu an (Server-Side Apply). */
export function namespaceManifests(user: string, limits: Limits): KubernetesObject[] {
  const namespace = namespaceOf(user);
  const meta = { name: 'shipli-default', namespace, labels: labels(user) };
  return [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      // die Admission-Policy shipli-nur-eigene-namespaces lässt Shipli nur Namespaces mit restricted anlegen
      metadata: { name: namespace, labels: { ...labels(user), 'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/enforce-version': 'latest' } },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: meta,
      spec: {
        podSelector: {},
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          { from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }] },
          { from: [{ podSelector: {} }] },
        ],
        egress: [
          { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: PRIVATE_NETS } }] },
          { to: [{ podSelector: {} }] },
          {
            to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
            ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
          },
        ],
      },
    },
    // Grenzen pro User aus der DB (Phase 4.5), der Admin ändert sie unter /admin
    ...quotaManifests(user, limits),
  ] as KubernetesObject[];
}

/** Passt während des Rollouts ein zweiter Pod in die Quota? Rechnet mit den Standardwerten der LimitRange. */
export function surgeFits(user: string, limits: Limits, status?: V1ResourceQuotaStatus): boolean {
  const [quota, range] = quotaManifests(user, limits) as unknown as [{ spec: { hard: Record<string, string> } }, { spec: { limits: Record<string, Record<string, string>>[] } }];
  const { defaultRequest, _default } = range.spec.limits[0];
  const pod: Record<string, string> = { 'requests.cpu': defaultRequest.cpu, 'limits.cpu': _default.cpu, 'limits.memory': _default.memory, 'limits.ephemeral-storage': _default['ephemeral-storage'], pods: '1' };
  return Object.entries(quota.spec.hard).every(([k, hard]) => {
    const cpu = k.endsWith('cpu');
    return parseQuantity(status?.used?.[k], cpu) + parseQuantity(pod[k], cpu) <= parseQuantity(hard, cpu);
  });
}

export function appManifests(input: DeployInput, sha: string, digest?: string, surge = true): KubernetesObject[] {
  const { user, project, env = {} } = input;
  const namespace = namespaceOf(user);
  const meta = { name: project, namespace, labels: labels(user, project) };
  const selector = { 'shipli/project': project };
  const { volume } = input;
  return [
    ...namespaceManifests(user, input.limits),
    { apiVersion: 'v1', kind: 'Secret', metadata: { ...meta, name: envSecretOf(project) }, type: 'Opaque', stringData: env },
    // ohne storageClassName nimmt Kubernetes die Standardklasse: im Cluster longhorn mit 3 Replikas, in k3d local-path
    ...(volume ? [{
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { ...meta, name: volumeOf(project) },
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: `${volume.mib}Mi` } } },
    }] : []),
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: meta,
      spec: {
        replicas: 1,
        // ohne Platz für einen zweiten Pod erst den alten stoppen (kurz offline), sonst bricht jeder Redeploy an der Quota ab
        // Ordner hängt nur an einem Pod (RWO): erst den alten ganz stoppen, sonst wartet der neue auf einem anderen Node ewig darauf
        strategy: volume ? { type: 'Recreate' }
          : { type: 'RollingUpdate', rollingUpdate: surge ? { maxSurge: 1, maxUnavailable: 0 } : { maxSurge: 0, maxUnavailable: 1 } },
        selector: { matchLabels: selector },
        template: {
          // geänderte Variablen sollen auch ohne neuen Commit einen Neustart auslösen
          metadata: { labels: labels(user, project), annotations: { 'shipli/env-hash': envHash(env) } },
          spec: {
            automountServiceAccountToken: false,
            // Railpack-Images laufen als root und Apps schreiben in /app (z. B. jass-app nach /app/data). Mit eigenem
            // User-Namespace ist root im Container auf dem Host eine unprivilegierte UID, das lässt PSA restricted zu
            hostUsers: false,
            securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
            // fällt ein Node aus, nach 30 s statt 5 min auf einem anderen starten (Longhorn hängt den Ordner dann um)
            tolerations: ['not-ready', 'unreachable'].map((t) => ({ key: `node.kubernetes.io/${t}`, operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 30 })),
            ...(volume && { volumes: [{ name: 'data', persistentVolumeClaim: { claimName: volumeOf(project) } }] }),
            containers: [{
              name: 'app',
              image: imageOf(config.registryPull, user, project, sha) + (digest ? `@${digest}` : ''),
              envFrom: [{ secretRef: { name: envSecretOf(project) } }],
              env: [{ name: 'PORT', value: String(PORT) }],
              ports: [{ containerPort: PORT }],
              readinessProbe: { tcpSocket: { port: PORT }, periodSeconds: 2 },
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
              ...(volume && { volumeMounts: [{ name: 'data', mountPath: volume.path }] }),
            }],
          },
        },
      },
    },
    { apiVersion: 'v1', kind: 'Service', metadata: meta, spec: { selector, ports: [{ port: 80, targetPort: PORT }] } },
    {
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'IngressRoute',
      metadata: meta,
      spec: {
        entryPoints: ['web'],
        routes: [{ match: `Host(\`${hostOf(user, project)}\`)`, kind: 'Rule', services: [{ name: project, port: 80 }] }],
      },
    },
  ] as KubernetesObject[];
}

export async function headSha(repo: string, token?: string): Promise<string> {
  const [, owner, name] = repo.match(REPO)!;
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/commits/HEAD`, {
    headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'shipli', ...(token && { Authorization: `Bearer ${token}` }) },
    signal: AbortSignal.timeout(15_000),
  });
  const sha = (await res.text()).trim();
  if (!res.ok || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Repo ${repo} nicht gefunden (privat? dann GitHub verbinden)`);
  return sha;
}

/** Macht aus "exceeded quota: shipli-default, requested: limits.memory=512Mi, used: …" einen Satz für den User. */
export function quotaMessage(message: string): string {
  if (!message.includes('exceeded quota')) return `App startet nicht: ${message}`;
  const what = message.match(/requested: (.*?), used:/)?.[1] ?? message;
  return `Deine Grenze ist erreicht, die App bekommt keinen Platz (verlangt: ${what}). Unter „Nutzung“ siehst du, was belegt ist; der Admin kann die Grenze erhöhen.`;
}

/** Satz für eine App, die beim Start abstürzt; bei OOMKilled reicht der RAM der Grenze nicht. */
export function crashMessage(t: { reason?: string; exitCode?: number } | undefined, limits: Limits): string {
  if (t?.reason === 'OOMKilled') return `Die App braucht mehr RAM als erlaubt und wurde beendet (höchstens ${Math.min(512, limits.memory_limit)} MiB pro App). Speicherbedarf senken oder den Admin um mehr RAM bitten.`;
  return `Die App stürzt beim Start ab${t?.exitCode !== undefined ? ` (Exit-Code ${t.exitCode})` : ''}. Im Log der App steht, warum.`;
}

/** Grösse eines Images in zot (komprimiert): Layer plus Config, bei einem Index die Summe aller Manifeste. Gemeinsame Basis-Layer zählen pro Projekt. */
export async function imageBytes(user: string, project: string, sha: string): Promise<number> {
  const base = process.env.SHIPLI_REGISTRY_API ?? `http://${config.registryPush}`;
  const auth = process.env.SHIPLI_REGISTRY_READ_AUTH; // "user:passwort", nur Leserecht
  const get = async (ref: string) => {
    const res = await fetch(`${base}/v2/${user}/${project}/manifests/${ref}`, {
      headers: {
        Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json',
        ...(auth && { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` }),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`zot antwortet ${res.status} für ${user}/${project}:${ref}`);
    return res.json() as Promise<{ manifests?: { digest: string }[]; layers?: { size: number }[]; config?: { size: number } }>;
  };
  const sizeOf = (m: { layers?: { size: number }[]; config?: { size: number } }) =>
    (m.layers ?? []).reduce((n, l) => n + l.size, 0) + (m.config?.size ?? 0);
  const top = await get(sha);
  if (!top.manifests) return sizeOf(top);
  let total = 0;
  for (const m of top.manifests) total += sizeOf(await get(m.digest));
  return total;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, timeoutMs: number, check: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await check();
    if (v !== undefined) return v;
    await sleep(2000);
  }
  throw new Error(`Zeitüberschreitung: ${what}`);
}

const containerState = (pod: V1Pod, name: string) =>
  [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].find((c) => c.name === name)?.state;

export const apply = (objects: KubernetesObjectApi, obj: KubernetesObject) =>
  objects.patch(obj, undefined, undefined, 'shipli', true, PatchStrategy.ServerSideApply);

/** Baut das Image und gibt seinen Digest zurück. Den Namespace shipli-builds legt deploy/shipli.yaml an. */
async function build(kc: KubeConfig, input: DeployInput, sha: string, out: NodeJS.WritableStream): Promise<string> {
  const core = kc.makeApiClient(CoreV1Api);
  const batch = kc.makeApiClient(BatchV1Api);
  const ns = config.buildNamespace;

  const meta = { generateName: `build-${input.project}--${input.user}-`, namespace: ns, labels: labels(input.user, input.project) };
  const envSecret = await core.createNamespacedSecret({ namespace: ns, body: { metadata: meta, stringData: input.env ?? {} } });
  const gitSecret = input.gitToken
    ? await core.createNamespacedSecret({ namespace: ns, body: { metadata: meta, stringData: { token: input.gitToken } } })
    : undefined;
  const job = await batch.createNamespacedJob({
    namespace: ns,
    body: buildJob(input, sha, { env: envSecret.metadata!.name!, git: gitSecret?.metadata?.name }),
  });
  const jobName = job.metadata!.name!;
  // Secrets hängen am Job und verschwinden mit ihm (ttlSecondsAfterFinished)
  const owner = [{ apiVersion: 'batch/v1', kind: 'Job', name: jobName, uid: job.metadata!.uid! }];
  for (const s of [envSecret, gitSecret]) {
    // client-node schickt hier einen JSON-Patch (Liste von Operationen), kein Merge-Objekt
    if (s) await core.patchNamespacedSecret({ name: s.metadata!.name!, namespace: ns, body: [{ op: 'add', path: '/metadata/ownerReferences', value: owner }] });
  }
  out.write(`Build-Job ${ns}/${jobName}\n`);

  const podName = await waitFor('Build-Pod', 60_000, async () =>
    (await core.listNamespacedPod({ namespace: ns, labelSelector: `job-name=${jobName}` })).items[0]?.metadata?.name);

  for (const container of ['prepare', 'build']) {
    out.write(container === 'prepare' ? `${STEP}Code holen und Build planen\n` : `\n${STEP}Image bauen\n`);
    const state = await waitFor(`Container ${container}`, 300_000, async () => {
      const s = containerState(await core.readNamespacedPod({ name: podName, namespace: ns }), container);
      return s?.running || s?.terminated ? s : undefined;
    });
    const stream = new PassThrough();
    stream.pipe(out, { end: false });
    const done = new Promise((r) => stream.on('end', r));
    await new Log(kc).log(ns, podName, container, stream, { follow: true });
    await done;
    if (container === 'prepare' && state.terminated && state.terminated.exitCode !== 0) break;
  }

  const status = await waitFor('Build-Ende', 900_000, async () => {
    const s = (await batch.readNamespacedJob({ name: jobName, namespace: ns })).status;
    return s?.succeeded ? 'ok' : s?.failed ? 'failed' : undefined;
  });
  if (status !== 'ok') throw new Error('Build fehlgeschlagen, Details im Log oben');
  const digest = digestOf(containerState(await core.readNamespacedPod({ name: podName, namespace: ns }), 'build')?.terminated?.message);
  if (!digest) throw new Error('Build ohne Digest');
  return digest;
}

export function digestOf(metadata: string | undefined): string | undefined {
  try {
    const d = JSON.parse(metadata ?? '')['containerimage.digest'];
    return /^sha256:[0-9a-f]{64}$/.test(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

export async function deploy(input: DeployInput, out: NodeJS.WritableStream = process.stdout): Promise<{ url: string; sha: string }> {
  validate(input);
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const sha = input.sha ?? (await headSha(input.repo, input.gitToken));
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Ungültiger Commit ${sha}`);
  const started = Date.now();
  out.write(`${STEP}Commit ${sha.slice(0, 7)} von ${input.repo.replace('https://github.com/', '')}\n`);

  const digest = await build(kc, input, sha, out);
  out.write(`\n${STEP}Image gebaut, App starten\n`);

  const objects = KubernetesObjectApi.makeApiClient(kc);
  const core = kc.makeApiClient(CoreV1Api);
  const namespace = namespaceOf(input.user);
  const quota = await core.readNamespacedResourceQuota({ name: 'shipli-default', namespace }).catch(() => undefined);
  const surge = !!input.volume || surgeFits(input.user, input.limits, quota?.status);
  if (input.volume) out.write(`${STEP}Mit dauerhaftem Ordner ${input.volume.path}: die alte Version stoppt zuerst\n`);
  else if (!surge) out.write(`${STEP}Kein Platz für einen zweiten Pod, die alte Version stoppt zuerst\n`);
  const manifests = appManifests(input, sha, digest, surge);
  const apps = kc.makeApiClient(AppsV1Api);
  if (input.volume) {
    // rollingUpdate setzt Kubernetes bei älteren Deployments als Standard, Server-Side Apply entfernt es dann nicht,
    // und Recreate mit rollingUpdate lehnt die API ab (422); darum die Strategie vorher ganz ersetzen
    await apps.patchNamespacedDeployment({ name: input.project, namespace, body: [{ op: 'replace', path: '/spec/strategy', value: { type: 'Recreate' } }] })
      .catch((err) => { if ((err as { code?: number }).code !== 404) throw err; });
  }
  for (const obj of manifests) await apply(objects, obj);
  const hash = envHash(input.env ?? {});
  const image = (manifests.find((o) => o.kind === 'Deployment') as { spec: { template: { spec: { containers: { image: string }[] } } } }).spec.template.spec.containers[0].image;

  const applied = Date.now();
  await waitFor('Rollout', 180_000, async () => {
    const d = await apps.readNamespacedDeployment({ name: input.project, namespace });
    const s = d.status;
    const ready = s?.observedGeneration === d.metadata?.generation && s?.updatedReplicas === 1 && s?.availableReplicas === 1 && !s?.unavailableReplicas;
    if (ready) return true;
    const pods = (await core.listNamespacedPod({ namespace, labelSelector: `shipli/project=${input.project}` })).items;
    // ein Pod, der gerade gestoppt wird (gleicher Commit nochmals deployt), ist nicht neu
    const isNew = (p: V1Pod) => !p.metadata?.deletionTimestamp && p.spec?.containers[0]?.image === image && p.metadata?.annotations?.['shipli/env-hash'] === hash;
    const crash = pods.filter(isNew).flatMap((p) => p.status?.containerStatuses ?? []).find((c) => c.state?.terminated || c.lastState?.terminated);
    if (crash) throw new Error(crashMessage(crash.state?.terminated ?? crash.lastState?.terminated, input.limits));
    if (input.volume && Date.now() - applied > 60_000) {
      const pvc = await core.readNamespacedPersistentVolumeClaim({ name: volumeOf(input.project), namespace });
      if (pvc.status?.phase !== 'Bound') throw new Error('Im Cluster ist gerade kein Platz für deinen Ordner. Frag den Admin.');
    }
    // z. B. Quota voll oder Pod verstösst gegen PSA: sonst nur eine stumme Zeitüberschreitung. Stoppt die alte
    // Version zuerst, belegt ihr Pod die Quota noch, bis er weg ist; so lange ist ReplicaFailure kein Fehler
    const failure = s?.conditions?.find((c) => c.type === 'ReplicaFailure' && c.status === 'True');
    if (failure && (surge || !pods.some((p) => !isNew(p)))) throw new Error(quotaMessage(failure.message ?? ''));
    return undefined;
  });
  // Ordner entfernt: erst jetzt löschen, vorher hing er noch an der alten Version
  if (!input.volume) await deleteIfExists(objects, 'v1', 'PersistentVolumeClaim', volumeOf(input.project), namespace);

  const port = process.env.SHIPLI_HTTP_PORT ? `:${process.env.SHIPLI_HTTP_PORT}` : '';
  const url = `http://${hostOf(input.user, input.project)}${port}`;
  const secs = Math.round((Date.now() - started) / 1000);
  out.write(`${STEP}Läuft nach ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} min: ${url}\n`);
  return { url, sha };
}

/** Löscht, was appManifests angelegt hat (ausser Namespace und NetworkPolicy, die gehören dem User). */
export async function removeApp(user: string, project: string): Promise<void> {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const objects = KubernetesObjectApi.makeApiClient(kc);
  const namespace = namespaceOf(user);
  for (const [apiVersion, kind, name] of [
    ['apps/v1', 'Deployment', project],
    ['v1', 'Service', project],
    ['traefik.io/v1alpha1', 'IngressRoute', project],
    ['v1', 'Secret', envSecretOf(project)],
    ['v1', 'PersistentVolumeClaim', volumeOf(project)],
  ]) await deleteIfExists(objects, apiVersion, kind, name, namespace);
}

const deleteIfExists = (objects: KubernetesObjectApi, apiVersion: string, kind: string, name: string, namespace: string) =>
  objects.delete({ apiVersion, kind, metadata: { name, namespace } }).then(() => undefined, (err) => {
    if ((err as { code?: number }).code !== 404) throw err;
  });

/** Löscht den ganzen Namespace des Users, Kubernetes räumt alles darin mit ab. */
export async function removeNamespace(user: string): Promise<void> {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  await kc.makeApiClient(CoreV1Api).deleteNamespace({ name: namespaceOf(user) }).catch((err) => {
    if ((err as { code?: number }).code !== 404) throw err;
  });
}

export async function runtimeLog(user: string, project: string, tailLines = 200): Promise<string> {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(CoreV1Api);
  const namespace = namespaceOf(user);
  const pods = (await core.listNamespacedPod({ namespace, labelSelector: `shipli/project=${project}` })).items
    .sort((a, b) => (b.metadata?.creationTimestamp?.getTime() ?? 0) - (a.metadata?.creationTimestamp?.getTime() ?? 0));
  const pod = pods[0]?.metadata?.name;
  if (!pod) return '';
  return core.readNamespacedPodLog({ name: pod, namespace, container: 'app', tailLines });
}
