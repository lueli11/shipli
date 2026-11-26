import { CoreV1Api, KubeConfig, KubernetesObjectApi, type KubernetesObject } from '@kubernetes/client-node';
import { sql } from './db.ts';
import { apply, labels, namespaceManifests, namespaceOf } from './deploy.ts';
import { getLimits } from './limits.ts';
import type { User } from './auth.ts';

const MAX_PER_PROJECT = 5;
const publicIp = () => process.env.SHIPLI_PUBLIC_IP ?? '';
const issuer = () => process.env.SHIPLI_CERT_ISSUER ?? 'letsencrypt-staging';

// Eigene Domains des Betreibers (SHIPLI_BLOCKED_DOMAINS, mit Komma): ein User könnte sonst per HTTP-01 ein Zertifikat
// für eine Subdomain davon holen und Cookies der Hauptdomain lesen
export function blockedDomains(): string[] {
  const app = process.env.SHIPLI_APP_URL ? new URL(process.env.SHIPLI_APP_URL).hostname : '';
  const own = (process.env.SHIPLI_BLOCKED_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase());
  return [...own, 'sslip.io', 'nip.io', app, process.env.SHIPLI_DOMAIN ?? ''].filter(Boolean);
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
// eine rein numerische Endung ist eine IP, keine Domain
const TLD = /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export const normalizeDomain = (raw: string) => raw.trim().toLowerCase().replace(/\.$/, '');

export function validateDomain(name: string, blocked = blockedDomains()): void {
  const labels = name.split('.');
  if (name.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !TLD.test(labels.at(-1)!)) {
    throw new Error(`"${name}" ist keine gültige Domain (z. B. meinefirma.ch, ohne https:// und ohne Pfad)`);
  }
  const hit = blocked.find((b) => name === b || name.endsWith(`.${b}`));
  if (hit) {
    throw new Error(`Domains unter ${hit} gehen nicht: sie gehören zur Infrastruktur hinter Shipli. Nimm eine eigene Domain wie meinefirma.ch, bis dahin läuft die App unter ihrer Shipli-Adresse.`);
  }
}

// shortcut: Google nennt das Format nicht (gesehen: 16 Hex-Zeichen), darum breiter; reicht, solange nur a-z und 0-9 vorkommen
export const GOOGLE_FILE = /^google[a-z0-9]{1,64}\.html$/;

export function validateGoogleFile(file: string): void {
  if (!GOOGLE_FILE.test(file)) throw new Error(`"${file}" ist kein Dateiname aus der Search Console. Nur den Namen einfügen, z. B. google1a2b3c4d5e6f7a8b.html`);
}

/** Der Inhalt nennt den Namen; der Dateiname kann vom Browser umbenannt sein („google… (1).html“). */
export function googleFileFromContent(content: string): string {
  const m = content.trim().match(/^google-site-verification: (\S+)$/);
  if (!m) throw new Error('Das ist nicht die Datei aus der Search Console. Sie heisst google….html und enthält nur eine Zeile „google-site-verification: …“.');
  validateGoogleFile(m[1]);
  return m[1];
}

/** Mit Häkchen „mit und ohne www“: die andere Variante dazu. */
export function withWww(name: string): string[] {
  return name.startsWith('www.') ? [name, name.slice(4)] : [name, `www.${name}`];
}

// --- DNS-Ampel -------------------------------------------------------------

// shortcut: Liste fest von https://www.cloudflare.com/ips-v4 (25.11.2026); ändert Cloudflare sie, neu abschreiben
const CLOUDFLARE = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14',
  '172.64.0.0/13', '131.0.72.0/22'];
const ipNum = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
export const isCloudflare = (ip: string) => CLOUDFLARE.some((cidr) => {
  const [net, bits] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  return Math.floor(ipNum(ip) / size) === Math.floor(ipNum(net) / size);
});

export type Answer = { a: string[]; aaaa: string[] } | null; // null: Resolver nicht erreichbar
export type Light = { state: 'ok' | 'warten' | 'falsch'; text: string };

