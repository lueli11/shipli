import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import { Bricolage_Grotesque, Instrument_Sans } from 'next/font/google';
import { currentUser } from './session.ts';
import { logoutAction } from './actions.ts';
import { Nav } from './nav.tsx';
import './globals.css';
import { Submit } from './submit.tsx';

// next/font lädt die Schriften beim Build, zur Laufzeit geht keine Anfrage an Google
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-display-face', weight: ['500', '700', '800'] });
const body = Instrument_Sans({ subsets: ['latin'], variable: '--font-body' });

export const metadata = { title: 'Shipli', icons: { icon: '/icon.svg' } };
export const viewport: Viewport = { themeColor: '#242933' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="de-CH" className={`${display.variable} ${body.variable}`}>
      <body className="min-h-dvh font-sans antialiased">
        {user ? (
          <div className="mx-auto max-w-4xl px-4 pb-16">
            <header className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-5 pb-5">
              <a href="/" className="font-display flex items-center gap-2.5 text-2xl font-extrabold [perspective:400px]">
                <span className="coin">S</span>
                Shipli
              </a>
              <Nav admin={user.is_admin} />
              <div className="ml-auto flex items-center gap-2">
                <a href="/konto" className="chip" title="Kontoeinstellungen">{user.name}</a>
                <form action={logoutAction}>
                  <Submit className="btn btn-sm">Abmelden</Submit>
                </form>
              </div>
            </header>
            {children}
          </div>
        ) : children}
      </body>
    </html>
  );
}
