import https from 'node:https';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { sql } from './db.ts';
import { imageBytesOf } from './limits.ts';

// Messwerte kommen nur aus /stats/summary der Kubelets (wie Dokploys Sammler, aber ohne Docker-Socket).
// Shipli fragt das Kubelet direkt mit nodes/stats; nodes/proxy würde exec in jeden Pod erlauben.

export const INTERVAL_MS = 30_000;
const KEEP_RAW = '7 days';
const KEEP_DAILY = '13 months';

type Counter = { rx: number; tx: number };
type Summary = {
  node: { nodeName: string; cpu?: { usageNanoCores?: number }; memory?: { workingSetBytes?: number }; fs?: { usedBytes?: number; capacityBytes?: number }; network?: { rxBytes?: number; txBytes?: number } };
  pods: { podRef: { name: string; namespace: string; uid: string }; cpu?: { usageNanoCores?: number }; memory?: { workingSetBytes?: number }; network?: { rxBytes?: number; txBytes?: number }; 'ephemeral-storage'?: { usedBytes?: number } }[];
};
export type NodeRow = { node: string; cpu: number; cpu_total: number; memory: number; memory_total: number; disk: number; disk_total: number; rx: number; tx: number };
export type PodRow = { user_id: number; project: string; pod: string; cpu: number; memory: number; disk: number; rx: number; tx: number };

/** Zuwachs eines Zählers; nach einem Neustart beginnt er bei 0, dann zählt der neue Stand ganz. */
export const delta = (prev: number | undefined, cur: number) => (prev === undefined ? 0 : cur < prev ? cur : cur - prev);

const milli = (nano?: number) => Math.round((nano ?? 0) / 1e6);

/** Pod "<projekt>-<replicaset>-<pod>" → Projekt; Projektnamen dürfen selbst "-" enthalten. */
export const projectOfPod = (pod: string) => pod.split('-').slice(0, -2).join('-') || pod;

/** Rechnet eine Summary in Zeilen um; prev hält die Netzzähler der letzten Runde (pro Node und Pod-UID). */
export function parseSummary(
  s: Summary,
  capacity: { cpu: number; memory: number },
  users: Map<string, number>,
  prev: Map<string, Counter>,
): { node: NodeRow; pods: PodRow[] } {
  const count = (key: string, net?: { rxBytes?: number; txBytes?: number }) => {
    const cur = { rx: net?.rxBytes ?? 0, tx: net?.txBytes ?? 0 };
    const p = prev.get(key);
    prev.set(key, cur);
    return { rx: delta(p?.rx, cur.rx), tx: delta(p?.tx, cur.tx) };
  };
  const n = s.node;
  const node: NodeRow = {
    node: n.nodeName,
    cpu: milli(n.cpu?.usageNanoCores),
    cpu_total: capacity.cpu,
    memory: n.memory?.workingSetBytes ?? 0,
    memory_total: capacity.memory,
    disk: n.fs?.usedBytes ?? 0,
    disk_total: n.fs?.capacityBytes ?? 0,
    ...count(`node/${n.nodeName}`, n.network),
  };
  const pods: PodRow[] = [];
  for (const p of s.pods) {
    const { name, namespace, uid } = p.podRef;
    const userId = namespace.startsWith('shipli-u-') ? users.get(namespace.slice('shipli-u-'.length)) : undefined;
    if (userId === undefined) continue;
    pods.push({
      user_id: userId,
      project: projectOfPod(name),
      pod: name,
      cpu: milli(p.cpu?.usageNanoCores),
      memory: p.memory?.workingSetBytes ?? 0,
      disk: p['ephemeral-storage']?.usedBytes ?? 0,
      ...count(`pod/${uid}`, p.network),
    });
  }
  return { node, pods };
}

