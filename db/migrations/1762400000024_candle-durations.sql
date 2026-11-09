-- Up Migration
-- Orders follow the clock candles: 1, 5, 15 and 30 minutes (30 s and 10 min removed).
update config set value = '[60, 300, 900, 1800]'::jsonb where key = 'orders.durations_sec';

-- Down Migration
update config set value = '[30, 60, 300, 600, 900, 1800]'::jsonb where key = 'orders.durations_sec';
