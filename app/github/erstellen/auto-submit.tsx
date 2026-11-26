'use client';

import { useEffect, useRef } from 'react';

// GitHub will das Manifest als POST-Formular; ohne JavaScript bleibt der Knopf
export function AutoSubmit({ action, manifest }: { action: string; manifest: string }) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => form.current?.submit(), []);
  return (
    <form ref={form} method="post" action={action} className="mt-6">
      <input type="hidden" name="manifest" value={manifest} />
      <button className="btn-primary">Weiter zu GitHub</button>
    </form>
  );
}
