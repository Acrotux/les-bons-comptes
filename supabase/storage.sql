-- Ajouts pour l'édition de profil : photo de profil.
-- Idempotent : peut être exécuté plusieurs fois sans erreur.

alter table profiles add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'avatars_public_read') then
    create policy "avatars_public_read" on storage.objects for select using (bucket_id = 'avatars');
  end if;
  if not exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'avatars_insert_own') then
    create policy "avatars_insert_own" on storage.objects for insert
      with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'avatars_update_own') then
    create policy "avatars_update_own" on storage.objects for update
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'avatars_delete_own') then
    create policy "avatars_delete_own" on storage.objects for delete
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;
