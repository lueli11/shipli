'use client';

import { useEffect, useState } from 'react';
import type { DomainState, Light } from '../../../src/domains.ts';
import { deployAction, primaryDomainAction, removeDomainAction } from '../../actions.ts';
import { Submit } from '../../submit.tsx';

const COLOR = { ok: 'text-ok', warten: 'text-warn', falsch: 'text-bad' } as const;

function Lamp({ label, light }: { label: string; light: Light }) {
  return (
    <span className={`inline-flex items-center gap-2 text-sm font-semibold ${COLOR[light.state]}`}>
      <span className={`dot ${light.state === 'warten' ? 'dot-busy' : light.state === 'falsch' ? 'dot-still' : ''}`} aria-hidden="true" />
      {label}: {light.text}
    </span>
  );
}

export function Domains({ projectId, deployed }: { projectId: number; deployed: boolean }) {
  const [domains, setDomains] = useState<DomainState[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/domains`, { cache: 'no-store' });
        if (!res.ok) throw new Error();
        const next: DomainState[] = await res.json();
        if (stop) return;
        setDomains(next);
        setFailed(false);
        // alle grün: nicht weiter fragen
        if (next.every((d) => d.dns.state === 'ok' && d.cert.state === 'ok')) return;
      } catch {
        if (!stop) setFailed(true);
      }
      if (!stop) timer = setTimeout(poll, 5000);
    };
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [projectId]);

  if (!domains) return <p className="text-sm text-muted">{failed ? 'Prüfung fehlgeschlagen, versuche es weiter …' : 'Prüfe DNS …'}</p>;
  if (!domains.length) return null;
  const primary = domains.find((d) => d.is_primary);

  return (
    <>
    {/* DNS und Zertifikat können grün sein, ohne dass eine App läuft: dann antwortet Traefik mit 404 */}
    {!deployed && (
      <>
        <p className="notice-warn mb-3" role="status">Die App ist noch nicht deployt. Bis zum ersten erfolgreichen Deploy antworten diese Domains mit 404.</p>
        <div id="deploy-first" popover="auto" className="card space-y-3 p-6 text-center">
          <p className="font-display text-2xl font-extrabold">Zuerst deployen</p>
          <p className="text-sm">DNS und Zertifikat stimmen, die Domain zeigt schon auf Shipli. Aber es läuft noch keine App, an die Shipli die Besucher weitergeben kann. Darum käme jetzt nur „404 page not found“.</p>
          <p className="text-sm text-muted">Ein Deploy holt den Code von GitHub, baut ihn und startet die App. Danach ist sie unter allen Domains erreichbar.</p>
          <form action={deployAction} className="pt-2">
            <input type="hidden" name="projectId" value={projectId} />
            <button className="btn-primary w-full py-3 text-base">Jetzt deployen</button>
          </form>
        </div>
      </>
    )}
    <ul className="rows rounded-2xl border-2 border-line">
      {domains.map((d) => (
        <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {d.cert.state !== 'ok' ? <code className="font-semibold">{d.name}</code>
                : deployed ? <a className="link font-semibold" href={`https://${d.name}`} target="_blank" rel="noopener">{d.name}</a>
                : <button type="button" className="link font-semibold" popoverTarget="deploy-first">{d.name}</button>}
              {d.is_primary ? <span className="chip">Hauptdomain</span> : primary && <span className="text-sm text-muted">leitet weiter auf {primary.name}</span>}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
              <Lamp label="DNS" light={d.dns} />
              <Lamp label="Zertifikat" light={d.cert} />
            </div>
            {d.dns.state !== 'ok' && (
              <p className="mt-2 text-sm text-muted">Beim DNS-Anbieter eintragen: <code className="chip">{d.record.type} {d.name} → {d.record.value}</code></p>
            )}
          </div>
          <div className="flex gap-2">
            {!d.is_primary && (
              <form action={primaryDomainAction}>
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="domainId" value={d.id} />
                <Submit className="btn btn-sm">Als Hauptdomain</Submit>
              </form>
            )}
            <form action={removeDomainAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="domainId" value={d.id} />
              <Submit className="btn btn-sm" aria-label={`${d.name} entfernen`} busy="Entfernt …">Entfernen</Submit>
            </form>
          </div>
        </li>
      ))}
    </ul>
    </>
  );
}
