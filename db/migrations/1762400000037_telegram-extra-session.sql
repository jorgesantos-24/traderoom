-- Up Migration
-- One-off sessions outside the fixed three (e.g. an extra night session) use the key 'extra'.
alter table telegram_signal_sessions drop constraint telegram_signal_sessions_session_check;
alter table telegram_signal_sessions add constraint telegram_signal_sessions_session_check check (session in ('manha', 'tarde', 'noite', 'extra'));
alter table telegram_signals drop constraint telegram_signals_session_check;
alter table telegram_signals add constraint telegram_signals_session_check check (session in ('manha', 'tarde', 'noite', 'extra'));

-- Down Migration
alter table telegram_signals drop constraint telegram_signals_session_check;
alter table telegram_signals add constraint telegram_signals_session_check check (session in ('manha', 'tarde', 'noite'));
alter table telegram_signal_sessions drop constraint telegram_signal_sessions_session_check;
alter table telegram_signal_sessions add constraint telegram_signal_sessions_session_check check (session in ('manha', 'tarde', 'noite'));
