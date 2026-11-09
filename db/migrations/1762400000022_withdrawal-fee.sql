-- Up Migration
-- Broker fee on withdrawals (USD cents). amount_cents stays what left the client's balance;
-- the Pix (pix_amount_cents, BRL) carries amount_cents - fee_cents. Older withdrawals had no fee.
alter table withdrawals add column fee_cents bigint not null default 0;
alter table withdrawals add constraint withdrawals_fee_check check (fee_cents >= 0 and fee_cents < amount_cents);

-- Down Migration
alter table withdrawals drop constraint if exists withdrawals_fee_check;
alter table withdrawals drop column if exists fee_cents;
