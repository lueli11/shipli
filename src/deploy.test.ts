import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toName, validate, validateBuild, validateEnvKey, validateVolumePath, hostOf, appManifests, buildJob, digestOf } from './deploy.ts';

const ok = { user: 'nino', project: 'blog', repo: 'https://github.com/lueli11/webseite', limits: { cpu_limit: 1000, memory_limit: 2048, storage_limit: 5120, max_projects: 3, volume_limit: 1024 } };

test('gültige Eingabe geht durch', () => validate(ok));

test('ungültige Namen und Repos werden abgelehnt', () => {
  for (const bad of [
    { ...ok, user: 'Nino' },
    { ...ok, user: 'a--b' },
    { ...ok, project: '-blog' },
    { ...ok, project: 'x'.repeat(21) },
    { ...ok, repo: 'https://gitlab.com/a/b' },
    { ...ok, repo: 'https://github.com/a/b;rm -rf /' },
    { ...ok, repo: 'file:///etc' },
  ]) assert.throws(() => validate(bad), JSON.stringify(bad));
});

test('Projektnamen werden zu gültigen Namen', () => {
  assert.equal(toName('Jass app'), 'jass-app');
  assert.equal(toName('  Mein  Blog!! 2 '), 'mein-blog-2');
  assert.equal(toName('a--b'), 'a-b');
  validate({ ...ok, project: toName('Jass app') });
});

test('Hosts zweier User kollidieren nicht', () => {
  // ohne Verbot von "--" wären "a-b"/"c" und "a"/"b-c" derselbe Host
  assert.notEqual(hostOf('c', 'a-b'), hostOf('b-c', 'a'));
});

test('Manifeste landen im Namespace des Users', () => {
  const objs = appManifests(ok, 'f'.repeat(40));
  assert.deepEqual(objs.map((o) => o.kind), ['Namespace', 'NetworkPolicy', 'ResourceQuota', 'LimitRange', 'Secret', 'Deployment', 'Service', 'IngressRoute']);
  for (const o of objs.slice(1)) assert.equal(o.metadata?.namespace, 'shipli-u-nino');
});

test('Variablen-Namen: gültige gehen, reservierte und kaputte nicht', () => {
  validateEnvKey('DATABASE_URL');
  validateEnvKey('next_public_x');
  for (const bad of ['1A', 'A-B', 'A B', '', 'PORT', 'SHIPLI_GIT_TOKEN']) assert.throws(() => validateEnvKey(bad), bad);
});

test('NetworkPolicy sperrt private Netze', () => {
  const np = appManifests(ok, 'f'.repeat(40))[1] as unknown as { spec: { egress: { to: { ipBlock?: { except: string[] } }[] }[] } };
  const except = np.spec.egress[0].to[0].ipBlock!.except;
  for (const net of ['10.0.0.0/8', '192.168.0.0/16']) assert.ok(except.includes(net));
});

test('Git-Token nur im prepare-Container, Variablen als Build-Secrets', () => {
  const job = buildJob({ ...ok, env: { B: '2', A: '1' }, gitToken: 'x' }, 'f'.repeat(40), { env: 'e', git: 'g' });
  const pod = job.spec.template.spec;
  assert.ok(JSON.stringify(pod.initContainers[0].env).includes('SHIPLI_GIT_TOKEN'));
  assert.ok(!JSON.stringify(pod.containers[0]).includes('SHIPLI_GIT_TOKEN'));
  const args = pod.containers[0].args.join(' ');
  assert.ok(args.includes('id=A,env=A') && args.includes('id=B,env=B') && args.includes('secrets-hash='));
});

test('Namespace mit PSA restricted, App im eigenen User-Namespace und per Digest', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const objs = appManifests(ok, 'f'.repeat(40), digest) as unknown as { kind: string; metadata: { labels: Record<string, string> }; spec: any }[];
  assert.equal(objs[0].metadata.labels['pod-security.kubernetes.io/enforce'], 'restricted');
  const pod = objs.find((o) => o.kind === 'Deployment')!.spec.template.spec;
  assert.equal(pod.hostUsers, false);
  assert.deepEqual(pod.containers[0].securityContext.capabilities.drop, ['ALL']);
  assert.ok(pod.containers[0].image.endsWith(`:${'f'.repeat(40)}@${digest}`));
});

test('Digest aus den Build-Metadaten, sonst nichts', () => {
  const d = `sha256:${'b'.repeat(64)}`;
  assert.equal(digestOf(JSON.stringify({ 'containerimage.digest': d, 'image.name': 'x' })), d);
  for (const bad of [undefined, '', 'kaputt', '{}', '{"containerimage.digest":"sha256:xyz"}']) assert.equal(digestOf(bad), undefined, bad);
});

