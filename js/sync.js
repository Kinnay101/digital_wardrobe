// Konto und Sync zwischen Geräten (Supabase), Ende-zu-Ende-verschlüsselt.
//
// Ablauf:
//  * Jede lokale Änderung kommt in den "Postausgang" (Store outbox).
//  * sync(): erst holen (pull), dann senden (push). Bei Konflikten gewinnt die jüngere Änderung.
//  * Supabase bekommt nur verschlüsselte Daten (payload) und verschlüsselte Fotos.
//
// Das Modul schreibt direkt in die lokale Datenbank und meldet Änderungen per onChange().

import * as db from './db.js';
import * as C from './crypto.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const BUCKET = 'images';
let client = null;
let syncing = null;   // laufende Sync-Promise
let timer = null;
let changeHandler = () => {};
const statusListeners = new Set();

export const status = { signedIn: false, email: '', syncing: false, lastSync: 0, error: '', pending: 0 };

export const available = () => !!(SUPABASE_URL && SUPABASE_KEY);
export const onChange = (fn) => { changeHandler = fn; };
export const onStatus = (fn) => { statusListeners.add(fn); fn(status); return () => statusListeners.delete(fn); };
function setStatus(patch) {
  Object.assign(status, patch);
  statusListeners.forEach((fn) => fn(status));
}

/** Nur für Tests: eigenen (nachgebauten) Supabase-Client setzen. */
export function _useClient(c) { client = c; }

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Sync-Bibliothek konnte nicht geladen werden'));
    document.head.append(s);
  });
}
async function getClient() {
  if (client) return client;
  if (!window.supabase) await loadScript(new URL('../vendor/supabase/supabase.js', import.meta.url).href);
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    // "implicit": Links aus E-Mails (Bestätigen, Passwort vergessen) funktionieren auch, wenn sie in einem
    // anderen Browser geöffnet werden als dem, in dem sie angefordert wurden (z. B. Safari statt Home-Bildschirm-App).
    // Die Tokens aus dem Link liest die App selbst aus (readAuthRedirect), daher detectSessionInUrl: false.
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'implicit', storageKey: 'kleiderschrank-auth' },
  });
  return client;
}

const check = ({ data, error }) => { if (error) throw error; return data; };
const iso = (ms) => new Date(ms).toISOString();
const imagePath = (userId, id) => `${userId}/${id}`;
const backPath = (userId, id) => `${userId}/${id}.back`;

async function downloadImage(c, dek, path, type) {
  const blob = check(await c.storage.from(BUCKET).download(path));
  const bytes = await C.decryptBytes(dek, new Uint8Array(await blob.arrayBuffer()));
  return new Blob([bytes], { type: type || 'image/png' });
}
async function uploadImage(c, dek, path, blob) {
  const enc = await C.encryptBytes(dek, new Uint8Array(await blob.arrayBuffer()));
  check(await c.storage.from(BUCKET).upload(path, new Blob([enc], { type: 'application/octet-stream' }), { upsert: true, contentType: 'application/octet-stream' }));
}

/** Fehlermeldungen von Supabase verständlich machen. */
function explain(err) {
  const m = String(err?.message || err);
  if (/Invalid login credentials/i.test(m)) return new Error('E-Mail oder Passwort falsch.');
  if (/Email not confirmed/i.test(m)) return new Error('Bitte bestätige zuerst deine E-Mail-Adresse (Link im Postfach).');
  if (/rate limit|too many/i.test(m)) return new Error('Zu viele Versuche. Bitte warte ein paar Minuten.');
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return new Error('Keine Verbindung zum Server.');
  return err instanceof Error ? err : new Error(m);
}

/* ---------- Konto ---------- */

