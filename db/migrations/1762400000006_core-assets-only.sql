-- Up Migration
-- Public launch with the most liquid pairs only: BTC, ETH, SOL and XRP. BNB, DOGE and ADA go many
-- seconds without a trade, which makes short-expiry orders settle on a frozen price. Disabled, not
-- deleted: order history keeps its foreign keys and an admin can turn them back on in /admin.
update assets set enabled = false where symbol in ('BNBUSDT', 'DOGEUSDT', 'ADAUSDT');

-- Down Migration
update assets set enabled = true where symbol in ('BNBUSDT', 'DOGEUSDT', 'ADAUSDT');
