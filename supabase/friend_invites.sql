-- Invitations d'amis par email (pour quelqu'un qui n'a pas encore de compte).
-- Idempotent : peut être exécuté plusieurs fois sans erreur.

create table if not exists friend_invites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  category text not null default 'Général',
  created_at timestamptz not null default now(),
  unique (owner_id, email)
);

alter table friend_invites enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'friend_invites' and policyname = 'friend_invites_select_own') then
    create policy "friend_invites_select_own" on friend_invites for select using (owner_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'friend_invites' and policyname = 'friend_invites_insert_own') then
    create policy "friend_invites_insert_own" on friend_invites for insert with check (owner_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'friend_invites' and policyname = 'friend_invites_delete_own') then
    create policy "friend_invites_delete_own" on friend_invites for delete using (owner_id = auth.uid());
  end if;
end $$;

-- Recherche exacte d'un profil par email (ne renvoie jamais l'email lui-même).
create or replace function find_profile_by_email(p_email text)
returns table(id uuid, display_name text, avatar_url text)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, p.display_name, p.avatar_url
  from profiles p
  where lower(p.email) = lower(p_email) and p.id <> auth.uid()
  limit 1;
$$;
revoke all on function find_profile_by_email(text) from public;
grant execute on function find_profile_by_email(text) to authenticated;

-- À appeler après connexion : convertit mes invitations en attente en vraies amitiés.
create or replace function claim_friend_invites()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  my_email text := auth.jwt() ->> 'email';
begin
  insert into friends (owner_id, friend_id, category)
  select fi.owner_id, auth.uid(), fi.category
  from friend_invites fi
  where lower(fi.email) = lower(my_email)
  on conflict (owner_id, friend_id) do nothing;

  delete from friend_invites where lower(email) = lower(my_email);
end;
$$;
revoke all on function claim_friend_invites() from public;
grant execute on function claim_friend_invites() to authenticated;
