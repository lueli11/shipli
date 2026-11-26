const GB = 2 ** 30;
export const gb = (bytes: number) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 2 : 1)} GB`;
export const cores = (milli: number) => `${(milli / 1000).toFixed(2)} CPU`;

/** Balken „verbraucht / erlaubt“; ohne max nur die Zahl (Bandbreite hat keine Grenze). */
export function UsageBar({ label, used, max, format }: { label: string; used: number; max?: number; format: (v: number) => string }) {
  const pct = max ? Math.min(100, (used / max) * 100) : 0;
  const color = pct >= 90 ? 'var(--bad)' : pct >= 75 ? 'var(--warn)' : 'var(--ok)';
  return (
    <div className="grid gap-1">
      <div className="flex justify-between gap-2 text-sm">
        <span className="font-semibold">{label}</span>
        <span className="text-muted">{format(used)}{max !== undefined && <> von {format(max)}</>}</span>
      </div>
      {max !== undefined && (
        <div className="h-2.5 overflow-hidden rounded-full bg-surface-2" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={used}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
        </div>
      )}
    </div>
  );
}
