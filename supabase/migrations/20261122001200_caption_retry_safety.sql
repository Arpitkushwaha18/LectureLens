-- Forward-only. Only definitive upstream rejections are safe to retry.
-- Client timeouts, malformed paid responses, lost leases and historical unknown jobs remain fenced.
alter table ll_private.automatic_caption_jobs add column attempts integer not null default 1;
alter table ll_private.automatic_caption_jobs add column available_at timestamptz not null default now();
create or replace function public.reserve_automatic_captions(p_source_id uuid) returns table(disposition text,token uuid)
language plpgsql security invoker set search_path='' as $$
declare job ll_private.automatic_caption_jobs;
begin
 perform pg_advisory_xact_lock(611210003);
 perform 1 from public.learning_sources where id=p_source_id and source_type='youtube' for update;
 if not found then raise exception 'Source required';end if;
 if exists(select 1 from public.transcripts where source_id=p_source_id and provenance='licensed_provider' and (expires_at is null or expires_at>now())) then return query select 'cached'::text,null::uuid;return;end if;
 if exists(select 1 from ll_private.transcript_extractions where source_id=p_source_id and status in('running','failed')) then return query select 'failed'::text,null::uuid;return;end if;
 select * into job from ll_private.automatic_caption_jobs where source_id=p_source_id for update;
 if found then
  if job.status='failed' and job.error_code='TRANSCRIPT_UNAVAILABLE' then return query select 'unavailable'::text,null::uuid;return;end if;
  if job.status='running' then return query select case when job.leased_until>clock_timestamp() then 'pending' else 'failed' end,null::uuid;return;end if;
  if job.status='failed' and job.error_code in('TRANSCRIPT_RATE_LIMITED','TRANSCRIPT_UPSTREAM_UNAVAILABLE') and job.attempts<3 then
   if job.available_at>clock_timestamp() then return query select 'cooldown'::text,null::uuid;return;end if;
  else return query select 'failed'::text,null::uuid;return;end if;
 end if;
 if (select count(*) from ll_private.automatic_caption_jobs where status='running' and leased_until>clock_timestamp())>=2 then return query select 'busy'::text,null::uuid;return;end if;
 insert into ll_private.automatic_caption_jobs(source_id,status,leased_until) values(p_source_id,'running',clock_timestamp()+interval '120 seconds')
 on conflict(source_id) do update set status='running',token=gen_random_uuid(),run_id=null,error_code=null,attempts=ll_private.automatic_caption_jobs.attempts+1,leased_until=clock_timestamp()+interval '120 seconds'
 returning * into job;
 return query select 'reserved'::text,job.token;
end;$$;
create or replace function public.fail_automatic_captions(p_source_id uuid,p_token uuid,p_code text) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update ll_private.automatic_caption_jobs set status='failed',error_code=left(p_code,64),available_at=clock_timestamp()+interval '60 seconds'
 where source_id=p_source_id and token=p_token and status='running';return found;
end;$$;
revoke all on function public.reserve_automatic_captions(uuid),public.fail_automatic_captions(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_automatic_captions(uuid),public.fail_automatic_captions(uuid,uuid,text) to service_role;
create or replace function public.youtube_storage_health() returns jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('ready',
  to_regprocedure('public.reserve_automatic_captions(uuid)') is not null and
  to_regprocedure('public.finish_automatic_captions(uuid,uuid,text,jsonb)') is not null and
  to_regprocedure('public.record_automatic_caption_run(uuid,uuid,text)') is not null and
  to_regprocedure('public.claim_youtube_notebook(text,uuid,text,text,text,integer,boolean)') is not null and
  exists(select 1 from information_schema.columns where table_schema='ll_private' and table_name='automatic_caption_jobs' and column_name='attempts') and
  has_table_privilege(current_user,'ll_private.automatic_caption_jobs','SELECT,INSERT,UPDATE') and
  has_table_privilege(current_user,'ll_private.youtube_note_jobs','SELECT,INSERT,UPDATE') and
  has_table_privilege(current_user,'ll_private.youtube_saved_notes','SELECT,INSERT,UPDATE'));
$$;
revoke all on function public.youtube_storage_health() from public,anon,authenticated;
grant execute on function public.youtube_storage_health() to service_role;
notify pgrst,'reload schema';
