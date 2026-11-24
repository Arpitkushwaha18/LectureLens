-- New lifecycle for private document/activity/tutor generation, not a duplicate
-- resources table. Shared YouTube notebook lifecycle and all historical jobs remain intact.
-- Apply manually after 001–015. Rollback by disabling new generation; retain jobs
-- and grants needed for reconciliation. NEVER drop a table with unresolved paid jobs.
create table ll_private.study_generation_jobs (
 identity text primary key check(identity ~ '^[a-f0-9]{64}$'),
 operation text not null check(operation ~ '^[a-f0-9]{64}$'),
 status text not null check(status in('running','ready','failed','retry_wait','blocked')),
 token uuid, deadline timestamptz, attempts integer not null default 1 check(attempts>0),
 request_sent boolean not null default false, provider_status integer,
 checkpoint jsonb, payload jsonb, error_code text, retry_at timestamptz,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 evidence jsonb not null default '[]'::jsonb
);
create index study_generation_operation on ll_private.study_generation_jobs(operation,status);
alter table ll_private.study_generation_jobs enable row level security;
revoke all on ll_private.study_generation_jobs from public,anon,authenticated;
grant select,insert,update on ll_private.study_generation_jobs to service_role;

create function public.study_generation(p_key text,p_operation text,p_action text,p_token uuid,p_value jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r ll_private.study_generation_jobs; other ll_private.study_generation_jobs;
 safe boolean; delay integer; code text; lease integer; fresh uuid; stored_operation text;
begin
 if p_key !~ '^[a-f0-9]{64}$' or p_operation !~ '^[a-f0-9]{64}$' then raise exception 'Invalid generation identity';end if;
 if p_action not in('read','check','claim','evidence','checkpoint','finish','fail','cancel') then raise exception 'Invalid operation';end if;
 -- The identity lock also prevents two first claims with different model/operation
 -- inputs from overwriting the same live lease through ON CONFLICT.
 perform pg_advisory_xact_lock(hashtextextended('key:'||p_key,0));
 select operation into stored_operation from ll_private.study_generation_jobs where identity=p_key;
 p_operation:=coalesce(stored_operation,p_operation);
 perform pg_advisory_xact_lock(hashtextextended(p_operation,0));
 -- Reconcile only proved outcomes. A timeout without evidence stays fenced forever.
 for other in select * from ll_private.study_generation_jobs where p_action in('read','check','claim') and (identity=p_key or operation=p_operation) and status='running' and deadline<=clock_timestamp() for update loop
  if other.checkpoint is not null then
   update ll_private.study_generation_jobs set status='ready',payload=checkpoint,token=null,deadline=null,updated_at=clock_timestamp() where identity=other.identity;
  elsif not other.request_sent or other.provider_status in(400,401,403,404,410,429,500,502,503,504) then
   update ll_private.study_generation_jobs set status='failed',token=null,deadline=null,
    error_code=case when not other.request_sent then 'GENERATION_CANCELLED_BEFORE_SEND' when other.provider_status=429 then 'GEMINI_QUOTA' when other.provider_status in(500,502,503,504) then 'GEMINI_TEMPORARY' else 'GEMINI_REQUEST_INVALID' end,
    retry_at=coalesce(retry_at,clock_timestamp()),updated_at=clock_timestamp() where identity=other.identity;
  else
   update ll_private.study_generation_jobs set status='blocked',error_code='JOB_RECOVERY_REQUIRED',updated_at=clock_timestamp() where identity=other.identity;
  end if;
 end loop;
 select * into r from ll_private.study_generation_jobs where identity=p_key for update;
 if p_action='read' then
  if r.checkpoint is not null and r.status<>'running' then
   update ll_private.study_generation_jobs set status='ready',payload=checkpoint,token=null,deadline=null,updated_at=clock_timestamp() where identity=p_key returning * into r;
  end if;
  return case when r.status='ready' then jsonb_build_object('notebook',r.payload) else '{}'::jsonb end;
 end if;
 safe:=not exists(select 1 from ll_private.study_generation_jobs where (identity=p_key or operation=p_operation) and status in('running','blocked'));
 delay:=greatest(0,ceil(extract(epoch from (coalesce(r.retry_at,clock_timestamp())-clock_timestamp())))::integer);
 code:=coalesce(r.error_code,'GENERATION_NOT_SENT');
 if p_action='check' then return jsonb_build_object('safe',safe,'code',case when safe then code else 'JOB_RECOVERY_REQUIRED' end,'delay',delay);end if;
 if p_action='claim' then
  if r.status='ready' then return jsonb_build_object('status','ready');end if;
  if not safe then return jsonb_build_object('status','blocked');end if;
  if delay>0 then return jsonb_build_object('status','cooldown','delay',delay);end if;
  if coalesce(r.attempts,0)>=3 then return jsonb_build_object('status','exhausted');end if;
  lease:=least(360000,greatest(60000,coalesce((p_value->>'leaseMs')::integer,360000)));
  fresh:=gen_random_uuid();
  insert into ll_private.study_generation_jobs(identity,operation,status,token,deadline)
   values(p_key,p_operation,'running',fresh,clock_timestamp()+lease*interval '1 millisecond')
   on conflict(identity) do update set status='running',token=fresh,deadline=excluded.deadline,attempts=study_generation_jobs.attempts+1,
   request_sent=false,provider_status=null,checkpoint=null,error_code=null,retry_at=null,updated_at=clock_timestamp();
  return jsonb_build_object('status','reserved','token',fresh);
 end if;
 if p_token is null or r.identity is null or r.token is distinct from p_token or not (r.status='running' or (r.status='blocked' and p_action in('checkpoint','finish','fail') or r.status='blocked' and p_action='evidence' and p_value->>'kind'='response')) then raise exception 'Generation lease lost';end if;
 if p_action='evidence' then
  if p_value->>'kind'='dispatch' and r.deadline<=clock_timestamp() then raise exception 'Generation lease expired';end if;
  update ll_private.study_generation_jobs set
   request_sent=case p_value->>'kind' when 'dispatch' then true when 'not_sent' then false else request_sent end,
   provider_status=coalesce((p_value->>'httpStatus')::integer,provider_status),
   evidence=evidence||jsonb_build_array(jsonb_build_object('at',clock_timestamp(),'event',p_value)),updated_at=clock_timestamp()
   where identity=p_key;
 elsif p_action='checkpoint' then
   if jsonb_typeof(p_value) is distinct from 'object' or p_value->>'schemaVersion' is distinct from '2' then raise exception 'Invalid checkpoint';end if;
  update ll_private.study_generation_jobs set checkpoint=p_value,updated_at=clock_timestamp() where identity=p_key;
 elsif p_action='finish' then
  if r.checkpoint is null then raise exception 'Validated checkpoint required';end if;
  update ll_private.study_generation_jobs set status='ready',payload=checkpoint,token=null,deadline=null,updated_at=clock_timestamp() where identity=p_key;
 elsif p_action='cancel' then
  if r.request_sent then raise exception 'Cannot cancel dispatched generation';end if;
  update ll_private.study_generation_jobs set status='failed',token=null,deadline=null,error_code='GENERATION_CANCELLED_BEFORE_SEND',updated_at=clock_timestamp() where identity=p_key;
 elsif p_action='fail' then
  code:=p_value->>'code';
  safe:=coalesce(code in('GEMINI_QUOTA','GEMINI_TEMPORARY','GEMINI_CREDENTIALS','GEMINI_MODEL_NOT_FOUND','GENERATION_ENDPOINT_RETIRED','GEMINI_REQUEST_INVALID','GEMINI_INVALID_OUTPUT','GEMINI_CONFIGURATION','GEMINI_MODEL_UNAVAILABLE','GEMINI_MODEL_LIMIT','GEMINI_NOT_CONFIGURED','GENERATION_AUDIT_UNAVAILABLE','GENERATION_NOT_SENT','GENERATION_CANCELLED_BEFORE_SEND'),false);
  delay:=least(86400,greatest(1,coalesce((p_value->>'retryAfterSeconds')::integer,60))*least(4,r.attempts));
  update ll_private.study_generation_jobs set status=case when checkpoint is not null then 'ready' when not safe then 'blocked' else 'failed' end,
   payload=case when checkpoint is not null then checkpoint else payload end,token=null,deadline=null,error_code=code,
   retry_at=clock_timestamp()+delay*interval '1 second',updated_at=clock_timestamp() where identity=p_key;
 end if;
 return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.study_generation(text,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.study_generation(text,text,text,uuid,jsonb) to service_role;
