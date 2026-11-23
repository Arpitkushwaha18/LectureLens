-- LOCAL ONLY. Requires explicit hosted approval; no historical jobs/resources are removed.
alter table public.generation_jobs add column provider_status integer,
 add column provider_request_id text, add column request_may_have_been_sent boolean,
 add column completion_checkpoint jsonb, add column operator_resolution text;
create table ll_private.generation_audit(id bigint generated always as identity primary key,
 job_id uuid not null references public.generation_jobs(id), at timestamptz not null default clock_timestamp(),
 actor text not null,kind text not null,details jsonb not null);
alter table ll_private.generation_audit enable row level security;
grant all on ll_private.generation_audit to service_role;
grant usage,select on sequence ll_private.generation_audit_id_seq to service_role;
do $$ declare definition text; begin
 definition:=pg_get_functiondef('public.claim_generation(uuid)'::regprocedure);
 if position('return token;' in definition)=0 then raise exception 'Unexpected claim definition'; end if;
 definition:=replace(definition,'j.status=''failed'' and j.last_error_code in','j.status=''failed'' and (j.operator_resolution is not null or j.last_error_code in');
 definition:=replace(definition,'(''GEMINI_UNCERTAIN'',''GEMINI_TIMEOUT'',''GEMINI_CONNECTION'')))) then', '(''GEMINI_UNCERTAIN'',''GEMINI_TIMEOUT'',''GEMINI_CONNECTION''))))) then');
 definition:=replace(definition,'return token;',
 'if token is not null then
 update public.generation_jobs set request_may_have_been_sent=false,provider_status=null,provider_request_id=null,completion_checkpoint=null,operator_resolution=null,last_error_code=null where id=p_job_id;
 insert into ll_private.generation_audit(job_id,actor,kind,details) values(p_job_id,''worker'',''claimed'',''{}''::jsonb);
 end if; return token;'); execute definition;
end $$;
create function public.record_generation_evidence(p_job_id uuid,p_token uuid,p_event jsonb,p_checkpoint jsonb default null)
returns boolean language plpgsql security invoker set search_path='' as $$ begin
 if p_event->>'kind' not in ('dispatch','response','validated','failure') then raise exception 'Invalid evidence'; end if;
 update public.generation_jobs set
 request_may_have_been_sent=case when p_event->>'kind'='dispatch' then true else request_may_have_been_sent end,
 provider_status=coalesce((p_event->>'httpStatus')::integer,provider_status),provider_request_id=coalesce(p_event->>'requestId',provider_request_id),
 completion_checkpoint=coalesce(p_checkpoint,completion_checkpoint) where id=p_job_id and status='running' and lease_token=p_token and (p_event->>'kind'<>'dispatch' or leased_until>clock_timestamp());
 if not found then return false; end if;
 insert into ll_private.generation_audit(job_id,actor,kind,details) values(p_job_id,'worker',p_event->>'kind',p_event); return true;
end $$;
create function public.operator_recover_generation(p_job_id uuid,p_revision text,p_action text,p_reason text,p_actor text,p_ack boolean default false)
returns boolean language plpgsql security invoker set search_path='' as $$
declare job public.generation_jobs; content_id uuid; output jsonb; resolved_code text;
begin
 if char_length(trim(p_reason)) not between 20 and 1000 or char_length(p_actor)<8 then raise exception 'Audit reason required'; end if;
 select generated_content_id into content_id from public.generation_jobs where id=p_job_id;
 perform 1 from public.generated_content where id=content_id for update;
 select * into job from public.generation_jobs where id=p_job_id for update;
 if not found or job.updated_at is distinct from p_revision::timestamptz then raise exception 'Job changed'; end if;
 select payload into output from public.generated_content where id=content_id and status='ready';
 if output is not null then return true; end if;
 if job.completion_checkpoint is not null and p_action<>'recover_output' then raise exception 'Recover the completed output instead'; end if;
 if p_action='recover_output' then
 output:=job.completion_checkpoint;
 if output is null or jsonb_typeof(output)<>'object' or output->>'schemaVersion'<>'1' then raise exception 'No validated completion'; end if;
 update public.generated_content set status='ready',payload=output,generated_at=clock_timestamp() where id=content_id;
 update public.generation_jobs set status='succeeded',finished_at=clock_timestamp(),lease_owner=null,lease_token=null,leased_until=null,operator_resolution=p_action where id=p_job_id;
 else
 if job.status='running' and job.leased_until>clock_timestamp() then raise exception 'Active lease cannot be released'; end if;
 if p_action='confirm_rejected' then
 if job.provider_status is null or job.provider_status not in (400,401,403,404,429) then raise exception 'No definitive rejection'; end if;
 resolved_code:=case job.provider_status when 400 then 'GEMINI_REQUEST_INVALID' when 404 then 'GEMINI_MODEL_NOT_FOUND' when 429 then 'GEMINI_QUOTA' else 'GEMINI_CREDENTIALS' end;
 elsif p_action='confirm_not_sent' then
 if job.request_may_have_been_sent is distinct from false then raise exception 'Dispatch cannot be ruled out'; end if; resolved_code:='GENERATION_NOT_SENT';
 elsif p_action='resolve_abandoned' then
 if not p_ack then raise exception 'Explicit acknowledgment of possible charge required'; end if; resolved_code:='OPERATOR_ABANDONED';
 elsif p_action='approve_retry' then
 if job.operator_resolution is null or job.operator_resolution not in ('confirm_rejected','confirm_not_sent','resolve_abandoned') or job.attempts>=job.max_attempts then raise exception 'Retry unsafe or exhausted'; end if;
 update public.generation_jobs set status='retry_wait',finished_at=null,available_at=clock_timestamp(),lease_owner=null,lease_token=null,leased_until=null where id=p_job_id;
 update public.generated_content set status='pending',payload=null,generated_at=null where id=content_id;
 else raise exception 'Unsupported action'; end if;
 if p_action<>'approve_retry' then
 update public.generation_jobs set status='failed',finished_at=clock_timestamp(),lease_owner=null,lease_token=null,leased_until=null,operator_resolution=p_action,last_error_code=resolved_code where id=p_job_id;
 update public.generated_content set status='failed',payload=null,generated_at=null where id=content_id;
 end if; end if;
 insert into ll_private.generation_audit(job_id,actor,kind,details) values(p_job_id,p_actor,p_action,jsonb_build_object('reason',p_reason,'acknowledgePossibleCharge',p_ack,'before',to_jsonb(job)-'completion_checkpoint')); return true;
end $$;
revoke all on function public.record_generation_evidence(uuid,uuid,jsonb,jsonb),public.operator_recover_generation(uuid,text,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.record_generation_evidence(uuid,uuid,jsonb,jsonb),public.operator_recover_generation(uuid,text,text,text,text,boolean) to service_role;
