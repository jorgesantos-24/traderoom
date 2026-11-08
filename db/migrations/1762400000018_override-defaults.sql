-- Up Migration
-- Tighter default gap for market overrides, and market assets created later get price decimals by
-- themselves (without them they never show in the override picker).

alter table assets alter column max_override_pct set default 0.1;
update assets set max_override_pct = 0.1 where max_override_pct = 0.2;

alter table assets alter column price_decimals set default 2;
update assets set price_decimals = 2 where kind = 'market' and price_decimals is null;

-- Down Migration
alter table assets alter column price_decimals drop default;
update assets set max_override_pct = 0.2 where max_override_pct = 0.1;
alter table assets alter column max_override_pct set default 0.2;
