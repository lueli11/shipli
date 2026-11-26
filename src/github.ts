import { createHmac, createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from './db.ts';

// Wie bei Dokploy: Jeder User legt per Manifest seine eigene private App an und installiert sie gleich danach.
// Privat heisst: nur sein eigenes GitHub-Konto kann sie installieren.

export type GithubApp = {
  user_id: number;
  app_id: number;
  slug: string;
  html_url: string;
  pem: string;
  webhook_secret: string;
  installation_id: number | null;
};

const API = 'https://api.github.com';
const headers = (auth?: string) => ({
  Accept: 'application/vnd.github+json',
  'User-Agent': 'shipli',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(auth && { Authorization: auth }),
});

async function gh<T>(path: string, init: RequestInit & { auth?: string } = {}): Promise<T> {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    ...init,
    headers: { ...headers(init.auth), ...(init.body && { 'Content-Type': 'application/json' }) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} bei ${path.replace(/\?.*/, '')}`);
  return res.json() as Promise<T>;
}

// bigint kommt aus Postgres als String
const row = (r: GithubApp | undefined) => r && { ...r, app_id: Number(r.app_id), installation_id: r.installation_id && Number(r.installation_id) };

export async function githubApp(userId: number): Promise<GithubApp | undefined> {
  const [r] = await sql<GithubApp[]>`SELECT * FROM github_apps WHERE user_id = ${userId}`;
  return row(r);
}

export async function githubAppById(appId: number): Promise<GithubApp | undefined> {
  if (!Number.isSafeInteger(appId)) return undefined;
  const [r] = await sql<GithubApp[]>`SELECT * FROM github_apps WHERE app_id = ${appId}`;
  return row(r);
}

export function manifest(baseUrl: string, userName: string) {
  return {
    // App-Namen sind auf GitHub weltweit eindeutig und höchstens 34 Zeichen lang
    name: `Shipli-${userName}-${randomBytes(3).toString('hex')}`.slice(0, 34),
    url: baseUrl,
    hook_attributes: { url: `${baseUrl}/api/github/webhook`, active: true },
    redirect_url: `${baseUrl}/api/github/setup`,
    // mit request_oauth_on_install geht es nach der Installation auf die erste callback_url (eine setup_url ist dann verboten)
    callback_urls: [`${baseUrl}/api/github/setup`],
    request_oauth_on_install: true,
    public: false,
    default_permissions: { contents: 'read', metadata: 'read' },
    default_events: ['push'],
  };
}

export async function convertManifest(userId: number, code: string): Promise<GithubApp> {
  const r = await gh<{ id: number; slug: string; pem: string; webhook_secret: string; html_url: string }>(
    `/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' });
  // legt der User eine neue App an, ersetzt sie die alte (die alte bleibt bei GitHub, bis er sie dort löscht)
  const [app] = await sql<GithubApp[]>`
    INSERT INTO github_apps (user_id, app_id, slug, html_url, pem, webhook_secret)
    VALUES (${userId}, ${r.id}, ${r.slug}, ${r.html_url}, ${r.pem}, ${r.webhook_secret})
    ON CONFLICT (user_id) DO UPDATE SET app_id = EXCLUDED.app_id, slug = EXCLUDED.slug, html_url = EXCLUDED.html_url,
      pem = EXCLUDED.pem, webhook_secret = EXCLUDED.webhook_secret, installation_id = NULL, created_at = now()
    RETURNING *`;
  return row(app)!;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function appJwt(cfg: Pick<GithubApp, 'app_id' | 'pem'>, now = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: cfg.app_id }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(cfg.pem);
  return `${head}.${body}.${b64url(sig)}`;
}

export async function installationToken(app: GithubApp): Promise<string> {
  if (!app.installation_id) throw new Error('GitHub App ist noch nicht installiert');
  const r = await gh<{ token: string }>(`/app/installations/${app.installation_id}/access_tokens`, { method: 'POST', auth: `Bearer ${appJwt(app)}` });
  return r.token;
}

export type Repo = { fullName: string; url: string; private: boolean; defaultBranch: string };

export async function listRepos(app: GithubApp): Promise<Repo[]> {
  const token = await installationToken(app);
  const repos: Repo[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await gh<{ repositories: { full_name: string; html_url: string; private: boolean; default_branch: string }[] }>(
      `/installation/repositories?per_page=100&page=${page}`, { auth: `Bearer ${token}` });
    repos.push(...r.repositories.map((x) => ({ fullName: x.full_name, url: x.html_url, private: x.private, defaultBranch: x.default_branch })));
    if (r.repositories.length < 100) break;
  }
  return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** Speichert die Installation, nachdem GitHub bestätigt hat, dass sie zur App dieses Users gehört. */
export async function linkInstallation(userId: number, installationId: number): Promise<void> {
  const app = await githubApp(userId);
  if (!app) throw new Error('Zuerst die GitHub App erstellen');
  // installation_id kommt aus der URL und lässt sich fälschen; GitHub antwortet nur für Installationen dieser App
  await gh(`/app/installations/${installationId}`, { auth: `Bearer ${appJwt(app)}` }).catch(() => {
    throw new Error('Diese Installation gehört nicht zu deiner GitHub App');
  });
  await sql`UPDATE github_apps SET installation_id = ${installationId} WHERE user_id = ${userId}`;
}

export function verifySignature(secret: string, body: string, signature: string | null): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
