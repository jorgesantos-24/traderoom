-- Up Migration
-- VIP sessions at 07:00, 12:00 and 18:00 (Brasília).
alter table telegram_signal_sessions drop constraint telegram_signal_sessions_session_check;
alter table telegram_signal_sessions add constraint telegram_signal_sessions_session_check
  check (session in ('manha', 'tarde', 'noite', 'extra', 'vip_manha', 'vip_tarde', 'vip_noite'));
alter table telegram_signals drop constraint telegram_signals_session_check;
alter table telegram_signals add constraint telegram_signals_session_check
  check (session in ('manha', 'tarde', 'noite', 'extra', 'vip_manha', 'vip_tarde', 'vip_noite'));

-- Down Migration
alter table telegram_signals drop constraint telegram_signals_session_check;
alter table telegram_signals add constraint telegram_signals_session_check check (session in ('manha', 'tarde', 'noite', 'extra'));
alter table telegram_signal_sessions drop constraint telegram_signal_sessions_session_check;
alter table telegram_signal_sessions add constraint telegram_signal_sessions_session_check check (session in ('manha', 'tarde', 'noite', 'extra'));
