create table if not exists public.owned_product_profiles (
  platform text not null,
  product_key text not null,
  app_id text not null,
  app_name text not null,
  developer_name text,
  icon_url text,
  store_url text,
  snapshot_at timestamptz,
  beijing_date date,
  beijing_hour integer,
  updated_at timestamptz not null default now(),
  primary key (platform, product_key)
);

create index if not exists owned_product_profiles_platform_idx
  on public.owned_product_profiles (platform);
