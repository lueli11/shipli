import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from './db.ts';
import { validateName } from './deploy.ts';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 10;

export type User = { id: number; email: string; name: string; is_admin?: boolean };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(password, salt, 64)).toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, key] = stored.split('$');
  const expected = Buffer.from(key, 'base64');
  return timingSafeEqual(await scrypt(password, Buffer.from(salt, 'base64'), expected.length), expected);
}

// nur gehashte Tokens in der DB: ein Dump der Datenbank öffnet keine Sessions
export async function createSession(userId: number): Promise<string> {
  const token = newToken();
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${sha256(token)}, ${userId}, now() + interval '30 days')`;
  return token;
}

export async function userBySession(token: string): Promise<User | undefined> {
  const [user] = await sql<User[]>`
    SELECT u.id, u.email, u.name, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha256(token)} AND s.expires_at > now()`;
  return user;
}

export async function deleteSession(token: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE token_hash = ${sha256(token)}`;
}

// shortcut: Zähler im Speicher, gilt pro Prozess; mit mehreren Replikas nach Postgres oder Redis verschieben
const failures = new Map<string, number[]>();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;
// pro IP grosszügiger: dahinter können mehrere Leute stecken (NAT), aber sie bremst das Durchprobieren vieler E-Mails
const MAX_IP_FAILURES = 30;

function blocked(key: string, max: number, now: number): boolean {
  const recent = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  // leere Einträge löschen, sonst wächst die Map mit jeder neuen IP
  if (recent.length) failures.set(key, recent);
  else failures.delete(key);
  return recent.length >= max;
}

export const loginBlocked = (email: string, now = Date.now()) => blocked(email, MAX_FAILURES, now);

/** ip: echte Client-IP (X-Real-Ip von Traefik, seit dem PROXY-Protokoll vom alten Traefik verlässlich). */
export async function login(email: string, password: string, ip?: string, now = Date.now()): Promise<string | undefined> {
  email = email.trim().toLowerCase();
  const keys = [email, ...(ip ? [`ip:${ip}`] : [])];
  if (loginBlocked(email, now) || (ip && blocked(`ip:${ip}`, MAX_IP_FAILURES, now))) {
    throw new Error('Zu viele Fehlversuche, warte 15 Minuten');
  }
  const token = await checkLogin(email, password);
  if (!token) for (const k of keys) failures.set(k, [...(failures.get(k) ?? []), now]);
  return token;
}

async function checkLogin(email: string, password: string): Promise<string | undefined> {
  const [user] = await sql<{ id: number; password_hash: string }[]>`SELECT id, password_hash FROM users WHERE email = ${email}`;
  if (!user || !(await verifyPassword(password, user.password_hash))) return undefined;
  return createSession(user.id);
}

