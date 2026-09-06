-- Justificatifs envoyés sans être encore rattachés à une dépense précise : permet d'envoyer
-- plusieurs tickets/factures d'un coup et de les attribuer un par un ensuite (libellé,
-- payeur(s), montant).
-- Idempotent : peut être exécuté plusieurs fois sans erreur.
-- À exécuter dans : Supabase Dashboard > SQL Editor > New query (après v2_features.sql).

create table if not exists pending_receipts (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references lists(id) on delete cascade,
  storage_path text not null,
  label text,
  uploaded_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_pending_receipts_list on pending_receipts(list_id);

alter table pending_receipts enable row level security;

drop policy if exists "pending_receipts_select_visible" on pending_receipts;
create policy "pending_receipts_select_visible" on pending_receipts for select
  using (is_list_visible(list_id));

drop policy if exists "pending_receipts_insert_member" on pending_receipts;
create policy "pending_receipts_insert_member" on pending_receipts for insert
  with check (is_list_member(list_id) and uploaded_by = auth.uid());

-- Suppression directe (abandon sans créer de dépense) : réservée à l'auteur ou à un admin.
drop policy if exists "pending_receipts_delete_owner_or_admin" on pending_receipts;
create policy "pending_receipts_delete_owner_or_admin" on pending_receipts for delete
  using (uploaded_by = auth.uid() or is_list_admin(list_id));

alter publication supabase_realtime add table pending_receipts;

-- Transforme un justificatif en attente en vraie dépense, en une seule transaction atomique.
-- Nécessaire car "attribuer" (n'importe quel participant actif) et "abandonner" (auteur ou
-- admin seulement, policy ci-dessus) n'ont pas le même périmètre d'autorisation : sans cette
-- fonction, un participant non-admin attribuant le justificatif de quelqu'un d'autre créerait
-- bien la dépense, mais échouerait silencieusement à supprimer l'entrée "en attente" (bloquée
-- par la policy de suppression directe), laissant le justificatif dupliqué dans les deux listes.
create or replace function attribute_pending_receipt(p_pending_id uuid, p_list_id uuid, p_label text, p_payers jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expense_id uuid;
  v_storage_path text;
  v_total integer;
begin
  if not is_list_member(p_list_id) then
    raise exception 'Accès refusé.';
  end if;

  select storage_path into v_storage_path from pending_receipts where id = p_pending_id and list_id = p_list_id;
  if v_storage_path is null then
    raise exception 'Justificatif introuvable.';
  end if;

  select coalesce(sum((p->>'amount_cents')::integer), 0) into v_total from jsonb_array_elements(p_payers) p;

  insert into expenses (list_id, label, amount_cents, added_by, receipt_url)
  values (p_list_id, p_label, v_total, auth.uid(), v_storage_path)
  returning id into v_expense_id;

  insert into expense_payers (expense_id, member_id, amount_cents)
  select v_expense_id, (p->>'member_id')::uuid, (p->>'amount_cents')::integer
  from jsonb_array_elements(p_payers) p;

  delete from pending_receipts where id = p_pending_id;

  return v_expense_id;
end;
$$;
revoke all on function attribute_pending_receipt(uuid, uuid, text, jsonb) from public;
grant execute on function attribute_pending_receipt(uuid, uuid, text, jsonb) to authenticated;
