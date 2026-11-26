import { after } from 'next/server';
import { handleMcp } from '../../../src/mcp.ts';

// nur POST: zustandslos ohne SSE-Stream, GET und DELETE beantwortet Next mit 405
export const POST = (req: Request) => handleMcp(req, after);
