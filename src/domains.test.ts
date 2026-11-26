import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { acceptInvite, createInvite, login, userBySession } from './auth.ts';
import { createProject, deleteAccount, deleteProject, getProject } from './projects.ts';
import { addDomains, dnsLight, domainManifests, isCloudflare, listDomains, normalizeDomain, setGoogleVerification, validateDomain, validateGoogleFile, googleFileFromContent, withWww } from './domains.ts';
import { GET as googleGet } from '../app/api/google/[file]/route.ts';
import { sql } from './db.ts';

const blocked = ['betreiber.com', 'zweite-firma.com', 'sslip.io', 'nip.io', 'shipli.betreiber.com'];
const IP = '203.0.113.7';

test('gültige Domains gehen durch', () => {
  for (const ok of ['example.ch', 'www.example.ch', 'a-b.c.example.co.uk', 'xn--mnchen-3ya.de', 'example.xn--p1ai']) validateDomain(ok, blocked);
  assert.equal(normalizeDomain('  WWW.Example.CH. '), 'www.example.ch');
});

test('kaputte Namen, IPs und gesperrte Domains werden abgelehnt', () => {
  for (const bad of [
    'localhost', 'example', '1.2.3.4', '::1', '-a.ch', 'a-.ch', 'a..ch', '*.example.ch', 'https://example.ch', 'example.ch/pfad',
    'a_b.ch', `${'a'.repeat(64)}.ch`, 'betreiber.com', 'x.betreiber.com', 'zweite-firma.com', 'www.zweite-firma.com',
    'blog--nino.203-0-113-7.sslip.io', 'sslip.io', '1-2-3-4.nip.io',
  ]) assert.throws(() => validateDomain(bad, blocked), bad);
  // Endung "...betreiber.com" ist nicht dieselbe Domain
  validateDomain('notbetreiber.com', blocked);
});

test('www-Variante kommt dazu, in beide Richtungen', () => {
  assert.deepEqual(withWww('example.ch'), ['example.ch', 'www.example.ch']);
  assert.deepEqual(withWww('www.example.ch'), ['www.example.ch', 'example.ch']);
});

test('Cloudflare-IPs werden erkannt', () => {
  assert.ok(isCloudflare('104.21.3.4'));
  assert.ok(isCloudflare('172.67.1.1'));
  assert.ok(!isCloudflare(IP));
  assert.ok(!isCloudflare('104.32.0.1'));
});

test('Ampel aus gemockten DNS-Antworten', () => {
  const r = (a: string[], aaaa: string[] = []) => ({ a, aaaa });
  const cases: [Parameters<typeof dnsLight>[0], string, RegExp?][] = [
    [[r([IP]), r([IP])], 'ok'],
    [[r([]), r([])], 'warten', /kein Eintrag/],
    [[r([IP]), r([])], 'warten', /nicht überall/],
    [[r([IP]), null], 'warten'],
    [[null, null], 'warten', /fehlgeschlagen/],
    [[r(['104.21.3.4']), r(['172.67.1.1'])], 'falsch', /Wolke/],
    [[r(['1.2.3.4']), r(['1.2.3.4'])], 'falsch', /1\.2\.3\.4/],
    [[r([IP, '1.2.3.4']), r([IP])], 'falsch', /1\.2\.3\.4/],
    [[r([IP], ['2001:db8::1']), r([IP])], 'falsch', /AAAA/],
  ];
  for (const [answers, state, text] of cases) {
    const light = dnsLight(answers, IP);
    assert.equal(light.state, state, JSON.stringify(answers));
    if (text) assert.match(light.text, text);
  }
});