/** Neues Konto anlegen. Supabase schickt eine Bestätigungs-E-Mail. */
export async function signUp(email, password) {
  const c = await getClient();
  const secret = await C.authSecret(email, password);
  const redirect = location.origin + location.pathname;
  let data;
  try {
    data = check(await c.auth.signUp({ email: email.trim(), password: secret, options: { emailRedirectTo: redirect } }));
  } catch (err) { throw explain(err); }
  if (data.session) return { ...(await finishSignIn(email, password, data.user.id)), confirmed: true };
  return { confirmed: false };
}

/** Anmelden. Beim allerersten Anmelden wird der Schlüsselbund erzeugt (liefert dann recoveryCode). */
export async function signIn(email, password) {
  const c = await getClient();
  const secret = await C.authSecret(email, password);
  let data;
  try {
    data = check(await c.auth.signInWithPassword({ email: email.trim(), password: secret }));
  } catch (err) { throw explain(err); }
  return finishSignIn(email, password, data.user.id);
}

async function finishSignIn(email, password, userId) {
  const c = await getClient();
  const keyring = check(await c.from('keyring').select('*').maybeSingle());
  let dek;
  let recoveryCode = null;
  if (!keyring) {
    const created = await C.createKeyring(password);
    check(await c.from('keyring').insert({ user_id: userId, ...created.row }));
    dek = created.dek;
    recoveryCode = created.recoveryCode;
  } else {
    try {
      dek = await C.unlockWithPassword(keyring, password);
    } catch {
      await c.auth.signOut();
      throw new Error('Der Schlüssel ließ sich nicht entsperren.');
    }
  }
  await db.setMeta('dek', dek);
  await db.setMeta('account', { email: email.trim(), userId });
  await queueEverything(); // lokale Daten dieses Geräts ins Konto übernehmen
  setStatus({ signedIn: true, email: email.trim(), error: '' });
  attachTriggers();
  sync();
  return { recoveryCode };
}

/* ---------- Passwort vergessen ---------- */

/** Schickt eine E-Mail mit Link zum Zurücksetzen. */
export async function requestPasswordReset(email) {
  const c = await getClient();
  try {
    check(await c.auth.resetPasswordForEmail(email.trim(), { redirectTo: location.origin + location.pathname }));
  } catch (err) { throw explain(err); }
}

/**
 * Liest Anmelde-Infos aus einem E-Mail-Link (#access_token=…&type=recovery bzw. signup).
 * Liefert null, wenn die Adresse keinen solchen Link enthält.
 */
export function readAuthRedirect(hash = location.hash) {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  if (p.get('error_description')) return { error: p.get('error_description').replace(/\+/g, ' ') };
  if (!p.get('access_token')) return null;
  return { type: p.get('type'), access_token: p.get('access_token'), refresh_token: p.get('refresh_token') };
}

/** Neues Passwort festlegen: Wiederherstellungs-Code entsperrt den Daten-Schlüssel, der neu eingepackt wird. */
export async function completeReset(tokens, recoveryCode, newPassword) {
  const c = await getClient();
  let user;
  try {
    user = check(await c.auth.setSession({ access_token: tokens.access_token, refresh_token: tokens.refresh_token })).user;
  } catch (err) {
    throw new Error('Der Link ist abgelaufen oder wurde schon benutzt. Bitte fordere einen neuen an.');
  }
  const keyring = check(await c.from('keyring').select('*').maybeSingle());
  if (!keyring) throw new Error('Für dieses Konto gibt es noch keinen Schlüssel – melde dich einfach mit einem neuen Passwort an.');
  let result;
  try {
    result = await C.recoverAndRewrap(keyring, recoveryCode, newPassword);
  } catch {
    throw new Error('Der Wiederherstellungs-Code ist falsch.');
  }
  // Erst den Schlüsselbund aktualisieren, dann das Anmelde-Passwort. Schlägt der zweite Schritt fehl,
  // lässt sich alles mit demselben Code wiederholen.
  check(await c.from('keyring').update({ ...result.update, updated_at: new Date().toISOString() }).eq('user_id', user.id));
  try {
    check(await c.auth.updateUser({ password: await C.authSecret(user.email, newPassword) }));
  } catch (err) { throw explain(err); }
  await db.setMeta('dek', result.dek);
  await db.setMeta('account', { email: user.email, userId: user.id });
  await queueEverything();
  setStatus({ signedIn: true, email: user.email, error: '' });
  attachTriggers();
  sync();
}

