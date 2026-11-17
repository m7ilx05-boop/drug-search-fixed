create table if not exists public.ema_medicine (
  ema_id text primary key,
  name text not null,
  category text,
  medicine_status text,
  active_substance text,
  substances text[] not null default '{}',
  n_substances int not null default 0,
  atc_code text,
  pharmacotherapeutic_group text,
  therapeutic_indication text,
  medicine_url text,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now()
);
create index if not exists ema_medicine_substances_gin on public.ema_medicine using gin (substances);
alter table public.ema_medicine enable row level security;
