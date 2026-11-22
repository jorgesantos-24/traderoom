-- Up Migration
-- Clients may cancel their own withdrawal while it has not been sent to the bank; the amount goes back to the balance.
alter table withdrawals drop constraint withdrawals_status_check;
alter table withdrawals add constraint withdrawals_status_check
  check (status in ('requested', 'approved', 'processing', 'completed', 'rejected', 'failed', 'returned', 'canceled'));

-- Down Migration
update withdrawals set status = 'rejected', note = coalesce(note, 'Cancelado pelo cliente') where status = 'canceled';
alter table withdrawals drop constraint withdrawals_status_check;
alter table withdrawals add constraint withdrawals_status_check
  check (status in ('requested', 'approved', 'processing', 'completed', 'rejected', 'failed', 'returned'));
