import { githubApp, listRepos, type Repo } from '../src/github.ts';
import { listProjects } from '../src/projects.ts';
import { createProjectAction } from './actions.ts';
import { requireUser } from './session.ts';
import { ErrorBox } from './error-box.tsx';
import { Status } from './status.tsx';
import { PageHead } from './page-head.tsx';
import { GithubIcon } from './github-icon.tsx';
import { Submit } from './submit.tsx';


export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser();
  const { error } = await searchParams;
  const [projects, app] = await Promise.all([listProjects(user.id), githubApp(user.id)]);
  let repos: Repo[] = [];
  let repoError = '';
  if (app?.installation_id) {
    try {
      repos = await listRepos(app);
    } catch (err) {
      repoError = (err as Error).message;
    }
  }
  return (
    <main>
      <PageHead icon="projects" color="var(--t-projects)" title="Projekte" question="Was läuft gerade?" />
      {projects.length === 0 ? (
        <p className="card rise p-5 text-muted" style={{ ['--i' as string]: 1 }}>Noch keine Projekte. Leg unten dein erstes an.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {projects.map((p, i) => (
            <li key={p.id} className="rise" style={{ ['--i' as string]: i + 1 }}>
              {/* Name als Link über die ganze Karte, die App-Adresse liegt darüber (Link in Link ist in HTML verboten) */}
              <div className="card tile relative flex h-full flex-col gap-3 p-5">
                <a href={`/projects/${p.id}`} className="font-display text-xl font-extrabold after:absolute after:inset-0 after:rounded-[20px]">{p.name}</a>
                <span className="truncate text-sm text-muted">{p.repo.replace('https://github.com/', '')}</span>
                {p.live && (
                  <a href={p.live} target="_blank" rel="noopener" className="link relative z-10 max-w-full self-start truncate text-sm font-semibold">
                    {p.live.replace(/^https?:\/\//, '')} ↗
                  </a>
                )}
                <Status status={p.status} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="card rise mt-8 p-5" style={{ ['--i' as string]: projects.length + 1 }}>
        <h2 className="label mb-4">Neues Projekt</h2>
        <ErrorBox error={error || repoError} />
        <form action={createProjectAction} className="flex flex-wrap items-end gap-3">
          <label className="field min-w-44 flex-1"><span>Name</span><input name="name" placeholder="Meine Seite" required /></label>
          {repos.length > 0 ? (
            <label className="field min-w-56 flex-[2]"><span>Repo</span>
              <select name="repo" required>
                {repos.map((r) => <option key={r.url} value={r.url}>{r.fullName}{r.private ? ' (privat)' : ''}</option>)}
              </select>
            </label>
          ) : (
            <label className="field min-w-56 flex-[2]"><span>Öffentliches GitHub-Repo</span><input name="repo" type="url" placeholder="https://github.com/user/repo" required /></label>
          )}
          <label className="field w-48"><span>Betriebsart</span>
            <select name="mode" defaultValue="single">
              <option value="single">Einzeln (1 Kopie)</option>
              <option value="cluster">Cluster (2 Kopien)</option>
            </select>
          </label>
          <Submit className="btn-primary" busy="Wird angelegt …">Anlegen</Submit>
        </form>
        <p className="mt-3 text-sm text-muted">Cluster: zwei Kopien auf verschiedenen Servern, die App übersteht den Ausfall eines Servers und deployt ohne Unterbruch. Braucht doppelt so viel CPU und RAM, hat keinen dauerhaften Ordner, und die App darf nichts nur im Speicher halten (z. B. Sessions). Lässt sich später nicht ändern.</p>
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-[var(--hair)] pt-4 text-sm text-muted">
          {!app && <>
            <a className="btn" href="/api/github/create-app"><GithubIcon /> GitHub App erstellen</a>
            <span>für private Repos und Deploy bei jedem Push. Shipli legt sie bei GitHub für dich an, danach wählst du die Repos aus.</span>
          </>}
          {app && !app.installation_id && <>
            <a className="btn" href="/api/github/install"><GithubIcon /> App installieren</a>
            <span>Deine App <a className="link" href={app.html_url}>{app.slug}</a> ist erstellt, aber noch auf keinem Repo installiert.</span>
          </>}
          {app?.installation_id && <>
            <span className="inline-flex items-center gap-2"><GithubIcon /> Verbunden über <a className="link" href={app.html_url}>{app.slug}</a>. Nach jedem Push auf den Hauptbranch deployt Shipli neu.</span>
            <a className="btn btn-sm" href="/api/github/install">Repos freigeben</a>
          </>}
        </div>
      </section>
    </main>
  );
}
