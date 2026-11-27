'use client';

import { useActionState } from 'react';
import { createInviteAction, type InviteState } from '../actions.ts';
import { CopyButton } from '../copy-button.tsx';
import { ErrorBox } from '../error-box.tsx';
import { Submit } from '../submit.tsx';

export function InviteForm() {
  const [state, action] = useActionState<InviteState, FormData>(createInviteAction, {});
  return (
    <section className="card grid gap-3 p-4">
      <h2 className="font-display text-lg font-extrabold">Einladen</h2>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="field min-w-52 flex-1"><span>E-Mail</span><input name="email" type="email" required autoComplete="off" /></label>
        <label className="field min-w-40 flex-1"><span>Username</span>
          <input name="name" required maxLength={40} pattern="[A-Za-z0-9]+(-[A-Za-z0-9]+)*" autoComplete="off" spellCheck={false} />
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm"><input name="admin" type="checkbox" /> Admin</label>
        <Submit className="btn-primary" busy="Wird erzeugt …">Link erzeugen</Submit>
      </form>
      <ErrorBox error={state.error} />
      {state.link && (
        <div className="grid gap-2">
          <p className="notice-ok" role="status">Link 7 Tage gültig und nur einmal einlösbar. Schick ihn der Person selbst, Shipli verschickt keine Mails.</p>
          <div className="flex flex-wrap items-center gap-3">
            <code className="log min-w-0 flex-1 py-2">{state.link}</code>
            <CopyButton text={state.link} />
          </div>
        </div>
      )}
    </section>
  );
}
