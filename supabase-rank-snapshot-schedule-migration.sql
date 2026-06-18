alter table public.app_store_rank_snapshots
  add column if not exists beijing_date date,
  add column if not exists beijing_hour integer,
  add column if not exists is_final_snapshot boolean not null default false,
  add column if not exists previous_rank integer,
  add column if not exists rank_change integer;

alter table public.google_play_rank_snapshots
  add column if not exists beijing_date date,
  add column if not exists beijing_hour integer,
  add column if not exists is_final_snapshot boolean not null default false,
  add column if not exists previous_rank integer,
  add column if not exists rank_change integer;

update public.app_store_rank_snapshots
set
  beijing_date = coalesce(beijing_date, (snapshot_at at time zone 'Asia/Shanghai')::date),
  beijing_hour = coalesce(beijing_hour, extract(hour from snapshot_at at time zone 'Asia/Shanghai')::integer),
  is_final_snapshot = coalesce(is_final_snapshot, false) or extract(hour from snapshot_at at time zone 'Asia/Shanghai')::integer = 21
where beijing_date is null
  or beijing_hour is null;

update public.google_play_rank_snapshots
set
  beijing_date = coalesce(beijing_date, (snapshot_at at time zone 'Asia/Shanghai')::date),
  beijing_hour = coalesce(beijing_hour, extract(hour from snapshot_at at time zone 'Asia/Shanghai')::integer),
  is_final_snapshot = coalesce(is_final_snapshot, false) or extract(hour from snapshot_at at time zone 'Asia/Shanghai')::integer = 21
where beijing_date is null
  or beijing_hour is null;

create index if not exists app_store_rank_snapshots_cleanup_idx
  on public.app_store_rank_snapshots (beijing_date, is_final_snapshot);

create index if not exists google_play_rank_snapshots_cleanup_idx
  on public.google_play_rank_snapshots (beijing_date, is_final_snapshot);
