import { createInvite } from '../src/auth.ts';
import { sql } from '../src/db.ts';

const args = process.argv.slice(2);
const admin = args.includes('--admin');
const [email, name] = args.filter((a) => a !== '--admin');
if (!name) {
  console.error('Aufruf: npm run invite -- <email> <username> [--admin]');
  process.exit(2);
}
try {
  const token = await createInvite(email, name, admin);
  console.log(`${process.env.SHIPLI_APP_URL ?? 'http://localhost:3000'}/invite/${token}`);
  // ohne zot-Konto bleibt jeder Build des neuen Users beim Einhängen des Push-Secrets hängen
  console.error('Das zot-Konto legt zot-sync im Cluster an, nach etwa 1 min kann der User bauen');
} catch (err) {
  console.error(`Fehler: ${(err as Error).message}`);
  process.exitCode = 1;
}
await sql.end();
