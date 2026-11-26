// Copyright 2026-present Dokploy Technology, Inc. Licensed under the Apache License, Version 2.0.
// Nach apps/dokploy/components/dashboard/monitoring/paid/servers/{cpu,memory,disk,network}-chart.tsx und
// show-paid-monitoring.tsx. Geändert: shadcn-Karten durch Shipli-Klassen ersetzt, Texte deutsch, Netz in kB/s.
'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, Label, PolarAngleAxis, PolarRadiusAxis, RadialBar, RadialBarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Point } from '../../src/metrics.ts';


const C = { cpu: 'var(--t-projects)', memory: 'var(--t-project)', disk: 'var(--warn)', in: 'var(--t-login)', out: 'var(--accent)' };
const time = (v: string) => new Date(v).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
const fullTime = (v: string) => new Date(v).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function ChartCard({ title, sub, children }: { title: string; sub: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-4">
      <h3 className="font-display text-lg font-extrabold">{title}</h3>
      <p className="mb-3 text-sm text-muted">{sub}</p>
      <div className="h-[250px] w-full">{children}</div>
    </section>
  );
}

function Tip({ label, rows }: { label?: string | number; rows: [string, string][] }) {
  return (
    <div className="card grid grid-cols-2 gap-2 p-2 text-sm">
      <div className="flex flex-col"><span className="text-[0.7rem] text-muted uppercase">Zeit</span><span className="font-bold">{label ? fullTime(String(label)) : ''}</span></div>
      {rows.map(([k, v]) => <div key={k} className="flex flex-col"><span className="text-[0.7rem] text-muted uppercase">{k}</span><span className="font-bold">{v}</span></div>)}
    </div>
  );
}

const Fill = ({ id, color }: { id: string; color: string }) => (
  <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
    <stop offset="5%" stopColor={color} stopOpacity={0.8} />
    <stop offset="95%" stopColor={color} stopOpacity={0.1} />
  </linearGradient>
);

const axis = { tickLine: false, axisLine: false, tick: { fill: 'var(--ink-muted)', fontSize: 12 } };

