-- V2 : co-administrateurs, dépenses à plusieurs payeurs, justificatifs (ticket/facture),
-- liste privée par défaut, lien d'invitation ami.
-- Idempotent : peut être exécuté plusieurs fois sans erreur.
-- À exécuter dans : Supabase Dashboard > SQL Editor > New query (après schema.sql, social.sql,
-- friend_invites.sql, list_invites.sql, storage.sql, hardening.sql).

-- ============================================================
-- Liste privée par défaut
-- ============================================================
alter table lists alter column is_private set default true;

-- ============================================================
-- Co-administrateurs
-- ============================================================
alter table list_members add column if not exists is_co_admin boolean not null default false;

-- Vrai si je suis le créateur de la liste OU un co-administrateur actif.
create or replace function is_list_admin(p_list_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from lists where id = p_list_id and created_by = auth.uid()
  ) or exists (
    select 1 from list_members
    where list_id = p_list_id and profile_id = auth.uid() and status = 'active' and is_co_admin = true
  );
$$;

-- Seul le créateur peut nommer/retirer un co-administrateur, même si un co-admin a par
-- ailleurs le droit de modifier la ligne d'un participant (nom/email).
create or replace function protect_co_admin_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created_by uuid;
begin
  select created_by into v_created_by from lists where id = new.list_id;
  if new.is_co_admin is distinct from old.is_co_admin and auth.uid() is distinct from v_created_by then
    raise exception 'Seul le créateur de la liste peut nommer ou retirer un co-administrateur.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_co_admin on list_members;
create trigger trg_protect_co_admin before update on list_members
  for each row execute function protect_co_admin_flag();

-- Seul le créateur peut clôturer/rouvrir la liste ou changer son créateur ; un co-admin peut
-- modifier le reste (catégorie, confidentialité).
create or replace function protect_list_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status and auth.uid() is distinct from old.created_by then
    raise exception 'Seul le créateur peut clôturer ou rouvrir la liste.';
  end if;
  if new.created_by is distinct from old.created_by then
    raise exception 'Le créateur de la liste ne peut pas être modifié.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_list_status on lists;
create trigger trg_protect_list_status before update on lists
  for each row execute function protect_list_status();

drop policy if exists "lists_update_creator" on lists;
drop policy if exists "lists_update_admin" on lists;
create policy "lists_update_admin" on lists for update
  using (is_list_admin(id));

drop policy if exists "members_update_creator" on list_members;
drop policy if exists "members_update_admin" on list_members;
create policy "members_update_admin" on list_members for update
  using (is_list_admin(list_id));

drop policy if exists "members_delete_creator" on list_members;
drop policy if exists "members_delete_admin" on list_members;
create policy "members_delete_admin" on list_members for delete
  using (
    is_list_admin(list_id)
    and profile_id is distinct from (select created_by from lists l where l.id = list_members.list_id)
  );

drop policy if exists "members_insert_by_member_or_creator" on list_members;
drop policy if exists "members_insert_by_member_or_admin" on list_members;
create policy "members_insert_by_member_or_admin" on list_members for insert
  with check (
    is_list_admin(list_id)
    or is_list_member(list_id)
    or (profile_id = auth.uid() and not (select is_private from lists where id = list_id))
  );

-- La personne qui a ajouté la dépense peut y joindre son justificatif après coup ; un
-- admin peut aussi corriger n'importe quelle dépense de la liste.
drop policy if exists "expenses_update_creator" on expenses;
drop policy if exists "expenses_update_admin" on expenses;
drop policy if exists "expenses_update_owner_or_admin" on expenses;
create policy "expenses_update_owner_or_admin" on expenses for update
  using (added_by = auth.uid() or is_list_admin(list_id));

drop policy if exists "expenses_delete_owner_or_creator" on expenses;
drop policy if exists "expenses_delete_owner_or_admin" on expenses;
create policy "expenses_delete_owner_or_admin" on expenses for delete
  using (added_by = auth.uid() or is_list_admin(list_id));

-- ============================================================
-- Dépenses à plusieurs payeurs (montants différents)
-- ============================================================
alter table expenses alter column member_id drop not null;
alter table expenses add column if not exists receipt_url text;

