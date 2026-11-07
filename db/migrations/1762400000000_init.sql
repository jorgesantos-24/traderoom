-- Up Migration
create extension if not exists citext;

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext unique not null,
  password_hash text not null,
  name text not null,
  role text not null default 'user' check (role in ('user','admin')),
  status text not null default 'active' check (status in ('active','blocked')),
  created_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table accounts (
  user_id uuid primary key references users(id) on delete cascade,
  balance_cents bigint not null default 0 check (balance_cents >= 0),
  currency text not null default 'BRL'
);

create table assets (
  id serial primary key,
  symbol text unique not null,
  display text not null,
  binance_stream text not null,
  payout_pct int not null default 87 check (payout_pct between 50 and 95),
  enabled boolean not null default true,
  sort int not null default 0
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  asset_id int not null references assets(id),
  direction text not null check (direction in ('call','put')),
  stake_cents bigint not null check (stake_cents > 0),
  payout_pct int not null,
  duration_sec int not null,
  open_price numeric(20,8) not null,
  close_price numeric(20,8),
  status text not null default 'open' check (status in ('open','won','lost','void')),
  opens_at timestamptz not null default now(),
  expires_at timestamptz not null,
  settled_at timestamptz,
  idempotency_key text unique not null
);
create index on orders (expires_at) where status = 'open';
create index on orders (user_id, opens_at desc);

create table ledger (
  id bigserial primary key,
  user_id uuid not null references users(id),
  order_id uuid references orders(id),
  delta_cents bigint not null,
  balance_after bigint not null,
  kind text not null check (kind in ('credit','debit','stake','payout','refund','adjust')),
  note text,
  created_at timestamptz not null default now()
);
create index on ledger (user_id, created_at desc);

create table price_snapshots (
  asset_id int not null references assets(id),
  price numeric(20,8) not null,
  captured_at timestamptz not null
);
create index on price_snapshots (asset_id, captured_at desc);

create table password_resets (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used boolean not null default false
);

create table admin_audit (
  id bigserial primary key,
  admin_id uuid not null references users(id),
  action text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table config (
  key text primary key,
  value jsonb not null
);

-- Down Migration
drop table if exists config;
drop table if exists admin_audit;
drop table if exists password_resets;
drop table if exists price_snapshots;
drop table if exists ledger;
drop table if exists orders;
drop table if exists assets;
drop table if exists accounts;
drop table if exists sessions;
drop table if exists users;
