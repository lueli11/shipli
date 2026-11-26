import type { ReactNode } from 'react';

// 24px-Strichsymbole (stroke = currentColor), wie im Finanz-Cockpit
const ICONS = {
  projects: <path d="M4 7l8-4 8 4-8 4zM4 12l8 4 8-4M4 17l8 4 8-4" />,
  project: <path d="M12 3l1.8 4.6L18.5 9l-3.6 3.3.9 4.9L12 14.8 8.2 17.2l.9-4.9L5.5 9l4.7-1.4z" />,
  account: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0" />,
  login: <path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5zM12 15v2" />,
  usage: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  monitor: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  connect: <path d="M9 7V3M15 7V3M6 7h12v4a6 6 0 0 1-12 0zM12 17v4" />,
};

export function PageHead({ icon, color, title, question, children }: {
  icon: keyof typeof ICONS;
  color: string;
  title: string;
  question?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="pagehead rise mb-6" style={{ ['--c' as string]: color }}>
      <span className="sticker">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {ICONS[icon]}
        </svg>
      </span>
      <div className="relative z-10 min-w-0">
        <h1 className="font-display text-3xl leading-none font-extrabold break-words sm:text-4xl">{title}</h1>
        {question && <p className="mt-1.5 font-semibold opacity-80">{question}</p>}
        {children}
      </div>
    </header>
  );
}
