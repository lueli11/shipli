import { inviteByToken } from '../../../src/auth.ts';
import { acceptInviteAction } from '../../actions.ts';
import { ErrorBox } from '../../error-box.tsx';
import { AuthCard } from '../../auth-card.tsx';
import { Submit } from '../../submit.tsx';

export default async function Invite(props: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await props.params;
  const { error } = await props.searchParams;
  const invite = await inviteByToken(token);
  if (!invite) {
    return <AuthCard subtitle="Einladung ungültig"><p className="text-sm text-muted">Der Link ist abgelaufen oder wurde schon benutzt.</p></AuthCard>;
  }
  return (
    <AuthCard subtitle={<>Willkommen, {invite.name}</>}>
      <form action={acceptInviteAction} className="space-y-4">
        <p className="text-sm text-muted">Lege ein Passwort für {invite.email} fest.</p>
        <input type="hidden" name="token" value={token} />
        {/* damit der Passwort-Manager das Passwort der richtigen E-Mail zuordnet */}
        <input type="email" name="username" autoComplete="username" value={invite.email} readOnly hidden />
        <label className="field"><span>Passwort (mindestens 10 Zeichen)</span><input name="password" type="password" autoComplete="new-password" minLength={10} required autoFocus /></label>
        <ErrorBox error={error} />
        <Submit className="btn-primary w-full" busy="Wird angelegt …">Konto anlegen</Submit>
      </form>
    </AuthCard>
  );
}
