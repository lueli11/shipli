import { redirect } from 'next/navigation';
import { runtimeLog } from '../../../src/deploy.ts';
import { getDeployment, getProject, listDeployments, listEnvKeys } from '../../../src/projects.ts';
import { addDomainAction, deleteProjectAction, deployAction, googleAction, removeVolumeAction, setBuildAction, setEnvAction, setVolumeAction, unsetEnvAction } from '../../actions.ts';
import { requireUser } from '../../session.ts';
import { ErrorBox } from '../../error-box.tsx';
import { Status } from '../../status.tsx';
import { LiveLog } from './live-log.tsx';
import { Domains } from './domains.tsx';
import { PageHead } from '../../page-head.tsx';
import { CopyButton } from '../../copy-button.tsx';
import { Submit } from '../../submit.tsx';
import { listDomains } from '../../../src/domains.ts';

type Search = { error?: string; in?: string; value?: string; deployment?: string; saved?: string; log?: string };

export default async function ProjectPage(props: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const user = await requireUser();
  const { id } = await props.params;
  const { error, in: section, value, deployment: selected, saved, log } = await props.searchParams;
  const errorIn = (s?: string) => <ErrorBox error={section === s ? error : undefined} />;
  const project = await getProject(user.id, Number(id));
  // gelöschtes Projekt oder alter Tab: zurück zur Übersicht statt 404
  if (!project) redirect('/');
  const [deployments, envKeys, domains] = await Promise.all([listDeployments(user.id, project.id), listEnvKeys(user.id, project.id), listDomains(user.id, project.id)]);
  // Hauptdomain erst zeigen, wenn ihr Zertifikat angelegt ist (vorher antwortet sie nicht über HTTPS)
  const primary = domains.find((d) => d.is_primary && d.status === 'cert');
  const addresses = project.url
    ? [...(primary ? [{ label: 'Hauptdomain', url: `https://${primary.name}` }] : []), { label: 'Shipli-Adresse', url: project.url }]
    : [];
  const shown = await getDeployment(user.id, Number(selected ?? deployments[0]?.id));
  let runtime = '';
  if (log) {
    try {
      runtime = (await runtimeLog(user.name, project.name)) || 'Noch keine Ausgabe.';
    } catch {
      runtime = 'Kein laufender Container gefunden.';
    }
  }

  const card = (i: number) => ({ className: 'card rise mt-6 p-5', style: { ['--i' as string]: i } });

  return (
    <main>
      <PageHead
        icon="project"
        color="var(--t-project)"
        title={project.name}
        question={<a href={project.repo}>{project.repo.replace('https://github.com/', '')}</a>}
      />
      {addresses.length > 0 && (
        <div className="card rise rows mb-6 px-5">
          {addresses.map(({ label, url }) => (
            <div key={url} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5">
              <span className="label w-32 flex-none">{label}</span>
              <a className="link min-w-0 truncate font-semibold" href={url} target="_blank" rel="noopener">{url.replace(/^https?:\/\//, '')}</a>
              <div className="ml-auto flex gap-2">
                <CopyButton text={url} />
                <a className="btn btn-sm" href={url} target="_blank" rel="noopener">Öffnen ↗</a>
              </div>
            </div>
          ))}
        </div>
      )}
      {errorIn()}
      <form action={deployAction}>
        <input type="hidden" name="projectId" value={project.id} />
        <Submit className="btn-primary" busy="Startet …">Jetzt deployen</Submit>
      </form>

      {shown && (
        <section {...card(1)}>
          <h2 className="label mb-3">Build #{shown.id}</h2>
          <LiveLog key={shown.id} id={shown.id} initial={{ status: shown.status, log: shown.log, url: shown.url }} />
        </section>
      )}

      <section id="domains" {...card(2)}>
        <h2 className="label mb-1">Domains</h2>
        <p className="mb-4 text-sm text-muted">Eigene Domain mit HTTPS. Shipli prüft das DNS alle 5 Sekunden und holt das Zertifikat, sobald es stimmt. Bei Cloudflare geht die orange Wolke, dann SSL/TLS auf „Full (strict)“ stellen.</p>
        {errorIn('domains')}
        <Domains projectId={project.id} deployed={!!project.url} />
        <form action={addDomainAction} className="mt-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="projectId" value={project.id} />
          <label className="field min-w-48 flex-1"><span>Domain</span><input name="domain" placeholder="meinefirma.ch" defaultValue={section === 'domains' ? value : undefined} required autoComplete="off" spellCheck={false} /></label>
          <span className="inline-flex items-center gap-2">
            <label className="pick"><input type="checkbox" name="www" defaultChecked /> mit und ohne www</label>
            <button type="button" className="info" popoverTarget="www-info" aria-label="Was heisst mit und ohne www?">i</button>
          </span>
          <div id="www-info" popover="auto" className="card max-w-sm space-y-2 p-5 text-sm">
            <p className="font-display text-lg font-extrabold">Mit und ohne www</p>
            <p>Mit Häkchen trägt Shipli beide Adressen ein, zum Beispiel <code>meinefirma.ch</code> und <code>www.meinefirma.ch</code>. Beide bekommen ein Zertifikat.</p>
            <p>Die zuerst eingetippte ist die Hauptdomain, die andere leitet dauerhaft (301) dorthin weiter. So landen Besucher immer auf derselben Adresse, egal ob sie www tippen oder nicht. Die Hauptdomain lässt sich später umstellen.</p>
            <p className="text-muted">Ohne Häkchen gilt nur genau die eingetippte Adresse. Für eine Subdomain wie <code>app.meinefirma.ch</code> braucht es meist kein www.</p>
          </div>
          <Submit className="btn-primary" busy="Wird hinzugefügt …">Hinzufügen</Submit>
        </form>
        <div id="google" className="mt-6 border-t-2 border-line pt-4">
          <h3 className="label mb-2">Google Search Console</h3>
          <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>In der Search Console „Property hinzufügen“, Typ „URL-Präfix“, Adresse <code>https://{primary?.name ?? 'deine-domain.ch'}</code>.</li>
            <li>Bei „HTML-Datei“ die Datei google….html herunterladen.</li>
            <li>Hier hochladen.</li>
            <li>In der Search Console auf „Bestätigen“ klicken. Die Datei danach nicht entfernen, Google prüft später nochmals.</li>
          </ol>
          <p className="mb-3 text-sm text-muted">Typ „Domain“ geht ohne Shipli: den TXT-Eintrag von Google beim Domain-Anbieter eintragen.</p>
          {errorIn('google')}
          {saved === 'google' && project.google_verification && (
            <p className="notice-ok mb-3" role="status">
              Hochgeladen. In ein paar Sekunden liefert {primary ? <a className="link" href={`https://${primary.name}/${project.google_verification}`} target="_blank" rel="noopener">https://{primary.name}/{project.google_verification}</a> : 'jede Domain mit Zertifikat'} die Datei aus. Jetzt in der Search Console auf „Bestätigen“ klicken.
            </p>
          )}
          {saved === 'google-weg' && <p className="notice-ok mb-3" role="status">Entfernt. Eine schon bestätigte Property kann Google beim nächsten Prüfen wieder verlieren.</p>}
          {project.google_verification && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-line px-4 py-3">
              <span className="text-sm">
                Aktiv:{' '}
                {primary ? <a className="link font-semibold" href={`https://${primary.name}/${project.google_verification}`} target="_blank" rel="noopener">{project.google_verification}</a> : <code className="font-semibold">{project.google_verification}</code>}
              </span>
              <form action={googleAction}>
                <input type="hidden" name="projectId" value={project.id} />
                <input type="hidden" name="remove" value="1" />
                <Submit className="btn btn-sm" busy="Entfernt …">Entfernen</Submit>
              </form>
            </div>
          )}
          <form action={googleAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="projectId" value={project.id} />
            <label className="field min-w-48 flex-1"><span>{project.google_verification ? 'Andere Datei hochladen' : 'Datei aus der Search Console'}</span><input type="file" name="file" accept=".html,text/html" required /></label>
            <Submit className="btn-primary" busy="Lädt hoch …">Hochladen</Submit>
          </form>
        </div>
      </section>

      <section id="env" {...card(3)}>
        <h2 className="label mb-1">Umgebungsvariablen</h2>
        <p className="mb-4 text-sm text-muted">Gelten beim Build und zur Laufzeit. Werte werden nicht mehr angezeigt, nur überschrieben. Wirkt ab dem nächsten Deploy.{saved === 'env' && ' Gespeichert.'}</p>
        {envKeys.length > 0 && (
          <ul className="rows mb-4 rounded-2xl border-2 border-line">
            {envKeys.map((k) => (
              <li key={k} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <code>{k}</code>
                <form action={unsetEnvAction}>
                  <input type="hidden" name="projectId" value={project.id} />
                  <input type="hidden" name="key" value={k} />
                  <Submit className="btn btn-sm" aria-label={`${k} löschen`}>Löschen</Submit>
                </form>
              </li>
            ))}
          </ul>
        )}
        {errorIn('env')}
        <form action={setEnvAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="projectId" value={project.id} />
          <label className="field min-w-44 flex-1"><span>Name</span><input name="key" placeholder="DATABASE_URL" pattern="[A-Za-z_][A-Za-z0-9_]*" required autoComplete="off" /></label>
          <label className="field min-w-44 flex-1"><span>Wert</span><input name="value" type="password" autoComplete="off" /></label>
          <Submit className="btn-primary" busy="Speichert …">Speichern</Submit>
        </form>
      </section>

      <section id="build" {...card(4)}>
        <h2 className="label mb-1">Build</h2>
        <p className="mb-4 text-sm text-muted">Railpack erkennt Sprache und Framework selbst. Mit Dockerfile baut Shipli genau dieses, die Umgebungsvariablen kommen als Build-Argumente (ARG) und Secrets hinein. Die App muss auf <code>$PORT</code> (3000) lauschen. Wirkt ab dem nächsten Deploy.{saved === 'build' && ' Gespeichert.'}</p>
        {errorIn('build')}
        <form action={setBuildAction} className="build-form flex flex-wrap items-end gap-3">
          <input type="hidden" name="projectId" value={project.id} />
          <label className="field w-40"><span>Build-Art</span>
            <select name="type" defaultValue={project.dockerfile ? 'dockerfile' : 'railpack'}>
              <option value="railpack">Railpack</option>
              <option value="dockerfile">Dockerfile</option>
            </select>
          </label>
          <label className="field docker-only min-w-40 flex-1"><span>Dockerfile</span><input name="file" defaultValue={project.dockerfile ?? 'Dockerfile'} autoComplete="off" spellCheck={false} /></label>
          <label className="field docker-only min-w-32 flex-1"><span>Kontext</span><input name="context" defaultValue={project.docker_context ?? '.'} autoComplete="off" spellCheck={false} /></label>
          <label className="field docker-only w-36"><span>Stage (optional)</span><input name="target" defaultValue={project.docker_target ?? ''} autoComplete="off" spellCheck={false} /></label>
          <Submit className="btn-primary" busy="Speichert …">Speichern</Submit>
        </form>
      </section>

      <section id="ordner" {...card(4)}>
        <h2 className="label mb-1">Dauerhafter Ordner</h2>
        <p className="mb-4 text-sm text-muted">Was die App in diesen Ordner schreibt, bleibt bei Deploys und Neustarts erhalten und zieht beim Ausfall eines Servers mit um (drei Kopien auf drei Servern). Alles andere im Container ist nach jedem Deploy weg. Was im Image an diesem Pfad liegt, ist verdeckt. Wirkt ab dem nächsten Deploy, der dann kurz offline ist. Grösse lässt sich nur erhöhen.{saved === 'ordner' && ' Gespeichert.'}</p>
        {errorIn('ordner')}
        <form action={setVolumeAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="projectId" value={project.id} />
          <label className="field min-w-48 flex-1"><span>Pfad im Container</span><input name="path" defaultValue={project.volume_path ?? '/app/data'} required autoComplete="off" spellCheck={false} /></label>
          <label className="field w-36"><span>Grösse (GB)</span><input name="size" type="number" step="0.1" min={project.volume_mib ? project.volume_mib / 1024 : 0.1} defaultValue={(project.volume_mib ?? 1024) / 1024} required /></label>
          <Submit className="btn-primary" busy="Speichert …">{project.volume_mib ? 'Ändern' : 'Ordner anlegen'}</Submit>
        </form>
        {project.volume_mib && (
          <form action={removeVolumeAction} className="mt-4 flex flex-wrap items-end gap-3 border-t-2 border-line pt-4">
            <input type="hidden" name="projectId" value={project.id} />
            <label className="field min-w-48 flex-1"><span>Ordner entfernen, die Daten löscht der nächste Deploy. Zum Bestätigen <strong className="text-ink">{project.name}</strong> eintippen</span>
              <input name="confirm" required autoComplete="off" spellCheck={false} />
            </label>
            <Submit className="btn-primary danger" busy="Entfernt …">Ordner entfernen</Submit>
          </form>
        )}
      </section>

      <section {...card(5)}>
        <h2 className="label mb-3">Laufzeit-Log</h2>
        {log ? <pre className="log">{runtime}</pre> : <a className="btn btn-sm" href={`?log=1${selected ? `&deployment=${selected}` : ''}`}>Letzte 200 Zeilen anzeigen</a>}
      </section>

      {deployments.length > 0 && (
        <section {...card(6)}>
          <h2 className="label mb-3">Verlauf</h2>
          <ul className="rows">
            {deployments.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <a className="link font-semibold" href={`?deployment=${d.id}`}>#{d.id}</a>
                <span className="text-sm text-muted">{d.sha?.slice(0, 7) ?? '–'} · {d.created_at.toLocaleString('de-CH', { timeZone: 'Europe/Zurich' })}</span>
                <Status status={d.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section id="loeschen" {...card(7)}>
        <h2 className="label mb-1">Projekt löschen</h2>
        <p className="mb-4 text-sm text-muted">Löscht die App, ihre Domains mit Zertifikaten, die Variablen, den Verlauf und den dauerhaften Ordner mit allen Daten. Lässt sich nicht rückgängig machen.</p>
        {errorIn('loeschen')}
        <form action={deleteProjectAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="projectId" value={project.id} />
          <label className="field min-w-48 flex-1"><span>Zum Bestätigen <strong className="text-ink">{project.name}</strong> eintippen</span>
            <input name="confirm" required autoComplete="off" spellCheck={false} />
          </label>
          <Submit className="btn-primary danger" busy="Wird gelöscht …">Projekt löschen</Submit>
        </form>
      </section>
    </main>
  );
}
