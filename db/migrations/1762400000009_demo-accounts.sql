-- Up Migration
-- Every user gets two balances: 'real' (the existing one) and 'demo' (practice money, starts at R$ 10.000).
-- Orders and ledger rows record which one they belong to.
alter table accounts add column kind text not null default 'real' check (kind in ('real', 'demo'));
alter table accounts drop constraint accounts_pkey;
alter table accounts add primary key (user_id, kind);
insert into accounts (user_id, kind, balance_cents) select id, 'demo', 1000000 from users;

alter table orders add column account text not null default 'real' check (account in ('real', 'demo'));
alter table ledger add column account text not null default 'real' check (account in ('real', 'demo'));

drop index if exists orders_user_id_opens_at_idx;
create index orders_user_account_opens_at_idx on orders (user_id, account, opens_at desc);
drop index if exists ledger_user_id_created_at_idx;
create index ledger_user_account_created_at_idx on ledger (user_id, account, created_at desc);

-- Down Migration
drop index if exists ledger_user_account_created_at_idx;
create index if not exists ledger_user_id_created_at_idx on ledger (user_id, created_at desc);
drop index if exists orders_user_account_opens_at_idx;
create index if not exists orders_user_id_opens_at_idx on orders (user_id, opens_at desc);

delete from ledger where account = 'demo';
delete from orders where account = 'demo';
alter table ledger drop column account;
alter table orders drop column account;

delete from accounts where kind = 'demo';
alter table accounts drop constraint accounts_pkey;
alter table accounts add primary key (user_id);
alter table accounts drop column kind;
