'use client';

import { useActionState } from 'react';
import { createTokenAction, type TokenState } from '../actions.ts';
import { Connect } from '../connect.tsx';
import { CopyButton } from '../copy-button.tsx';
import { ErrorBox } from '../error-box.tsx';
import { Submit } from '../submit.tsx';

export function TokenForm({ url }: { url: string }) {
  const [state, action] = useActionState<TokenState, FormData>(createTokenAction, {});
  return (
    <>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="field min-w-44 flex-1"><span>Name, z. B. laptop-claude</span>
          <input name="name" required maxLength={40} autoComplete="off" spellCheck={false} />
        </label>
        <Submit className="btn-primary" busy="Wird erzeugt …">Token erzeugen</Submit>
      </form>
      <div className="mt-3"><ErrorBox error={state.error} /></div>
      {state.token && (
        <div className="mt-2 grid gap-4">
          <p className="notice-warn" role="status">Der Token wird nur jetzt angezeigt. Kopiere ihn oder einen der Befehle unten, bevor du die Seite verlässt.</p>
          <div className="flex flex-wrap items-center gap-3">
            <code className="log min-w-0 flex-1 py-2">{state.token}</code>
            <CopyButton text={state.token} />
          </div>
          <Connect url={url} token={state.token} />
        </div>
      )}
    </>
  );
}
