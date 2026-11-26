import { redirect } from 'next/navigation';
import { manifest } from '../../../src/github.ts';
import { requireUser } from '../../session.ts';
import { appUrl } from '../../api/github/state.ts';
import { GithubIcon } from '../../github-icon.tsx';
import { AutoSubmit } from './auto-submit.tsx';

export default async function CreateGithubApp({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const user = await requireUser();
  const { state = '' } = await searchParams;
  if (!/^[A-Za-z0-9_-]{32}$/.test(state)) redirect('/api/github/create-app');
  return (
    <main className="grid place-items-center pt-10">
      <section className="card rise w-full max-w-lg p-6 text-center">
        <span className="sticker mx-auto"><GithubIcon size={26} /></span>
        <h1 className="font-display mt-5 text-3xl leading-none font-extrabold">Weiter zu GitHub …</h1>
        <p className="mt-3 text-sm text-muted">
          Dort auf <strong className="text-ink">Create GitHub App</strong> klicken. Danach wählst du die Repos aus und kommst hierher zurück.
        </p>
        <AutoSubmit action={`https://github.com/settings/apps/new?state=${state}`} manifest={JSON.stringify(manifest(appUrl(), user.name))} />
      </section>
    </main>
  );
}
