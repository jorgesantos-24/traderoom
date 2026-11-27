-- Up Migration
-- 00:00 (midnight) session of the "SALA DE SINAIS M1" channel.
alter table telegram_signal_sessions drop constraint telegram_signal_sessions_session_check;
alter table telegram_signal_sessions add constraint telegram_signal_sessions_session_check
  check (session in ('manha', 'tarde', 'noite', 'extra', 'vip_manha', 'vip_tarde', 'vip_noite', 'm1_manha', 'm1_tarde', 'm1_noite', 'm1_madrugada'));
alter table telegram_signals drop constraint telegram_signals_session_check;
alter table telegram_signals add constraint telegram_signals_session_check
  check (session in ('manha', 'tarde', 'noite', 'extra', 'vip_manha', 'vip_tarde', 'vip_noite', 'm1_manha', 'm1_tarde', 'm1_noite', 'm1_madrugada'));

-- Down Migration
alter table telegram_signals drop constraint telegram_signals_session_check;
alter table telegram_signals add constraint telegram_signals_session_check
  check (session in ('manha', 'tarde', 'noite', 'extra', 'vip_manha', 'vip_tarde', 'vip_noite', 'm1_manha', 'm1_tarde', 'm1_noite'));
alter table telegram_signal_sessions drop constraint telegram_signal_sessions_session_check;
alter table telegram_signal_sessions add constraint telegram_signal_sessions_session_check
  check (session in ('manha', 'tarde', 'noite', 'extra', 'vip_manha', 'vip_tarde', 'vip_noite', 'm1_manha', 'm1_tarde', 'm1_noite'));
