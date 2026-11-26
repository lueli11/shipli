import { currentUser } from '../../../session.ts';
import { userSeries } from '../../../../src/metrics.ts';

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Nicht angemeldet' }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const project = q.get('project');
  return Response.json(await userSeries(user.id, project && project !== 'all' ? project : undefined, Number(q.get('points'))));
}
