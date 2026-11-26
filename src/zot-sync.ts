// zot-Konten im Cluster: release (nur shipli/**), puller (containerd auf den Nodes, Shipli) und pro User u-<name>,
// das nur <name>/** schreiben darf. Läuft als eigener Pod mit eigenem Service-Account (deploy/shipli.yaml), nicht in
// Shipli: wer zot-zugang schreiben darf, vergibt Rechte in zot, und das soll ein kompromittiertes Shipli nicht können.
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import base from './zot-config.json' with { type: 'json' };

export const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const pushSecret = (user: string) => `zot-push-${user}`;

export type Accounts = { htpasswd: string; config: string; passwords: Map<string, string> };

/**
 * Baut htpasswd und config.json. Bestehende Passwörter (aus den Push-Secrets) bleiben, und eine Zeile aus dem alten
 * htpasswd wird übernommen, solange sie zum Passwort passt: bcrypt salzt jedes Mal neu, sonst änderte sich das Secret
 * bei jedem Durchlauf und zot lüde jedes Mal neu.
 */
export async function buildAccounts(users: string[], known: Map<string, string>, system: { release: string; puller: string }, oldHtpasswd = ''): Promise<Accounts> {
  for (const u of users) {
    // Namen landen in Secret-Namen und Policies; die DB prüft das Format nicht selbst
    if (!NAME.test(u) || u === 'shipli') throw new Error(`Ungültiger Username in der DB: '${u}'`);
  }
  const old = new Map(oldHtpasswd.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf(':')), l] as const));
  const passwords = new Map(users.map((u) => [u, known.get(u) ?? randomBytes(24).toString('hex')]));
  const all: [string, string][] = [['release', system.release], ['puller', system.puller], ...[...passwords].map(([u, pw]) => [`u-${u}`, pw] as [string, string])];
  const lines: string[] = [];
  for (const [account, pw] of all) {
    const line = old.get(account);
    lines.push(line && (await bcrypt.compare(pw, line.slice(account.length + 1))) ? line : `${account}:${await bcrypt.hash(pw, 10)}`);
  }
  const config = structuredClone(base);
  const repos = config.http.accessControl.repositories as Record<string, { policies: { users: string[]; actions: string[] }[] }>;
  for (const u of users) {
    repos[`${u}/**`] = { policies: [{ users: [`u-${u}`], actions: ['read', 'create', 'update'] }, { users: ['puller'], actions: ['read'] }] };
  }
  return { htpasswd: lines.join('\n') + '\n', config: JSON.stringify(config, null, 2), passwords };
}

export const dockerConfig = (registry: string, user: string, pw: string) =>
  JSON.stringify({ auths: { [registry]: { username: `u-${user}`, password: pw, auth: Buffer.from(`u-${user}:${pw}`).toString('base64') } } });

export function passwordFromDockerConfig(json: string): string | undefined {
  const auths = (JSON.parse(json) as { auths?: Record<string, { password?: string }> }).auths ?? {};
  return Object.values(auths)[0]?.password;
}
