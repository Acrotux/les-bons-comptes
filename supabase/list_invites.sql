-- Consentement requis pour rejoindre une liste : ajouter quelqu'un par pseudo crée une
-- invitation en attente au lieu de le rendre membre actif immédiatement.
-- Idempotent : peut être exécuté plusieurs fois sans erreur.

alter table list_members add column if not exists status text not null default 'active';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'list_members_status_check') then
    alter table list_members add constraint list_members_status_check check (status in ('invited', 'active'));
  end if;
end $$;

-- Un membre "invité" (pas encore accepté) ne doit pas compter comme un vrai participant
-- pour l'accès aux données (voir la liste privée, ajouter des dépenses, etc.).
create or replace function is_list_member(p_list_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from list_members
    where list_id = p_list_id and profile_id = auth.uid() and status = 'active'
  );
$$;

-- Mes invitations en attente, avec le nom de la liste et de la personne qui a invité
-- (fonction sécurisée : contourne le RLS pour permettre de voir l'invitation avant d'accepter,
-- même si la liste est privée).
create or replace function my_pending_list_invites()
returns table(member_id uuid, list_id uuid, list_name text, invited_by_name text)
language sql
security definer
set search_path = public
stable
as $$
  select lm.id, l.id, l.name, inviter.display_name
  from list_members lm
  join lists l on l.id = lm.list_id
  left join profiles inviter on inviter.id = lm.added_by
  where lm.profile_id = auth.uid() and lm.status = 'invited';
$$;
revoke all on function my_pending_list_invites() from public;
grant execute on function my_pending_list_invites() to authenticated;

-- On peut accepter ou refuser sa propre invitation, indépendamment des droits du créateur.
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'list_members' and policyname = 'members_accept_own_invite') then
    create policy "members_accept_own_invite" on list_members for update
      using (profile_id = auth.uid() and status = 'invited')
      with check (status = 'active');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'list_members' and policyname = 'members_decline_own_invite') then
    create policy "members_decline_own_invite" on list_members for delete
      using (profile_id = auth.uid() and status = 'invited');
  end if;
end $$;
