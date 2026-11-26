import { after } from 'next/server';
import { githubAppById, verifySignature } from '../../../../src/github.ts';
import { startDeploysForPush } from '../../../../src/projects.ts';
import { sql } from '../../../../src/db.ts';

type Push = { ref: string; after: string; deleted?: boolean; repository: { full_name: string; default_branch: string } };

export async function POST(req: Request) {
  // jede App eines Users hat ihr eigenes Webhook-Secret; GitHub nennt die App im Header
  const app = await githubAppById(Number(req.headers.get('x-github-hook-installation-target-id')));
  const body = await req.text();
  if (!app || !verifySignature(app.webhook_secret, body, req.headers.get('x-hub-signature-256'))) {
    return new Response('Signatur ungültig', { status: 401 });
  }
  const event = req.headers.get('x-github-event');
  const payload = JSON.parse(body);

  if (event === 'installation' && payload.action === 'deleted') {
    await sql`UPDATE github_apps SET installation_id = NULL WHERE app_id = ${app.app_id}`;
  }
  if (event === 'push') {
    const push = payload as Push;
    // nur der Standard-Branch wird deployt; gelöschte und andere Branches ignorieren
    if (!push.deleted && push.ref === `refs/heads/${push.repository.default_branch}`) {
      const started = await startDeploysForPush(app.user_id, push.repository.full_name, push.after);
      after(() => Promise.all(started.map((d) => d.run())).then(() => {}));
      return Response.json({ deployments: started.map((d) => d.id) }, { status: 202 });
    }
  }
  return new Response(null, { status: 204 });
}
