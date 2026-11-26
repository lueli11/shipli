import { Writable } from 'node:stream';
import { sql } from './db.ts';
import { deploy, FAIL, imageBytes, removeApp, removeNamespace, toName, validate, validateEnvKey, validateVolumePath, type DeployInput } from './deploy.ts';
import { githubApp, installationToken } from './github.ts';
import { deleteDomainObjects, listDomains } from './domains.ts';
import { checkPassword, type User } from './auth.ts';
import { checkStorage, getLimits } from './limits.ts';

// Jede Abfrage filtert nach user_id: das ist die Grenze zwischen den Usern (bei Kubero fehlte genau das)

export type Project = { id: number; name: string; repo: string; status: string | null; url: string | null };
export type Deployment = { id: number; status: 'building' | 'done' | 'failed'; sha: string | null; url: string | null; log: string; created_at: Date };

/** live: Adresse zum Öffnen, die Hauptdomain wenn sie ein Zertifikat hat, sonst die Shipli-Adresse; nur wenn je ein Deploy klappte. */
export async function listProjects(userId: number): Promise<(Project & { live: string | null; deployment_id: number | null })[]> {
  return sql<(Project & { live: string | null; deployment_id: number | null })[]>`
    SELECT p.id, p.name, p.repo, d.status, d.url, d.id AS deployment_id,
      CASE WHEN ok.url IS NOT NULL THEN coalesce('https://' || dom.name, ok.url) END AS live
    FROM projects p
    LEFT JOIN LATERAL (SELECT id, status, url FROM deployments WHERE project_id = p.id ORDER BY id DESC LIMIT 1) d ON true
    LEFT JOIN LATERAL (SELECT url FROM deployments WHERE project_id = p.id AND status = 'done' ORDER BY id DESC LIMIT 1) ok ON true
    LEFT JOIN domains dom ON dom.project_id = p.id AND dom.is_primary AND dom.status = 'cert'
    WHERE p.user_id = ${userId} ORDER BY p.name`;
}

// IDs kommen aus der URL; "abc" oder ein fehlender Wert ergibt NaN, und Postgres würde dann abbrechen
const isId = (n: number) => Number.isSafeInteger(n) && n > 0;

type ProjectDetails = Project & { google_verification: string | null; volume_path: string | null; volume_mib: number | null };

export async function getProject(userId: number, projectId: number): Promise<ProjectDetails | undefined> {
  if (!isId(projectId)) return undefined;
  const [p] = await sql<ProjectDetails[]>`
    SELECT p.id, p.name, p.repo, p.google_verification, p.volume_path, p.volume_mib, d.status, d.url FROM projects p
    LEFT JOIN LATERAL (SELECT status, url FROM deployments WHERE project_id = p.id AND status = 'done' ORDER BY id DESC LIMIT 1) d ON true
    WHERE p.id = ${projectId} AND p.user_id = ${userId}`;
  return p;
}

const MAX_PROJECTS = 3;

