import { currentUser } from '../../../../session.ts';
import { checkDomains } from '../../../../../src/domains.ts';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Nicht angemeldet' }, { status: 401 });
  const domains = await checkDomains(user, Number((await ctx.params).id));
  if (!domains) return Response.json({ error: 'Nicht gefunden' }, { status: 404 });
  return Response.json(domains);
}
