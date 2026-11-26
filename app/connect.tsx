import { CopyButton } from './copy-button.tsx';

/** Fertige Befehle für Claude Code und Codex; /konto füllt sie direkt nach dem Erzeugen mit dem echten Token. */
export function Connect({ url, token }: { url: string; token: string }) {
  const endpoint = `${url}/api/mcp`;
  const blocks = [
    {
      title: 'Claude Code',
      note: 'Speichert den Token in ~/.claude.json.',
      code: `claude mcp add --transport http --scope user shipli ${endpoint} --header "Authorization: Bearer ${token}"`,
    },
    {
      title: 'Codex',
      note: 'Codex liest den Token aus der Umgebungsvariable SHIPLI_TOKEN.',
      code: `echo 'export SHIPLI_TOKEN=${token}' >> ~/.bashrc && export SHIPLI_TOKEN=${token}\ncodex mcp add shipli --url ${endpoint} --bearer-token-env-var SHIPLI_TOKEN`,
    },
    {
      title: 'Codex, von Hand in ~/.codex/config.toml',
      note: 'Gleich wie der Befehl oben; SHIPLI_TOKEN muss trotzdem gesetzt sein.',
      code: `[mcp_servers.shipli]\nurl = "${endpoint}"\nbearer_token_env_var = "SHIPLI_TOKEN"`,
    },
  ];
  return (
    <div className="grid gap-4">
      {blocks.map((b) => (
        <div key={b.title}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="font-semibold">{b.title}</h3>
            <CopyButton text={b.code} />
          </div>
          <pre className="log">{b.code}</pre>
          <p className="mt-1.5 text-sm text-muted">{b.note}</p>
        </div>
      ))}
    </div>
  );
}
