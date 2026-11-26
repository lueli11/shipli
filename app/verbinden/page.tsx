import { requireUser } from '../session.ts';
import { Connect } from '../connect.tsx';
import { PageHead } from '../page-head.tsx';

export default async function Verbinden() {
  await requireUser();
  const url = process.env.SHIPLI_APP_URL ?? 'http://localhost:3000';
  const card = (i: number) => ({ className: 'card rise mt-6 p-5', style: { ['--i' as string]: i } });
  return (
    <main>
      <PageHead icon="connect" color="var(--t-monitor)" title="Mit Claude/Codex verbinden" question="Deine Projekte direkt aus dem Agenten steuern" />
      <section {...card(1)}>
        <h2 className="label mb-3">So geht es</h2>
        <ol className="grid list-decimal gap-1.5 pl-5 text-sm">
          <li>Unter <a className="link" href="/konto#tokens">Konto</a> einen Token erzeugen. Dort stehen die Befehle gleich mit deinem Token.</li>
          <li>Den Befehl für Claude Code oder Codex im Terminal ausführen, <code>DEIN_TOKEN</code> ersetzen.</li>
          <li>Im Agenten fragen, z. B. „Liste meine Shipli-Projekte“.</li>
        </ol>
        <p className="mt-3 text-sm text-muted">
          Der Agent hat deine Rechte: Projekte anlegen, deployen, Logs lesen, Variablen setzen und Domains anhängen. Löschen geht nur hier in der Oberfläche.
          Werte von Variablen zeigt Shipli nie an. Ein Token gilt 90 Tage und lässt sich unter Konto widerrufen.
        </p>
      </section>
      <section {...card(2)}>
        <h2 className="label mb-4">Befehle</h2>
        <Connect url={url} token="DEIN_TOKEN" />
      </section>
    </main>
  );
}
