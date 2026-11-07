-- Up Migration
-- Pix deposits and withdrawals through the payment gateway (Novus). Real account only.

-- The gateway needs the payer's CPF on every Pix charge; asked once, on the first deposit.
alter table users add column cpf text check (cpf ~ '^[0-9]{11}$');

alter table ledger drop constraint ledger_kind_check;
alter table ledger add constraint ledger_kind_check check (kind in (
  'credit', 'debit', 'stake', 'payout', 'refund', 'adjust',
  'deposit', 'deposit_reversal', 'withdrawal', 'withdrawal_return'
));

create table deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  amount_cents bigint not null check (amount_cents > 0),
  -- pending → paid (credited) | expired | failed; paid → reversed (refund/chargeback at the gateway)
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'failed', 'reversed')),
  provider_id text unique,
  pix_code text,
  expires_at timestamptz,
  credited_cents bigint,
  provider_status text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);
create index deposits_user_created_idx on deposits (user_id, created_at desc);

create table withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  amount_cents bigint not null check (amount_cents > 0),
  pix_key text not null,
  pix_key_type text not null check (pix_key_type in ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'RANDOM')),
  -- requested (balance already debited) → approved (admin) → processing (sent to the gateway) → completed
  -- requested|approved → rejected (admin, money back); processing → failed (money back) | completed → returned (bank sent it back)
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'processing', 'completed', 'rejected', 'failed', 'returned')),
  provider_id text unique,
  provider_status text,
  note text,
  reviewed_by uuid references users(id),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index withdrawals_user_created_idx on withdrawals (user_id, created_at desc);
create index withdrawals_open_idx on withdrawals (created_at) where status in ('requested', 'approved', 'processing');

alter table ledger add column deposit_id uuid references deposits(id);
alter table ledger add column withdrawal_id uuid references withdrawals(id);

-- Down Migration
alter table ledger drop column if exists withdrawal_id;
alter table ledger drop column if exists deposit_id;
drop table if exists withdrawals;
drop table if exists deposits;
delete from ledger where kind in ('deposit', 'deposit_reversal', 'withdrawal', 'withdrawal_return');
alter table ledger drop constraint ledger_kind_check;
alter table ledger add constraint ledger_kind_check check (kind in ('credit', 'debit', 'stake', 'payout', 'refund', 'adjust'));
alter table users drop column if exists cpf;
