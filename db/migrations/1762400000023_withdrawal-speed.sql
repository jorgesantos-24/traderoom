-- Up Migration
-- Two kinds of withdrawal: 'standard' (lower fee, admin review, up to 3 business days) and
-- 'instant' (higher fee, sent to the gateway right away, no review).
alter table withdrawals add column speed text not null default 'standard' check (speed in ('standard', 'instant'));
-- When the payout request to the gateway started; while one may be in flight the withdrawal cannot be refused.
alter table withdrawals add column send_started_at timestamptz;

-- Down Migration
alter table withdrawals drop column if exists send_started_at;
alter table withdrawals drop column if exists speed;
