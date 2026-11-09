-- Up Migration
-- Second Pix gateway (EaglePay) beside Novus: each charge and payout remembers which gateway holds it,
-- so switching gateways never asks the new one about the old one's transactions.
-- Ids are only unique within one gateway (EaglePay withdrawal ids are small integers).
alter table deposits add column provider text check (provider in ('novus', 'eagle'));
alter table withdrawals add column provider text check (provider in ('novus', 'eagle'));
update deposits set provider = 'novus' where provider_id is not null;
update withdrawals set provider = 'novus' where provider_id is not null;

alter table deposits drop constraint deposits_provider_id_key;
alter table withdrawals drop constraint withdrawals_provider_id_key;
alter table deposits add constraint deposits_provider_id_key unique (provider, provider_id);
alter table withdrawals add constraint withdrawals_provider_id_key unique (provider, provider_id);

-- The background sync looks at open transactions only.
create index deposits_pending_idx on deposits (created_at) where status = 'pending' and provider_id is not null;
create index withdrawals_processing_idx on withdrawals (updated_at) where status = 'processing';

-- Down Migration
drop index if exists withdrawals_processing_idx;
drop index if exists deposits_pending_idx;
alter table withdrawals drop constraint if exists withdrawals_provider_id_key;
alter table deposits drop constraint if exists deposits_provider_id_key;
alter table withdrawals add constraint withdrawals_provider_id_key unique (provider_id);
alter table deposits add constraint deposits_provider_id_key unique (provider_id);
alter table withdrawals drop column if exists provider;
alter table deposits drop column if exists provider;
