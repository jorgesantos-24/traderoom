-- Up Migration
-- Identity verification (KYC): the user sends personal data, an ID document and a selfie; an admin approves or rejects.
-- Real-money operations (deposit, withdrawal) require kyc_status = 'approved'.

alter table users add column kyc_status text not null default 'none'
  check (kyc_status in ('none', 'pending', 'approved', 'rejected'));
-- One CPF per account.
create unique index users_cpf_uq on users (cpf) where cpf is not null;

create table kyc_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  -- draft (uploading files) → pending (sent) → approved | rejected
  status text not null default 'draft' check (status in ('draft', 'pending', 'approved', 'rejected')),
  full_name text,
  cpf text check (cpf ~ '^[0-9]{11}$'),
  birth_date date,
  phone text,
  address_zip text,
  address_street text,
  address_number text,
  address_complement text,
  address_district text,
  address_city text,
  address_state text check (address_state ~ '^[A-Z]{2}$'),
  doc_type text check (doc_type in ('RG', 'CNH', 'RNE', 'PASSAPORTE')),
  reject_reason text,
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz not null default now()
);
-- At most one open (draft or pending) submission per user.
create unique index kyc_open_uq on kyc_submissions (user_id) where status in ('draft', 'pending');
create index kyc_pending_idx on kyc_submissions (submitted_at) where status = 'pending';

-- Images are kept in the database (private; served only to admins through the API).
create table kyc_files (
  submission_id uuid not null references kyc_submissions(id) on delete cascade,
  kind text not null check (kind in ('doc_front', 'doc_back', 'selfie')),
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  data bytea not null,
  size_bytes int not null,
  created_at timestamptz not null default now(),
  primary key (submission_id, kind)
);

-- Down Migration
drop table if exists kyc_files;
drop table if exists kyc_submissions;
drop index if exists users_cpf_uq;
alter table users drop column if exists kyc_status;
