import { listProjects } from '../../src/projects.ts';
import { usage } from '../../src/metrics.ts';
import { requireUser } from '../session.ts';
import { PageHead } from '../page-head.tsx';
import { MetricsView } from '../monitoring/charts.tsx';
import { UsageBar, cores, gb } from '../usage-bar.tsx';

export default async function Nutzung() {
  const user = await requireUser();
  const [[u], projects] = await Promise.all([usage(user.id), listProjects(user.id)]);
  const month = new Date().toLocaleDateString('de-CH', { month: 'long' });
  return (
    <main>
      <PageHead icon="usage" color="var(--t-usage)" title="Nutzung" question="Wie viel brauchen deine Apps?" />
      <section className="card rise grid gap-4 p-5 sm:grid-cols-2" style={{ ['--i' as string]: 1 }}>
        <UsageBar label="CPU (garantiert, kurz bis 4×)" used={u.cpu} max={u.cpu_limit} format={cores} />
        <UsageBar label="RAM" used={u.memory} max={u.memory_limit} format={gb} />
        <UsageBar label="Speicher (Images und /tmp)" used={u.storage} max={u.storage_limit} format={gb} />
        <UsageBar label="Projekte" used={u.projects} max={u.max_projects} format={String} />
        <UsageBar label="Dauerhafte Ordner (zugeteilt)" used={u.volume} max={u.volume_limit} format={gb} />
        <UsageBar label={`Bandbreite im ${month}`} used={u.rx_month + u.tx_month} format={(v) => `${gb(v)} (↓ ${gb(u.rx_month)} ↑ ${gb(u.tx_month)})`} />
      </section>
      <div className="rise mt-6" style={{ ['--i' as string]: 2 }}>
        <MetricsView
          url="/api/metrics/usage"
          select={{ name: 'project', label: 'Projekt', options: [['all', 'Alle Projekte'], ...projects.map((p): [string, string] => [p.name, p.name])] }}
          cpuLabel=" der garantierten CPU"
          diskTitle="Speicher"
        />
      </div>
    </main>
  );
}
