-- Durcissement sécurité avant ouverture publique.
-- Idempotent : peut être exécuté plusieurs fois sans erreur.

-- Empêche les noms vides (évite un crash d'affichage sur l'initiale de l'avatar
-- et des lignes de participants illisibles).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_display_name_not_blank') then
    alter table profiles add constraint profiles_display_name_not_blank check (length(trim(display_name)) > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'list_members_display_name_not_blank') then
    alter table list_members add constraint list_members_display_name_not_blank check (length(trim(display_name)) > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lists_name_not_blank') then
    alter table lists add constraint lists_name_not_blank check (length(trim(name)) > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'expenses_label_not_blank') then
    alter table expenses add constraint expenses_label_not_blank check (length(trim(label)) > 0);
  end if;
end $$;

-- Valide le format des emails saisis pour des tiers (participants placeholder, invitations
-- d'amis). Sans ça, un email malformé (ex: contenant "?bcc=...") peut détourner les liens
-- mailto (récapitulatif de liste, contact d'un participant) vers une adresse non prévue.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'list_members_email_format') then
    alter table list_members add constraint list_members_email_format
      check (email is null or email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'friend_invites_email_format') then
    alter table friend_invites add constraint friend_invites_email_format
      check (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');
  end if;
end $$;

-- Limite le bucket avatars : formats raster uniquement (pas de SVG, potentiellement exécutable
-- si ouvert directement dans un onglet) et taille plafonnée à 2 Mo.
update storage.buckets
set file_size_limit = 2097152,
    allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
where id = 'avatars';
