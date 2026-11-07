-- Up Migration
-- Payout 82% on every asset (enabled or not), and as the default for new ones.
-- Open orders keep the payout they were opened with (stored on the order).
update assets set payout_pct = 82;
alter table assets alter column payout_pct set default 82;

-- Down Migration
alter table assets alter column payout_pct set default 87;
update assets set payout_pct = 87;
