-- Up Migration
-- Admin "Logs" lists every client's ledger newest first, and "Resultados" sums real orders by
-- open time; without these both would scan and sort the whole table.
create index ledger_created_at_idx on ledger (created_at desc, id desc);
create index orders_real_opens_at_idx on orders (opens_at) where account = 'real';

-- Down Migration
drop index if exists orders_real_opens_at_idx;
drop index if exists ledger_created_at_idx;
