// Ende-zu-Ende-Verschlüsselung für den Sync (nur Web Crypto API des Browsers, keine Fremd-Bibliothek).
//
// Aufbau:
//  * Daten-Schlüssel (DEK): zufälliger AES-256-GCM-Schlüssel, verschlüsselt alle Daten und Fotos.
//  * Aus dem Passwort werden mit PBKDF2 zwei UNABHÄNGIGE Werte abgeleitet:
//      - authSecret: dient als Passwort bei Supabase. Supabase sieht nie dein echtes Passwort.
//      - KEK: "packt" den Daten-Schlüssel ein. Wird nie übertragen.
//  * Wiederherstellungs-Code: packt den Daten-Schlüssel ein zweites Mal ein, falls das Passwort
//    vergessen wird. Wird nur einmal angezeigt und nirgends gespeichert.
// Supabase speichert nur eingepackte Schlüssel und verschlüsselte Daten.

const enc = new TextEncoder();
const dec = new TextDecoder();
export const PASSWORD_ITERATIONS = 600000; // Empfehlung OWASP 2023 für PBKDF2-SHA256
const RECOVERY_ITERATIONS = 100000;         // Code ist zufällig und lang, weniger Runden genügen

/* ---------- Hilfen ---------- */
export function toB64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

async function pbkdf2(secret, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
}
async function wrappingKey(secret, salt, iterations) {
  const bits = await pbkdf2(secret, salt, iterations);
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['wrapKey', 'unwrapKey']);
}

/* ---------- Anmelde-Geheimnis ---------- */
/** Wird statt des echten Passworts an Supabase geschickt. Salt aus der E-Mail, damit es auf jedem Gerät gleich ist. */
export async function authSecret(email, password) {
  const salt = enc.encode('kleiderschrank/auth/v1:' + email.trim().toLowerCase());
  return toB64(await pbkdf2(password, salt, PASSWORD_ITERATIONS));
}

/* ---------- Schlüsselbund ---------- */
async function wrap(dek, secret, salt, iterations) {
  const iv = randomBytes(12);
  const wrapped = await crypto.subtle.wrapKey('raw', dek, await wrappingKey(secret, salt, iterations), { name: 'AES-GCM', iv });
  return toB64(concat(iv, new Uint8Array(wrapped)));
}
async function unwrap(wrappedB64, secret, salt, iterations, extractable = false) {
  const data = fromB64(wrappedB64);
  return crypto.subtle.unwrapKey(
    'raw', data.subarray(12), await wrappingKey(secret, salt, iterations),
    { name: 'AES-GCM', iv: data.subarray(0, 12) }, 'AES-GCM', extractable, ['encrypt', 'decrypt'],
  );
}

/** Lesbarer Wiederherstellungs-Code, z. B. "K7QX-2MNP-…" (Base32 ohne verwechselbare Zeichen, 120 Bit). */
function newRecoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(24);
  const chars = [...bytes].map((b) => alphabet[b & 31]).join('');
  return chars.match(/.{4}/g).join('-');
}
const normalizeCode = (code) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Neues Konto: Daten-Schlüssel erzeugen und zweimal einpacken. Liefert Schlüsselbund-Zeile + Code. */
export async function createKeyring(password) {
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const kdfSalt = randomBytes(16);
  const recoverySalt = randomBytes(16);
  const recoveryCode = newRecoveryCode();
  const row = {
    kdf_salt: toB64(kdfSalt),
    kdf_iterations: PASSWORD_ITERATIONS,
    wrapped_key: await wrap(dek, password, kdfSalt, PASSWORD_ITERATIONS),
    recovery_salt: toB64(recoverySalt),
    wrapped_key_recovery: await wrap(dek, normalizeCode(recoveryCode), recoverySalt, RECOVERY_ITERATIONS),
  };
  return { row, recoveryCode, dek: await reimport(dek) };
}

/** Daten-Schlüssel mit dem Passwort auspacken (falsches Passwort -> Fehler). */
export function unlockWithPassword(row, password) {
  return unwrap(row.wrapped_key, password, fromB64(row.kdf_salt), row.kdf_iterations);
}

/** Mit Wiederherstellungs-Code auspacken und gleich mit neuem Passwort neu einpacken. */
export async function recoverAndRewrap(row, recoveryCode, newPassword) {
  const dek = await unwrap(row.wrapped_key_recovery, normalizeCode(recoveryCode), fromB64(row.recovery_salt), RECOVERY_ITERATIONS, true);
  const kdfSalt = randomBytes(16);
  const update = {
    kdf_salt: toB64(kdfSalt),
    kdf_iterations: PASSWORD_ITERATIONS,
    wrapped_key: await wrap(dek, newPassword, kdfSalt, PASSWORD_ITERATIONS),
  };
  return { update, dek: await reimport(dek) };
}

/** Schlüssel als "nicht exportierbar" neu anlegen: Er kann dann auf dem Gerät gespeichert, aber nie ausgelesen werden. */
async function reimport(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/* ---------- Ver- und Entschlüsseln ---------- */
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
export async function encryptBytes(dek, bytes) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, bytes);
  return concat(iv, new Uint8Array(ct));
}
export async function decryptBytes(dek, data) {
  const u = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, dek, u.subarray(12)));
}
export async function encryptJson(dek, obj) {
  return toB64(await encryptBytes(dek, enc.encode(JSON.stringify(obj))));
}
export async function decryptJson(dek, b64) {
  return JSON.parse(dec.decode(await decryptBytes(dek, fromB64(b64))));
}
