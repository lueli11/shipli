import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

// CSRF-Schutz für die Rückleitungen von GitHub: zufälliger Wert im Cookie und in der URL
const COOKIE = 'shipli_gh_state';

export async function newState(): Promise<string> {
  const state = randomBytes(24).toString('base64url');
  (await cookies()).set(COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 900, path: '/' });
  return state;
}

export async function checkState(given: string | null): Promise<boolean> {
  const store = await cookies();
  const expected = store.get(COOKIE)?.value;
  store.delete(COOKIE);
  return !!given && !!expected && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export const appUrl = () => (process.env.SHIPLI_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
