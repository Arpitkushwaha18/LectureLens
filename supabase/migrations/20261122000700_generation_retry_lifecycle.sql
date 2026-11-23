-- LOCAL ONLY. Requires approval before hosted application. No historical rows removed.
alter table public.generation_jobs add column failure_kind text check(failure_kind in ('definitive','uncertain','not_sent')),
 add column operation_identity text,add column request_identity text;
create function ll_private.generation_operation(p_source uuid,p_hash text,p_output text,p_language text)
returns text language sql immutable set search_path='' as $$
 select encode(sha256(convert_to(jsonb_build_array(p_source,p_hash,p_output,p_language)::text,'UTF8')),'hex');
$$;
update public.generation_jobs j set operation_identity=ll_private.generation_operation(c.source_id,t.content_hash,c.output_type,c.language),
 request_identity=encode(sha256(convert_to(jsonb_build_array(c.source_id,t.content_hash,c.output_type,c.language,c.model_identifier,c.generation_settings,c.prompt_version,c.output_schema_version)::text,'UTF8')),'hex')
from public.generated_content c left join public.transcripts t on t.id=c.transcript_id where j.generated_content_id=c.id;
create function ll_private.generation_job_identity() returns trigger language plpgsql set search_path='' as $$
declare c public.generated_content; hash text;
begin select * into c from public.generated_content where id=new.generated_content_id;
 select content_hash into hash from public.transcripts where id=c.transcript_id;
 new.operation_identity:=ll_private.generation_operation(c.source_id,hash,c.output_type,c.language);
 new.request_identity:=encode(sha256(convert_to(jsonb_build_array(c.source_id,hash,c.output_type,c.language,c.model_identifier,c.generation_settings,c.prompt_version,c.output_schema_version)::text,'UTF8')),'hex');return new;end;
$$;
create trigger generation_job_identity before insert on public.generation_jobs for each row execute function ll_private.generation_job_identity();
create index generation_jobs_operation_status on public.generation_jobs(operation_identity,status);
create index generation_jobs_request_status on public.generation_jobs(request_identity,status);
create index generation_jobs_history on public.generation_jobs(generated_content_id,created_at desc);
-- Outstanding queued/cooldown reservations remain deduplicated by the existing partial
-- unique indexes. Failed/cancelled/succeeded rows are already excluded from those indexes.
-- Advisory operation locks additionally serialize claims across model/settings identities.
create table ll_private.generation_attempts(token uuid primary key,job_id uuid not null references public.generation_jobs(id),
 number integer not null,status text not null,started_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz,error_code text,provider_status integer,request_id text,request_sent boolean);
create index generation_attempts_job on ll_private.generation_attempts(job_id,number);
alter table ll_private.generation_attempts enable row level security;
grant all on ll_private.generation_attempts to service_role;
create function ll_private.definitive_generation_failure(code text) returns boolean language sql immutable set search_path='' as $$
 select coalesce(code=any(array['GEMINI_QUOTA','GEMINI_TEMPORARY','GEMINI_CREDENTIALS','GEMINI_MODEL_NOT_FOUND','GEMINI_REQUEST_INVALID','GEMINI_INVALID_OUTPUT','GEMINI_CONFIGURATION','GEMINI_MODEL_UNAVAILABLE','GEMINI_MODEL_LIMIT','GEMINI_NOT_CONFIGURED','GENERATION_AUDIT_UNAVAILABLE','GENERATION_NOT_SENT','GENERATION_CANCELLED_BEFORE_SEND']),false);
$$;
-- Legacy error codes classify terminal rows only: an old running row can carry
-- the PREVIOUS attempt's error, so its outcome remains unknown.
update public.generation_jobs set failure_kind=case when ll_private.definitive_generation_failure(last_error_code) then 'definitive' else 'uncertain' end where status in ('failed','cancelled');

