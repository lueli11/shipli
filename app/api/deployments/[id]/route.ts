import { currentUser } from '../../../session.ts';
import { getDeployment } from '../../../../src/projects.ts';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Nicht angemeldet' }, { status: 401 });
  const deployment = await getDeployment(user.id, Number((await ctx.params).id));
  if (!deployment) return Response.json({ error: 'Nicht gefunden' }, { status: 404 });
  return Response.json(deployment);
}
