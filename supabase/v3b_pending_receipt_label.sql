-- Libellé optionnel dès l'envoi d'un justificatif en attente (avant même de l'attribuer à
-- une dépense), pour distinguer plusieurs tickets/factures envoyés d'un coup.
-- Idempotent : peut être exécuté plusieurs fois sans erreur.
-- À exécuter dans : Supabase Dashboard > SQL Editor > New query (après v3_pending_receipts.sql).

alter table pending_receipts add column if not exists label text;