create function public.reconcile_generation(p_job_id uuid) returns boolean language plpgsql security invoker set search_path='' as $$
declare job public.generation_jobs; code text;
begin
 select * into job from public.generation_jobs where id=p_job_id;if not found then return false;end if;
 perform pg_advisory_xact_lock(hashtextextended(job.operation_identity,0));
 perform 1 from public.generated_content where id=job.generated_content_id for update;
 select * into job from public.generation_jobs where id=p_job_id for update;
 if job.status not in ('running','failed','cancelled') then return false;end if;
 if job.status='running' and job.leased_until>clock_timestamp() then return false;end if;
 if job.completion_checkpoint is not null then
  if jsonb_typeof(job.completion_checkpoint)<>'object' or job.completion_checkpoint->>'schemaVersion'<>'1' then return false;end if;
  insert into ll_private.generation_audit(job_id,actor,kind,details) values(p_job_id,'automatic','completion_recovered',to_jsonb(job)-'completion_checkpoint');
  update public.generated_content set status='ready',payload=job.completion_checkpoint,generated_at=clock_timestamp() where id=job.generated_content_id;
  update public.generation_jobs set status='succeeded',finished_at=clock_timestamp(),lease_owner=null,lease_token=null,leased_until=null where id=p_job_id;
  update ll_private.generation_attempts set status='completed',finished_at=clock_timestamp() where token=job.lease_token;return true;
 end if;
 if job.status<>'running' then return false;end if;
 if job.request_may_have_been_sent is distinct from false and (job.provider_status is null or job.provider_status not in(400,401,403,404,429,500,502,503,504)) then return false;end if;
 code:=case when job.request_may_have_been_sent=false then 'GENERATION_CANCELLED_BEFORE_SEND'
 when job.provider_status in(401,403) then 'GEMINI_CREDENTIALS' when job.provider_status=400 then 'GEMINI_REQUEST_INVALID'
 when job.provider_status=404 then 'GEMINI_MODEL_NOT_FOUND' when job.provider_status=429 then 'GEMINI_QUOTA' else 'GEMINI_TEMPORARY' end;
 insert into ll_private.generation_audit(job_id,actor,kind,details) values(p_job_id,'automatic','expired_attempt_reconciled',to_jsonb(job)-'completion_checkpoint');
 update public.generation_jobs set status='failed',finished_at=clock_timestamp(),lease_owner=null,lease_token=null,leased_until=null,last_error_code=code,failure_kind='definitive' where id=p_job_id;
 update public.generated_content set status='failed',payload=null,generated_at=null where id=job.generated_content_id;
 update ll_private.generation_attempts set status='failed',finished_at=clock_timestamp(),error_code=code where token=job.lease_token;return true;
end;
$$;

create or replace function public.reserve_generation(p_source_id uuid,p_transcript_id uuid,p_output_type text,p_language text,
 p_model_identifier text,p_prompt_version text,p_output_schema_version integer,p_generation_settings jsonb default '{}'::jsonb)
