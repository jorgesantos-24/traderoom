-- Up Migration
-- Manual balance adjustments carry the admin's Idempotency-Key (stored as "admin:<adminId>:<key>"),
-- so a retried request never credits twice. Null for every other ledger row.
alter table ledger add column idempotency_key text;
create unique index ledger_idempotency_key_uq on ledger (idempotency_key) where idempotency_key is not null;

-- Down Migration
drop index if exists ledger_idempotency_key_uq;
alter table ledger drop column if exists idempotency_key;
