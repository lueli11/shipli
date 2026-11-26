import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLog } from './log-view.ts';
import { FAIL, STEP } from './deploy.ts';

test('Normale Log-Ansicht: Schritte und Fehler, Rauschen weg', () => {
  const log = [`${STEP}Commit abc`, 'fetch 1', '#5 writing layer sha256:1', '', `${STEP}Läuft`].join('\n');
  assert.deepEqual(summarizeLog(log), { text: `${STEP}Commit abc\n${STEP}Läuft`, hidden: 2 });
});

test('Bei einem Fehlschlag kommen die Zeilen davor mit', () => {
  const raw = Array.from({ length: 50 }, (_, i) => `zeile ${i}`);
  const log = [`${STEP}Image bauen`, ...raw, 'ERROR: failed to solve', `${FAIL}Build fehlgeschlagen`].join('\n');
  const { text } = summarizeLog(log);
  assert.ok(text.includes('ERROR: failed to solve'));
  assert.ok(text.includes('zeile 49') && text.includes('zeile 21') && !text.includes('zeile 19'));
  assert.ok(text.startsWith(`${STEP}Image bauen`));
});
