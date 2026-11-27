import { getRegistration } from '../../src/auth.ts';
import { loginAction } from '../actions.ts';
import { ErrorBox } from '../error-box.tsx';
import { AuthCard } from '../auth-card.tsx';
import { Submit } from '../submit.tsx';

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; deleted?: string }> }) {
  const { error, deleted } = await searchParams;
  const canRegister = (await getRegistration()) !== 'invite';
  return (
    <AuthCard subtitle="Push. Build. Läuft.">
      {deleted && <p className="notice-ok" role="status">Dein Konto ist gelöscht.</p>}
      <form action={loginAction} className="space-y-4">
        <label className="field"><span>E-Mail</span><input name="email" type="email" autoComplete="email" required autoFocus /></label>
        <label className="field"><span>Passwort</span><input name="password" type="password" autoComplete="current-password" required /></label>
        <ErrorBox error={error} />
        <Submit className="btn-primary w-full" busy="Melde an …">Anmelden</Submit>
      </form>
      {canRegister && <a className="btn w-full" href="/registrieren">Registrieren</a>}
    </AuthCard>
  );
}
