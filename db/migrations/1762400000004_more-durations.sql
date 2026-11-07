-- Up Migration
-- Expiry options offered to traders: 30 s, 1, 5, 10, 15 and 30 min.
update config set value = '[30, 60, 300, 600, 900, 1800]'::jsonb where key = 'orders.durations_sec';

-- Down Migration
update config set value = '[60, 300]'::jsonb where key = 'orders.durations_sec';
