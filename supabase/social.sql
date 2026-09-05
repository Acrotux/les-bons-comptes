-- Ajouts : recherche de pseudo, amis catégorisés, catégorie de liste, avatars des membres.
-- Idempotent : peut être exécuté plusieurs fois sans erreur.

alter table lists add column if not exists category text;

create table if not exists friends (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  friend_id uuid not null references auth.users(id) on delete cascade,
  category text not null default 'Général',
  created_at timestamptz not null default now(),
  unique (owner_id, friend_id)
);

alter table friends enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'friends' and policyname = 'friends_select_own') then
    create policy "friends_select_own" on friends for select using (owner_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'friends' and policyname = 'friends_insert_own') then
    create policy "friends_insert_own" on friends for insert with check (owner_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'friends' and policyname = 'friends_update_own') then
    create policy "friends_update_own" on friends for update using (owner_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'friends' and policyname = 'friends_delete_own') then
    create policy "friends_delete_own" on friends for delete using (owner_id = auth.uid());
  end if;
end $$;

-- Recherche de profils par pseudo (ne renvoie jamais l'email, uniquement id/pseudo/avatar).
create or replace function search_profiles(query text)
returns table(id uuid, display_name text, avatar_url text)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, p.display_name, p.avatar_url
  from profiles p
  where p.display_name ilike '%' || query || '%'
    and p.id <> auth.uid()
  order by p.display_name
  limit 20;
$$;
revoke all on function search_profiles(text) from public;
grant execute on function search_profiles(text) to authenticated;

-- Mes amis, avec leur pseudo/avatar (join sécurisé, contourne le RLS de profiles).
create or replace function my_friends()
returns table(id uuid, friend_id uuid, display_name text, avatar_url text, category text)
language sql
security definer
set search_path = public
stable
as $$
  select f.id, f.friend_id, p.display_name, p.avatar_url, f.category
  from friends f
  join profiles p on p.id = f.friend_id
  where f.owner_id = auth.uid()
  order by f.category, p.display_name;
$$;
revoke all on function my_friends() from public;
grant execute on function my_friends() to authenticated;

-- Profils (pseudo/avatar) des participants d'une liste visible par moi — pour afficher avatars + couronne du créateur.
create or replace function list_member_profiles(p_list_id uuid)
returns table(profile_id uuid, display_name text, avatar_url text)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, p.display_name, p.avatar_url
  from profiles p
  join list_members lm on lm.profile_id = p.id
  where lm.list_id = p_list_id and is_list_visible(p_list_id);
$$;
revoke all on function list_member_profiles(uuid) from public;
grant execute on function list_member_profiles(uuid) to authenticated;
