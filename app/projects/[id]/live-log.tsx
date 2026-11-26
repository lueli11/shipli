'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Status } from '../../status.tsx';
import { summarizeLog } from '../../../src/log-view.ts';

type State = { status: string; log: string; url: string | null };

export function LiveLog({ id, initial }: { id: number; initial: State }) {
  const [state, setState] = useState(initial);
  const [debug, setDebug] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (state.status !== 'building') return;
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/deployments/${id}`, { cache: 'no-store' });
      if (!res.ok) return;
      const next: State = await res.json();
      setState(next);
      if (next.status !== 'building') router.refresh();
    }, 1500);
    return () => clearTimeout(timer);
  }, [id, state, router]);

  useEffect(() => {
    const el = pre.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.log, debug]);

  const { text, hidden } = summarizeLog(state.log);
  const shown = debug ? state.log : text;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Status status={state.status} />
        {state.url && <a className="link text-sm" href={state.url} target="_blank" rel="noopener">{state.url}</a>}
        <label className="pick ml-auto"><input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} /> Debug</label>
      </div>
      <pre className="log" ref={pre} aria-live="polite">{shown || 'Warte auf den Build …'}</pre>
      {!debug && hidden > 0 && <p className="mt-2 text-xs text-muted">{hidden} Zeilen ausgeblendet, alles unter „Debug“.</p>}
    </>
  );
}