/** Prüft das Passwort eines eingeloggten Users; Fehlversuche zählen zur Login-Sperre. */
export async function checkPassword(user: User, password: string): Promise<void> {
  if (loginBlocked(user.email)) throw new Error('Zu viele Fehlversuche, warte 15 Minuten');
  const [row] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${user.id}`;
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    failures.set(user.email, [...(failures.get(user.email) ?? []), Date.now()]);
    throw new Error('Passwort ist falsch');
  }
}

export async function changePassword(user: User, current: string, next: string, keepSession: string): Promise<void> {
  if (next.length < MIN_PASSWORD) throw new Error(`Neues Passwort braucht mindestens ${MIN_PASSWORD} Zeichen`);
  await checkPassword(user, current);
  await sql`UPDATE users SET password_hash = ${await hashPassword(next)} WHERE id = ${user.id}`;
  // andere Geräte abmelden: wer das alte Passwort kannte, soll mit seiner Session nicht weitermachen
  await sql`DELETE FROM sessions WHERE user_id = ${user.id} AND token_hash <> ${sha256(keepSession)}`;
}

/** Gibt die E-Mail normalisiert zurück. */
async function checkNewUser(email: string, name: string): Promise<string> {
  email = email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error(`E-Mail "${email}" ist ungültig`);
  validateName('User', name);
  // Repos eines Users heissen in zot "<user>/…", und shipli/** ist Shipli selbst vorbehalten
  if (name === 'shipli') throw new Error('Der Name "shipli" ist reserviert');
  const [taken] = await sql`SELECT 1 FROM users WHERE email = ${email} OR name = ${name}`;
  if (taken) throw new Error('E-Mail oder Name ist schon vergeben');
  return email;
}

export async function createInvite(email: string, name: string, admin = false): Promise<string> {
  name = name.trim().toLowerCase();
  email = await checkNewUser(email, name);
  const token = newToken();
  await sql`INSERT INTO invites (token_hash, email, name, admin, expires_at) VALUES (${sha256(token)}, ${email}, ${name}, ${admin}, now() + interval '7 days')`;
  return token;
}

/** Erster Admin beim allerersten Start (Installer setzt SHIPLI_ADMIN_*); sobald es einen User gibt, passiert nichts. */
export async function createFirstAdmin(email: string, name: string, password: string): Promise<boolean> {
  name = name.trim().toLowerCase();
  validateName('User', name);
  const hash = await hashPassword(password);
  const rows = await sql`
    INSERT INTO users (email, name, password_hash, is_admin)
    SELECT ${email.trim().toLowerCase()}, ${name}, ${hash}, true WHERE NOT EXISTS (SELECT 1 FROM users)`;
  return rows.count === 1;
}

export async function inviteByToken(token: string): Promise<{ email: string; name: string } | undefined> {
  const [invite] = await sql<{ email: string; name: string }[]>`
    SELECT email, name FROM invites WHERE token_hash = ${sha256(token)} AND used_at IS NULL AND expires_at > now()`;
  return invite;
}

export async function acceptInvite(token: string, password: string): Promise<string> {
  if (password.length < MIN_PASSWORD) throw new Error(`Passwort braucht mindestens ${MIN_PASSWORD} Zeichen`);
  const passwordHash = await hashPassword(password);
  const userId = await sql.begin(async (tx) => {
    // FOR UPDATE: ein Link lässt sich auch bei zwei gleichzeitigen Klicks nur einmal einlösen
    const [invite] = await tx<{ email: string; name: string; admin: boolean }[]>`
      SELECT email, name, admin FROM invites WHERE token_hash = ${sha256(token)} AND used_at IS NULL AND expires_at > now() FOR UPDATE`;
    if (!invite) throw new Error('Einladung ungültig oder abgelaufen');
    const [user] = await tx<{ id: number }[]>`
      INSERT INTO users (email, name, password_hash, is_admin) VALUES (${invite.email}, ${invite.name}, ${passwordHash}, ${invite.admin}) RETURNING id`;
    await tx`UPDATE invites SET used_at = now() WHERE token_hash = ${sha256(token)}`;
    return user.id;
  });
  return createSession(userId);
}

// --- Registrierung ohne Einladung --------------------------------------------

/** invite: nur per Einladung, email: Link per Mail (eine Einladung an sich selbst), open: Konto sofort. */
export const REGISTRATION = ['invite', 'email', 'open'] as const;
export type Registration = (typeof REGISTRATION)[number];
const MAX_REGISTRATIONS = 5;

export async function getRegistration(): Promise<Registration> {
  const [row] = await sql<{ value: Registration }[]>`SELECT value FROM settings WHERE key = 'registration'`;
  return row?.value ?? 'invite';
}

export async function setRegistration(mode: string, mailReady: boolean): Promise<void> {
  if (!REGISTRATION.includes(mode as Registration)) throw new Error(`Unbekannte Art der Registrierung: ${mode}`);
  if (mode === 'email' && !mailReady) throw new Error('Für Bestätigung per E-Mail fehlt SHIPLI_SMTP_URL');
  await sql`INSERT INTO settings (key, value) VALUES ('registration', ${sql.json(mode)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

/**
 * Gibt bei "open" die Session zurück, bei "email" den Einladungstoken für die Mail.
 * Jeder Versuch zählt pro IP, damit niemand massenhaft Konten anlegt oder Mails an fremde Adressen auslöst.
 */
export async function register(
  input: { email: string; name: string; password: string },
  ip?: string,
  now = Date.now(),
): Promise<{ session: string } | { invite: string; email: string }> {
  const mode = await getRegistration();
  if (mode === 'invite') throw new Error('Shipli läuft nur auf Einladung');
  const key = ip && `reg:${ip}`;
  if (key) {
    if (blocked(key, MAX_REGISTRATIONS, now)) throw new Error('Zu viele Registrierungen von dieser Adresse, warte 15 Minuten');
    failures.set(key, [...(failures.get(key) ?? []), now]);
  }
  const name = input.name.trim().toLowerCase();
  if (mode === 'email') {
    const email = input.email.trim().toLowerCase();
    return { invite: await createInvite(email, name), email };
  }
  if (input.password.length < MIN_PASSWORD) throw new Error(`Passwort braucht mindestens ${MIN_PASSWORD} Zeichen`);
  const email = await checkNewUser(input.email, name);
  const [user] = await sql<{ id: number }[]>`
    INSERT INTO users (email, name, password_hash) VALUES (${email}, ${name}, ${await hashPassword(input.password)}) RETURNING id`;
  return { session: await createSession(user.id) };
}

// --- API-Tokens für MCP -----------------------------------------------------

const API_TOKEN = /^shipli_[A-Za-z0-9_-]{43}$/;
const MAX_TOKENS = 5;

export type ApiToken = { id: number; name: string; prefix: string; created_at: Date; expires_at: Date; last_used_at: Date | null };
export type TokenUser = User & { token_id: number };

/** Gibt den Token einmal zurück; gespeichert werden nur Hash und Präfix. Gilt 90 Tage. */
export async function createApiToken(userId: number, name: string): Promise<string> {
  name = name.trim();
  if (!name || name.length > 40) throw new Error('Name des Tokens: 1 bis 40 Zeichen, z. B. „laptop-claude“');
  const token = `shipli_${newToken()}`;
  await sql.begin(async (tx) => {
    // FOR UPDATE: zwei gleichzeitige Formulare können die Grenze nicht gemeinsam überschreiten
    await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const [{ n }] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM api_tokens WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > now()`;
    if (n >= MAX_TOKENS) throw new Error(`Du hast schon ${MAX_TOKENS} Tokens. Widerrufe zuerst einen alten.`);
    await tx`INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at)
      VALUES (${userId}, ${name}, ${sha256(token)}, ${token.slice(0, 12)}, now() + interval '90 days')`;
  });
  return token;
}

export async function listApiTokens(userId: number): Promise<ApiToken[]> {
  return sql<ApiToken[]>`SELECT id, name, prefix, created_at, expires_at, last_used_at FROM api_tokens
    WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at`;
}

export async function revokeApiToken(userId: number, tokenId: number): Promise<void> {
  await sql`UPDATE api_tokens SET revoked_at = now() WHERE id = ${tokenId} AND user_id = ${userId} AND revoked_at IS NULL`;
}

/**
 * header: "Authorization" der Anfrage. Ohne is_admin: über MCP gelten auch für Admins die Rechte eines normalen Users.
 * Verglichen wird nur der sha256-Hash; ein Timing-Leck verrät so nichts über den Token selbst (wie bei sessions).
 */
export async function userByApiToken(header: string | null, ip?: string, now = Date.now()): Promise<TokenUser | undefined> {
  // eigener Schlüssel, damit ein kaputter Agent nicht das Login-Formular derselben IP sperrt
  const key = ip && `mcp:${ip}`;
  if (key && blocked(key, MAX_IP_FAILURES, now)) throw new Error('Zu viele falsche Tokens von dieser Adresse, warte 15 Minuten');
  if (!header) return undefined;
  const token = header.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
  const [user] = API_TOKEN.test(token)
    ? await sql<TokenUser[]>`
      WITH t AS (UPDATE api_tokens SET last_used_at = now()
        WHERE token_hash = ${sha256(token)} AND revoked_at IS NULL AND expires_at > now() RETURNING id, user_id)
      SELECT u.id, u.email, u.name, t.id AS token_id FROM t JOIN users u ON u.id = t.user_id`
    : [];
  if (!user && key) failures.set(key, [...(failures.get(key) ?? []), now]);
  return user;
}

export type UserOverview ={ id: number; name: string; email: string; is_admin: boolean; created_at: Date; projects: number };

export async function listUsers(): Promise<UserOverview[]> {
  return sql<UserOverview[]>`
    SELECT u.id, u.name, u.email, u.is_admin, u.created_at, count(p.id)::int AS projects
    FROM users u LEFT JOIN projects p ON p.user_id = u.id
    GROUP BY u.id ORDER BY u.created_at`;
}
