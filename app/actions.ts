'use server';

import { after } from 'next/server';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { acceptInvite, changePassword, createApiToken, createInvite, deleteSession, login, revokeApiToken } from '../src/auth.ts';
import { refresh } from 'next/cache';
import { createProject, deleteAccount, deleteProject, removeVolume, setEnv, setVolume, startDeploy, unsetEnv } from '../src/projects.ts';
import { addDomains, googleFileFromContent, normalizeDomain, removeDomain, setGoogleVerification, setPrimaryDomain, withWww } from '../src/domains.ts';
import { setLimits } from '../src/limits.ts';
import { usage } from '../src/metrics.ts';
import { notFound } from 'next/navigation';
import { requireUser, sessionToken, setSessionCookie, takeSessionCookie } from './session.ts';

const field = (form: FormData, name: string) => String(form.get(name) ?? '');
// section: Fehler erscheint beim Formular statt oben, value: Eingabe bleibt stehen
const withError = (path: string, err: unknown, section?: string, value?: string): never => {
  const q = new URLSearchParams({ error: (err as Error).message });
  if (section) q.set('in', section);
  if (value) q.set('value', value);
  return redirect(`${path}?${q}${section ? `#${section}` : ''}`);
};

export async function loginAction(form: FormData) {
  let token: string | undefined;
  try {
    token = await login(field(form, 'email'), field(form, 'password'), (await headers()).get('x-real-ip') ?? undefined);
  } catch (err) {
    return withError('/login', err);
  }
  if (!token) return withError('/login', new Error('E-Mail oder Passwort falsch'));
  await setSessionCookie(token);
  redirect('/');
}

export async function logoutAction() {
  const token = await takeSessionCookie();
  if (token) await deleteSession(token);
  redirect('/login');
}

export async function acceptInviteAction(form: FormData) {
  const token = field(form, 'token');
  let session: string;
  try {
    session = await acceptInvite(token, field(form, 'password'));
  } catch (err) {
    return withError(`/invite/${encodeURIComponent(token)}`, err);
  }
  await setSessionCookie(session);
  redirect('/');
}

export async function createProjectAction(form: FormData) {
  const user = await requireUser();
  let id: number;
  try {
    id = await createProject(user, field(form, 'name'), field(form, 'repo'));
  } catch (err) {
    return withError('/', err);
  }
  redirect(`/projects/${id}`);
}

export async function deployAction(form: FormData) {
  const user = await requireUser();
  const projectId = Number(field(form, 'projectId'));
  let deployment: Awaited<ReturnType<typeof startDeploy>>;
  try {
    deployment = await startDeploy(user, projectId);
  } catch (err) {
    return withError(`/projects/${projectId}`, err);
  }
  // shortcut: der Build läuft im Prozess von Next.js; startet der Server neu, bleibt er als "building" stehen (räumt startDeploy nach 20 min auf). Mit mehreren Replikas eine Queue einführen.
  after(deployment.run);
  redirect(`/projects/${projectId}?deployment=${deployment.id}`);
}

export async function setEnvAction(form: FormData) {
  const user = await requireUser();
  const projectId = Number(field(form, 'projectId'));
  try {
    await setEnv(user.id, projectId, field(form, 'key').trim(), field(form, 'value'));
  } catch (err) {
    return withError(`/projects/${projectId}`, err, 'env');
  }
  redirect(`/projects/${projectId}?saved=env`);
}

export async function setVolumeAction(form: FormData) {
  const user = await requireUser();
  const projectId = Number(field(form, 'projectId'));
  try {
    await setVolume(user.id, projectId, field(form, 'path').trim(), Math.round(Number(field(form, 'size').replace(',', '.')) * 1024));
  } catch (err) {
    return withError(`/projects/${projectId}`, err, 'ordner');
  }
  redirect(`/projects/${projectId}?saved=ordner#ordner`);
}

export async function removeVolumeAction(form: FormData) {
  const user = await requireUser();
  const projectId = Number(field(form, 'projectId'));
  try {
    await removeVolume(user.id, projectId, field(form, 'confirm'));
  } catch (err) {
    return withError(`/projects/${projectId}`, err, 'ordner');
  }
  redirect(`/projects/${projectId}?saved=ordner#ordner`);
}

export async function unsetEnvAction(form: FormData) {
  const user = await requireUser();
  const projectId = Number(field(form, 'projectId'));
  await unsetEnv(user.id, projectId, field(form, 'key'));
  redirect(`/projects/${projectId}?saved=env`);
}

export async function addDomainAction(form: FormData) {
  const user = await requireUser();
  const projectId = Number(field(form, 'projectId'));
  const name = normalizeDomain(field(form, 'domain'));
  try {
    await addDomains(user.id, projectId, form.get('www') ? withWww(name) : [name]);
  } catch (err) {
    return withError(`/projects/${projectId}`, err, 'domains', name);
  }
  redirect(`/projects/${projectId}#domains`);
}

export async function primaryDomainAction(form: FormData) {
  const user = await requireUser();
  const projectId = Number(field(form, 'projectId'));
  try {
    await setPrimaryDomain(user, projectId, Number(field(form, 'domainId')));
  } catch (err) {
    return withError(`/projects/${projectId}`, err, 'domains');
  }
  redirect(`/projects/${projectId}#domains`);
}

export async function removeDomainAction(form: FormData) {
  const user = await requireUser();
  const projectId = Number(field(form, 'projectId'));
  try {
    await removeDomain(user, projectId, Number(field(form, 'domainId')));
  } catch (err) {
    return withError(`/projects/${projectId}`, err, 'domains');
  }
  redirect(`/projects/${projectId}#domains`);
}

export async function googleAction(form: FormData) {
  const user = await requireUser();
  const projectId = Number(field(form, 'projectId'));
  const upload = form.get('file');
  try {
    let name = '';
    if (!form.get('remove')) {
      if (!(upload instanceof File) || !upload.size) throw new Error('Zuerst die heruntergeladene Datei auswählen');
      if (upload.size > 1024) throw new Error('Die Datei ist zu gross für eine Datei aus der Search Console');
      name = googleFileFromContent(await upload.text());
    }
    await setGoogleVerification(user, projectId, name);
  } catch (err) {
    return withError(`/projects/${projectId}`, err, 'google');
  }
  redirect(`/projects/${projectId}?saved=${form.get('remove') ? 'google-weg' : 'google'}#google`);
}

export async function deleteProjectAction(form: FormData) {
  const user = await requireUser();
  const projectId = Number(field(form, 'projectId'));
  try {
    await deleteProject(user, projectId, field(form, 'confirm'));
  } catch (err) {
    return withError(`/projects/${projectId}`, err, 'loeschen');
  }
  redirect('/');
}

export async function changePasswordAction(form: FormData) {
  const user = await requireUser();
  try {
    if (field(form, 'next') !== field(form, 'repeat')) throw new Error('Die neuen Passwörter stimmen nicht überein');
    await changePassword(user, field(form, 'current'), field(form, 'next'), (await sessionToken())!);
  } catch (err) {
    return withError('/konto', err);
  }
  redirect('/konto?saved=pw');
}

export async function deleteAccountAction(form: FormData) {
  const user = await requireUser();
  try {
    await deleteAccount(user, field(form, 'password'), field(form, 'confirm'));
  } catch (err) {
    return withError('/konto', err);
  }
  await takeSessionCookie();
  redirect('/login?deleted=1');
}

export async function setLimitsAction(form: FormData) {
  const admin = await requireUser();
  if (!admin.is_admin) notFound();
  const userId = Number(field(form, 'userId'));
  const num = (name: string, factor: number) => Math.round(Number(field(form, name).replace(',', '.')) * factor);
  const limits = { cpu_limit: num('cpu', 1000), memory_limit: num('memory', 1024), storage_limit: num('storage', 1024), max_projects: num('projects', 1), volume_limit: num('volume', 1024) };
  let warn = '';
  try {
    await setLimits(userId, limits);
    // laufende Pods bleiben, aber der nächste Rollout scheitert an der Quota
    const [u] = await usage(userId);
    const over = [
      u.memory > limits.memory_limit * 2 ** 20 && 'RAM',
      u.storage > limits.storage_limit * 2 ** 20 && 'Speicher',
      u.projects > limits.max_projects && 'Projekte',
      u.volume > limits.volume_limit * 2 ** 20 && 'Ordner',
    ].filter(Boolean);
    if (over.length) warn = `${over.join(', ')} schon jetzt über der neuen Grenze. Laufende Apps bleiben, der nächste Deploy scheitert.`;
  } catch (err) {
    return withError('/admin', err, `u${userId}`);
  }
  const q = new URLSearchParams({ saved: String(userId), ...(warn && { warn }) });
  redirect(`/admin?${q}#u${userId}`);
}

export type TokenState = { token?: string; error?: string };

/** Ohne Redirect: der Token geht nur in die Antwort dieser Action, nie in eine URL oder den Verlauf. */
export async function createTokenAction(_prev: TokenState, form: FormData): Promise<TokenState> {
  const user = await requireUser();
  try {
    const token = await createApiToken(user.id, field(form, 'name'));
    refresh();
    return { token };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export type InviteState = { link?: string; error?: string };

/** Wie beim Token ohne Redirect: der Einladungslink soll nicht in Verlauf oder Logs landen. */
export async function createInviteAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  const admin = await requireUser();
  if (!admin.is_admin) notFound();
  try {
    const token = await createInvite(field(form, 'email'), field(form, 'name').trim(), form.get('admin') === 'on');
    return { link: `${process.env.SHIPLI_APP_URL ?? 'http://localhost:3000'}/invite/${token}` };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function revokeTokenAction(form: FormData) {
  const user = await requireUser();
  await revokeApiToken(user.id, Number(field(form, 'tokenId')));
  redirect('/konto?saved=token#tokens');
}
