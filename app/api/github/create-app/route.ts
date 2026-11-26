import { redirect } from 'next/navigation';
import { githubApp } from '../../../../src/github.ts';
import { currentUser } from '../../../session.ts';
import { newState } from '../state.ts';

// Cookies lassen sich nur hier setzen, nicht in einer Seite; die Seite schickt dann das Manifest ab
export async function GET() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (await githubApp(user.id)) redirect('/api/github/install');
  redirect(`/github/erstellen?state=${await newState()}`);
}
