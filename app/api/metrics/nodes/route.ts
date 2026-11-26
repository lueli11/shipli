import { currentUser } from '../../../session.ts';
import { nodeSeries } from '../../../../src/metrics.ts';

export async function GET(req: Request) {
  const user = await currentUser();
  // 404 wie die Seite: Nicht-Admins sollen nicht erfahren, dass es das gibt
  if (!user?.is_admin) return Response.json({ error: 'Nicht gefunden' }, { status: 404 });
  const q = new URL(req.url).searchParams;
  const node = q.get('node');
  return Response.json(await nodeSeries(node && node !== 'all' ? node : undefined, Number(q.get('points'))));
}
