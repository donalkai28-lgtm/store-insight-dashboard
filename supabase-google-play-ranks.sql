create table if not exists public.google_play_rank_snapshots (
  snapshot_at timestamptz not null,
  country text not null,
  chart_type text not null,
  rank integer not null,
  app_id text not null,
  app_name text not null,
  developer_name text,
  icon_url text,
  play_store_url text,
  score numeric,
  created_at timestamptz not null default now(),
  primary key (snapshot_at, country, chart_type, rank)
);

create index if not exists google_play_rank_snapshots_lookup_idx
  on public.google_play_rank_snapshots (country, chart_type, snapshot_at desc, rank asc);

create index if not exists google_play_rank_snapshots_app_lookup_idx
  on public.google_play_rank_snapshots (country, chart_type, app_id, snapshot_at desc);