export async function signOut() {
  try { await (await getClient()).auth.signOut(); } catch { /* offline: lokal trotzdem abmelden */ }
  await db.delMeta('dek');
  await db.delMeta('account');
  for (const e of await db.getAll('outbox')) await db.remove('outbox', e.key);
  setStatus({ signedIn: false, email: '', error: '', pending: 0, lastSync: 0 });
}

/** Beim App-Start: angemeldet bleiben, wenn Schlüssel und Sitzung noch da sind. */
export async function init() {
  if (!available()) return;
  const account = await db.getMeta('account');
  const dek = await db.getMeta('dek');
  if (!account || !dek) return;
  setStatus({ signedIn: true, email: account.email, pending: (await db.getAll('outbox')).length });
  attachTriggers();
  sync();
}

/** Automatisch synchronisieren: wieder online, App wieder im Vordergrund, alle 5 Minuten. */
let triggersAttached = false;
function attachTriggers() {
  if (triggersAttached) return;
  triggersAttached = true;
  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 5 * 60 * 1000);
}

/* ---------- Postausgang ---------- */

/**
 * Von der App nach jeder lokalen Änderung aufrufen. kind: 'item' | 'outfit', op: 'put' | 'delete'.
 * image / back: Vorder- bzw. Rückseiten-Foto hat sich geändert und muss hochgeladen (oder entfernt) werden.
 */
export async function markChanged(kind, id, op, { image = false, back = false } = {}) {
  if (!status.signedIn) return;
  const key = `${kind}:${id}`;
  const prev = await db.get('outbox', key);
  await db.put('outbox', { key, kind, id, op, image: image || !!prev?.image, back: back || !!prev?.back, at: Date.now() });
  setStatus({ pending: (await db.getAll('outbox')).length });
  clearTimeout(timer);
  timer = setTimeout(() => sync(), 1500);
}

async function queueEverything() {
  const now = Date.now();
  for (const it of await db.getAll('items')) await db.put('outbox', { key: `item:${it.id}`, kind: 'item', id: it.id, op: 'put', image: true, back: !!it.back, at: it.updatedAt || it.createdAt || now });
  for (const o of await db.getAll('outfits')) await db.put('outbox', { key: `outfit:${o.id}`, kind: 'outfit', id: o.id, op: 'put', image: false, at: o.updatedAt || o.createdAt || now });
}

/* ---------- Sync ---------- */

export function sync() {
  if (!status.signedIn) return Promise.resolve();
  syncing ??= (async () => {
    setStatus({ syncing: true });
    try {
      const dek = await db.getMeta('dek');
      const account = await db.getMeta('account');
      if (!dek || !account) throw new Error('Nicht angemeldet');
      const c = await getClient();
      const { data: { session } } = await c.auth.getSession();
      if (!session) {
        setStatus({ error: 'Sitzung abgelaufen – bitte neu anmelden.' });
        return;
      }
      const changed = (await pull(c, dek, account.userId)) | (await push(c, dek, account.userId));
      setStatus({ lastSync: Date.now(), error: '', pending: (await db.getAll('outbox')).length });
      if (changed) await changeHandler();
    } catch (err) {
      console.warn('Sync fehlgeschlagen', err);
      setStatus({ error: explain(err).message });
    } finally {
      setStatus({ syncing: false });
      syncing = null;
    }
  })();
  return syncing;
}

