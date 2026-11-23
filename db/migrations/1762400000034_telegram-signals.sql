-- Up Migration
-- Daily signals the worker posts to the Telegram channel: 3 sessions (morning, afternoon, night),
-- a reminder 15 minutes before each, 3 five-minute entries each, the real result of each one (from price_snapshots) and a session report.
-- Rows are inserted before the message is sent, so a restart never posts the same thing twice.
create table telegram_signal_sessions (
  day date not null,
  session text not null check (session in ('manha', 'tarde', 'noite')),
  reminded_at timestamptz,
  announced_at timestamptz,
  reported_at timestamptz,
  primary key (day, session)
);

create table telegram_signals (
  id bigserial primary key,
  day date not null,
  session text not null check (session in ('manha', 'tarde', 'noite')),
  seq int not null check (seq between 1 and 20),
  asset_id int not null references assets(id),
  display text not null,
  direction text not null check (direction in ('call', 'put')),
  entry_at timestamptz not null,
  expiry_sec int not null,
  gales int not null check (gales between 0 and 3),
  message_id bigint,
  -- win at step result_step (0 = direct, 1 = 1st protection...), loss, draw (last step tied: refunded),
  -- void (no price for a step).
  result text check (result in ('win', 'loss', 'draw', 'void')),
  result_step int,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (day, session, seq)
);
create index telegram_signals_open_idx on telegram_signals (entry_at) where result is null;

-- Down Migration
drop table telegram_signals;
drop table telegram_signal_sessions;
