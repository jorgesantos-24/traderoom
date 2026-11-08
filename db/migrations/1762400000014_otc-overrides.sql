-- Up Migration
-- Intervenção manual no preço de um ativo OTC, presa a UM candle: o preço tem que
-- fechar exatamente em target_price no fim do candle e depois volta ao base_price.
create table otc_overrides (
  id bigserial primary key,
  asset_id int not null references assets(id),
  interval_sec int not null check (interval_sec between 60 and 86400),
  target_price numeric(20,8) not null check (target_price > 0),
  -- Preço natural no momento da captura: para onde o preço volta depois do candle.
  base_price numeric(20,8) not null check (base_price > 0),
  candle_open_ms bigint not null,
  candle_close_ms bigint not null,
  ramp_ms int not null check (ramp_ms between 500 and 60000),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  active boolean not null default true,
  check (candle_close_ms > candle_open_ms)
);
-- Um só override ativo no sistema inteiro.
create unique index otc_overrides_one_active on otc_overrides (active) where active;
create index on otc_overrides (created_at desc);

-- Down Migration
drop table if exists otc_overrides;