export async function createProject(user: User, name: string, repo: string): Promise<number> {
  repo = repo.trim().replace(/\.git$|\/$/, '');
  name = toName(name);
  validate({ user: user.name, project: name, repo });
  // die ResourceQuota im Namespace ist auf drei Apps ausgelegt
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM projects WHERE user_id = ${user.id}`;
  if (n >= MAX_PROJECTS && !user.is_admin) throw new Error(`Höchstens ${MAX_PROJECTS} Projekte pro Konto`);
  try {
    return await sql.begin(async (tx) => {
      // FOR UPDATE: zwei gleichzeitige Anfragen können die Grenze nicht gemeinsam überschreiten
      const [u] = await tx<{ max: number; n: number }[]>`
        SELECT max_projects AS max, (SELECT count(*)::int FROM projects WHERE user_id = ${user.id}) AS n FROM users WHERE id = ${user.id} FOR UPDATE`;
      if (u && u.n >= u.max) throw new Error(`Du hast schon ${u.n} von ${u.max} Projekten. Lösche eines oder frag den Admin nach mehr.`);
      const [p] = await tx<{ id: number }[]>`INSERT INTO projects (user_id, name, repo) VALUES (${user.id}, ${name}, ${repo}) RETURNING id`;
      return p.id;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new Error(`Projekt "${name}" gibt es schon`);
    throw err;
  }
}

export async function deleteProject(user: User, projectId: number, confirm: string): Promise<void> {
  const project = await getProject(user.id, projectId);
  if (!project) throw new Error('Projekt nicht gefunden');
  if (confirm.trim() !== project.name) throw new Error(`Zum Löschen genau "${project.name}" eintippen`);
  // ein laufender Build würde die App nach dem Löschen wieder anlegen
  const [building] = await sql`SELECT 1 FROM deployments WHERE project_id = ${projectId} AND status = 'building'
    AND created_at > now() - interval '20 minutes'`;
  if (building) throw new Error('Es läuft noch ein Build, bitte warten bis er fertig ist');
  // zuerst im Cluster: schlägt das fehl, bleibt das Projekt in der Liste und Löschen lässt sich wiederholen
  for (const d of await listDomains(user.id, projectId)) await deleteDomainObjects(user.name, project.name, d);
  await removeApp(user.name, project.name);
  await sql`DELETE FROM projects WHERE id = ${projectId} AND user_id = ${user.id}`;
}

export async function deleteAccount(user: User, password: string, confirm: string): Promise<void> {
  if (confirm.trim() !== user.name) throw new Error(`Zum Löschen genau "${user.name}" eintippen`);
  await checkPassword(user, password);
  const [building] = await sql`SELECT 1 FROM deployments d JOIN projects p ON p.id = d.project_id
    WHERE p.user_id = ${user.id} AND d.status = 'building' AND d.created_at > now() - interval '20 minutes'`;
  if (building) throw new Error('Es läuft noch ein Build, bitte warten bis er fertig ist');
  // zuerst im Cluster: schlägt das fehl, bleibt das Konto und Löschen lässt sich wiederholen
  await removeNamespace(user.name);
  // Projekte, Variablen, Verlauf, Domains, Sessions und GitHub-Verbindung hängen per ON DELETE CASCADE am User
  await sql`DELETE FROM users WHERE id = ${user.id}`;
}

export async function listDeployments(userId: number, projectId: number): Promise<Omit<Deployment, 'log'>[]> {
  return sql<Omit<Deployment, 'log'>[]>`
    SELECT d.id, d.status, d.sha, d.url, d.created_at FROM deployments d JOIN projects p ON p.id = d.project_id
    WHERE d.project_id = ${projectId} AND p.user_id = ${userId} ORDER BY d.id DESC LIMIT 20`;
}

export async function getDeployment(userId: number, deploymentId: number): Promise<Deployment | undefined> {
  if (!isId(deploymentId)) return undefined;
  const [d] = await sql<Deployment[]>`
    SELECT d.id, d.status, d.sha, d.url, d.log, d.created_at FROM deployments d JOIN projects p ON p.id = d.project_id
    WHERE d.id = ${deploymentId} AND p.user_id = ${userId}`;
  return d;
}

/** Legt den Deploy an und gibt eine Funktion zurück, die ihn ausführt (für after()). */
export async function startDeploy(user: User, projectId: number, sha?: string): Promise<{ id: number; run: () => Promise<void> }> {
  const project = await getProject(user.id, projectId);
  if (!project) throw new Error('Projekt nicht gefunden');
  await checkStorage(user.id);
  // Der Build-Job bricht nach 15 min ab; ein älterer "building"-Eintrag stammt von einem abgestürzten Server
  await sql`UPDATE deployments SET status = 'failed', finished_at = now(), log = log || ${'\nAbgebrochen (Server neu gestartet?)\n'}
    WHERE project_id = ${projectId} AND status = 'building' AND created_at < now() - interval '20 minutes'`;
  let id: number;
  try {
    [{ id }] = await sql<{ id: number }[]>`INSERT INTO deployments (project_id) VALUES (${projectId}) RETURNING id`;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new Error('Es läuft schon ein Build');
    throw err;
  }
  const volume = project.volume_path && project.volume_mib ? { path: project.volume_path, mib: project.volume_mib } : undefined;
  return { id, run: () => runDeploy(id, user.id, { user: user.name, project: project.name, repo: project.repo, sha, volume }) };
}

/** Push-Webhook: alle Projekte des Users (dem die App gehört) mit diesem Repo neu deployen. */
export async function startDeploysForPush(userId: number, repoFullName: string, sha: string) {
  const rows = await sql<(User & { project_id: number })[]>`
    SELECT u.id, u.email, u.name, p.id AS project_id FROM projects p JOIN users u ON u.id = p.user_id
    WHERE u.id = ${userId} AND lower(p.repo) = lower(${'https://github.com/' + repoFullName})`;
  const started = [];
  for (const { project_id, ...user } of rows) {
    try {
      started.push(await startDeploy(user, project_id, sha));
    } catch (err) {
      console.warn(`Push-Deploy für Projekt ${project_id} übersprungen: ${(err as Error).message}`);
    }
  }
  return started;
}

const gb = (mib: number) => `${(mib / 1024).toLocaleString('de-CH', { maximumFractionDigits: 2 })} GB`;

/** Ordner anlegen, verschieben oder vergrössern; gilt ab dem nächsten Deploy. */
export async function setVolume(userId: number, projectId: number, path: string, mib: number): Promise<void> {
  validateVolumePath(path);
  if (!Number.isSafeInteger(mib) || mib < 100) throw new Error('Grösse: mindestens 0,1 GB');
  await sql.begin(async (tx) => {
    // FOR UPDATE: zwei gleichzeitige Anfragen können die Grenze nicht gemeinsam überschreiten
    const [u] = await tx<{ limit: number; others: number; current: number | null }[]>`
      SELECT u.volume_limit AS limit,
        (SELECT coalesce(sum(volume_mib), 0)::int FROM projects WHERE user_id = u.id AND id <> ${projectId}) AS others,
        (SELECT volume_mib FROM projects WHERE user_id = u.id AND id = ${projectId}) AS current
      FROM users u WHERE u.id = ${userId} AND EXISTS (SELECT 1 FROM projects WHERE id = ${projectId} AND user_id = u.id) FOR UPDATE`;
    if (!u) throw new Error('Projekt nicht gefunden');
    // Longhorn kann ein Volume nur vergrössern
    if (u.current && mib < u.current) throw new Error(`Ein Ordner lässt sich nicht verkleinern (jetzt ${gb(u.current)})`);
    if (u.others + mib > u.limit) throw new Error(`Deine Ordner dürfen zusammen ${gb(u.limit)} haben, frei sind noch ${gb(u.limit - u.others)}. Frag den Admin nach mehr.`);
    await tx`UPDATE projects SET volume_path = ${path}, volume_mib = ${mib} WHERE id = ${projectId} AND user_id = ${userId}`;
  });
}

/** Ordner entfernen; die Daten löscht der nächste Deploy, bis dahin läuft die App mit ihnen weiter. */
export async function removeVolume(userId: number, projectId: number, confirm: string): Promise<void> {
  const project = await getProject(userId, projectId);
  if (!project) throw new Error('Projekt nicht gefunden');
  if (confirm.trim() !== project.name) throw new Error(`Zum Entfernen genau "${project.name}" eintippen`);
  await sql`UPDATE projects SET volume_path = NULL, volume_mib = NULL WHERE id = ${projectId} AND user_id = ${userId}`;
}

export async function listEnvKeys(userId: number, projectId: number): Promise<string[]> {
  const rows = await sql<{ key: string }[]>`
    SELECT e.key FROM project_env e JOIN projects p ON p.id = e.project_id
    WHERE e.project_id = ${projectId} AND p.user_id = ${userId} ORDER BY e.key`;
  return rows.map((r) => r.key);
}

export async function setEnv(userId: number, projectId: number, key: string, value: string): Promise<void> {
  validateEnvKey(key);
  if (value.length > 32_768) throw new Error('Wert ist zu lang (höchstens 32 KB)');
  if (!(await getProject(userId, projectId))) throw new Error('Projekt nicht gefunden');
  await sql`INSERT INTO project_env (project_id, key, value) VALUES (${projectId}, ${key}, ${value})
    ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`;
}

export async function unsetEnv(userId: number, projectId: number, key: string): Promise<void> {
  await sql`DELETE FROM project_env e USING projects p WHERE p.id = e.project_id AND p.user_id = ${userId} AND e.project_id = ${projectId} AND e.key = ${key}`;
}

async function runDeploy(id: number, userId: number, input: Omit<DeployInput, 'limits'>): Promise<void> {
  let pending = '';
  let chain = Promise.resolve();
  const flush = () => {
    const text = pending;
    pending = '';
    // nacheinander anhängen, sonst kann der Log durcheinander geraten
    if (text) chain = chain.then(async () => { await sql`UPDATE deployments SET log = log || ${text} WHERE id = ${id}`; });
  };
  const out = new Writable({ write(chunk, _enc, cb) { pending += chunk.toString(); cb(); } });
  const timer = setInterval(flush, 1000);
  let result: { status: 'done' | 'failed'; sha?: string; url?: string };
  try {
    const env = await sql<{ key: string; value: string }[]>`SELECT e.key, e.value FROM project_env e JOIN projects p ON p.id = e.project_id
      WHERE p.user_id = ${userId} AND p.name = ${input.project}`;
    const app = await githubApp(userId);
    result = {
      status: 'done',
      ...(await deploy({
        ...input,
        env: Object.fromEntries(env.map((e) => [e.key, e.value])),
        gitToken: app?.installation_id ? await installationToken(app) : undefined,
        limits: await getLimits(userId),
      }, out)),
    };
  } catch (err) {
    pending += `\n${FAIL}${(err as Error).message}\n`;
    result = { status: 'failed' };
  }
  clearInterval(timer);
  flush();
  await chain;
  await sql`UPDATE deployments SET status = ${result.status}, sha = ${result.sha ?? null}, url = ${result.url ?? null}, finished_at = now() WHERE id = ${id}`;
  if (result.sha) {
    // nur für „Nutzung“; fehlt die Grösse, zählt das Image bis zum nächsten Deploy nicht zum Speicher
    await imageBytes(input.user, input.project, result.sha)
      .then((bytes) => sql`UPDATE deployments SET image_bytes = ${bytes} WHERE id = ${id}`)
      .catch((err) => console.warn(`Imagegrösse für ${input.user}/${input.project}: ${(err as Error).message}`));
  }
}
