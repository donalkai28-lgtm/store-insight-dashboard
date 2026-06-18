create table if not exists public.google_play_events (
  app_id text not null,
  product_key text not null,
  app_name text not null,
  event_title text not null,
  relative_end_time text,
  estimated_end_date date,
  image_url text,
  event_url text,
  collected_at timestamptz not null,
  beijing_date date not null,
  created_at timestamptz not null default now(),
  primary key (app_id, event_title, beijing_date)
);

create index if not exists google_play_events_date_idx
  on public.google_play_events (beijing_date desc, app_id);
