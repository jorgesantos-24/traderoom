-- Up Migration
-- Currency pairs are shown without the "(OTC)" suffix (test; the symbols stay EURUSDOTC etc.).
update assets set display = regexp_replace(display, '\s*\(OTC\)$', '') where category = 'forex';

-- Down Migration
update assets set display = display || ' (OTC)' where category = 'forex' and display not like '%(OTC)';
