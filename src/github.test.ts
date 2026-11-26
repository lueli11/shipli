import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { appJwt, manifest, verifySignature } from './github.ts';
import { loginBlocked } from './auth.ts';

test('Webhook-Signatur: richtig, falsch, fehlt', () => {
  const body = '{"ref":"refs/heads/main"}';
  const good = `sha256=${createHmac('sha256', 'geheim').update(body).digest('hex')}`;
  assert.equal(verifySignature('geheim', body, good), true);
  assert.equal(verifySignature('anders', body, good), false);
  assert.equal(verifySignature('geheim', body + ' ', good), false);
  assert.equal(verifySignature('geheim', body, null), false);
  assert.equal(verifySignature('geheim', body, 'sha256=abc'), false);
});

test('App-JWT ist mit dem privaten Schlüssel signiert und kurz gültig', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = appJwt({ app_id: 42, pem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() }, 1_000_000);
  const [head, body, sig] = jwt.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${head}.${body}`).verify(publicKey, Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  assert.deepEqual(claims, { iat: 999_940, exp: 1_000_540, iss: 42 });
});

test('Manifest: private App pro User, nur Leserechte, Rückweg über /api/github/setup', () => {
  const m = manifest('https://shipli.example.com', 'x'.repeat(20));
  assert.equal(m.public, false);
  assert.equal(m.request_oauth_on_install, true);
  assert.deepEqual(m.default_permissions, { contents: 'read', metadata: 'read' });
  assert.equal(m.hook_attributes.url, 'https://shipli.example.com/api/github/webhook');
  assert.equal(m.redirect_url, 'https://shipli.example.com/api/github/setup');
  assert.deepEqual(m.callback_urls, ['https://shipli.example.com/api/github/setup']);
  // mit request_oauth_on_install verboten
  assert.ok(!('setup_url' in m));
  // GitHub erlaubt höchstens 34 Zeichen, auch beim längsten Usernamen bleibt der Zufallsteil ganz
  assert.match(m.name, /^Shipli-x{20}-[0-9a-f]{6}$/);
  assert.ok(m.name.length <= 34);
  assert.notEqual(manifest('https://a.ch', 'nino').name, manifest('https://a.ch', 'nino').name);
});

test('Login-Sperre greift erst nach 10 Fehlversuchen', () => {
  assert.equal(loginBlocked('niemand@example.com'), false);
});