/** Holt Änderungen anderer Geräte. Liefert true, wenn sich lokal etwas geändert hat. */
async function pull(c, dek, userId) {
  let changed = false;
  for (const [table, store, kind] of [['items', 'items', 'item'], ['outfits', 'outfits', 'outfit']]) {
    const rows = check(await c.from(table).select('id,updated_at,deleted'));
    const wanted = [];
    for (const row of rows) {
      const remoteAt = Date.parse(row.updated_at);
      const local = await db.get(store, row.id);
      const pending = await db.get('outbox', `${kind}:${row.id}`);
      const localAt = pending ? pending.at : local ? local.updatedAt || local.createdAt || 0 : 0;
      if (remoteAt <= localAt) continue;            // lokal gleich oder neuer
      if (pending) await db.remove('outbox', pending.key); // andere Änderung ist jünger -> gewinnt
      if (row.deleted) {
        if (local) { await db.remove(store, row.id); changed = true; }
        continue;
      }
      wanted.push(row.id);
    }
    for (let i = 0; i < wanted.length; i += 50) {
      const chunk = wanted.slice(i, i + 50);
      const full = check(await c.from(table).select('id,payload,updated_at').in('id', chunk));
      for (const row of full) {
        const data = await C.decryptJson(dek, row.payload);
        const updatedAt = Date.parse(row.updated_at);
        if (kind === 'item') {
          const local = await db.get('items', row.id);
          // Vorderseite: neu laden, wenn sie auf dem anderen Gerät ersetzt wurde (imageRev, ältere Teile haben keinen)
          const sameImage = local?.image && (local.imageRev || null) === (data.imageRev || null);
          const image = sameImage ? local.image : await downloadImage(c, dek, imagePath(userId, row.id), data.imageType);
          // Rückseite: nur laden, wenn es eine gibt und sie sich geändert hat (backRev = Zeitpunkt der letzten Änderung)
          let back = null;
          if (data.backRev) {
            back = local?.back && local.backRev === data.backRev ? local.back : await downloadImage(c, dek, backPath(userId, row.id), data.backType);
          }
          const { imageType, backType, ...rest } = data;
          const item = { ...rest, id: row.id, image, updatedAt };
          if (back) item.back = back;
          await db.put('items', item);
        } else {
          await db.put('outfits', { ...data, id: row.id, updatedAt });
        }
        changed = true;
      }
    }
  }
  return changed;
}

/** Schickt den Postausgang. */
async function push(c, dek, userId) {
  for (const e of await db.getAll('outbox')) {
    const table = e.kind === 'item' ? 'items' : 'outfits';
    if (e.op === 'delete') {
      const row = { id: e.id, payload: null, deleted: true, updated_at: iso(e.at) };
      if (e.kind === 'item') row.has_image = false;
      check(await c.from(table).upsert(row));
      if (e.kind === 'item') await c.storage.from(BUCKET).remove([imagePath(userId, e.id), backPath(userId, e.id)]);
    } else if (e.kind === 'item') {
      const it = await db.get('items', e.id);
      if (it) {
        if (e.image) await uploadImage(c, dek, imagePath(userId, it.id), it.image);
        if (e.back) {
          if (it.back) await uploadImage(c, dek, backPath(userId, it.id), it.back);
          else await c.storage.from(BUCKET).remove([backPath(userId, it.id)]);
        }
        const { id, image, back, updatedAt, ...meta } = it;
        const payload = await C.encryptJson(dek, { ...meta, imageType: image.type, ...(back ? { backType: back.type } : { backRev: null }) });
        check(await c.from('items').upsert({ id, payload, has_image: true, deleted: false, updated_at: iso(updatedAt || it.createdAt) }));
      }
    } else {
      const o = await db.get('outfits', e.id);
      if (o) {
        const { id, updatedAt, ...data } = o;
        const payload = await C.encryptJson(dek, data);
        check(await c.from('outfits').upsert({ id, payload, deleted: false, updated_at: iso(updatedAt || o.createdAt) }));
      }
    }
    // Nur entfernen, wenn sich der Eintrag während des Hochladens nicht geändert hat
    const cur = await db.get('outbox', e.key);
    if (cur && cur.at === e.at) await db.remove('outbox', e.key);
  }
  return false;
}
