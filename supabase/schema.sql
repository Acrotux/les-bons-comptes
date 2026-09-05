-- Les Bons Comptes — schéma Supabase
-- À exécuter une fois dans : Supabase Dashboard > SQL Editor > New query

-- ============================================================
-- Extensions
-- ============================================================
create extension if not exists "pgcrypto";

-- ============================================================
-- Tables
-- ============================================================

-- Profil léger, un par compte auth. Créé/mis à jour par le client au login.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_private boolean not null default false,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists list_members (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references lists(id) on delete cascade,
  profile_id uuid references auth.users(id), -- null tant que le participant n'a pas rejoint / été identifié
  display_name text not null,
  email text,
  added_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references lists(id) on delete cascade,
  member_id uuid not null references list_members(id),
  label text not null,
  amount_cents integer not null check (amount_cents > 0),
  added_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists settlements (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references lists(id) on delete cascade,
  from_member_id uuid not null references list_members(id),
  to_member_id uuid not null references list_members(id),
  amount_cents integer not null check (amount_cents > 0),
  declared_by uuid not null references auth.users(id),
  declared_at timestamptz not null default now(),
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz
);

create index if not exists idx_list_members_list on list_members(list_id);
create index if not exists idx_expenses_list on expenses(list_id);
create index if not exists idx_settlements_list on settlements(list_id);

-- ============================================================
-- Fonctions utilitaires (SECURITY DEFINER pour éviter la récursion RLS)
-- ============================================================

create or replace function is_list_member(p_list_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from list_members
    where list_id = p_list_id and profile_id = auth.uid()
  );
$$;

create or replace function is_list_creator(p_list_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from lists
    where id = p_list_id and created_by = auth.uid()
  );
$$;

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
      and (l.is_private = false or l.created_by = auth.uid() or is_list_member(p_list_id))
  );
$$;

-- ============================================================
-- RLS
-- ============================================================

alter table profiles enable row level security;
alter table lists enable row level security;
alter table list_members enable row level security;
alter table expenses enable row level security;
alter table settlements enable row level security;

-- profiles : chacun voit/gère son propre profil ; les co-membres peuvent lire le nom/email pour affichage
create policy "profiles_select_own" on profiles for select
  using (id = auth.uid());
create policy "profiles_upsert_own" on profiles for insert
  with check (id = auth.uid());
create policy "profiles_update_own" on profiles for update
  using (id = auth.uid());

-- lists
create policy "lists_select_visible" on lists for select
  using (is_private = false or created_by = auth.uid() or is_list_member(id));
create policy "lists_insert_self" on lists for insert
  with check (created_by = auth.uid());
create policy "lists_update_creator" on lists for update
  using (created_by = auth.uid());

-- list_members
create policy "members_select_visible" on list_members for select
  using (is_list_visible(list_id));
create policy "members_insert_by_member_or_creator" on list_members for insert
  with check (
    is_list_creator(list_id)
    or is_list_member(list_id)
    or (profile_id = auth.uid() and not (select is_private from lists where id = list_id))
  );
create policy "members_update_creator" on list_members for update
  using (is_list_creator(list_id));
create policy "members_self_claim" on list_members for update
  using (profile_id is null and email = (auth.jwt() ->> 'email'))
  with check (profile_id = auth.uid());
create policy "members_delete_creator" on list_members for delete
  using (is_list_creator(list_id));

-- expenses
create policy "expenses_select_visible" on expenses for select
  using (is_list_visible(list_id));
create policy "expenses_insert_member" on expenses for insert
  with check (is_list_member(list_id) and added_by = auth.uid());
create policy "expenses_update_creator" on expenses for update
  using (is_list_creator(list_id));
create policy "expenses_delete_owner_or_creator" on expenses for delete
  using (added_by = auth.uid() or is_list_creator(list_id));

-- settlements
create policy "settlements_select_visible" on settlements for select
  using (is_list_visible(list_id));
create policy "settlements_insert_debtor" on settlements for insert
  with check (
    declared_by = auth.uid()
    and exists (select 1 from list_members where id = from_member_id and profile_id = auth.uid())
  );
create policy "settlements_confirm_creditor" on settlements for update
  using (
    exists (select 1 from list_members where id = to_member_id and profile_id = auth.uid())
  );

-- ============================================================
-- Realtime
-- ============================================================
alter publication supabase_realtime add table lists, list_members, expenses, settlements;
