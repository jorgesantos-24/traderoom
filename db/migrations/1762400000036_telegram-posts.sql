-- Up Migration
-- Fixed weekly posts of the Telegram channel (e.g. the Corujão invite): one row per post per day, inserted
-- before sending so a restart never posts it twice.
create table telegram_posts (
  day date not null,
  key text not null,
  sent_at timestamptz not null default now(),
  primary key (day, key)
);

-- Down Migration
drop table telegram_posts;
