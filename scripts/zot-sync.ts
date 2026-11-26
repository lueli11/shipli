// Hält die zot-Konten alle 15 s mit den Usern und offenen Einladungen in der DB gleich (siehe src/zot-sync.ts).
// Im Cluster: Deployment zot-sync in deploy/shipli.yaml.
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { sql } from '../src/db.ts';
import { buildAccounts, dockerConfig, passwordFromDockerConfig, pushSecret } from '../src/zot-sync.ts';

const kc = new KubeConfig();
kc.loadFromDefault();
const core = kc.makeApiClient(CoreV1Api);
const registry = process.env.SHIPLI_REGISTRY_PUSH ?? 'zot.zot.svc.cluster.local:5000';
const system = { release: process.env.ZOT_RELEASE_PASSWORD ?? '', puller: process.env.ZOT_PULLER_PASSWORD ?? '' };
if (!system.release || !system.puller) throw new Error('ZOT_RELEASE_PASSWORD und ZOT_PULLER_PASSWORD fehlen (Secret zot-konten)');
const decode = (v?: string) => (v ? Buffer.from(v, 'base64').toString() : '');
const is404 = (err: unknown) => (err as { code?: number }).code === 404;

async function sync() {
  const users = (await sql<{ name: string }[]>`
    SELECT name FROM users UNION SELECT name FROM invites WHERE used_at IS NULL AND expires_at > now() ORDER BY 1`).map((r) => r.name);
  const secrets = (await core.listNamespacedSecret({ namespace: 'shipli-builds', labelSelector: 'shipli/zot-push=true' })).items;
  const known = new Map<string, string>();
  for (const s of secrets) {
    const pw = passwordFromDockerConfig(decode(s.data?.['.dockerconfigjson']));
    if (pw) known.set(s.metadata!.name!.slice('zot-push-'.length), pw);
  }
  const current = await core.readNamespacedSecret({ name: 'zot-zugang', namespace: 'zot' }).catch((err) => (is404(err) ? undefined : Promise.reject(err)));
  const acc = await buildAccounts(users, known, system, decode(current?.data?.htpasswd));

  if (decode(current?.data?.htpasswd) !== acc.htpasswd || decode(current?.data?.['config.json']) !== acc.config) {
    const body = { metadata: { name: 'zot-zugang', namespace: 'zot' }, stringData: { htpasswd: acc.htpasswd, 'config.json': acc.config } };
    await (current ? core.replaceNamespacedSecret({ name: 'zot-zugang', namespace: 'zot', body }) : core.createNamespacedSecret({ namespace: 'zot', body }));
    console.log(`zot-Konten: release, puller, ${users.map((u) => `u-${u}`).join(', ')}`);
  }
  // zot kennt ein neues Konto erst, wenn das Kubelet zot-zugang nachgeladen hat (bis etwa 1 min)
  for (const u of users) {
    if (known.has(u)) continue;
    await core.createNamespacedSecret({ namespace: 'shipli-builds', body: {
      metadata: { name: pushSecret(u), labels: { 'shipli/zot-push': 'true' } }, type: 'kubernetes.io/dockerconfigjson',
      stringData: { '.dockerconfigjson': dockerConfig(registry, u, acc.passwords.get(u)!) } } });
  }
  for (const u of known.keys()) {
    if (users.includes(u)) continue;
    await core.deleteNamespacedSecret({ name: pushSecret(u), namespace: 'shipli-builds' }).catch((err) => (is404(err) ? undefined : Promise.reject(err)));
    console.log(`zot-Konto von ${u} entfernt`);
  }
}

for (;;) {
  await sync().catch((err) => console.error(`zot-sync: ${(err as Error).message}`));
  await new Promise((r) => setTimeout(r, 15_000));
}
