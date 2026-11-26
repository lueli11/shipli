import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { acceptInvite, createInvite, userBySession } from './auth.ts';
import { createProject, removeVolume, setVolume } from './projects.ts';
import { delta, parseQuantity, parseSummary, projectOfPod, usage, userSeries } from './metrics.ts';
import { quotaManifests, validateLimits, type Limits } from './limits.ts';
import { crashMessage, quotaMessage, surgeFits } from './deploy.ts';
import { sql } from './db.ts';

const db = { skip: !process.env.DATABASE_URL && 'DATABASE_URL fehlt' };
const suffix = randomBytes(3).toString('hex');
after(async () => {
  await sql`DELETE FROM users WHERE name LIKE ${'m' + suffix + '%'}`;
  await sql`DELETE FROM invites WHERE name LIKE ${'m' + suffix + '%'}`;
  await sql.end();
});

async function newUser(tag: string) {
  const name = `m${suffix}-${tag}`;
  return (await userBySession(await acceptInvite(await createInvite(`${name}@example.com`, name), 'langes-passwort')))!;
}

test('Netzzähler: Differenz, Neustart zählt ganz, erste Runde 0', () => {
  assert.equal(delta(undefined, 500), 0);
  assert.equal(delta(100, 350), 250);
  assert.equal(delta(1000, 40), 40);
});

test('Projekt aus dem Pod-Namen, auch mit Bindestrich', () => {
  assert.equal(projectOfPod('jass-app-7d9f8c6b5-x2k4q'), 'jass-app');
  assert.equal(projectOfPod('blog-5c7b9-abcde'), 'blog');
});

test('Mengen aus Kubernetes', () => {
  assert.equal(parseQuantity('4', true), 4000);
  assert.equal(parseQuantity('3900m', true), 3900);
  assert.equal(parseQuantity('16384Ki'), 16 * 2 ** 20);
  assert.equal(parseQuantity('2Gi'), 2 * 2 ** 30);
});

test('Summary: nur Pods von Usern, Netz als Zuwachs pro Pod', () => {
  const summary = (rx: number) => ({
    node: { nodeName: 'n1', cpu: { usageNanoCores: 1_500_000_000 }, memory: { workingSetBytes: 1000 }, fs: { usedBytes: 5, capacityBytes: 10 }, network: { rxBytes: rx, txBytes: 0 } },
    pods: [
      { podRef: { name: 'blog-abc12-xyz34', namespace: 'shipli-u-anna', uid: 'u1' }, cpu: { usageNanoCores: 20_000_000 }, memory: { workingSetBytes: 300 }, network: { rxBytes: rx, txBytes: 2 * rx }, 'ephemeral-storage': { usedBytes: 7 } },
      { podRef: { name: 'traefik-1-2', namespace: 'kube-system', uid: 'k1' } },
      { podRef: { name: 'x-1-2', namespace: 'shipli-u-unbekannt', uid: 'u2' } },
    ],
  });
  const prev = new Map();
  const users = new Map([['anna', 7]]);
  const cap = { cpu: 4000, memory: 8000 };
  const first = parseSummary(summary(100), cap, users, prev);
  assert.deepEqual(first.node, { node: 'n1', cpu: 1500, cpu_total: 4000, memory: 1000, memory_total: 8000, disk: 5, disk_total: 10, rx: 0, tx: 0 });
  assert.deepEqual(first.pods, [{ user_id: 7, project: 'blog', pod: 'blog-abc12-xyz34', cpu: 20, memory: 300, disk: 7, rx: 0, tx: 0 }]);
  const second = parseSummary(summary(250), cap, users, prev);
  assert.equal(second.node.rx, 150);
  assert.deepEqual([second.pods[0].rx, second.pods[0].tx], [150, 300]);
});

test('Quota aus den Grenzen; Standard pro Container nie über dem Maximum', () => {
  const l: Limits = { cpu_limit: 1000, memory_limit: 2048, storage_limit: 5120, max_projects: 3, volume_limit: 1024 };
  const [quota, range] = quotaManifests('anna', l) as unknown as [{ spec: { hard: Record<string, string> } }, { spec: { limits: Record<string, Record<string, string>>[] } }];
  assert.deepEqual(quota.spec.hard, { 'requests.cpu': '1000m', 'limits.cpu': '4000m', 'limits.memory': '2048Mi', 'limits.ephemeral-storage': '5120Mi', pods: '8', 'requests.storage': '1024Mi', persistentvolumeclaims: '3' });
  const small = (quotaManifests('anna', { ...l, memory_limit: 256, storage_limit: 256 })[1] as unknown as typeof range).spec.limits[0];
  assert.equal(small._default.memory, '256Mi');
  assert.equal(small.max.memory, '256Mi');
  assert.equal(small.defaultRequest.memory, '128Mi');
  assert.equal(range.spec.limits[0].max.cpu, '4000m');
});