/** cpuLabel: beim User „der garantierten CPU“, beim Server leer */
export function CPUChart({ data, cpuLabel = '' }: { data: Point[]; cpuLabel?: string }) {
  const last = data.at(-1);
  return (
    <ChartCard title="CPU" sub={`Auslastung: ${last?.cpu ?? 0} %${cpuLabel}`}>
      <ResponsiveContainer>
        <AreaChart data={data}>
          <defs><Fill id="fillCPU" color={C.cpu} /></defs>
          <CartesianGrid vertical={false} stroke="var(--hair)" />
          <XAxis dataKey="timestamp" {...axis} tickMargin={8} minTickGap={32} tickFormatter={time} />
          <YAxis {...axis} tickFormatter={(v) => `${v}%`} domain={[0, (max: number) => Math.max(100, Math.ceil(max))]} width={48} />
          <Tooltip cursor={false} content={({ active, payload, label }) => active && payload?.length ? <Tip label={label} rows={[['CPU', `${payload[0].payload.cpu} %`]]} /> : null} />
          <Area name="CPU" dataKey="cpu" type="monotone" isAnimationActive={false} fill="url(#fillCPU)" stroke={C.cpu} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function MemoryChart({ data }: { data: Point[] }) {
  const last = data.at(-1);
  const pct = last && last.memTotalGB ? Math.round((last.memUsedGB / last.memTotalGB) * 100) : 0;
  return (
    <ChartCard title="RAM" sub={`Belegt: ${last?.memUsedGB ?? 0} GB von ${last?.memTotalGB ?? 0} GB (${pct} %)`}>
      <ResponsiveContainer>
        <AreaChart data={data}>
          <defs><Fill id="fillMemory" color={C.memory} /></defs>
          <CartesianGrid vertical={false} stroke="var(--hair)" />
          <XAxis dataKey="timestamp" {...axis} tickMargin={8} minTickGap={32} tickFormatter={time} />
          <YAxis {...axis} tickFormatter={(v: number) => `${v < 10 ? +v.toFixed(1) : Math.round(v)} GB`} domain={[0, last?.memTotalGB || 'auto']} width={56} />
          <Tooltip cursor={false} content={({ active, payload, label }) => active && payload?.length ? <Tip label={label} rows={[['RAM', `${payload[0].payload.memUsedGB} GB`]]} /> : null} />
          <Area name="RAM" dataKey="memUsedGB" type="monotone" isAnimationActive={false} fill="url(#fillMemory)" stroke={C.memory} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function DiskChart({ data, title = 'Platte' }: { data?: Point; title?: string }) {
  const used = data?.diskUsedGB ?? 0;
  const total = data?.diskTotalGB ?? 0;
  const pct = total ? (used / total) * 100 : 0;
  return (
    <ChartCard title={title} sub={`${used.toFixed(1)} GB belegt von ${total.toFixed(1)} GB`}>
      <ResponsiveContainer>
        {/* ganzer Kreis als grauer Hintergrund, der belegte Teil beginnt oben und läuft im Uhrzeigersinn */}
        <RadialBarChart data={[{ disk: Math.min(pct, 100) }]} startAngle={90} endAngle={-270} innerRadius={80} outerRadius={110} barSize={24}>
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
          <RadialBar dataKey="disk" background={{ fill: 'var(--surface-3)' }} cornerRadius={12} fill={pct > 90 ? 'var(--bad)' : C.disk} isAnimationActive={false} />
          <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
            <Label content={({ viewBox }) => viewBox && 'cx' in viewBox && 'cy' in viewBox ? (
              <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                <tspan x={viewBox.cx} y={viewBox.cy} style={{ fill: 'var(--ink)', fontSize: 34, fontWeight: 800 }}>{pct.toFixed(1)} %</tspan>
                <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 24} style={{ fill: 'var(--ink-muted)', fontSize: 14 }}>belegt</tspan>
              </text>
            ) : null} />
          </PolarRadiusAxis>
        </RadialBarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function NetworkChart({ data }: { data: Point[] }) {
  const last = data.at(-1);
  return (
    <ChartCard title="Netz" sub={`Jetzt: ↓ ${last?.networkIn ?? 0} kB/s ↑ ${last?.networkOut ?? 0} kB/s`}>
      <ResponsiveContainer>
        <AreaChart data={data}>
          <defs><Fill id="fillNetIn" color={C.in} /><Fill id="fillNetOut" color={C.out} /></defs>
          <CartesianGrid vertical={false} stroke="var(--hair)" />
          <XAxis dataKey="timestamp" {...axis} tickMargin={8} minTickGap={32} tickFormatter={time} />
          <YAxis {...axis} tickFormatter={(v) => `${v}`} width={56} />
          <Tooltip cursor={false} content={({ active, payload, label }) => active && payload?.length ? (
            <Tip label={label} rows={[['Netz', `↓ ${payload[0].payload.networkIn} kB/s · ↑ ${payload[0].payload.networkOut} kB/s`]]} />
          ) : null} />
          <Area name="rein" dataKey="networkIn" type="monotone" isAnimationActive={false} fill="url(#fillNetIn)" stroke={C.in} strokeWidth={2} />
          <Area name="raus" dataKey="networkOut" type="monotone" isAnimationActive={false} fill="url(#fillNetOut)" stroke={C.out} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// Wie bei Dokploy: Anzahl Punkte und Intervall wählbar; gemessen wird alle 30 s
const POINTS = { '50': '50 Punkte (25 min)', '120': '120 Punkte (1 h)', '720': '720 Punkte (6 h)', '2880': '2880 Punkte (1 Tag)', '20160': 'alle (7 Tage)' } as const;
const REFRESH = { '10000': '10 s', '30000': '30 s', '60000': '1 min' } as const;

/** Holt die Punkte von url (plus ?points=…&key=value) und zeigt die vier Diagramme. */
export function MetricsView({ url, select, cpuLabel, diskTitle }: {
  url: string;
  select?: { name: string; label: string; options: [string, string][] };
  cpuLabel?: string;
  diskTitle?: string;
}) {
  const [points, setPoints] = useState<keyof typeof POINTS>('120');
  const [refresh, setRefresh] = useState<keyof typeof REFRESH>('30000');
  const [choice, setChoice] = useState(select?.options[0]?.[0] ?? '');
  const [data, setData] = useState<Point[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ points });
    if (select && choice) q.set(select.name, choice);
    const load = () => fetch(`${url}?${q}`).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Fehler ${r.status}`);
      return r.json();
    }).then((d) => { if (alive) { setData(d); setError(''); } }, (e) => alive && setError(e.message));
    load();
    const t = setInterval(load, Number(refresh));
    return () => { alive = false; clearInterval(t); };
  }, [url, points, refresh, choice, select]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        {select && (
          <label className="field min-w-40"><span>{select.label}</span>
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              {select.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        )}
        <label className="field min-w-40"><span>Datenpunkte</span>
          <select value={points} onChange={(e) => setPoints(e.target.value as keyof typeof POINTS)}>
            {Object.entries(POINTS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="field min-w-32"><span>Aktualisieren alle</span>
          <select value={refresh} onChange={(e) => setRefresh(e.target.value as keyof typeof REFRESH)}>
            {Object.entries(REFRESH).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      {error && <p className="notice-bad" role="alert">{error}</p>}
      {!data ? (
        <p className="card p-5 text-muted">Lädt …</p>
      ) : data.length === 0 ? (
        <p className="card p-5 text-muted">Noch keine Messwerte. Shipli misst alle 30 Sekunden, sobald eine App läuft.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CPUChart data={data} cpuLabel={cpuLabel} />
          <MemoryChart data={data} />
          <DiskChart data={data.at(-1)} title={diskTitle} />
          <NetworkChart data={data} />
        </div>
      )}
    </div>
  );
}
