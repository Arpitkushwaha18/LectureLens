-- LOCAL ONLY. Add automatic track selection without altering legacy paid fences.
create table ll_private.automatic_caption_jobs(
 source_id uuid primary key references public.learning_sources(id) on delete restrict,
 status text not null check(status in('running','succeeded','failed')),token uuid not null default gen_random_uuid(),
 leased_until timestamptz not null, error_code text, transcript_id uuid references public.transcripts(id),
 selection_version text not null default 'transcriptfetch-provider-default-v1',created_at timestamptz not null default clock_timestamp()
);
alter table ll_private.automatic_caption_jobs enable row level security;
revoke all on ll_private.automatic_caption_jobs from public,anon,authenticated;
grant select,insert,update on ll_private.automatic_caption_jobs to service_role;
create function public.reserve_automatic_captions(p_source_id uuid) returns table(disposition text,token uuid)
language plpgsql security invoker set search_path='' as $$
declare job ll_private.automatic_caption_jobs;
begin
 perform pg_advisory_xact_lock(611210003);
 perform 1 from public.learning_sources where id=p_source_id and source_type='youtube' for update;if not found then raise exception 'Source required';end if;
 if exists(select 1 from public.transcripts where source_id=p_source_id and provenance='licensed_provider' and (expires_at is null or expires_at>now())) then return query select 'cached'::text,null::uuid;return;end if;
 -- Switching the language picker off must NEVER bypass an older uncertain POST.
 if exists(select 1 from ll_private.transcript_extractions where source_id=p_source_id and status in('running','failed')) then return query select 'failed'::text,null::uuid;return;end if;
 select * into job from ll_private.automatic_caption_jobs where source_id=p_source_id for update;
 if found then return query select case when job.status='running' and job.leased_until>clock_timestamp() then 'pending' else 'failed' end,null::uuid;return;end if;
 if (select count(*) from ll_private.automatic_caption_jobs where status='running' and leased_until>clock_timestamp())>=2 then return query select 'busy'::text,null::uuid;return;end if;
 insert into ll_private.automatic_caption_jobs(source_id,status,leased_until) values(p_source_id,'running',clock_timestamp()+interval '120 seconds') returning * into job;
 return query select 'reserved'::text,job.token;
end;
$$;
create function public.finish_automatic_captions(p_source_id uuid,p_token uuid,p_text text,p_metadata jsonb) returns boolean
language plpgsql security invoker set search_path='' as $$
declare lang text;next_version integer;transcript uuid;joined text;
begin
 perform 1 from public.learning_sources where id=p_source_id for update;
 perform 1 from ll_private.automatic_caption_jobs where source_id=p_source_id and token=p_token and status='running' and leased_until>clock_timestamp() for update;if not found then return false;end if;
 lang:=p_metadata->>'language';
 if lang is null or lang!~'^(?:[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*|und)$' or char_length(p_text) not between 1 and 100000 or octet_length(p_text)>400000 or jsonb_typeof(p_metadata->'segments') is distinct from 'array' or jsonb_array_length(p_metadata->'segments') not between 1 and 10000 then raise exception 'Invalid captions';end if;
 select string_agg(value->>'text',' ' order by ordinality) into joined from jsonb_array_elements(p_metadata->'segments') with ordinality;
 if joined is distinct from p_text then raise exception 'Caption segments mismatch';end if;
 select id into transcript from public.transcripts where source_id=p_source_id and content_hash=encode(sha256(convert_to(p_text,'UTF8')),'hex') and language=lang and (expires_at is null or expires_at>now()) limit 1;
 if not found then
 select coalesce(max(version),0)+1 into next_version from public.transcripts where source_id=p_source_id and language=lang;
 insert into public.transcripts(source_id,text_content,language,content_hash,provenance,provider_id,provider_version,version,metadata)
 values(p_source_id,p_text,lang,encode(sha256(convert_to(p_text,'UTF8')),'hex'),'licensed_provider','transcriptfetch','sdk-captions-auto-v1',next_version,p_metadata) returning id into transcript;
 end if;
 update ll_private.automatic_caption_jobs set status='succeeded',transcript_id=transcript where source_id=p_source_id and token=p_token;return true;
end;
$$;
create function public.fail_automatic_captions(p_source_id uuid,p_token uuid,p_code text) returns boolean language plpgsql security invoker set search_path='' as $$
begin update ll_private.automatic_caption_jobs set status='failed',error_code=left(p_code,64) where source_id=p_source_id and token=p_token and status='running';return found;end;
$$;
revoke all on function public.reserve_automatic_captions(uuid),public.finish_automatic_captions(uuid,uuid,text,jsonb),public.fail_automatic_captions(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_automatic_captions(uuid),public.finish_automatic_captions(uuid,uuid,text,jsonb),public.fail_automatic_captions(uuid,uuid,text) to service_role;
