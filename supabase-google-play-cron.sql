create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'collect-google-play-hourly'
  ) then
    perform cron.unschedule('collect-google-play-hourly');
  end if;
end $$;

select cron.schedule(
  'collect-google-play-hourly',
  '55 * * * *',
  $$
  select net.http_get(
    url := 'https://store-insight-dashboard.vercel.app/api/collect-google-play?secret=store-insight-cron-2026-strong-secret',
    headers := '{"User-Agent":"Supabase Cron"}'::jsonb,
    timeout_milliseconds := 30000
  ) as request_id;
  $$
);
