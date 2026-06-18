create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'collect-app-store-hourly'
  ) then
    perform cron.unschedule('collect-app-store-hourly');
  end if;

  if exists (
    select 1
    from cron.job
    where jobname = 'collect-google-play-hourly'
  ) then
    perform cron.unschedule('collect-google-play-hourly');
  end if;

  if exists (
    select 1
    from cron.job
    where jobname = 'collect-app-store-scheduled'
  ) then
    perform cron.unschedule('collect-app-store-scheduled');
  end if;

  if exists (
    select 1
    from cron.job
    where jobname = 'collect-google-play-scheduled'
  ) then
    perform cron.unschedule('collect-google-play-scheduled');
  end if;

  if exists (
    select 1
    from cron.job
    where jobname = 'collect-google-play-events-daily'
  ) then
    perform cron.unschedule('collect-google-play-events-daily');
  end if;
end $$;

select cron.schedule(
  'collect-app-store-scheduled',
  '10 1,5,9,13,16,21 * * *',
  $$
  select net.http_get(
    url := 'https://store-insight-dashboard.vercel.app/api/collect-app-store?secret=store-insight-cron-2026-strong-secret',
    headers := '{"User-Agent":"Supabase Cron"}'::jsonb,
    timeout_milliseconds := 30000
  ) as request_id;
  $$
);

select cron.schedule(
  'collect-google-play-scheduled',
  '10 1,5,9,13,16,21 * * *',
  $$
  select net.http_get(
    url := 'https://store-insight-dashboard.vercel.app/api/collect-google-play?secret=store-insight-cron-2026-strong-secret',
    headers := '{"User-Agent":"Supabase Cron"}'::jsonb,
    timeout_milliseconds := 30000
  ) as request_id;
  $$
);

select cron.schedule(
  'collect-google-play-events-daily',
  '20 16 * * *',
  $$
  select net.http_get(
    url := 'https://store-insight-dashboard.vercel.app/api/collect-google-play-events?secret=store-insight-cron-2026-strong-secret',
    headers := '{"User-Agent":"Supabase Cron"}'::jsonb,
    timeout_milliseconds := 30000
  ) as request_id;
  $$
);
