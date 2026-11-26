'use client';

import { useState } from 'react';

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ohne HTTPS (z. B. lokal über die IP) gibt es keine Clipboard-API
      const area = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button type="button" className="btn btn-sm" onClick={copy} aria-live="polite">
      {done ? 'Kopiert ✓' : 'Kopieren'}
    </button>
  );
}
