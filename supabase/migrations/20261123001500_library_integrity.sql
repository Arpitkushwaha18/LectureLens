-- Additive repair. Review/apply manually; no records are deleted or rewritten.
-- Rollback: keep indexes, restore prior study_list definition from migration 008.
create index if not exists study_owner_created on public.study_resources(owner_id,created_at desc,id) where state='ready';
create index if not exists study_attempt_owner_resource on public.study_quiz_attempts(owner_id,resource_id,created_at desc);
create index if not exists study_provenance_source on ll_private.study_provenance(source_identity);

create or replace function public.study_list(p_owner uuid,p_filters jsonb) returns jsonb language sql security invoker set search_path='' as $$
 with selected as (
  select r.id,r.created_at from public.study_resources r
  where r.state='ready'
   and (case when p_filters->>'scope'='mine' then r.owner_id=p_owner else r.visibility='published' end)
   and (coalesce(p_filters->>'outputType','')='' or r.output_type=p_filters->>'outputType')
   and (coalesce(p_filters->>'sourceType','')='' or r.source_type=p_filters->>'sourceType')
   and (coalesce(p_filters->>'language','')='' or r.language=p_filters->>'language')
   and (coalesce(p_filters->>'subject','')='' or r.subject=p_filters->>'subject')
   and (coalesce(p_filters->>'search','')='' or strpos(lower(r.title||' '||r.description||' '||coalesce(r.subject,'')),lower(p_filters->>'search'))>0)
  order by r.created_at desc,r.id limit 101 offset least(10000,greatest(0,coalesce((p_filters->>'offset')::integer,0)))
 )
 select jsonb_build_object(
  'data',coalesce((select jsonb_agg(public.study_summary(id,p_owner) order by created_at desc,id) from (select * from selected order by created_at desc,id limit 100) s),'[]'::jsonb),
  'hasMore',(select count(*)>100 from selected));
$$;
revoke all on function public.study_list(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.study_list(uuid,jsonb) to service_role;