/** Ampel aus den Antworten mehrerer Resolver (1.1.1.1 und 8.8.8.8). */
export function dnsLight(answers: Answer[], ip: string): Light {
  const all = answers.filter((a): a is NonNullable<Answer> => a !== null);
  const a = [...new Set(all.flatMap((r) => r.a))];
  if (a.some(isCloudflare)) return { state: 'falsch', text: 'Cloudflare-Proxy ist an: Wolke auf grau stellen (nur DNS)' };
  const wrong = a.filter((x) => x !== ip);
  if (wrong.length) return { state: 'falsch', text: `zeigt auf ${wrong.join(', ')} statt ${ip}` };
  // Let's Encrypt prüft bevorzugt über IPv6, Shipli ist dort nicht erreichbar
  if (all.some((r) => r.aaaa.length)) return { state: 'falsch', text: 'AAAA-Eintrag (IPv6) löschen' };
  if (all.length === answers.length && all.every((r) => r.a.includes(ip))) return { state: 'ok', text: 'stimmt' };
  if (a.length) return { state: 'warten', text: 'noch nicht überall sichtbar' };
  return { state: 'warten', text: answers.length && !all.length ? 'DNS-Abfrage fehlgeschlagen' : 'noch kein Eintrag' };
}

const RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

async function doh(resolver: string, name: string, type: 'A' | 'AAAA'): Promise<string[]> {
  const res = await fetch(`${resolver}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { Accept: 'application/dns-json' },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`DoH ${res.status}`);
  const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
  // Answer enthält auch die CNAME-Kette, nur die Adressen zählen
  return (body.Answer ?? []).filter((r) => r.type === (type === 'A' ? 1 : 28)).map((r) => r.data);
}

async function lookup(resolver: string, name: string): Promise<Answer> {
  try {
    const [a, aaaa] = await Promise.all([doh(resolver, name, 'A'), doh(resolver, name, 'AAAA')]);
    return { a, aaaa };
  } catch {
    return null;
  }
}

export const checkDns = async (name: string) => dnsLight(await Promise.all(RESOLVERS.map((r) => lookup(r, name))), publicIp());

// --- Kubernetes ------------------------------------------------------------

export type Domain = { id: number; name: string; is_primary: boolean; status: 'dns' | 'cert' };

const objName = (project: string, d: Pick<Domain, 'id'>) => `${project}-d${d.id}`;
// doppelter Bindestrich: kein Projekt kann so heissen (validateName), also kein Zusammenstoss mit dessen Service
const GOOGLE = 'shipli--google';
export type Google = { file: string; ip: string };

/** Service ohne Selector auf die ClusterIP von Shipli: Traefik darf keine Services in shipli-system nennen (allowCrossNamespace aus). */
function googleManifests(user: string, ip: string): KubernetesObject[] {
  const meta = { name: GOOGLE, namespace: namespaceOf(user), labels: labels(user) };
  const ports = [{ name: 'http', port: 80, protocol: 'TCP' }];
  return [
    { apiVersion: 'v1', kind: 'Service', metadata: meta, spec: { ports } },
    {
      apiVersion: 'discovery.k8s.io/v1',
      kind: 'EndpointSlice',
      metadata: { ...meta, labels: { ...meta.labels, 'kubernetes.io/service-name': GOOGLE } },
      addressType: 'IPv4',
      // ohne ready: true lässt Traefik den Endpunkt still weg
      endpoints: [{ addresses: [ip], conditions: { ready: true } }],
      ports,
    },
    { apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', metadata: meta, spec: { addPrefix: { prefix: '/api/google' } } },
  ] as unknown as KubernetesObject[];
}

/** Zertifikat und Routen einer Domain; redirectTo gesetzt heisst: 301 auf die Hauptdomain statt App. */
export function domainManifests(user: string, project: string, d: Pick<Domain, 'id' | 'name'>, redirectTo?: string, google?: Google): KubernetesObject[] {
  const namespace = namespaceOf(user);
  const name = objName(project, d);
  const meta = { namespace, labels: { ...labels(user, project), 'shipli/domain': String(d.id) } };
  const host = `Host(\`${d.name}\`)`;
  const service = [{ name: project, port: 80 }];
  const middleware = redirectTo ? `${name}-weiter` : 'nach-https';
  // ohne priority gewinnt die längere Regel, also vor der App und der Weiterleitung, auch auf Nebendomains
  const googleRoute = google ? [{ match: `${host} && Path(\`/${google.file}\`)`, kind: 'Rule', services: [{ name: GOOGLE, port: 80 }], middlewares: [{ name: GOOGLE }] }] : [];
  return [
    ...(google ? googleManifests(user, google.ip) : []),
    { apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', metadata: { name: 'nach-https', namespace, labels: labels(user) }, spec: { redirectScheme: { scheme: 'https', permanent: true } } },
    ...(redirectTo ? [{
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'Middleware',
      metadata: { ...meta, name: `${name}-weiter` },
      spec: { redirectRegex: { regex: '^https?://[^/]+(.*)$', replacement: `https://${redirectTo}\${1}`, permanent: true } },
    }] : []),
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: { ...meta, name },
      spec: { secretName: `${name}-tls`, dnsNames: [d.name], issuerRef: { kind: 'ClusterIssuer', name: issuer() } },
    },
    {
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'IngressRoute',
      metadata: { ...meta, name },
      spec: {
        entryPoints: ['websecure'],
        routes: [...googleRoute, { match: host, kind: 'Rule', services: service, ...(redirectTo && { middlewares: [{ name: middleware }] }) }],
        tls: { secretName: `${name}-tls` },
      },
    },
    {
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'IngressRoute',
      metadata: { ...meta, name: `${name}-http` },
      spec: {
        entryPoints: ['web'],
        // Priorität 1: der Router des cert-manager-Solvers (/.well-known/acme-challenge/…) muss gewinnen
        routes: [...googleRoute, { match: host, kind: 'Rule', priority: 1, services: service, middlewares: [{ name: middleware }] }],
      },
    },
  ] as unknown as KubernetesObject[];
}

function kube() {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return { objects: KubernetesObjectApi.makeApiClient(kc), core: kc.makeApiClient(CoreV1Api) };
}

const notFound = (err: unknown) => (err as { code?: number }).code === 404;
const ignore404 = (err: unknown) => { if (!notFound(err)) throw err; };

type ProjectRow = { id: number; name: string; google_verification: string | null };

async function syncDomains(user: string, { name: project, google_verification: file }: ProjectRow, domains: Domain[]) {
  const { objects } = kube();
  const active = domains.filter((x) => x.status === 'cert');
  if (!active.length) return;
  // setzt Kubernetes selbst für den Service shipli im eigenen Namespace; die IP ist in deploy/shipli.yaml fest
  const ip = process.env.SHIPLI_SERVICE_HOST;
  if (file && !ip) throw new Error('Google-Bestätigung geht nur, wenn Shipli im Cluster läuft (SHIPLI_SERVICE_HOST fehlt)');
  const google = file ? { file, ip: ip! } : undefined;
  // Domain kann vor dem ersten Deploy kommen, dann gibt es den Namespace noch nicht
  for (const obj of namespaceManifests(user, await getLimits(user))) await apply(objects, obj);
  const primary = active.find((d) => d.is_primary);
  for (const d of active) {
    const redirectTo = primary && primary.id !== d.id ? primary.name : undefined;
    for (const obj of domainManifests(user, project, d, redirectTo, google)) await apply(objects, obj);
    // war die Domain vorher Nebendomain, bliebe ihre Weiterleitung sonst als Leiche liegen
    if (!redirectTo) {
      await objects.delete({ apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', metadata: { name: `${objName(project, d)}-weiter`, namespace: namespaceOf(user) } }).catch(ignore404);
    }
  }
}

export async function deleteDomainObjects(user: string, project: string, d: Domain) {
  const { objects, core } = kube();
  const namespace = namespaceOf(user);
  const name = objName(project, d);
  for (const [apiVersion, kind, n] of [
    ['cert-manager.io/v1', 'Certificate', name],
    ['traefik.io/v1alpha1', 'IngressRoute', name],
    ['traefik.io/v1alpha1', 'IngressRoute', `${name}-http`],
    ['traefik.io/v1alpha1', 'Middleware', `${name}-weiter`],
  ]) await objects.delete({ apiVersion, kind, metadata: { name: n, namespace } }).catch(ignore404);
  // cert-manager lässt das Secret beim Löschen des Zertifikats stehen
  await core.deleteNamespacedSecret({ name: `${name}-tls`, namespace }).catch(ignore404);
}

type CertCondition = { type: string; status: string; message?: string };
const MISSING: Light = { state: 'warten', text: 'wird angelegt' };

async function certLight(user: string, project: string, d: Domain): Promise<Light> {
  if (d.status === 'dns') return { state: 'warten', text: 'wartet auf DNS' };
  try {
    const cert = await kube().objects.read({ apiVersion: 'cert-manager.io/v1', kind: 'Certificate', metadata: { name: objName(project, d), namespace: namespaceOf(user) } });
    const ready = ((cert as { status?: { conditions?: CertCondition[] } }).status?.conditions ?? []).find((c) => c.type === 'Ready');
    if (ready?.status === 'True') return { state: 'ok', text: 'HTTPS aktiv' };
    if (ready?.message && !/issuing|in progress|does not exist/i.test(ready.message)) return { state: 'falsch', text: ready.message };
    return { state: 'warten', text: 'wird ausgestellt' };
  } catch (err) {
    if (notFound(err)) return MISSING;
    throw err;
  }
}

// --- Datenbank (jede Abfrage nach user_id gefiltert) -----------------------

async function projectOf(userId: number, projectId: number) {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return undefined;
  const [p] = await sql<ProjectRow[]>`SELECT id, name, google_verification FROM projects WHERE id = ${projectId} AND user_id = ${userId}`;
  return p;
}

export async function listDomains(userId: number, projectId: number): Promise<Domain[]> {
  return sql<Domain[]>`
    SELECT d.id, d.name, d.is_primary, d.status FROM domains d JOIN projects p ON p.id = d.project_id
    WHERE d.project_id = ${projectId} AND p.user_id = ${userId} ORDER BY d.is_primary DESC, d.id`;
}

export async function addDomains(userId: number, projectId: number, names: string[]): Promise<void> {
  names = [...new Set(names.map(normalizeDomain))];
  names.forEach((n) => validateDomain(n));
  if (!(await projectOf(userId, projectId))) throw new Error('Projekt nicht gefunden');
  try {
    await sql.begin(async (tx) => {
      // FOR UPDATE: zwei gleichzeitige Formulare sollen die Grenze nicht gemeinsam überschreiten
      await tx`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
      const [{ count, has_primary }] = await tx<{ count: number; has_primary: boolean }[]>`
        SELECT count(*)::int AS count, coalesce(bool_or(is_primary), false) AS has_primary FROM domains WHERE project_id = ${projectId}`;
      if (count + names.length > MAX_PER_PROJECT) throw new Error(`Höchstens ${MAX_PER_PROJECT} Domains pro Projekt`);
      for (const [i, name] of names.entries()) {
        await tx`INSERT INTO domains (project_id, name, is_primary) VALUES (${projectId}, ${name}, ${!has_primary && i === 0})`;
      }
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new Error(`Eine dieser Domains wird auf Shipli schon verwendet: ${names.join(', ')}`);
    throw err;
  }
}

export async function setPrimaryDomain(user: User, projectId: number, domainId: number): Promise<void> {
  const project = await projectOf(user.id, projectId);
  if (!project) throw new Error('Projekt nicht gefunden');
  await sql`UPDATE domains SET is_primary = (id = ${domainId}) WHERE project_id = ${projectId}
    AND EXISTS (SELECT 1 FROM domains WHERE id = ${domainId} AND project_id = ${projectId})`;
  await syncDomains(user.name, project, await listDomains(user.id, projectId));
}

export async function removeDomain(user: User, projectId: number, domainId: number): Promise<void> {
  const project = await projectOf(user.id, projectId);
  const domain = project && (await listDomains(user.id, projectId)).find((d) => d.id === domainId);
  if (!project || !domain) throw new Error('Domain nicht gefunden');
  // zuerst im Cluster: schlägt das fehl, bleibt die Zeile, und Löschen lässt sich wiederholen
  await deleteDomainObjects(user.name, project.name, domain);
  await sql`DELETE FROM domains WHERE id = ${domainId} AND project_id = ${projectId}`;
  if (domain.is_primary) {
    await sql`UPDATE domains SET is_primary = true WHERE id = (SELECT min(id) FROM domains WHERE project_id = ${projectId})`;
  }
  await syncDomains(user.name, project, await listDomains(user.id, projectId));
}

/** Leerer Name entfernt die Datei; die Route verschwindet beim Sync, Service und EndpointSlice bleiben wie nach-https liegen. */
export async function setGoogleVerification(user: User, projectId: number, raw: string): Promise<void> {
  const file = raw.trim() || null;
  if (file) validateGoogleFile(file);
  const project = await projectOf(user.id, projectId);
  if (!project) throw new Error('Projekt nicht gefunden');
  // zuerst im Cluster: schlägt das fehl, bleibt der alte Stand in DB und Routen
  await syncDomains(user.name, { ...project, google_verification: file }, await listDomains(user.id, projectId));
  await sql`UPDATE projects SET google_verification = ${file} WHERE id = ${projectId} AND user_id = ${user.id}`;
}

/** Für den Endpunkt hinter der Google-Route: nur die Datei des Projekts, dem dieser Host gehört, und nur mit Zertifikat. */
export async function hasGoogleFile(host: string, file: string): Promise<boolean> {
  const [hit] = await sql`SELECT 1 FROM domains d JOIN projects p ON p.id = d.project_id
    WHERE lower(d.name) = ${host.toLowerCase()} AND d.status = 'cert' AND p.google_verification = ${file}`;
  return !!hit;
}

export type DomainState = Domain & { dns: Light; cert: Light; record: { type: 'A' | 'CNAME'; value: string } };

/** Für den Assistenten: DNS prüfen, bei grünem DNS Zertifikat und Routen anlegen, Stand zurückgeben. */
export async function checkDomains(user: User, projectId: number): Promise<DomainState[] | undefined> {
  const project = await projectOf(user.id, projectId);
  if (!project) return undefined;
  let domains = await listDomains(user.id, projectId);
  const dns = new Map(await Promise.all(domains.map(async (d) => [d.id, await checkDns(d.name)] as const)));
  const ready = domains.filter((d) => d.status === 'dns' && dns.get(d.id)!.state === 'ok');
  if (ready.length) {
    // erst nach grünem DNS: jeder Fehlversuch zählt bei Let's Encrypt (5 pro Stunde und Host)
    domains = domains.map((d) => (ready.includes(d) ? { ...d, status: 'cert' as const } : d));
    // zuerst im Cluster: schlägt das fehl, bleibt der Status "dns" und der nächste Check versucht es neu
    await syncDomains(user.name, project, domains);
    await sql`UPDATE domains SET status = 'cert' WHERE id IN ${sql(ready.map((d) => d.id))} AND project_id = ${projectId}`;
  }
  const certs = () => Promise.all(domains.map((d) => certLight(user.name, project.name, d)));
  let cert = await certs();
  // Status "cert" ohne Zertifikat im Cluster (abgebrochener Sync, gelöschtes Objekt): neu anlegen
  if (cert.includes(MISSING)) {
    await syncDomains(user.name, project, domains);
    cert = await certs();
  }
  const names = new Set(domains.map((d) => d.name));
  return domains.map((d, i) => ({
    ...d,
    dns: dns.get(d.id)!,
    cert: cert[i],
    record: d.name.startsWith('www.') && names.has(d.name.slice(4))
      ? { type: 'CNAME' as const, value: d.name.slice(4) }
      : { type: 'A' as const, value: publicIp() },
  }));
}
