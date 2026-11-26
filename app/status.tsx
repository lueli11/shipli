const LABEL = { building: 'baut …', done: 'läuft', failed: 'fehlgeschlagen' } as const;
const COLOR = { building: 'text-warn', done: 'text-ok', failed: 'text-bad' } as const;

export function Status({ status }: { status: string | null }) {
  if (!status) return <span className="text-sm text-muted">noch nie deployt</span>;
  const s = status as keyof typeof LABEL;
  return (
    <span className={`inline-flex items-center gap-2 text-sm font-semibold ${COLOR[s] ?? ''}`}>
      <span className={`dot ${s === 'building' ? 'dot-busy' : s === 'failed' ? 'dot-still' : ''}`} aria-hidden="true" />
      {LABEL[s] ?? status}
    </span>
  );
}
