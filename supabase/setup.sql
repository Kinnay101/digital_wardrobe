-- Kleiderschrank: Datenbank-Setup für Supabase
-- Einmal im Supabase-Dashboard unter "SQL Editor" ausführen.
--
-- Grundsatz: Supabase speichert nur VERSCHLÜSSELTE Daten. Namen, Kategorien, Farben und
-- Fotos werden auf dem Gerät mit AES-256-GCM verschlüsselt, bevor sie hochgeladen werden.
-- Der Schlüssel verlässt das Gerät nie unverschlüsselt.
-- Row Level Security sorgt zusätzlich dafür, dass jedes Konto nur seine eigenen Zeilen sieht.

-- ---------- Schlüsselbund pro Konto ----------
-- Der eigentliche Daten-Schlüssel ist zufällig und liegt hier nur "eingepackt" (verschlüsselt):
--  * einmal mit einem Schlüssel aus deinem Passwort
--  * einmal mit deinem Wiederherstellungs-Code (falls das Passwort vergessen wird)
create table if not exists public.keyring (
  user_id uuid primary key references auth.users (id) on delete cascade,
  kdf_salt text not null,            -- Salt für die Ableitung aus dem Passwort (Base64)
  kdf_iterations integer not null,   -- PBKDF2-Runden
  wrapped_key text not null,         -- Daten-Schlüssel, verschlüsselt mit Passwort-Schlüssel
  recovery_salt text not null,
  wrapped_key_recovery text not null, -- Daten-Schlüssel, verschlüsselt mit Wiederherstellungs-Code
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Kleidungsstücke und Outfits ----------
-- payload = verschlüsseltes JSON (Name, Kategorie, Farbe, Layout …), für Supabase unlesbar.
create table if not exists public.items (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  payload text,                      -- null, wenn gelöscht
  has_image boolean not null default false,
  deleted boolean not null default false,
  updated_at timestamptz not null    -- Zeitpunkt der letzten Änderung (vom Gerät)
);
create index if not exists items_user_updated on public.items (user_id, updated_at);

create table if not exists public.outfits (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  payload text,
  deleted boolean not null default false,
  updated_at timestamptz not null
);
create index if not exists outfits_user_updated on public.outfits (user_id, updated_at);

-- ---------- Zugriff über die Data API ----------
-- "Grant API access to new tables automatically" ist bewusst AUS. Deshalb hier gezielt freigeben:
-- nur für angemeldete Nutzer (authenticated), nicht für Anonyme (anon).
revoke all on public.keyring, public.items, public.outfits from anon;
grant select, insert, update, delete on public.keyring, public.items, public.outfits to authenticated;

-- ---------- Row Level Security: nur eigene Zeilen ----------
alter table public.keyring enable row level security;
alter table public.items   enable row level security;
alter table public.outfits enable row level security;

drop policy if exists "eigener Schlüsselbund" on public.keyring;
create policy "eigener Schlüsselbund" on public.keyring
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "eigene Teile" on public.items;
create policy "eigene Teile" on public.items
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "eigene Outfits" on public.outfits;
create policy "eigene Outfits" on public.outfits
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- Speicher für die (verschlüsselten) Fotos ----------
-- Privater Bucket; Pfad: <user_id>/<item_id>. Jede Datei ist mit dem Daten-Schlüssel verschlüsselt.
insert into storage.buckets (id, name, public, file_size_limit)
values ('images', 'images', false, 10485760)
on conflict (id) do nothing;

drop policy if exists "eigene Fotos lesen" on storage.objects;
create policy "eigene Fotos lesen" on storage.objects
  for select to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "eigene Fotos hochladen" on storage.objects;
create policy "eigene Fotos hochladen" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "eigene Fotos ersetzen" on storage.objects;
create policy "eigene Fotos ersetzen" on storage.objects
  for update to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "eigene Fotos löschen" on storage.objects;
create policy "eigene Fotos löschen" on storage.objects
  for delete to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text);
