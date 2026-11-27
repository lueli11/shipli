import { notFound } from 'next/navigation';
import { getRegistration, listUsers } from '../../src/auth.ts';
import { mailReady } from '../../src/mail.ts';
import { usage } from '../../src/metrics.ts';
import { setLimitsAction, setRegistrationAction } from '../actions.ts';
import { requireUser } from '../session.ts';
import { PageHead } from '../page-head.tsx';
import { Submit } from '../submit.tsx';
import { UsageBar, cores, gb } from '../usage-bar.tsx';
import { InviteForm } from './invite-form.tsx';

export default async function Admin({ searchParams }: { searchParams: Promise<{ error?: string; in?: string; saved?: string; warn?: string }> }) {
  const user = await requireUser();
  // 404 statt 403: Nicht-Admins sollen nicht erfahren, dass es die Seite gibt
  if (!user.is_admin) notFound();
  const q = await searchParams;
  const [users, all, registration] = await Promise.all([listUsers(), usage(), getRegistration()]);
  const byId = new Map(all.map((u) => [u.user_id, u]));
  const total = users.reduce((n, u) => n + u.projects, 0);
  return (
    <main>
      <PageHead icon="account" color="var(--t-project)" title="User" question={`${users.length} User, ${total} Projekte`} />
      <div className="mb-3"><InviteForm /></div>
      <section id="registrierung" className="card mb-3 grid gap-3 p-4">
        <h2 className="font-display text-lg font-extrabold">Registrierung</h2>
        <form action={setRegistrationAction} className="flex flex-wrap items-end gap-3">
          <label className="field min-w-64 flex-1"><span>Wer darf ein Konto anlegen?</span>
            <select name="mode" defaultValue={registration}>
              <option value="invite">Nur mit Einladung</option>
              <option value="email" disabled={!mailReady()}>Alle, nach Bestätigung per E-Mail{mailReady() ? '' : ' (SHIPLI_SMTP_URL fehlt)'}</option>
              <option value="open">Alle, sofort ohne Bestätigung</option>
            </select>
          </label>
          <Submit className="btn" busy="Speichert …">Speichern</Submit>
        </form>
        <p className="text-sm text-muted">Neue Konten bekommen die Standardgrenzen (1 Kern, 2 GB RAM, 3 Projekte) und dürfen sofort Code bauen und laufen lassen.</p>
        {q.in === 'registrierung' && q.error && <p className="notice-bad" role="alert">{q.error}</p>}
        {q.saved === 'registrierung' && <p className="notice-ok" role="status">Gespeichert.</p>}
      </section>
      <ul className="grid gap-3">
        {users.map((u, i) => {
          const use = byId.get(u.id)!;
          const id = `u${u.id}`;
          return (
            <li key={u.id} id={id} className="card rise grid gap-4 p-4" style={{ ['--i' as string]: i + 1 }}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="font-display text-lg font-extrabold">{u.name}</span>
                {u.is_admin && <span className="chip">Admin</span>}
                <span className="min-w-0 flex-1 truncate text-sm text-muted">{u.email}</span>
                <span className="text-sm text-muted">seit {u.created_at.toLocaleDateString('de-CH')}</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <UsageBar label="CPU" used={use.cpu} max={use.cpu_limit} format={cores} />
                <UsageBar label="RAM" used={use.memory} max={use.memory_limit} format={gb} />
                <UsageBar label="Speicher" used={use.storage} max={use.storage_limit} format={gb} />
                <UsageBar label="Projekte" used={use.projects} max={use.max_projects} format={String} />
                <UsageBar label="Ordner (zugeteilt)" used={use.volume} max={use.volume_limit} format={gb} />
                <UsageBar label="Bandbreite diesen Monat" used={use.rx_month + use.tx_month} format={gb} />
              </div>
              {q.in === id && q.error && <p className="notice-bad" role="alert">{q.error}</p>}
              {q.saved === String(u.id) && (q.warn
                ? <p className="notice-warn" role="status">Gespeichert. {q.warn}</p>
                : <p className="notice-ok" role="status">Gespeichert und im Cluster angewendet.</p>)}
              <form action={setLimitsAction} className="grid grid-cols-2 gap-3 sm:grid-cols-6 sm:items-end">
                <input type="hidden" name="userId" value={u.id} />
                <label className="field"><span>CPU (Kerne)</span><input name="cpu" type="number" step="0.1" min="0.1" max="16" defaultValue={use.cpu_limit / 1000} required /></label>
                <label className="field"><span>RAM (GB)</span><input name="memory" type="number" step="0.25" min="0.125" max="64" defaultValue={use.memory_limit / 2 ** 30} required /></label>
                <label className="field"><span>Speicher (GB)</span><input name="storage" type="number" step="0.5" min="0.25" max="1024" defaultValue={use.storage_limit / 2 ** 30} required /></label>
                <label className="field"><span title="Belegt im Cluster das Dreifache (eine Kopie pro Node)">Ordner (GB)</span><input name="volume" type="number" step="0.5" min="0" max="1024" defaultValue={use.volume_limit / 2 ** 30} required /></label>
                <label className="field"><span>Projekte</span><input name="projects" type="number" step="1" min="0" max="100" defaultValue={use.max_projects} required /></label>
                <Submit className="btn" busy="Speichert …">Grenzen speichern</Submit>
              </form>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
