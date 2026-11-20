-- Closest real brand names to a (possibly misread) name, from the Egyptian drug reference list. Read-only; callable only with the service role.
-- (Applied to the project as migration "rx_fuzzy_names".)
create or replace function public.rx_fuzzy_names(p_name text, p_limit int default 6)
returns table(brand text, scientific_name text, score numeric)
language sql
stable
set search_path = public, extensions
as $$
  with q as (
    select lower(regexp_replace(coalesce(p_name,''), '[^A-Za-z]', '', 'g')) as k
  ),
  base as (
    select
      initcap(trim(substring(d.commercial_name_en from '^[A-Za-z][A-Za-z\-]*(?: [A-Za-z][A-Za-z\-]*)?(?= \d| [A-Z]{0,3}\.|$)'))) as brand,
      d.scientific_name,
      lower(regexp_replace(split_part(trim(d.commercial_name_en), ' ', 1), '[^A-Za-z]', '', 'g')) as bk
    from public.ref_egyptian_drugs d, q
    where length(q.k) >= 4 and d.commercial_name_en is not null
      and lower(left(d.commercial_name_en, 1)) = left(q.k, 1)
  ),
  scored as (
    select b.brand, b.scientific_name, b.bk,
      1 - (levenshtein(b.bk, q.k)::numeric / greatest(length(b.bk), length(q.k))) as lev_sim
    from base b, q
    where b.brand is not null and length(b.bk) >= 3
  )
  select s.brand, min(s.scientific_name) as scientific_name, round(max(s.lev_sim), 2) as score
  from scored s
  where s.lev_sim >= 0.6
  group by s.brand
  order by max(s.lev_sim) desc, s.brand
  limit greatest(1, least(p_limit, 10));
$$;
revoke all on function public.rx_fuzzy_names(text, int) from public, anon, authenticated;
grant execute on function public.rx_fuzzy_names(text, int) to service_role;
