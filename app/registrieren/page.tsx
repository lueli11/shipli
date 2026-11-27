import { getRegistration } from '../../src/auth.ts';
import { registerAction } from '../actions.ts';
import { ErrorBox } from '../error-box.tsx';
import { AuthCard } from '../auth-card.tsx';
import { Submit } from '../submit.tsx';

export default async function Registrieren({ searchParams }: { searchParams: Promise<{ error?: string; sent?: string }> }) {
  const { error, sent } = await searchParams;
  const mode = await getRegistration();
  if (mode === 'invite') {
    return (
      <AuthCard subtitle="Nur auf Einladung">
        <p className="text-sm text-muted">Neue Konten gibt es nur per Einladungslink vom Admin.</p>
        <a className="link text-sm" href="/login">Zurück zum Login</a>
      </AuthCard>
    );
  }
  if (sent) {
    return (
      <AuthCard subtitle="Fast fertig">
        <p className="notice-ok" role="status">Wir haben dir einen Link geschickt. Öffne ihn und lege dein Passwort fest; er gilt 7 Tage.</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard subtitle="Konto anlegen">
      <form action={registerAction} className="space-y-4">
        <label className="field"><span>E-Mail</span><input name="email" type="email" autoComplete="email" required autoFocus /></label>
        <label className="field"><span>Username</span>
          <input name="name" autoComplete="username" required maxLength={40} pattern="[A-Za-z0-9]+(-[A-Za-z0-9]+)*" spellCheck={false} />
        </label>
        {mode === 'open' && (
          <label className="field"><span>Passwort (mindestens 10 Zeichen)</span><input name="password" type="password" autoComplete="new-password" minLength={10} required /></label>
        )}
        <ErrorBox error={error} />
        <Submit className="btn-primary w-full" busy="Wird angelegt …">{mode === 'email' ? 'Link per Mail schicken' : 'Konto anlegen'}</Submit>
        <p className="text-center text-sm text-muted">Schon ein Konto? <a className="link" href="/login">Anmelden</a></p>
      </form>
    </AuthCard>
  );
}
