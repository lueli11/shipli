import { CoreV1Api, KubeConfig, KubernetesObjectApi, type KubernetesObject } from '@kubernetes/client-node';
import { sql } from './db.ts';
import { apply, labels, namespaceOf } from './deploy.ts';

/** Grenzen eines Users: CPU in Millicores (garantiert, kurz bis 4×), RAM und Speicher in MiB. */
export type Limits = { cpu_limit: number; memory_limit: number; storage_limit: number; max_projects: number; volume_limit: number };

const RANGES: Record<keyof Limits, [number, number]> = {
  cpu_limit: [100, 16_000],
  memory_limit: [128, 65_536],
  storage_limit: [256, 1_048_576],
  max_projects: [0, 100],
  volume_limit: [0, 1_048_576],
};

export function validateLimits(l: Limits): void {
  for (const [key, [min, max]] of Object.entries(RANGES) as [keyof Limits, [number, number]][]) {
    if (!Number.isSafeInteger(l[key]) || l[key] < min || l[key] > max) throw new Error(`${key} muss zwischen ${min} und ${max} liegen`);
  }
}

/** Nach ID oder Name (Name ist eindeutig, deploy() kennt nur ihn). */
export async function getLimits(user: number | string): Promise<Limits> {
  const [l] = await sql<Limits[]>`SELECT cpu_limit, memory_limit, storage_limit, max_projects, volume_limit FROM users
    WHERE ${typeof user === 'number' ? sql`id = ${user}` : sql`name = ${user}`}`;
  if (!l) throw new Error('User nicht gefunden');
  return l;
}

/** ResourceQuota und LimitRange für den Namespace des Users. */
export function quotaManifests(user: string, l: Limits): KubernetesObject[] {
  const meta = { name: 'shipli-default', namespace: namespaceOf(user), labels: labels(user) };
  const cpuMax = l.cpu_limit * 4;
  // Standard pro Container darf nicht über dem Maximum liegen, sonst lehnt Kubernetes die LimitRange ab
  const def = { cpu: Math.min(500, cpuMax), memory: Math.min(512, l.memory_limit), storage: Math.min(512, l.storage_limit) };
  return [
    {
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: meta,
      spec: {
        hard: {
          'requests.cpu': `${l.cpu_limit}m`,
          'limits.cpu': `${cpuMax}m`,
          'limits.memory': `${l.memory_limit}Mi`,
          'limits.ephemeral-storage': `${l.storage_limit}Mi`,
          // jedes Projekt plus ein neuer Pod während des Rollouts
          pods: String(2 * l.max_projects + 2),
          // dauerhafte Ordner, höchstens einer pro Projekt
          'requests.storage': `${l.volume_limit}Mi`,
          persistentvolumeclaims: String(l.max_projects),
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'LimitRange',
      metadata: meta,
      spec: {
        limits: [{
          type: 'Container',
          defaultRequest: { cpu: `${Math.min(50, def.cpu)}m`, memory: `${Math.min(128, def.memory)}Mi`, 'ephemeral-storage': `${Math.min(64, def.storage)}Mi` },
          // client-node serialisiert nach seinem Modell, dort heisst das Feld _default; "default" fiele still weg
          // und Kubernetes nähme dann max als Standard für jeden Container
          _default: { cpu: `${def.cpu}m`, memory: `${def.memory}Mi`, 'ephemeral-storage': `${def.storage}Mi` },
          max: { cpu: `${cpuMax}m`, memory: `${l.memory_limit}Mi`, 'ephemeral-storage': `${l.storage_limit}Mi` },
        }],
      },
    },
  ] as unknown as KubernetesObject[];
}

/** Speichert neue Grenzen und wendet sie sofort an, falls der User schon einen Namespace hat. */
export async function setLimits(userId: number, l: Limits): Promise<void> {
  validateLimits(l);
  const [u] = await sql<{ name: string }[]>`
    UPDATE users SET cpu_limit = ${l.cpu_limit}, memory_limit = ${l.memory_limit}, storage_limit = ${l.storage_limit}, max_projects = ${l.max_projects}, volume_limit = ${l.volume_limit}
    WHERE id = ${userId} RETURNING name`;
  if (!u) throw new Error('User nicht gefunden');
  const kc = new KubeConfig();
  kc.loadFromDefault();
  try {
    await kc.makeApiClient(CoreV1Api).readNamespace({ name: namespaceOf(u.name) });
  } catch (err) {
    if ((err as { code?: number }).code === 404) return; // kommt beim ersten Deploy
    throw err;
  }
  const objects = KubernetesObjectApi.makeApiClient(kc);
  for (const obj of quotaManifests(u.name, l)) await apply(objects, obj);
}

/** Bytes der laufenden Images (letzter erfolgreicher Deploy pro Projekt). */
export async function imageBytesOf(userId: number, project?: string): Promise<number> {
  const [r] = await sql<{ bytes: string | null }[]>`
    SELECT sum(d.image_bytes) AS bytes FROM projects p
    JOIN LATERAL (SELECT image_bytes FROM deployments WHERE project_id = p.id AND status = 'done' ORDER BY id DESC LIMIT 1) d ON true
    WHERE p.user_id = ${userId} ${project ? sql`AND p.name = ${project}` : sql``}`;
  return Number(r?.bytes ?? 0);
}

/** Vor einem Deploy: Images allein dürfen den Speicher nicht schon füllen (Kubernetes kennt die Images nicht). */
export async function checkStorage(userId: number): Promise<void> {
  const { storage_limit } = await getLimits(userId);
  if ((await imageBytesOf(userId)) >= storage_limit * 2 ** 20) {
    throw new Error(`Dein Speicher (${(storage_limit / 1024).toFixed(1)} GiB) ist voll. Lösche ein Projekt oder frag den Admin nach mehr.`);
  }
}
