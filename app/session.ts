import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { userBySession, type User } from '../src/auth.ts';

const COOKIE = 'shipli_session';

export const sessionToken = async () => (await cookies()).get(COOKIE)?.value;

export async function currentUser(): Promise<User | undefined> {
  const token = await sessionToken();
  return token ? userBySession(token) : undefined;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 3600,
    path: '/',
  });
}

export async function takeSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  store.delete(COOKIE);
  return token;
}