test('Build hat Limits und den zot-Zugang nur im build-Container', () => {
  const pod = buildJob(ok, 'f'.repeat(40), { env: 'e' }).spec.template.spec;
  assert.ok(pod.containers[0].resources.limits.memory && pod.initContainers[0].resources.limits.memory);
  assert.ok(pod.volumes.every((v: { emptyDir?: { sizeLimit?: string } }) => !v.emptyDir || v.emptyDir.sizeLimit));
  assert.ok(pod.containers[0].volumeMounts.some((m: { name: string }) => m.name === 'zot'));
  assert.ok(!JSON.stringify(pod.initContainers[0]).includes('zot'));
  // eigenes zot-Konto pro User, sonst überschreibt ein Build Images und Cache anderer
  assert.equal(pod.volumes.find((v: { name: string }) => v.name === 'zot')?.secret?.secretName, 'zot-push-nino');
});

test('Ordner: PVC, Mount und Recreate, ohne Ordner nichts davon', () => {
  const kinds = (o: unknown[]) => (o as { kind: string }[]).map((x) => x.kind);
  const deployment = (o: unknown[]) => (o as { kind: string; spec: any }[]).find((x) => x.kind === 'Deployment')!.spec;
  const plain = appManifests(ok, 'f'.repeat(40));
  assert.ok(!kinds(plain).includes('PersistentVolumeClaim'));
  assert.equal(deployment(plain).strategy.type, 'RollingUpdate');
  assert.equal(deployment(plain).template.spec.volumes, undefined);

  const objs = appManifests({ ...ok, volume: { path: '/app/data', mib: 1024 } }, 'f'.repeat(40));
  const pvc = (objs as unknown as { kind: string; metadata: { name: string; namespace: string }; spec: any }[]).find((o) => o.kind === 'PersistentVolumeClaim')!;
  assert.deepEqual([pvc.metadata.name, pvc.metadata.namespace, pvc.spec.resources.requests.storage, pvc.spec.accessModes[0]], ['blog-data', 'shipli-u-nino', '1024Mi', 'ReadWriteOnce']);
  const d = deployment(objs);
  assert.deepEqual(d.strategy, { type: 'Recreate' });
  assert.equal(d.template.spec.volumes[0].persistentVolumeClaim.claimName, 'blog-data');
  assert.equal(d.template.spec.containers[0].volumeMounts[0].mountPath, '/app/data');
  // auch ohne Ordner: nach 30 s auf einen anderen Node, wenn der eigene ausfällt
  for (const t of [d.template.spec.tolerations, deployment(plain).template.spec.tolerations]) assert.deepEqual(t.map((x: any) => x.tolerationSeconds), [30, 30]);
});

test('Ordner-Pfad: nur eigene Ordner, nichts vom System oder der Code', () => {
  for (const good of ['/app/data', '/data', '/app/storage/db', '/var/lib/app', '/home/node/.cache']) validateVolumePath(good);
  for (const bad of ['/', 'app/data', '/app', '/app/', '/etc', '/etc/x', '/proc/1', '/usr/local', '/run', '/app/../etc', '/app/./data', '/a b', '/a;rm', '//x', `/${'a'.repeat(200)}`]) {
    assert.throws(() => validateVolumePath(bad), bad);
  }
});

test('Dockerfile-Build: Pfad, Kontext, Stage und Variablen als Build-Argumente', () => {
  const build = { type: 'dockerfile' as const, file: 'docker/web.Dockerfile', context: 'apps/web', target: 'runner' };
  const pod = buildJob({ ...ok, env: { A: '1' }, build }, 'f'.repeat(40), { env: 'e' }).spec.template.spec;
  const args = pod.containers[0].args.join(' ');
  for (const part of ['--frontend=dockerfile.v0', 'context=/work/src/apps/web', 'dockerfile=/work/src/docker', 'filename=web.Dockerfile', 'target=runner', 'id=A,env=A']) assert.ok(args.includes(part), part);
  assert.ok(!args.includes('railpack') && !args.includes('secrets-hash'));
  // Werte nie im Job-Spec, nur die Namen
  assert.ok(!JSON.stringify(pod).includes('build-arg:A='));
  assert.equal(pod.containers[0].env.find((e: { name: string }) => e.name === 'SHIPLI_BUILD_ARGS')!.value, 'A');
  assert.equal(pod.initContainers[0].env.find((e: { name: string }) => e.name === 'SHIPLI_DOCKERFILE')!.value, 'docker/web.Dockerfile');
  const railpack = buildJob(ok, 'f'.repeat(40), { env: 'e' }).spec.template.spec;
  assert.equal(railpack.containers[0].env.find((e: { name: string }) => e.name === 'SHIPLI_BUILD_ARGS')!.value, '');
});

test('Dockerfile-Pfade bleiben im Repo', () => {
  validateBuild({ type: 'dockerfile', file: 'Dockerfile', context: '.' });
  for (const bad of [{ file: '../x', context: '.' }, { file: '/etc/passwd', context: '.' }, { file: 'Dockerfile', context: 'a/../..' }, { file: 'Dockerfile', context: '.', target: '-x' }]) {
    assert.throws(() => validateBuild({ type: 'dockerfile', ...bad }), JSON.stringify(bad));
  }
});
