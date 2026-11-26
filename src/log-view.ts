// Normale Ansicht des Build-Logs wie bei Coolify: Schritte und Fehler, den Rest nur im Debug-Modus.
// Eigene Datei ohne Server-Importe, weil die Seite sie im Browser braucht.
const STEP = '▸ ';
const FAIL = '✖ ';
const ERROR = /\berror\b|failed to|did not complete successfully/i;
const CONTEXT = 30;

export function summarizeLog(log: string): { text: string; hidden: number } {
  const lines = log.split('\n');
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.startsWith(STEP) || l.startsWith(FAIL) || ERROR.test(l)) keep.add(i);
    // bei einem Fehlschlag die Rohzeilen davor zeigen, sonst sieht man die Ursache nicht
    if (l.startsWith(FAIL)) for (let j = Math.max(0, i - CONTEXT); j < i; j++) keep.add(j);
  });
  const shown = lines.filter((l, i) => keep.has(i) && l.trim());
  return { text: shown.join('\n'), hidden: lines.filter((l) => l.trim()).length - shown.length };
}
