import { redirect } from 'next/navigation';
import { convertManifest, linkInstallation } from '../../../../src/github.ts';
import { currentUser } from '../../../session.ts';
import { checkState, newState } from '../state.ts';

// Rückweg von GitHub für beide Schritte, wie bei Dokploy:
// 1. App erstellt: ?code=…&state=… → App speichern und direkt weiter zur Installation
// 2. App installiert: ?installation_id=…&state=… → Installation speichern
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) redirect('/login');
  const params = new URL(req.url).searchParams;
  const installationId = params.get('installation_id');
  const code = params.get('code');
  let error = '';
  let next = '/';
  if (!(await checkState(params.get('state')))) {
    error = 'Ungültiger Ablauf, bitte über Shipli neu starten';
  } else {
    try {
      if (installationId) {
        await linkInstallation(user.id, Number(installationId));
      } else if (code) {
        const app = await convertManifest(user.id, code);
        next = `${app.html_url}/installations/new?state=${await newState()}`;
      } else {
        error = 'GitHub hat nichts zurückgegeben';
      }
    } catch (err) {
      error = (err as Error).message;
    }
  }
  redirect(error ? `/?error=${encodeURIComponent(error)}` : next);
}