returns table(content_id uuid,job_id uuid,disposition text) language plpgsql security invoker set search_path='' as $$
declare c public.generated_content; previous public.generation_jobs; op text; request_key text; hash text; candidate uuid;
begin
 select content_hash into hash from public.transcripts where id=p_transcript_id and source_id=p_source_id and (expires_at is null or expires_at>now());
 if not found then raise exception 'Transcript unavailable';end if;
 op:=ll_private.generation_operation(p_source_id,hash,p_output_type,p_language);
 request_key:=encode(sha256(convert_to(jsonb_build_array(p_source_id,hash,p_output_type,p_language,p_model_identifier,p_generation_settings,p_prompt_version,p_output_schema_version)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(op,0));
 for candidate in select id from public.generation_jobs where operation_identity=op and status in('running','failed','cancelled') order by generated_content_id loop perform public.reconcile_generation(candidate);end loop;
 select content.* into c from public.generation_jobs j join public.generated_content content on content.id=j.generated_content_id where j.request_identity=request_key and content.status='ready' and(content.expires_at is null or content.expires_at>now()) order by content.generated_at desc limit 1;
 if found then return query select c.id,null::uuid,'reused'::text;return;end if;
 insert into public.generated_content(source_id,transcript_id,output_type,language,model_identifier,prompt_version,output_schema_version,generation_settings)
 values(p_source_id,p_transcript_id,p_output_type,p_language,p_model_identifier,p_prompt_version,p_output_schema_version,p_generation_settings)
 on conflict(cache_identity) do update set cache_identity=excluded.cache_identity returning * into c;
 if c.status='ready' and(c.expires_at is null or c.expires_at>now()) then return query select c.id,null::uuid,'reused'::text;return;end if;
 select * into previous from public.generation_jobs where operation_identity=op and
 (status='running' or(status in('failed','cancelled') and not ll_private.definitive_generation_failure(last_error_code) and operator_resolution is distinct from 'retry_approved')) order by created_at desc limit 1;
 if found then return query select previous.generated_content_id,previous.id,case when previous.status='running' then 'existing_job' else 'failed' end;return;end if;
 select * into previous from public.generation_jobs where request_identity=request_key and status in('queued','retry_wait') order by created_at desc limit 1;
 if found then return query select previous.generated_content_id,previous.id,'existing_job'::text;return;end if;
 select * into previous from public.generation_jobs where generated_content_id=c.id and status in('failed','cancelled') order by created_at desc limit 1;
 if found then insert into ll_private.generation_audit(job_id,actor,kind,details) values(previous.id,'automatic','definitive_attempt_superseded',jsonb_build_object('error',previous.last_error_code,'status',previous.status));end if;
 update public.generated_content set status='pending',payload=null,generated_at=null,expires_at=null where id=c.id;
 insert into public.generation_jobs(generated_content_id,idempotency_key,available_at) values(c.id,c.cache_identity,greatest(clock_timestamp(),coalesce(previous.available_at,clock_timestamp()))) returning id into candidate;
 return query select c.id,candidate,'reserved'::text;
end;
$$;

create or replace function public.claim_generation(p_job_id uuid) returns uuid language plpgsql security invoker set search_path='' as $$
declare token uuid; job public.generation_jobs;
begin
 select * into job from public.generation_jobs where id=p_job_id;if not found then return null;end if;
 perform pg_advisory_xact_lock(hashtextextended(job.operation_identity,0));
 if exists(select 1 from public.generation_jobs j where j.id<>p_job_id and j.operation_identity=job.operation_identity and
 (j.status='running' or(j.status in('failed','cancelled') and not ll_private.definitive_generation_failure(j.last_error_code) and j.operator_resolution is distinct from 'retry_approved'))) then return null;end if;
 perform 1 from public.generated_content c join public.learning_sources s on s.id=c.source_id join public.transcripts t on t.id=c.transcript_id
 where c.id=job.generated_content_id and c.status='pending' and c.output_type='detailed_notes' and s.source_type='youtube' and s.visibility='published' and(t.expires_at is null or t.expires_at>now()) for update of c;
 if not found then return null;end if;
 update public.generation_jobs set status='running',attempts=attempts+1,lease_owner='lifecycle-v2',lease_token=gen_random_uuid(),leased_until=now()+interval '180 seconds',
 request_may_have_been_sent=false,provider_status=null,provider_request_id=null,completion_checkpoint=null,operator_resolution=null,failure_kind=null
 where id=p_job_id and status in('queued','retry_wait') and available_at<=clock_timestamp() and attempts<max_attempts returning lease_token into token;
 if token is not null then
 insert into ll_private.generation_attempts(token,job_id,number,status,request_sent) values(token,p_job_id,job.attempts+1,'running',false);
 insert into ll_private.generation_audit(job_id,actor,kind,details) values(p_job_id,'worker','claimed',jsonb_build_object('token',token,'attempt',job.attempts+1));end if;return token;
end;
$$;

create or replace function public.record_generation_evidence(p_job_id uuid,p_token uuid,p_event jsonb,p_checkpoint jsonb default null)
returns boolean language plpgsql security invoker set search_path='' as $$begin
 if p_event->>'kind' not in('dispatch','response','validated','failure','not_sent') then raise exception 'Invalid evidence';end if;
 update public.generation_jobs set request_may_have_been_sent=case when p_event->>'kind'='dispatch' then true when p_event->>'kind'='not_sent' then false else request_may_have_been_sent end,
 provider_status=coalesce((p_event->>'httpStatus')::integer,provider_status),provider_request_id=coalesce(p_event->>'requestId',provider_request_id),completion_checkpoint=coalesce(p_checkpoint,completion_checkpoint),
 available_at=case when p_event->>'kind'='response' and (p_event->>'httpStatus')::integer in(429,500,502,503,504) then greatest(available_at,clock_timestamp()+make_interval(secs=>greatest(coalesce((p_event->>'retryAfterSeconds')::integer,60),least(300,ceil(60*power(2,mod(greatest(1,attempts)-1,3))*(1+random()*0.25))::integer)))) else available_at end
 where id=p_job_id and status='running' and lease_token=p_token and(p_event->>'kind'<>'dispatch' or leased_until>clock_timestamp());if not found then return false;end if;
 update ll_private.generation_attempts set request_sent=case when p_event->>'kind'='dispatch' then true when p_event->>'kind'='not_sent' then false else request_sent end,
 provider_status=coalesce((p_event->>'httpStatus')::integer,provider_status),request_id=coalesce(p_event->>'requestId',request_id) where token=p_token;
 insert into ll_private.generation_audit(job_id,actor,kind,details) values(p_job_id,'worker',p_event->>'kind',p_event);return true;end;$$;

-- Failure transition and cooldown are ONE transaction; no later unfenced timestamp patch.
create function public.fail_generation_attempt(p_job_id uuid,p_token uuid,p_code text,p_retryable boolean,p_delay_seconds integer default 60)
returns boolean language plpgsql security invoker set search_path='' as $$
declare job public.generation_jobs; next_status text; safe boolean;
begin select * into job from public.generation_jobs where id=p_job_id;
 perform 1 from public.generated_content where id=job.generated_content_id for update;
 select * into job from public.generation_jobs where id=p_job_id for update;
 if not found or job.status<>'running' or job.lease_token is distinct from p_token then return false;end if;
 safe:=ll_private.definitive_generation_failure(p_code);
 next_status:=case when safe and p_retryable and job.attempts<job.max_attempts then 'retry_wait' else 'failed' end;
 insert into ll_private.generation_audit(job_id,actor,kind,details) values(p_job_id,'worker','failure',jsonb_build_object('token',p_token,'classification',p_code,'retryable',safe and p_retryable,'before',to_jsonb(job)-'completion_checkpoint'));
 update public.generation_jobs set status=next_status,finished_at=case when next_status='failed' then clock_timestamp() else null end,
 available_at=clock_timestamp()+make_interval(secs=>case when safe and p_retryable then greatest(1,p_delay_seconds) else 0 end),lease_owner=null,lease_token=null,leased_until=null,last_error_code=p_code,
 failure_kind=case when safe then 'definitive' else 'uncertain' end where id=p_job_id;
 update public.generated_content set status=case when next_status='retry_wait' then 'pending' else 'failed' end,payload=null,generated_at=null,expires_at=null where id=job.generated_content_id;
 update ll_private.generation_attempts set status=case when safe then 'failed' else 'uncertain' end,error_code=p_code,finished_at=clock_timestamp() where token=p_token;return true;
end;$$;
create or replace function public.fail_generation(p_job_id uuid,p_token uuid,p_code text,p_retryable boolean)
returns boolean language sql security invoker set search_path='' as $$select public.fail_generation_attempt(p_job_id,p_token,p_code,p_retryable,60);$$;

-- Keep the original validated/published-source completion checks; audit the token as terminal.
do $$declare definition text;begin
 definition:=pg_get_functiondef('public.finish_generation(uuid,uuid,jsonb)'::regprocedure);
 definition:=replace(definition,'return true;', 'update ll_private.generation_attempts set status=''completed'',finished_at=clock_timestamp() where token=p_token;
 insert into ll_private.generation_audit(job_id,actor,kind,details) values(p_job_id,''worker'',''completed'',jsonb_build_object(''token'',p_token)); return true;');execute definition;
 definition:=pg_get_functiondef('public.operator_recover_generation(uuid,text,text,text,text,boolean)'::regprocedure);
 definition:=replace(definition,'or job.attempts>=job.max_attempts','');
 definition:=replace(definition,'set status=''retry_wait'',finished_at=null,available_at=clock_timestamp()', 'set status=''retry_wait'',operator_resolution=''retry_approved'',finished_at=null,available_at=clock_timestamp(),max_attempts=least(10,greatest(max_attempts,attempts+1))');
 execute definition;
end;$$;
revoke all on function ll_private.generation_operation(uuid,text,text,text),ll_private.generation_job_identity(),ll_private.definitive_generation_failure(text),
 public.reconcile_generation(uuid),public.fail_generation_attempt(uuid,uuid,text,boolean,integer) from public,anon,authenticated;
grant execute on function ll_private.generation_operation(uuid,text,text,text),ll_private.generation_job_identity(),ll_private.definitive_generation_failure(text),
 public.reconcile_generation(uuid),public.fail_generation_attempt(uuid,uuid,text,boolean,integer) to service_role;
