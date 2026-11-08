-- Up Migration
-- The price override also works on market assets (1m candle, close only). Orders opened before an
-- override settle on the real price, not on the one the platform showed.

alter table otc_overrides add column kind text not null default 'otc' check (kind in ('otc', 'market'));

alter table assets add column price_decimals int check (price_decimals between 0 and 8);
-- Largest allowed gap between the target and the current price, in percent.
alter table assets add column max_override_pct numeric(5, 3) not null default 0.2 check (max_override_pct > 0);
-- Small noise on the ramp of a market override, so it looks like a market move.
alter table assets add column market_jitter boolean not null default true;
update assets set price_decimals = 2 where kind = 'market';

-- Set only while an override changes the shown price: what the market really traded at.
alter table price_snapshots add column real_price numeric(20, 8);

-- The override whose price the order was opened on (null: a natural price).
alter table orders add column override_id bigint references otc_overrides(id);
create index orders_override_id on orders (override_id) where override_id is not null;

-- Down Migration
drop index if exists orders_override_id;
alter table orders drop column if exists override_id;
alter table price_snapshots drop column if exists real_price;
alter table assets drop column if exists market_jitter;
alter table assets drop column if exists max_override_pct;
alter table assets drop column if exists price_decimals;
alter table otc_overrides drop column if exists kind;