test('Manifeste: Hauptdomain liefert die App, andere leiten mit 301 weiter, Port 80 mit Priorität 1', () => {
  const kinds = (objs: ReturnType<typeof domainManifests>) => objs.map((o) => `${o.kind}/${o.metadata!.name}`);
  const main = domainManifests('nino', 'blog', { id: 7, name: 'example.ch' });
  assert.deepEqual(kinds(main), ['Middleware/nach-https', 'Certificate/blog-d7', 'IngressRoute/blog-d7', 'IngressRoute/blog-d7-http']);
  for (const o of main) assert.equal(o.metadata!.namespace, 'shipli-u-nino');
  const json = JSON.stringify(main);
  assert.ok(!json.includes('redirectRegex'));
  const http = main[3] as unknown as { spec: { routes: { priority: number; middlewares: { name: string }[] }[] } };
  assert.equal(http.spec.routes[0].priority, 1);
  assert.equal(http.spec.routes[0].middlewares[0].name, 'nach-https');

  const www = domainManifests('nino', 'blog', { id: 8, name: 'www.example.ch' }, 'example.ch');
  const mw = www.find((o) => o.metadata!.name === 'blog-d8-weiter') as unknown as { spec: { redirectRegex: { regex: string; replacement: string; permanent: boolean } } };
  assert.equal(mw.spec.redirectRegex.replacement, 'https://example.ch${1}');
  assert.equal(mw.spec.redirectRegex.permanent, true);
  // Pfad und Query bleiben erhalten
  const m = 'https://www.example.ch/a/b?x=1'.match(new RegExp(mw.spec.redirectRegex.regex))!;
  assert.equal(mw.spec.redirectRegex.replacement.replace('${1}', m[1]), 'https://example.ch/a/b?x=1');
  const routes = www.filter((o) => o.kind === 'IngressRoute') as unknown as { spec: { routes: { middlewares?: { name: string }[] }[] } }[];
  for (const r of routes) assert.equal(r.spec.routes[0].middlewares?.[0].name, 'blog-d8-weiter');
});

test('Google-Datei: nur der Dateiname, nur a-z und 0-9', () => {
  for (const ok of ['google1a2b3c4d5e6f7a8b.html', 'googleabc123.html']) validateGoogleFile(ok);
  for (const bad of ['google.html', 'Google1a2b.html', 'google1a2b.htm', 'x/google1a2b.html', 'https://example.ch/google1a2b.html',
    'google1a2b.html\n', 'google-site-verification: google1a2b.html', 'google1a2b.html`) || Host(`evil.ch', `google${'a'.repeat(65)}.html`]) {
    assert.throws(() => validateGoogleFile(bad), /kein Dateiname/, bad);
  }
});

test('Google-Datei: Name kommt aus dem Inhalt, nicht aus dem Dateinamen', () => {
  assert.equal(googleFileFromContent('google-site-verification: google4125137244ee87e3.html\n'), 'google4125137244ee87e3.html');
  for (const bad of ['', '<html>hallo</html>', 'google-site-verification: index.html', 'google-site-verification: google1a.html\nmehr',
    'google-site-verification: google1a.html`) || Host(`evil.ch']) {
    assert.throws(() => googleFileFromContent(bad), /Search Console/, bad);
  }
});

test('Manifeste mit Google-Datei: Route vor der App auf 443 und 80, Service ohne Selector auf die ClusterIP', () => {
  const google = { file: 'google1a2b3c4d5e6f7a8b.html', ip: '10.43.76.237' };
  const objs = domainManifests('nino', 'blog', { id: 8, name: 'www.example.ch' }, 'example.ch', google);
  const byKind = (k: string) => objs.filter((o) => o.kind === k) as unknown as Record<string, any>[];
  const [svc] = byKind('Service');
  assert.equal(svc.metadata.name, 'shipli--google');
  assert.equal(svc.spec.selector, undefined);
  const [slice] = byKind('EndpointSlice');
  assert.equal(slice.metadata.labels['kubernetes.io/service-name'], 'shipli--google');
  assert.deepEqual(slice.endpoints, [{ addresses: ['10.43.76.237'], conditions: { ready: true } }]);
  assert.deepEqual(slice.ports, svc.spec.ports);
  assert.ok(byKind('Middleware').some((m) => m.metadata.name === 'shipli--google' && m.spec.addPrefix.prefix === '/api/google'));
  for (const o of [...objs, svc]) assert.equal(o.metadata!.namespace, 'shipli-u-nino');
  const routes = byKind('IngressRoute');
  assert.deepEqual(routes.map((r) => r.spec.entryPoints[0]), ['websecure', 'web']);
  for (const r of routes) {
    const [first, app] = r.spec.routes;
    assert.equal(first.match, 'Host(`www.example.ch`) && Path(`/google1a2b3c4d5e6f7a8b.html`)');
    assert.deepEqual(first.middlewares, [{ name: 'shipli--google' }]);
    // Nebendomain: die Google-Route leitet nicht weiter, die App-Route schon
    assert.equal(app.middlewares[0].name, 'blog-d8-weiter');
    assert.ok(first.priority === undefined && first.match.length > app.match.length, 'längere Regel gewinnt');
  }
  const without = JSON.stringify(domainManifests('nino', 'blog', { id: 8, name: 'www.example.ch' }, 'example.ch'));
  assert.ok(!without.includes('google'));
});

const db = { skip: !process.env.DATABASE_URL && 'DATABASE_URL fehlt' };
const suffix = randomBytes(3).toString('hex');
after(async () => {
  await sql`DELETE FROM users WHERE name LIKE ${'d' + suffix + '%'}`;
  await sql`DELETE FROM invites WHERE name LIKE ${'d' + suffix + '%'}`;
  await sql.end();
});

