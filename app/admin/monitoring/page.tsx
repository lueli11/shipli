import { notFound } from 'next/navigation';
import { nodeInfos } from '../../../src/metrics.ts';
import { requireUser } from '../../session.ts';
import { PageHead } from '../../page-head.tsx';
import { MetricsView } from '../../monitoring/charts.tsx';

export default async function Monitoring() {
  const user = await requireUser();
  if (!user.is_admin) notFound();
  const nodes = await nodeInfos();
  const up = nodes.filter((n) => n.ready).length;
  return (
    <main>
      <PageHead icon="monitor" color="var(--t-monitor)" title="Monitoring" question={`${up} von ${nodes.length} Nodes bereit`} />
      <ul className="mb-6 grid gap-3 sm:grid-cols-3">
        {nodes.map((n, i) => (
          <li key={n.name} className="card rise p-4" style={{ ['--i' as string]: i + 1 }}>
            <div className="flex items-center gap-2">
              <span className="font-display text-lg font-extrabold">{n.name}</span>
              <span className={`ml-auto inline-flex items-center gap-2 text-sm font-semibold ${n.ready ? 'text-ok' : 'text-bad'}`}>
                <span className={`dot ${n.ready ? '' : 'dot-still'}`} aria-hidden="true" />{n.ready ? 'bereit' : 'nicht bereit'}
              </span>
            </div>
            <p className="mt-1 text-sm">{n.cpus} CPU · {n.memoryGB} GB RAM</p>
            <p className="text-sm text-muted">{n.os}, Kernel {n.kernel} ({n.arch})</p>
            <p className="text-sm text-muted">{n.kubelet}</p>
          </li>
        ))}
      </ul>
      <MetricsView
        url="/api/metrics/nodes"
        select={{ name: 'node', label: 'Node', options: [['all', 'Alle Nodes'], ...nodes.map((n): [string, string] => [n.name, n.name])] }}
      />
    </main>
  );
}
