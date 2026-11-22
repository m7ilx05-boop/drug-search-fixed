alter table public.page_read_outcomes add column if not exists match_terms text[];
comment on column public.page_read_outcomes.match_terms is 'Normalized names (trade, Arabic, ingredients) the page lists, saved when it was rejected only because it did not match a search. Lets drug-refresh skip the page for any later search whose name matches none of them.';