async function newUser(tag: string) {
  const name = `d${suffix}-${tag}`;
  return (await userBySession(await acceptInvite(await createInvite(`${name}@example.com`, name), 'langes-passwort')))!;
}

test('Domain gilt plattformweit nur einmal, auch in anderer Schreibweise', db, async () => {
  const a = await newUser('a');
  const b = await newUser('b');
  const pa = await createProject(a, 'web', 'https://github.com/lueli11/webseite');
  const pb = await createProject(b, 'web', 'https://github.com/lueli11/webseite');
  const domain = `${suffix}.example.ch`;
  await addDomains(a.id, pa, withWww(domain));
  await assert.rejects(addDomains(b.id, pb, [domain.toUpperCase()]), /schon verwendet/);
  await assert.rejects(addDomains(a.id, pa, [domain]), /schon verwendet/);
  // B darf nicht in As Projekt eintragen
  await assert.rejects(addDomains(b.id, pa, [`x${domain}`]), /nicht gefunden/);
  const list = await listDomains(a.id, pa);
  assert.deepEqual(list.map((d) => [d.name, d.is_primary]), [[domain, true], [`www.${domain}`, false]]);
  assert.equal((await listDomains(b.id, pa)).length, 0);
  await assert.rejects(addDomains(a.id, pa, ['a', 'b', 'c', 'd'].map((x) => `${x}${domain}`)), /Höchstens 5/);
});

test('Google-Endpunkt: nur eigener Host, eigene Datei und Domain mit Zertifikat', db, async () => {
  const a = await newUser('g-a');
  const b = await newUser('g-b');
  const pa = await createProject(a, 'web', 'https://github.com/lueli11/webseite');
  const pb = await createProject(b, 'web', 'https://github.com/lueli11/webseite');
  const [mine, other, waiting] = [`g${suffix}.example.ch`, `g${suffix}.example.org`, `w${suffix}.example.ch`];
  await addDomains(a.id, pa, [mine, waiting]);
  await addDomains(b.id, pb, [other]);
  await sql`UPDATE domains SET status = 'cert' WHERE name IN ${sql([mine, other])}`;
  const [fileA, fileB] = ['google1a2b3c4d5e6f7a8b.html', 'googleffff0000ffff0000.html'];
  await sql`UPDATE projects SET google_verification = ${fileA} WHERE id = ${pa}`;
  await sql`UPDATE projects SET google_verification = ${fileB} WHERE id = ${pb}`;
  const get = (host: string, file: string) =>
    googleGet(new Request(`http://${host}/api/google/${file}`, { headers: { host } }), { params: Promise.resolve({ file }) });

  const ok = await get(`${mine.toUpperCase()}:443`, fileA);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), `google-site-verification: ${fileA}`);
  assert.match(ok.headers.get('content-type')!, /^text\/html/);
  assert.equal((await get(other, fileA)).status, 404, 'fremder Host');
  assert.equal((await get(mine, fileB)).status, 404, 'fremde Datei');
  assert.equal((await get(waiting, fileA)).status, 404, 'Domain ohne Zertifikat');
  assert.equal((await get('shipli.betreiber.com', fileA)).status, 404, 'Host ohne Domain');
  // B darf As Datei nicht setzen, ungültige Namen kommen gar nicht bis zur DB
  await assert.rejects(setGoogleVerification(b, pa, fileB), /nicht gefunden/);
  await assert.rejects(setGoogleVerification(a, pa, 'index.html'), /kein Dateiname/);
});

test('Projekt löschen: nur der Besitzer und nur mit richtigem Namen', db, async () => {
  const a = await newUser('del-a');
  const b = await newUser('del-b');
  const id = await createProject(a, 'Weg Damit', 'https://github.com/lueli11/webseite');
  await assert.rejects(deleteProject(b, id, 'weg-damit'), /nicht gefunden/);
  await assert.rejects(deleteProject(a, id, 'falsch'), /eintippen/);
  assert.ok(await getProject(a.id, id));
});

test('Konto löschen: nur mit eigenem Namen und richtigem Passwort', db, async () => {
  const a = await newUser('acc');
  await assert.rejects(deleteAccount(a, 'langes-passwort', 'jemand-anders'), /eintippen/);
  await assert.rejects(deleteAccount(a, 'falsches-passwort', a.name), /falsch/);
  assert.ok(await userBySession(await login(a.email, 'langes-passwort') ?? ''));
});
