import { redirect } from 'next/navigation';
import { githubApp } from '../../../../src/github.ts';
import { currentUser } from '../../../session.ts';
import { newState } from '../state.ts';

export async function GET() {
  const user = await currentUser();
  if (!user) redirect('/login');
  const app = await githubApp(user.id);
  if (!app) redirect('/api/github/create-app');
  redirect(`${app.html_url}/installations/new?state=${await newState()}`);
}
