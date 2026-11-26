import { hasGoogleFile } from '../../../../src/domains.ts';

// Google folgt keiner Weiterleitung und meldet sich nicht an: direkt 200 oder 404
export async function GET(req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '');
  if (!(await hasGoogleFile(host, file))) return new Response('Nicht gefunden', { status: 404 });
  return new Response(`google-site-verification: ${file}`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
