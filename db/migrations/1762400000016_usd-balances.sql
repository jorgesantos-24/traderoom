-- Up Migration
-- Balances are in US dollars. Pix still moves reais: a deposit is converted to dollars at the quote
-- of the moment it is created, and a withdrawal in dollars is paid out in reais at the quote of the
-- moment it is requested. Both rates are stored on the row.
--
-- Money already on the platform (in reais) is converted once at 5.5033 BRL/USD (commercial dollar,
-- mid of bid 5.5030 / ask 5.5035, close of 2026-11-06). The real account's history (statement,
-- orders, deposits, withdrawals) is converted with it, so the statement keeps reading in one currency,
-- and a zero-value statement line records the conversion. Demo money is relabeled (R$ 10.000 → US$ 10.000).

alter table deposits add column fx_rate numeric(10, 4) check (fx_rate > 0);
comment on column deposits.amount_cents is 'BRL cents charged by Pix';
comment on column deposits.credited_cents is 'USD cents credited to the balance';
comment on column deposits.fx_rate is 'BRL per USD used to convert this deposit';

alter table withdrawals add column pix_amount_cents bigint check (pix_amount_cents > 0);
alter table withdrawals add column fx_rate numeric(10, 4) check (fx_rate > 0);
comment on column withdrawals.amount_cents is 'USD cents debited from the balance';
comment on column withdrawals.pix_amount_cents is 'BRL cents sent by Pix';
comment on column withdrawals.fx_rate is 'BRL per USD used to convert this withdrawal';

-- Users who had anything on the real account, before the numbers change.
create temporary table usd_converted on commit drop as
  select distinct user_id from ledger where account = 'real';

update accounts set balance_cents = floor(balance_cents / 5.5033) where kind = 'real' and currency = 'BRL';
update accounts set currency = 'USD';
alter table accounts alter column currency set default 'USD';

update ledger set delta_cents = round(delta_cents / 5.5033), balance_after = floor(balance_after / 5.5033)
 where account = 'real';
update orders set stake_cents = greatest(1, round(stake_cents / 5.5033)) where account = 'real';

update deposits set fx_rate = 5.5033, credited_cents = floor(credited_cents / 5.5033);
update withdrawals set pix_amount_cents = amount_cents, fx_rate = 5.5033, amount_cents = greatest(1, floor(amount_cents / 5.5033));
alter table withdrawals alter column pix_amount_cents set not null;
alter table withdrawals alter column fx_rate set not null;

insert into ledger (user_id, delta_cents, balance_after, kind, note, account)
select a.user_id, 0, a.balance_cents, 'adjust', 'Saldo convertido de reais para dólares (US$ 1 = R$ 5,5033).', 'real'
  from accounts a join usd_converted u on u.user_id = a.user_id
 where a.kind = 'real';

-- Down Migration
delete from ledger where kind = 'adjust' and delta_cents = 0 and note like 'Saldo convertido de reais para dólares%';
update withdrawals set amount_cents = pix_amount_cents;
update deposits set credited_cents = round(credited_cents * coalesce(fx_rate, 5.5033));
update orders set stake_cents = round(stake_cents * 5.5033) where account = 'real';
update ledger set delta_cents = round(delta_cents * 5.5033), balance_after = round(balance_after * 5.5033) where account = 'real';
update accounts set balance_cents = round(balance_cents * 5.5033) where kind = 'real';
update accounts set currency = 'BRL';
alter table accounts alter column currency set default 'BRL';
alter table withdrawals drop column fx_rate;
alter table withdrawals drop column pix_amount_cents;
alter table deposits drop column fx_rate;
