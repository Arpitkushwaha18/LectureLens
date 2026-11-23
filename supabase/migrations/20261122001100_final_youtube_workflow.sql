-- Forward-only. Dependencies: 001 through 007 and 009 (008/010 retain historical library data).
-- No existing rows, jobs, permissions audits or migration history are deleted.
alter table ll_private.automatic_caption_jobs add column run_id text;
create function public.record_automatic_caption_run(p_source_id uuid,p_token uuid,p_run_id text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update ll_private.automatic_caption_jobs set run_id=left(p_run_id,200),leased_until=greatest(leased_until,clock_timestamp()+interval '120 seconds')
 where source_id=p_source_id and token=p_token and status='running' and leased_until>clock_timestamp();
 return found;
end;$$;

create table ll_private.youtube_note_jobs(
 identity text primary key,source_id uuid not null references public.learning_sources(id),
 transcript_id uuid not null references public.transcripts(id),output_type text not null check(output_type in('detailed_notes','short_notes')),
 content_hash text not null,actual_language text not null,model text not null,prompt_version text not null,schema_version integer not null check(schema_version=2),
 status text not null check(status in('running','failed','succeeded')),token uuid not null default gen_random_uuid(),
 sent boolean not null default false,checkpoint jsonb,error_code text,retry_safe boolean not null default false,
 leased_until timestamptz not null,available_at timestamptz not null default now(),created_at timestamptz not null default now()
);
create table ll_private.youtube_saved_notes(
 identity text primary key references ll_private.youtube_note_jobs(identity),payload jsonb not null,
 created_at timestamptz not null default now(),check(payload->>'schemaVersion'='2' and jsonb_typeof(payload->'blocks')='array' and jsonb_array_length(payload->'blocks')>0)
);
alter table ll_private.youtube_note_jobs enable row level security;
alter table ll_private.youtube_saved_notes enable row level security;
revoke all on ll_private.youtube_note_jobs,ll_private.youtube_saved_notes from public,anon,authenticated;
grant select,insert,update on ll_private.youtube_note_jobs,ll_private.youtube_saved_notes to service_role;

create function public.claim_youtube_notebook(p_video_id text,p_transcript_id uuid,p_output text,p_model text,p_prompt text,p_schema integer,p_check boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare t public.transcripts;s public.learning_sources;j ll_private.youtube_note_jobs;k text;n jsonb;
begin
 select * into t from public.transcripts where id=p_transcript_id and (expires_at is null or expires_at>now());
 select * into s from public.learning_sources where id=t.source_id and youtube_video_id=p_video_id;
 if t.id is null or s.id is null or p_output not in('detailed_notes','short_notes') or p_schema<>2 or char_length(p_model) not between 1 and 120 or char_length(p_prompt) not between 1 and 120 then raise exception 'Invalid notebook source or identity';end if;
 k:=encode(sha256(convert_to(jsonb_build_array(p_video_id,t.content_hash,t.language,p_output,p_model,p_prompt,p_schema)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_video_id,t.content_hash,t.language,p_output)::text,0));
 select payload into n from ll_private.youtube_saved_notes where identity=k;
 if found then return jsonb_build_object('status','ready','identity',k,'notebook',n);end if;
 select * into j from ll_private.youtube_note_jobs where identity=k for update;
 if found and j.checkpoint is not null then
  insert into ll_private.youtube_saved_notes(identity,payload) values(k,j.checkpoint) on conflict do nothing;
  update ll_private.youtube_note_jobs set status='succeeded' where identity=k;
  return jsonb_build_object('status','ready','identity',k,'notebook',j.checkpoint);
 end if;
 if found and (j.status='running' and (j.sent or j.leased_until>clock_timestamp()) or j.status='failed' and not j.retry_safe) then return jsonb_build_object('status','pending','identity',k);end if;
 if found and j.available_at>clock_timestamp() then return jsonb_build_object('status','cooldown','identity',k);end if;
 if exists(select 1 from ll_private.youtube_note_jobs where source_id=s.id and content_hash=t.content_hash and actual_language=t.language and output_type=p_output and identity<>k and (status='running' and (sent or leased_until>clock_timestamp()) or status='failed' and not retry_safe)) then return jsonb_build_object('status','pending','identity',k);end if;
 if p_check then return jsonb_build_object('status','missing','identity',k);end if;
 -- Do not abandon older uncertain paid work when changing the storage/prompt.
 if exists(select 1 from public.generation_jobs g join public.generated_content c on c.id=g.generated_content_id where c.source_id=s.id and c.transcript_id=t.id and c.output_type=p_output and (g.status in('queued','running','retry_wait') or g.status in('failed','cancelled') and coalesce(g.last_error_code,'') not in('GEMINI_QUOTA','GEMINI_TEMPORARY','GEMINI_MODEL_NOT_FOUND','GEMINI_INVALID_OUTPUT','GENERATION_NOT_SENT','GENERATION_CANCELLED_BEFORE_SEND'))) then return jsonb_build_object('status','pending','identity',k);end if;
 insert into ll_private.youtube_note_jobs(identity,source_id,transcript_id,output_type,content_hash,actual_language,model,prompt_version,schema_version,status,leased_until)
 values(k,s.id,t.id,p_output,t.content_hash,t.language,p_model,p_prompt,p_schema,'running',clock_timestamp()+interval '240 seconds')
 on conflict(identity) do update set status='running',token=gen_random_uuid(),sent=false,retry_safe=false,error_code=null,leased_until=clock_timestamp()+interval '240 seconds'
 returning * into j;
 return jsonb_build_object('status','reserved','identity',k,'token',j.token);
end;$$;
create function public.youtube_notebook_evidence(p_identity text,p_token uuid,p_event jsonb,p_checkpoint jsonb default null)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 if p_checkpoint is not null and (p_checkpoint->>'schemaVersion' is distinct from '2' or jsonb_typeof(p_checkpoint->'blocks') is distinct from 'array' or jsonb_array_length(p_checkpoint->'blocks')<1) then raise exception 'Invalid notebook';end if;
 update ll_private.youtube_note_jobs set sent=case when p_event->>'kind'='dispatch' then true when p_event->>'kind'='not_sent' then false else sent end,
 checkpoint=coalesce(p_checkpoint,checkpoint),leased_until=greatest(leased_until,clock_timestamp()+interval '240 seconds')
 where identity=p_identity and token=p_token and status='running';return found;
end;$$;
create function public.finish_youtube_notebook(p_identity text,p_token uuid,p_payload jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 perform 1 from ll_private.youtube_note_jobs where identity=p_identity and token=p_token and status='running' for update;if not found then return false;end if;
 if p_payload->>'schemaVersion' is distinct from '2' or jsonb_typeof(p_payload->'blocks') is distinct from 'array' or jsonb_array_length(p_payload->'blocks')<1 then raise exception 'Invalid notebook';end if;
 insert into ll_private.youtube_saved_notes(identity,payload) values(p_identity,p_payload) on conflict do nothing;
 update ll_private.youtube_note_jobs set status='succeeded',checkpoint=p_payload where identity=p_identity;return true;
end;$$;
create function public.fail_youtube_notebook(p_identity text,p_token uuid,p_code text,p_safe boolean)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update ll_private.youtube_note_jobs set status='failed',error_code=left(p_code,64),retry_safe=p_safe and p_code in('GEMINI_QUOTA','GEMINI_TEMPORARY','GEMINI_MODEL_NOT_FOUND','GEMINI_INVALID_OUTPUT','GEMINI_CREDENTIALS','GEMINI_REQUEST_INVALID','GENERATION_NOT_SENT','GENERATION_CANCELLED_BEFORE_SEND'),available_at=clock_timestamp()+interval '60 seconds'
 where identity=p_identity and token=p_token and status='running';return found;
end;$$;
create function public.youtube_storage_health() returns jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('ready',to_regprocedure('public.reserve_automatic_captions(uuid)') is not null and to_regprocedure('public.finish_automatic_captions(uuid,uuid,text,jsonb)') is not null and to_regprocedure('public.record_automatic_caption_run(uuid,uuid,text)') is not null and to_regprocedure('public.claim_youtube_notebook(text,uuid,text,text,text,integer,boolean)') is not null);
$$;
revoke all on function public.record_automatic_caption_run(uuid,uuid,text),public.claim_youtube_notebook(text,uuid,text,text,text,integer,boolean),public.youtube_notebook_evidence(text,uuid,jsonb,jsonb),public.finish_youtube_notebook(text,uuid,jsonb),public.fail_youtube_notebook(text,uuid,text,boolean),public.youtube_storage_health() from public,anon,authenticated;
grant execute on function public.record_automatic_caption_run(uuid,uuid,text),public.claim_youtube_notebook(text,uuid,text,text,text,integer,boolean),public.youtube_notebook_evidence(text,uuid,jsonb,jsonb),public.finish_youtube_notebook(text,uuid,jsonb),public.fail_youtube_notebook(text,uuid,text,boolean),public.youtube_storage_health() to service_role;
notify pgrst,'reload schema';
-- Retain historical library rows, but withdraw the discontinued public feed and publication capability.
do $$begin
 if to_regclass('public.study_resources') is not null then
  revoke all on public.study_resources,public.study_resource_entries from anon,authenticated;
  revoke execute on function public.study_publish(uuid,uuid,jsonb) from service_role;
 end if;
end;$$;
