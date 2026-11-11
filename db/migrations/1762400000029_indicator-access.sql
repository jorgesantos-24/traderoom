-- Up Migration
-- Premium chart indicators (Smart Money Concepts, chart patterns) are shown only to the users an
-- admin grants them to. One row per user and indicator.
create table indicator_access (
  user_id uuid not null references users(id) on delete cascade,
  indicator text not null check (indicator in ('smc', 'patterns')),
  granted_by uuid references users(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, indicator)
);

-- Down Migration
drop table indicator_access;