test('Grenzen werden geprüft', () => {
  const ok: Limits = { cpu_limit: 1000, memory_limit: 2048, storage_limit: 5120, max_projects: 3, volume_limit: 1024 };
  validateLimits(ok);
  for (const bad of [{ cpu_limit: 0 }, { memory_limit: NaN }, { storage_limit: 1.5 }, { max_projects: -1 }, { cpu_limit: 99_999 }]) {
    assert.throws(() => validateLimits({ ...ok, ...bad }), JSON.stringify(bad));
  }
});

test('Quota-Fehler wird ein Satz für den User', () => {
  const m = quotaMessage('pods "blog-1-2" is forbidden: exceeded quota: shipli-default, requested: limits.memory=512Mi, used: limits.memory=2Gi, limited: limits.memory=2Gi');
  assert.match(m, /Grenze ist erreicht.*limits\.memory=512Mi/);
});

test('Rollout mit zweitem Pod nur, wenn er in die Quota passt', () => {
  const l: Limits = { cpu_limit: 1000, memory_limit: 512, storage_limit: 5120, max_projects: 3, volume_limit: 1024 };
  const used = (mem: string) => ({ used: { 'requests.cpu': '50m', 'limits.cpu': '500m', 'limits.memory': mem, 'limits.ephemeral-storage': '512Mi', pods: '1' } });
  assert.equal(surgeFits('u', l, undefined), true); // erster Deploy
  assert.equal(surgeFits('u', l, used('512Mi')), false); // 512 MiB belegt, zweiter Pod hätte keinen Platz
  assert.equal(surgeFits('u', { ...l, memory_limit: 2048 }, used('1536Mi')), true);
  assert.equal(surgeFits('u', { ...l, memory_limit: 2048 }, used('1600Mi')), false);
});

test('Absturz wegen RAM wird ein Satz für den User', () => {
  const l: Limits = { cpu_limit: 1000, memory_limit: 512, storage_limit: 5120, max_projects: 3, volume_limit: 1024 };
  assert.match(crashMessage({ reason: 'OOMKilled', exitCode: 137 }, l), /mehr RAM.*512 MiB/);
  assert.match(crashMessage({ reason: 'Error', exitCode: 1 }, l), /Exit-Code 1/);
});

test('Quota zählt Ordner und PVCs', () => {
  const hard = (quotaManifests('anna', { cpu_limit: 1000, memory_limit: 2048, storage_limit: 5120, max_projects: 3, volume_limit: 1536 })[0] as unknown as { spec: { hard: Record<string, string> } }).spec.hard;
  assert.equal(hard['requests.storage'], '1536Mi');
  assert.equal(hard.persistentvolumeclaims, '3');
});

test('Ordner: Grenze pro User, nur vergrössern, nur eigene Projekte', db, async () => {
  const [a, b] = [await newUser('va'), await newUser('vb')];
  const p1 = await createProject(a, 'eins', 'https://github.com/a/b');
  const p2 = await createProject(a, 'zwei', 'https://github.com/a/b');
  await setVolume(a.id, p1, '/app/data', 768);
  await assert.rejects(setVolume(a.id, p2, '/app/data', 512), /frei sind noch 0\.25 GB/); // 1024 Standard
  await setVolume(a.id, p2, '/app/data', 256);
  await assert.rejects(setVolume(a.id, p1, '/app/data', 512), /nicht verkleinern/);
  await assert.rejects(setVolume(b.id, p1, '/app/data', 512), /nicht gefunden/);
  await assert.rejects(removeVolume(b.id, p1, 'eins'), /nicht gefunden/);
  await removeVolume(a.id, p1, 'eins');
  const [ua] = await usage(a.id);
  assert.deepEqual([ua.volume, ua.volume_limit], [256 * 2 ** 20, 1024 * 2 ** 20]);
});

test('Projektgrenze gilt', db, async () => {
  const u = await newUser('p');
  await sql`UPDATE users SET max_projects = 1 WHERE id = ${u.id}`;
  await createProject(u, 'eins', 'https://github.com/a/b');
  await assert.rejects(createProject(u, 'zwei', 'https://github.com/a/b'), /1 von 1 Projekten/);
});

test('User sieht nur die eigenen Messwerte', db, async () => {
  const [a, b] = [await newUser('a'), await newUser('b')];
  const at = new Date();
  await sql`INSERT INTO pod_metrics (at, user_id, project, pod, cpu, memory, disk, rx, tx)
    VALUES (${at}, ${a.id}, 'blog', 'blog-1-2', 250, ${2 ** 30}, 0, 3000, 6000)`;
  await sql`INSERT INTO usage_daily (user_id, day, rx, tx) VALUES (${a.id}, ${at}::date, 3000, 6000)`;
  const [ua] = await usage(a.id);
  assert.deepEqual([ua.cpu, ua.memory, ua.rx_month, ua.tx_month], [250, 2 ** 30, 3000, 6000]);
  const [ub] = await usage(b.id);
  assert.deepEqual([ub.cpu, ub.memory, ub.rx_month], [0, 0, 0]);
  assert.equal((await userSeries(a.id, undefined, 50)).length, 1);
  assert.equal((await userSeries(b.id, undefined, 50)).length, 0);
  assert.equal((await userSeries(a.id, 'blog', 50))[0].cpu, 25); // 250m von 1000m garantiert
});
