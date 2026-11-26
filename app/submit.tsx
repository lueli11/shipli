'use client';

import type { ComponentProps } from 'react';
import { useFormStatus } from 'react-dom';

/** Absenden-Knopf, der während der Server-Action gesperrt ist und zeigt, dass etwas läuft. */
export function Submit({ busy, children, ...props }: ComponentProps<'button'> & { busy?: string }) {
  const { pending } = useFormStatus();
  return (
    <button {...props} disabled={pending} aria-busy={pending}>
      {pending && busy ? busy : children}
    </button>
  );
}
