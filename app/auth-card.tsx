import type { ReactNode } from 'react';

/** Login und Einladung: eine Karte mitten auf dem Punktraster. */
export function AuthCard({ subtitle, children }: { subtitle: ReactNode; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <div className="card rise w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center gap-3 [perspective:400px]">
          <span className="coin coin-lg font-display">S</span>
          <div>
            <h1 className="font-display text-3xl leading-none font-extrabold">Shipli</h1>
            <p className="mt-1 text-sm text-muted">{subtitle}</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}
