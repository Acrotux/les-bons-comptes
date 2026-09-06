-- Corrige un blocage : un participant seulement "invité" (pas encore actif) sur une liste
-- PRIVÉE ne pouvait ni accepter ni refuser son invitation. En cause : Postgres exige de
-- pouvoir "voir" une ligne (règle SELECT) pour la modifier (UPDATE) ou la supprimer (DELETE),
-- et is_list_visible() ne considérait comme visible que les membres déjà actifs — un
-- blocage inextricable pour quelqu'un qui n'a justement pas encore accepté. Ce bug était
-- latent depuis l'ajout du consentement pour rejoindre une liste, mais n'était quasiment
-- jamais rencontré tant que les listes étaient publiques par défaut ; il est devenu
-- systématique une fois les listes privées par défaut (v2_features.sql).
--
-- Correction : une invitation en attente (n'importe quel statut, pas seulement actif) rend
-- désormais la liste visible pour la personne concernée — elle peut ainsi la consulter pour
-- décider, et accepter/refuser. Les autres personnes sans lien avec la liste ne voient
-- toujours rien si elle est privée.
-- Idempotent : peut être exécuté plusieurs fois sans erreur.
-- À exécuter dans : Supabase Dashboard > SQL Editor > New query (après v2_features.sql).

create or replace function is_list_visible(p_list_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from lists l
    where l.id = p_list_id
      and (
        l.is_private = false
        or l.created_by = auth.uid()
        or exists (select 1 from list_members where list_id = p_list_id and profile_id = auth.uid())
      )
  );
$$;
