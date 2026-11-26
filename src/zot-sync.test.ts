import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { buildAccounts, dockerConfig, passwordFromDockerConfig } from './zot-sync.ts';

const system = { release: 'r'.repeat(10), puller: 'p'.repeat(10) };

test('zot-Konten: Rechte pro User, Passwörter bleiben, htpasswd stabil', async () => {
  const first = await buildAccounts(['nino'], new Map(), system);
  const pw = first.passwords.get('nino')!;
  const line = first.htpasswd.split('\n').find((l) => l.startsWith('u-nino:'))!;
  assert.ok(await bcrypt.compare(pw, line.slice('u-nino:'.length)));
  const repos = JSON.parse(first.config).http.accessControl.repositories;
  assert.deepEqual(repos['nino/**'].policies[0], { users: ['u-nino'], actions: ['read', 'create', 'update'] });
  assert.deepEqual(repos['shipli/**'].policies[0].users, ['release'], 'shipli/** bleibt nur für release');

  const again = await buildAccounts(['nino', 'lea'], new Map([['nino', pw]]), system, first.htpasswd);
  assert.equal(again.passwords.get('nino'), pw);
  assert.ok(again.htpasswd.includes(line), 'unveränderte Zeile bleibt, sonst lädt zot bei jedem Durchlauf neu');
  assert.ok(again.htpasswd.includes('u-lea:'));

  const removed = await buildAccounts([], new Map(), system, again.htpasswd);
  assert.ok(!removed.htpasswd.includes('u-nino') && !JSON.parse(removed.config).http.accessControl.repositories['nino/**']);
});

test('zot-Konten: kaputte Namen aus der DB brechen ab', async () => {
  for (const bad of ['shipli', 'Nino', 'a/b', '../x', 'x"}']) await assert.rejects(buildAccounts([bad], new Map(), system), bad);
});

test('Push-Secret: Passwort kommt wieder heraus', () => {
  assert.equal(passwordFromDockerConfig(dockerConfig('zot:5000', 'nino', 'geheim')), 'geheim');
});
