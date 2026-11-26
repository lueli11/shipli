import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { acceptInvite, changePassword, createFirstAdmin, createInvite, hashPassword, inviteByToken, login, userBySession, verifyPassword } from './auth.ts';
import { createProject, getDeployment, getProject, listProjects, startDeploy } from './projects.ts';
import { sql } from './db.ts';

const db = { skip: !process.env.DATABASE_URL && 'DATABASE_URL fehlt' };
const suffix = randomBytes(3).toString('hex');
after(async () => {
  await sql`DELETE FROM users WHERE name LIKE ${'t' + suffix + '%'}`;
  await sql`DELETE FROM invites WHERE name LIKE ${'t' + suffix + '%'}`;
  await sql.end();
});

async function newUser(tag: string) {
  const name = `t${suffix}-${tag}`;
  const session = await acceptInvite(await createInvite(`${name}@example.com`, name), 'langes-passwort');
  return (await userBySession(session))!;
}

test('Erster Admin nur, solange es keinen User gibt', db, async () => {
  await newUser('vorher');
  assert.equal(await createFirstAdmin(`t${suffix}-admin@example.com`, `t${suffix}-admin`, 'start-passwort'), false);
  assert.equal((await sql`SELECT 1 FROM users WHERE name = ${`t${suffix}-admin`}`).length, 0);
});

test('Passwort-Hash prüft richtig', async () => {
  const hash = await hashPassword('richtig-horse');
  assert.equal(await verifyPassword('richtig-horse', hash), true);
  assert.equal(await verifyPassword('falsch-horse', hash), false);
});

test('Einladung gilt nur einmal, Login danach mit Passwort', db, async () => {
  const name = `t${suffix}-once`;
  const token = await createInvite(`${name}@example.com`, name);
  await assert.rejects(acceptInvite(token, 'kurz'), /mindestens/);
  await acceptInvite(token, 'langes-passwort');
  assert.equal(await inviteByToken(token), undefined);
  await assert.rejects(acceptInvite(token, 'langes-passwort'), /ungültig/);
  assert.ok(await login(`${name}@EXAMPLE.com`, 'langes-passwort'));
  assert.equal(await login(`${name}@example.com`, 'falsches-passwort'), undefined);
});

test('User sieht und deployt keine fremden Projekte', db, async () => {
  const [a, b] = [await newUser('a'), await newUser('b')];
  const id = await createProject(a, 'blog', 'https://github.com/lueli11/webseite');
  assert.equal((await listProjects(b.id)).length, 0);
  assert.equal(await getProject(b.id, id), undefined);
  await assert.rejects(startDeploy(b, id), /nicht gefunden/);
  const [{ id: dep }] = await sql<{ id: number }[]>`INSERT INTO deployments (project_id) VALUES (${id}) RETURNING id`;
  assert.equal(await getDeployment(b.id, dep), undefined);
  assert.ok(await getDeployment(a.id, dep));
  await assert.rejects(startDeploy(a, id), /läuft schon/);
});

test('Passwort ändern: altes nötig, andere Geräte abgemeldet, eigene Session bleibt', db, async () => {
  const name = `t${suffix}-pw`;
  const email = `${name}@example.com`;
  const mine = await acceptInvite(await createInvite(email, name), 'altes-passwort');
  const other = (await login(email, 'altes-passwort'))!;
  const user = (await userBySession(mine))!;
  await assert.rejects(changePassword(user, 'falsches-pw', 'neues-passwort', mine), /falsch/);
  await assert.rejects(changePassword(user, 'altes-passwort', 'kurz', mine), /mindestens/);
  await changePassword(user, 'altes-passwort', 'neues-passwort', mine);
  assert.ok(await userBySession(mine));
  assert.equal(await userBySession(other), undefined);
  assert.equal(await login(email, 'altes-passwort'), undefined);
  assert.ok(await login(email, 'neues-passwort'));
});

test('Login-Sperre pro IP: viele E-Mails von derselben IP', db, async () => {
  const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
  for (let i = 0; i < 30; i++) assert.equal(await login(`t${suffix}-spray${i}@example.com`, 'falsch-falsch', ip), undefined);
  await assert.rejects(login(`t${suffix}-spray-neu@example.com`, 'egal-egal', ip), /Zu viele/);
  // andere IP ist nicht betroffen
  assert.equal(await login(`t${suffix}-spray-neu@example.com`, 'egal-egal', '198.51.100.7'), undefined);
});
