// Verbindung zum Sync-Dienst (Supabase).
// Beides darf öffentlich sein: Der "publishable key" ist für Browser-Apps gedacht. Die Sicherheit
// kommt von Row Level Security (jedes Konto sieht nur seine Zeilen) und der Ende-zu-Ende-Verschlüsselung.
// NIEMALS hier einen "secret"- oder "service_role"-Key eintragen.
// Leer lassen = App läuft ohne Konto/Sync.
export const SUPABASE_URL = 'https://adgbntfsihgzzwrngadf.supabase.co';
export const SUPABASE_KEY = 'sb_publishable__Kw61ywelROam7y1TQlgWg_cEaqTtN8';
