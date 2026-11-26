'use client';

import { usePathname } from 'next/navigation';

export function Nav({ admin }: { admin?: boolean }) {
  const path = usePathname();
  const active = path === '/' || path.startsWith('/projects');
  return (
    <nav className="flex flex-wrap gap-1.5">
      <a href="/" aria-current={active ? 'page' : undefined} className="navchip" style={{ ['--c' as string]: 'var(--t-projects)' }}>Projekte</a>
      <a href="/nutzung" aria-current={path === '/nutzung' ? 'page' : undefined} className="navchip" style={{ ['--c' as string]: 'var(--t-usage)' }}>Nutzung</a>
      <a href="/verbinden" aria-current={path === '/verbinden' ? 'page' : undefined} className="navchip" style={{ ['--c' as string]: 'var(--t-monitor)' }}>Claude/Codex</a>
      {admin && <a href="/admin" aria-current={path === '/admin' ? 'page' : undefined} className="navchip" style={{ ['--c' as string]: 'var(--t-project)' }}>User</a>}
      {admin && <a href="/admin/monitoring" aria-current={path === '/admin/monitoring' ? 'page' : undefined} className="navchip" style={{ ['--c' as string]: 'var(--t-monitor)' }}>Monitoring</a>}
    </nav>
  );
}
