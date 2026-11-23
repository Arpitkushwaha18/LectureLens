-- LOCAL ONLY. Forward-only hardening; preserves resources, history and paid jobs.
create or replace function public.study_find(p_shared text,p_owner uuid) returns uuid language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from public.study_resources where shared_key=p_shared and state='removed') then raise exception 'Resource identity removed; operator review required';end if;
 return (select id from public.study_resources where shared_key=p_shared and state='ready' and (visibility='published' or owner_id=p_owner) order by (visibility='published') desc limit 1);
end;
$$;
create function public.study_removal_fence() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from public.study_resources where shared_key=new.shared_key and state='removed') then raise exception 'Resource identity removed; operator review required';end if;
 return new;
end;
$$;
create trigger study_no_republish_removed before insert or update of visibility on public.study_resources for each row execute function public.study_removal_fence();
create function public.study_related(p_source text,p_subject text,p_outputs jsonb) returns jsonb language sql security invoker set search_path='' as $$
 select coalesce(jsonb_agg(public.study_summary(id,null)),'[]'::jsonb) from(
 select r.id from public.study_resources r join ll_private.study_provenance p on p.resource_id=r.id
 where r.state='ready' and r.visibility='published' and (p.source_identity=p_source or (p_subject is not null and lower(r.subject)=lower(p_subject)))
 and p_outputs ? r.output_type order by r.created_at desc limit 50) selected;
$$;
revoke all on function public.study_find(text,uuid),public.study_removal_fence(),public.study_related(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.study_find(text,uuid),public.study_removal_fence(),public.study_related(text,text,jsonb) to service_role;
