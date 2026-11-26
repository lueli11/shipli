import { githubApp } from '../../src/github.ts';
import { listApiTokens } from '../../src/auth.ts';
import { changePasswordAction, deleteAccountAction, revokeTokenAction } from '../actions.ts';
import { TokenForm } from './token-form.tsx';
import { requireUser } from '../session.ts';
import { ErrorBox } from '../error-box.tsx';
import { PageHead } from '../page-head.tsx';
import { Submit } from '../submit.tsx';

export default async function Konto({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const user = await requireUser();
  const { error, saved } = await searchParams;
  const [app, tokens] = await Promise.all([githubApp(user.id), listApiTokens(user.id)]);
  const date = (d: Date | null) => (d ? d.toLocaleDateString('de-CH') : 'nie');
  const card = (i: number) => ({ className: 'card rise mt-6 p-5', style: { ['--i' as string]: i } });
  // die App gehört dem GitHub-Konto des Users; Shipli kann sie nicht selbst löschen
  const appSettings = app && `https://github.com/settings/apps/${app.slug}`;

  return (
    <main>
      <PageHead icon="account" color="var(--t-login)" title={user.name} question={user.email} />
      <ErrorBox error={error} />
      {saved === 'pw' && <p className="notice-ok mb-4" role="status">Passwort geändert. Andere Geräte sind abgemeldet.</p>}
      {saved === 'token' && <p className="notice-ok mb-4" role="status">Token widerrufen. Ein Agent damit bekommt ab jetzt keinen Zugriff mehr.</p>}

      <section {...card(1)}>
        <h2 className="label mb-4">Passwort ändern</h2>
        <form action={changePasswordAction} className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <input type="email" name="username" autoComplete="username" value={user.email} readOnly hidden />
          <label className="field"><span>Aktuelles Passwort</span><input name="current" type="password" autoComplete="current-password" required /></label>
          <label className="field"><span>Neues Passwort</span><input name="next" type="password" autoComplete="new-password" minLength={10} required /></label>
          <label className="field"><span>Neues Passwort wiederholen</span><input name="repeat" type="password" autoComplete="new-password" minLength={10} required /></label>
          <div className="sm:col-span-3"><Submit className="btn-primary" busy="Wird geändert …">Passwort ändern</Submit></div>
        </form>
      </section>

      <section {...card(2)}>
        <h2 className="label mb-3">GitHub</h2>
        {app ? (
          <p className="text-sm">Deine App <a className="link" href={app.html_url}>{app.slug}</a> {app.installation_id ? 'ist installiert.' : 'ist noch nicht installiert.'} <a className="link" href={appSettings!}>Auf GitHub verwalten</a></p>
        ) : (
          <p className="text-sm text-muted">Noch keine GitHub App. Du kannst sie bei „Neues Projekt“ erstellen.</p>
        )}
      </section>

      <section {...card(3)} id="tokens">
        <h2 className="label mb-1">Tokens für Claude und Codex</h2>
        <p className="mb-4 text-sm text-muted">
          Ein Token gibt einem Agenten deine Rechte, ausser Löschen. Er gilt 90 Tage, höchstens 5 gleichzeitig. <a className="link" href="/verbinden">So verbindest du ihn</a>
        </p>
        {tokens.length > 0 && (
          <div className="rows mb-4">
            {tokens.map((t) => (
              <form key={t.id} action={revokeTokenAction} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm">
                <input type="hidden" name="tokenId" value={t.id} />
                <strong className="min-w-32">{t.name}</strong>
                <code className="text-muted">{t.prefix}…</code>
                <span className="text-muted">zuletzt benutzt {date(t.last_used_at)}, läuft ab {date(t.expires_at)}</span>
                <Submit className="btn btn-sm ml-auto" busy="Wird widerrufen …">Widerrufen</Submit>
              </form>
            ))}
          </div>
        )}
        <TokenForm url={process.env.SHIPLI_APP_URL ?? 'http://localhost:3000'} />
      </section>

      <section {...card(4)}>
        <h2 className="label mb-1">Konto löschen</h2>
        <p className="mb-4 text-sm text-muted">
          Löscht alle deine Projekte mit Apps, Domains und Zertifikaten, Variablen und Verlauf, dazu dein Konto. Lässt sich nicht rückgängig machen.
          {app && <> Die GitHub App <strong className="text-ink">{app.slug}</strong> bleibt bei GitHub, <a className="link" href={appSettings!}>dort löschen</a>.</>}
        </p>
        <form action={deleteAccountAction} className="flex flex-wrap items-end gap-3">
          <label className="field min-w-44 flex-1"><span>Zum Bestätigen <strong className="text-ink">{user.name}</strong> eintippen</span>
            <input name="confirm" required autoComplete="off" spellCheck={false} />
          </label>
          <label className="field min-w-44 flex-1"><span>Passwort</span><input name="password" type="password" autoComplete="current-password" required /></label>
          <Submit className="btn-primary danger" busy="Wird gelöscht …">Konto löschen</Submit>
        </form>
      </section>
    </main>
  );
}
