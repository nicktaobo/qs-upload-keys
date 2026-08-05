create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  role text not null check (role in ('ADMIN', 'SUPPLIER')),
  channel_type_id integer,
  channel_group text,
  channel_name_prefix text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table app_users add column if not exists channel_type_id integer;
alter table app_users add column if not exists channel_group text;
alter table app_users add column if not exists channel_name_prefix text;

create table if not exists sessions (
  id text primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists channel_configs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references app_users(id) on delete cascade,
  name text not null,
  provider text not null,
  type_id integer not null,
  models jsonb not null default '[]'::jsonb,
  model_mapping jsonb not null default '{}'::jsonb,
  group_name text not null default 'default',
  discount numeric(12, 6) not null default 1,
  auto_disable boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, name)
);

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references app_users(id) on delete cascade,
  channel_config_id uuid not null references channel_configs(id) on delete cascade,
  key_name text not null,
  encrypted_key text not null,
  key_iv text not null,
  key_auth_tag text not null,
  upstream_job_id text,
  upstream_channel_id text,
  upstream_channel_key text,
  upstream_channel_name text,
  upstream_error text,
  status text not null default 'PENDING',
  usage_usd numeric(18, 6) not null default 0,
  rpm integer not null default 0,
  tpm integer not null default 0,
  last_synced_at timestamptz,
  created_at timestamptz not null default now()
);

alter table api_keys add column if not exists upstream_job_id text;
alter table api_keys add column if not exists upstream_channel_key text;
alter table api_keys add column if not exists upstream_channel_name text;
alter table api_keys add column if not exists upstream_error text;

create index if not exists api_keys_owner_idx on api_keys(owner_id);
create index if not exists api_keys_channel_idx on api_keys(channel_config_id);
create index if not exists api_keys_upstream_channel_idx on api_keys(upstream_channel_id) where upstream_channel_id is not null;

create table if not exists platform_metrics (
  id boolean primary key default true,
  rpm integer not null default 0,
  tpm bigint not null default 0,
  sampled_at timestamptz not null default now()
);

insert into platform_metrics (id) values (true) on conflict (id) do nothing;

create table if not exists upstream_metadata (
  id boolean primary key default true,
  profile_type text not null,
  channel_types jsonb not null default '[]'::jsonb,
  groups jsonb not null default '[]'::jsonb,
  type_models jsonb not null default '{}'::jsonb,
  enabled_models jsonb not null default '[]'::jsonb,
  all_models jsonb not null default '[]'::jsonb,
  synced_at timestamptz not null default now()
);
