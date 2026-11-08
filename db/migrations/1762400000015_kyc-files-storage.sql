-- Up Migration
-- KYC photos can live in Firebase Storage: the row keeps the object path instead of the bytes.
alter table kyc_files alter column data drop not null;
alter table kyc_files add column storage_path text;
alter table kyc_files add constraint kyc_files_data_or_path check ((data is null) <> (storage_path is null));

-- Down Migration
alter table kyc_files drop constraint if exists kyc_files_data_or_path;
alter table kyc_files drop column if exists storage_path;
alter table kyc_files alter column data set not null;
