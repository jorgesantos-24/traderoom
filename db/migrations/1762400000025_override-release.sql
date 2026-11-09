-- Up Migration
-- Tempo de volta ao preço real, por override. 2 s é o padrão antigo; valores maiores espalham a
-- volta pela vela seguinte (curva suave) em vez de dar um talo no gráfico.
alter table otc_overrides add column release_ms int not null default 2000
  check (release_ms between 500 and 600000);

-- Alvo fora da banda de max_override_pct, a pedido do admin. Imediato: a API aceita o alvo.
-- Agendado: vai no wire (schedule.ignoreBand) e o ws deixa de encolher o corpo na abertura do candle.
alter table otc_overrides add column ignore_band boolean not null default false;

-- Down Migration
alter table otc_overrides drop column if exists ignore_band;
alter table otc_overrides drop column if exists release_ms;