create table if not exists expense_payers (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references expenses(id) on delete cascade,
  member_id uuid not null references list_members(id),
  amount_cents integer not null check (amount_cents > 0),
  unique (expense_id, member_id)
);
create index if not exists idx_expense_payers_expense on expense_payers(expense_id);

-- Reprend les dépenses déjà existantes (un seul payeur) dans la nouvelle table.
insert into expense_payers (expense_id, member_id, amount_cents)
select id, member_id, amount_cents from expenses
where member_id is not null
on conflict (expense_id, member_id) do nothing;

alter table expense_payers enable row level security;

drop policy if exists "expense_payers_select_visible" on expense_payers;
create policy "expense_payers_select_visible" on expense_payers for select
  using (exists (select 1 from expenses e where e.id = expense_id and is_list_visible(e.list_id)));

drop policy if exists "expense_payers_insert" on expense_payers;
create policy "expense_payers_insert" on expense_payers for insert
  with check (exists (
    select 1 from expenses e where e.id = expense_id and (e.added_by = auth.uid() or is_list_admin(e.list_id))
  ));

drop policy if exists "expense_payers_delete" on expense_payers;
create policy "expense_payers_delete" on expense_payers for delete
  using (exists (
    select 1 from expenses e where e.id = expense_id and (e.added_by = auth.uid() or is_list_admin(e.list_id))
  ));

drop policy if exists "expense_payers_update" on expense_payers;
create policy "expense_payers_update" on expense_payers for update
  using (exists (
    select 1 from expenses e where e.id = expense_id and (e.added_by = auth.uid() or is_list_admin(e.list_id))
  ));

-- Le montant total d'une dépense est toujours la somme de ses payeurs (empêche toute
-- incohérence, même si le client enverrait un total différent).
create or replace function sync_expense_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expense_id uuid := coalesce(new.expense_id, old.expense_id);
begin
  update expenses set amount_cents = (
    select coalesce(sum(amount_cents), 0) from expense_payers where expense_id = v_expense_id
  ) where id = v_expense_id;
  return null;
end;
$$;

drop trigger if exists trg_sync_expense_total on expense_payers;
create trigger trg_sync_expense_total after insert or update or delete on expense_payers
  for each row execute function sync_expense_total();

alter publication supabase_realtime add table expense_payers;

-- Détail des payeurs de chaque dépense d'une liste (id de la part, pour pouvoir la réassigner
-- dans le cas simple à un seul payeur).
create or replace function list_expense_payers(p_list_id uuid)
returns table(id uuid, expense_id uuid, member_id uuid, amount_cents integer)
language sql
security definer
set search_path = public
stable
as $$
  select ep.id, ep.expense_id, ep.member_id, ep.amount_cents
  from expense_payers ep
  join expenses e on e.id = ep.expense_id
  where e.list_id = p_list_id and is_list_visible(p_list_id);
$$;
revoke all on function list_expense_payers(uuid) from public;
grant execute on function list_expense_payers(uuid) to authenticated;

-- ============================================================
-- Justificatifs (ticket de caisse / facture) — bucket privé, visible par les membres de la liste
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 8388608, array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'])
on conflict (id) do update set file_size_limit = 8388608, allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];

-- Chemin de stockage attendu : <list_id>/<expense_id>-<nom fichier>
drop policy if exists "receipts_select_members" on storage.objects;
create policy "receipts_select_members" on storage.objects for select
  using (bucket_id = 'receipts' and is_list_visible(((storage.foldername(name))[1])::uuid));

drop policy if exists "receipts_insert_members" on storage.objects;
create policy "receipts_insert_members" on storage.objects for insert
  with check (bucket_id = 'receipts' and is_list_member(((storage.foldername(name))[1])::uuid));

drop policy if exists "receipts_delete_members" on storage.objects;
create policy "receipts_delete_members" on storage.objects for delete
  using (bucket_id = 'receipts' and is_list_admin(((storage.foldername(name))[1])::uuid));

-- ============================================================
-- Lien d'invitation ami (carte publique minimale d'un profil, pour l'écran d'ajout par lien)
-- ============================================================
create or replace function public_profile_card(p_id uuid)
returns table(id uuid, display_name text, avatar_url text)
language sql
security definer
set search_path = public
stable
as $$
  select id, display_name, avatar_url from profiles where id = p_id;
$$;
revoke all on function public_profile_card(uuid) from public;
grant execute on function public_profile_card(uuid) to authenticated;