/** "4" → 4000, "3900m" → 3900; "16Gi"/"16384Ki" → Bytes. */
export function parseQuantity(q: string | undefined, cpu = false): number {
  const m = (q ?? '0').match(/^([0-9.]+)([a-zA-Z]*)$/);
  if (!m) return 0;
  const v = Number(m[1]);
  const unit: Record<string, number> = { '': 1, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 };
  const value = v * (unit[m[2]] ?? 1);
  return Math.round(cpu ? value * 1000 : value);
}

async function kubeletSummary(kc: KubeConfig, ip: string, port: number): Promise<Summary> {
  const opts: https.RequestOptions = { host: ip, port, path: '/stats/summary?only_cpu_and_memory=false', method: 'GET', timeout: 10_000 };
  await kc.applyToHTTPSOptions(opts);
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Kubelet ${ip}: ${res.statusCode} ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Kubelet ${ip}: Zeitüberschreitung`)));
    req.on('error', reject);
    req.end();
  });
}

const prev = new Map<string, Counter>();
let lastPrune = 0;

/** Eine Messrunde: alle Nodes, alle Pods in shipli-u-*. Ein Node, der nicht antwortet, fehlt nur in dieser Runde. */
export async function collect(kc: KubeConfig): Promise<{ nodes: number; pods: number; errors: string[] }> {
  const at = new Date();
  const users = new Map((await sql<{ id: number; name: string }[]>`SELECT id, name FROM users`).map((u) => [u.name, u.id]));
  const nodes = (await kc.makeApiClient(CoreV1Api).listNode()).items;
  const errors: string[] = [];
  const nodeRows: NodeRow[] = [];
  const podRows: PodRow[] = [];
  await Promise.all(nodes.map(async (n) => {
    const ip = n.status?.addresses?.find((a) => a.type === 'InternalIP')?.address;
    if (!ip) return;
    try {
      const summary = await kubeletSummary(kc, ip, n.status?.daemonEndpoints?.kubeletEndpoint?.Port ?? 10250);
      const capacity = { cpu: parseQuantity(n.status?.capacity?.cpu, true), memory: parseQuantity(n.status?.capacity?.memory) };
      const r = parseSummary(summary, capacity, users, prev);
      nodeRows.push(r.node);
      podRows.push(...r.pods);
    } catch (err) {
      errors.push(`${n.metadata?.name}: ${(err as Error).message}`);
    }
  }));
  if (nodeRows.length) await sql`INSERT INTO node_metrics ${sql(nodeRows.map((r) => ({ at, ...r })))}`;
  if (podRows.length) await sql`INSERT INTO pod_metrics ${sql(podRows.map((r) => ({ at, ...r })))}`;
  const perUser = new Map<number, Counter>();
  for (const p of podRows) {
    const u = perUser.get(p.user_id) ?? { rx: 0, tx: 0 };
    perUser.set(p.user_id, { rx: u.rx + p.rx, tx: u.tx + p.tx });
  }
  for (const [userId, c] of perUser) {
    if (!c.rx && !c.tx) continue;
    await sql`INSERT INTO usage_daily (user_id, day, rx, tx) VALUES (${userId}, ${at}::date, ${c.rx}, ${c.tx})
      ON CONFLICT (user_id, day) DO UPDATE SET rx = usage_daily.rx + EXCLUDED.rx, tx = usage_daily.tx + EXCLUDED.tx`;
  }
  if (Date.now() - lastPrune > 3600_000) {
    lastPrune = Date.now();
    await sql`DELETE FROM node_metrics WHERE at < now() - ${KEEP_RAW}::interval`;
    await sql`DELETE FROM pod_metrics WHERE at < now() - ${KEEP_RAW}::interval`;
    await sql`DELETE FROM usage_daily WHERE day < now() - ${KEEP_DAILY}::interval`;
    await sql`DELETE FROM mcp_audit WHERE at < now() - interval '90 days'`;
    // Netzzähler gelöschter Pods nicht ewig behalten
    if (prev.size > 5000) prev.clear();
  }
  return { nodes: nodeRows.length, pods: podRows.length, errors };
}

/** Startet die Messung im Prozess von Next.js. */
// shortcut: jede Replika misst für sich; mit mehr als einer Replika pg_try_advisory_lock oder ein eigener Pod
export function startCollector(): void {
  const g = globalThis as { shipliCollector?: NodeJS.Timeout };
  if (g.shipliCollector) return;
  const kc = new KubeConfig();
  kc.loadFromDefault();
  let lastError = '';
  const run = () => collect(kc).then(
    (r) => {
      const e = r.errors.join('; ');
      if (e && e !== lastError) console.warn(`Messung unvollständig: ${e}`);
      lastError = e;
    },
    (err) => {
      const e = (err as Error).message;
      if (e !== lastError) console.warn(`Messung fehlgeschlagen: ${e}`);
      lastError = e;
    },
  );
  g.shipliCollector = setInterval(run, INTERVAL_MS);
  g.shipliCollector.unref();
  void run();
}

// ---- Abfragen für die Oberfläche. Werte pro Punkt: CPU in %, RAM/Platte in GB, Netz in kB/s (wie die Diagramme von Dokploy).

export type Point = { timestamp: string; cpu: number; memUsedGB: number; memTotalGB: number; diskUsedGB: number; diskTotalGB: number; networkIn: number; networkOut: number };

const GB = 2 ** 30;
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const points = (n: number) => Math.min(Math.max(Math.trunc(n) || 50, 10), 20_160); // 7 Tage à 30 s

/** Admin: ein Node oder alle zusammen. */
export async function nodeSeries(node: string | undefined, n: number): Promise<Point[]> {
  const rows = await sql<{ at: Date; cpu: string; cpu_total: string; memory: string; memory_total: string; disk: string; disk_total: string; rx: string; tx: string }[]>`
    SELECT at, sum(cpu) AS cpu, sum(cpu_total) AS cpu_total, sum(memory) AS memory, sum(memory_total) AS memory_total,
      sum(disk) AS disk, sum(disk_total) AS disk_total, sum(rx) AS rx, sum(tx) AS tx
    FROM node_metrics ${node ? sql`WHERE node = ${node}` : sql``}
    GROUP BY at ORDER BY at DESC LIMIT ${points(n)}`;
  return rows.reverse().map((r) => ({
    timestamp: r.at.toISOString(),
    cpu: round((Number(r.cpu) / Number(r.cpu_total)) * 100, 1),
    memUsedGB: round(Number(r.memory) / GB),
    memTotalGB: round(Number(r.memory_total) / GB),
    diskUsedGB: round(Number(r.disk) / GB),
    diskTotalGB: round(Number(r.disk_total) / GB),
    networkIn: round(Number(r.rx) / 1024 / (INTERVAL_MS / 1000), 1),
    networkOut: round(Number(r.tx) / 1024 / (INTERVAL_MS / 1000), 1),
  }));
}

export type NodeInfo = { name: string; cpus: number; memoryGB: number; os: string; kernel: string; arch: string; kubelet: string; ready: boolean; since: string | null };

export async function nodeInfos(): Promise<NodeInfo[]> {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return (await kc.makeApiClient(CoreV1Api).listNode()).items.map((n) => ({
    name: n.metadata!.name!,
    cpus: parseQuantity(n.status?.capacity?.cpu, true) / 1000,
    memoryGB: round(parseQuantity(n.status?.capacity?.memory) / GB, 1),
    os: n.status?.nodeInfo?.osImage ?? '',
    kernel: n.status?.nodeInfo?.kernelVersion ?? '',
    arch: n.status?.nodeInfo?.architecture ?? '',
    kubelet: n.status?.nodeInfo?.kubeletVersion ?? '',
    ready: n.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false,
    since: n.metadata?.creationTimestamp ? new Date(n.metadata.creationTimestamp).toISOString() : null,
  }));
}

/** User: eigene Pods, optional ein Projekt. CPU in % der garantierten CPU, RAM und Platte gegen die eigenen Grenzen. */
export async function userSeries(userId: number, project: string | undefined, n: number): Promise<Point[]> {
  const [u] = await sql<{ cpu_limit: number; memory_limit: number; storage_limit: number }[]>`
    SELECT cpu_limit, memory_limit, storage_limit FROM users WHERE id = ${userId}`;
  if (!u) return [];
  const images = await imageBytesOf(userId, project);
  const rows = await sql<{ at: Date; cpu: string; memory: string; disk: string; rx: string; tx: string }[]>`
    SELECT at, sum(cpu) AS cpu, sum(memory) AS memory, sum(disk) AS disk, sum(rx) AS rx, sum(tx) AS tx
    FROM pod_metrics WHERE user_id = ${userId} ${project ? sql`AND project = ${project}` : sql``}
    GROUP BY at ORDER BY at DESC LIMIT ${points(n)}`;
  return rows.reverse().map((r) => ({
    timestamp: r.at.toISOString(),
    cpu: round((Number(r.cpu) / u.cpu_limit) * 100, 1),
    memUsedGB: round(Number(r.memory) / GB),
    memTotalGB: round(u.memory_limit / 1024),
    diskUsedGB: round((Number(r.disk) + images) / GB),
    diskTotalGB: round(u.storage_limit / 1024),
    networkIn: round(Number(r.rx) / 1024 / (INTERVAL_MS / 1000), 1),
    networkOut: round(Number(r.tx) / 1024 / (INTERVAL_MS / 1000), 1),
  }));
}

export type Usage = {
  user_id: number;
  cpu: number; cpu_limit: number; // Millicores
  memory: number; memory_limit: number; // Bytes
  storage: number; storage_limit: number; // Bytes
  projects: number; max_projects: number;
  volume: number; volume_limit: number; // Bytes, zugeteilte Ordner (nicht belegt)
  rx_month: number; tx_month: number; // Bytes seit dem 1. des Monats
};

/** Aktueller Stand (letzte Messrunde der letzten 2 Minuten) für einen User oder alle. */
export async function usage(userId?: number): Promise<Usage[]> {
  const rows = await sql<Record<keyof Usage, string | number>[]>`
    WITH last AS (SELECT max(at) AS at FROM pod_metrics WHERE at > now() - interval '2 minutes'),
    now_ AS (
      SELECT m.user_id, sum(m.cpu) AS cpu, sum(m.memory) AS memory, sum(m.disk) AS disk
      FROM pod_metrics m, last WHERE m.at = last.at GROUP BY m.user_id
    ),
    img AS (
      SELECT p.user_id, sum(d.image_bytes) AS bytes, count(*) AS projects, sum(p.volume_mib)::bigint * 1048576 AS volume FROM projects p
      LEFT JOIN LATERAL (SELECT image_bytes FROM deployments WHERE project_id = p.id AND status = 'done' ORDER BY id DESC LIMIT 1) d ON true
      GROUP BY p.user_id
    ),
    month AS (
      SELECT user_id, sum(rx) AS rx, sum(tx) AS tx FROM usage_daily WHERE day >= date_trunc('month', now()) GROUP BY user_id
    )
    SELECT u.id AS user_id,
      coalesce(n.cpu, 0) AS cpu, u.cpu_limit,
      coalesce(n.memory, 0) AS memory, u.memory_limit::bigint * 1048576 AS memory_limit,
      coalesce(n.disk, 0) + coalesce(i.bytes, 0) AS storage, u.storage_limit::bigint * 1048576 AS storage_limit,
      coalesce(i.projects, 0) AS projects, u.max_projects,
      coalesce(i.volume, 0) AS volume, u.volume_limit::bigint * 1048576 AS volume_limit,
      coalesce(mo.rx, 0) AS rx_month, coalesce(mo.tx, 0) AS tx_month
    FROM users u
    LEFT JOIN now_ n ON n.user_id = u.id
    LEFT JOIN img i ON i.user_id = u.id
    LEFT JOIN month mo ON mo.user_id = u.id
    ${userId === undefined ? sql`` : sql`WHERE u.id = ${userId}`}
    ORDER BY u.created_at`;
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])) as Usage);
}
