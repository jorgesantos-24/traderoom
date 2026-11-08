-- Up Migration
-- Scheduled override (market, 1m): the admin books a future candle with a color and a body in
-- ticks. The target is only known at that candle's open (the ws resolves it and writes it here).
alter table otc_overrides alter column target_price drop not null;
alter table otc_overrides add column direction text check (direction in ('up', 'down'));
alter table otc_overrides add column body_ticks int check (body_ticks >= 10 and body_ticks % 5 = 0);
alter table otc_overrides add constraint otc_overrides_target_or_schedule
  check (target_price is not null or (direction is not null and body_ticks is not null));

-- Down Migration
delete from otc_overrides where target_price is null;
alter table otc_overrides drop constraint if exists otc_overrides_target_or_schedule;
alter table otc_overrides drop column if exists body_ticks;
alter table otc_overrides drop column if exists direction;
alter table otc_overrides alter column target_price set not null;
