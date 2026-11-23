-- Up Migration
-- A session stops (no more signals) once it reaches the stop loss; the stop message is claimed by this column.
alter table telegram_signal_sessions add column stopped_at timestamptz;

-- Down Migration
alter table telegram_signal_sessions drop column stopped_at;
