-- Pages that a normal search read and rejected, so the same search does not read them again for 30 days.
-- query_key = the normalized searched name when the page was rejected only because it does not match that search;
-- '*' when the page is rejected for its own content (valid for every search until rules_version changes).
create table if not exists public.page_read_outcomes (
  page_key text not null,
  query_key text not null,
  outcome text not null check (outcome in ('rejected_query', 'rejected_page')),
  reason text,
  rules_version integer not null,
  read_at timestamptz not null default now(),
  primary key (page_key, query_key)
);
create index if not exists page_read_outcomes_page_idx on public.page_read_outcomes (page_key);
alter table public.page_read_outcomes enable row level security;
comment on table public.page_read_outcomes is 'Rejected page reads (per search or per page) used by drug-refresh to skip re-reading for 30 days; service role only.';
