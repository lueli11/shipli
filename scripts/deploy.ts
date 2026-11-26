import { deploy } from '../src/deploy.ts';
import { getLimits } from '../src/limits.ts';

const [user, project, repo] = process.argv.slice(2);
if (!repo) {
  console.error('Aufruf: npm run deploy -- <user> <projekt> <https://github.com/owner/repo>');
  process.exit(2);
}
try {
  // der User muss in der DB stehen, seine Grenzen kommen von dort
  await deploy({ user, project, repo, limits: await getLimits(user) });
  process.exit(0); // offene DB-Verbindung hielte das Skript sonst am Leben
} catch (err) {
  console.error(`Fehler: ${(err as Error).message}`);
  process.exit(1);
}
