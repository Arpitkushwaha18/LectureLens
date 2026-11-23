-- Service-only YouTube MVP. No client IDs, document lookup or student writes.
create function public.ensure_youtube_source(p_video_id text) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare source_id uuid;
begin
  insert into public.learning_sources(source_type, youtube_video_id, visibility, canonical_identity)
  values ('youtube', p_video_id, 'published', 'https://www.youtube.com/watch?v=' || p_video_id)
  on conflict (youtube_video_id) where source_type='youtube' do nothing;
  select id into strict source_id from public.learning_sources
    where source_type='youtube' and visibility='published' and youtube_video_id=p_video_id;
  return source_id;
end;
$$;

create function public.acquire_youtube_transcript(
  p_source_id uuid, p_text text, p_language text, p_provenance text,
  p_provider_id text, p_provider_version text
) returns table(id uuid, text_content text, content_hash text, provenance text, reused boolean)
language plpgsql security invoker set search_path = '' as $$
declare existing public.transcripts; next_version integer;
begin
  perform 1 from public.learning_sources s where s.id=p_source_id
    and s.source_type='youtube' and s.visibility='published' for update;
  if not found then raise exception 'Published YouTube source required'; end if;
  if char_length(p_text) not between 1 and 40000 or octet_length(p_text)>80000
    or char_length(btrim(p_text))=0 then raise exception 'Transcript exceeds MVP limits'; end if;
  select * into existing from public.transcripts t where t.source_id=p_source_id
    and t.language=lower(p_language) and (t.expires_at is null or t.expires_at>now())
    order by t.version asc limit 1;
  if found then
    return query select existing.id, existing.text_content, existing.content_hash, existing.provenance, true;
    return;
  end if;
  select coalesce(max(t.version),0)+1 into next_version from public.transcripts t
    where t.source_id=p_source_id and t.language=lower(p_language);
  insert into public.transcripts(source_id, text_content, language, content_hash, provenance,
    provider_id, provider_version, version)
  values (p_source_id,p_text,lower(p_language),encode(sha256(convert_to(p_text,'UTF8')),'hex'),
    p_provenance,p_provider_id,p_provider_version,next_version) returning * into existing;
  return query select existing.id, existing.text_content, existing.content_hash, existing.provenance, false;
end;
$$;

-- Preserve the cache lock/uniqueness foundation, but block unlimited new jobs
-- after terminal failure. Retryable failures stay on the SAME bounded job.
create or replace function public.reserve_generation(
  p_source_id uuid, p_transcript_id uuid, p_output_type text, p_language text,
  p_model_identifier text, p_prompt_version text, p_output_schema_version integer,
  p_generation_settings jsonb default '{}'::jsonb
) returns table(content_id uuid, job_id uuid, disposition text)
language plpgsql security invoker set search_path = '' as $$
declare current_content public.generated_content; active_job uuid; terminal_job uuid;
begin
  if p_transcript_id is not null and not exists(select 1 from public.transcripts t
    where t.id=p_transcript_id and t.source_id=p_source_id and (t.expires_at is null or t.expires_at>now()))
  then raise exception 'Transcript is unavailable or expired'; end if;
  insert into public.generated_content(source_id,transcript_id,output_type,language,
    model_identifier,prompt_version,output_schema_version,generation_settings)
  values(p_source_id,p_transcript_id,p_output_type,p_language,p_model_identifier,p_prompt_version,
    p_output_schema_version,p_generation_settings)
  on conflict(cache_identity) do update set cache_identity=excluded.cache_identity
  returning * into current_content;
  if current_content.status='ready' and (current_content.expires_at is null or current_content.expires_at>now()) then
    return query select current_content.id,null::uuid,'reused'::text; return;
  end if;
  select id into active_job from public.generation_jobs where generated_content_id=current_content.id
    and status in ('queued','running','retry_wait');
  if active_job is not null then
    return query select current_content.id,active_job,'existing_job'::text; return;
  end if;
  select id into terminal_job from public.generation_jobs where generated_content_id=current_content.id
    and status in ('failed','cancelled') order by created_at desc limit 1;
  if terminal_job is not null then
    return query select current_content.id,terminal_job,'failed'::text; return;
  end if;
  update public.generated_content set status='pending',payload=null,generated_at=null,expires_at=null
    where id=current_content.id;
  insert into public.generation_jobs(generated_content_id,idempotency_key)
    values(current_content.id,current_content.cache_identity) returning id into active_job;
  return query select current_content.id,active_job,'reserved'::text;
end;
$$;

create function public.claim_generation(p_job_id uuid) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare token uuid; content_id uuid;
begin
  select generated_content_id into content_id from public.generation_jobs where id=p_job_id;
  perform 1 from public.generated_content c join public.learning_sources s on s.id=c.source_id
    join public.transcripts t on t.id=c.transcript_id
    where c.id=content_id and c.status='pending' and c.output_type='detailed_notes'
    and s.source_type='youtube' and s.visibility='published'
    and (t.expires_at is null or t.expires_at>now()) for update of c;
  if not found then return null; end if;
  update public.generation_jobs set status='running',attempts=attempts+1,
    lease_owner='b3-inline',lease_token=gen_random_uuid(),leased_until=now()+interval '180 seconds'
  where id=p_job_id and status in ('queued','retry_wait') and available_at<=now() and attempts<max_attempts
  returning lease_token into token;
  -- Never reclaim an expired running job: a timed-out paid call may still be
  -- executing upstream. Keep it fenced and surface a recovery-required error.
  return token;
end;
$$;

create function public.finish_generation(p_job_id uuid,p_token uuid,p_payload jsonb) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare content_id uuid;
begin
  select generated_content_id into content_id from public.generation_jobs where id=p_job_id;
  perform 1 from public.generated_content c join public.learning_sources s on s.id=c.source_id
    join public.transcripts t on t.id=c.transcript_id where c.id=content_id and c.status='pending'
    and s.source_type='youtube' and s.visibility='published'
    and (t.expires_at is null or t.expires_at>now()) for update of c;
  if not found then return false; end if;
  update public.generation_jobs set status='succeeded',finished_at=now(),lease_owner=null,
    lease_token=null,leased_until=null,last_error_code=null
    where id=p_job_id and status='running' and lease_token=p_token and leased_until>now();
  if not found then return false; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or p_payload->>'schemaVersion' is distinct from '1'
    then raise exception 'Invalid notes payload'; end if;
  update public.generated_content set status='ready',payload=p_payload,generated_at=now()
    where id=content_id;
  return true;
end;
$$;

create function public.fail_generation(p_job_id uuid,p_token uuid,p_code text,p_retryable boolean)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare content_id uuid; next_status text;
begin
  select generated_content_id into content_id from public.generation_jobs where id=p_job_id;
  perform 1 from public.generated_content where id=content_id for update;
  update public.generation_jobs set
    status=case when p_retryable and attempts<max_attempts then 'retry_wait' else 'failed' end,
    finished_at=case when p_retryable and attempts<max_attempts then null else now() end,
    available_at=now()+interval '60 seconds',lease_owner=null,lease_token=null,leased_until=null,
    last_error_code=p_code
  where id=p_job_id and status='running' and lease_token=p_token returning status into next_status;
  if not found then return false; end if;
  update public.generated_content set status=case when next_status='retry_wait' then 'pending' else 'failed' end,
    payload=null,generated_at=null,expires_at=null where id=content_id;
  return true;
end;
$$;

create function public.read_youtube_notes(p_video_id text,p_content_id uuid)
returns table(payload jsonb,transcript_id uuid,content_hash text,provenance text)
language sql stable security invoker set search_path = '' as $$
  select c.payload,t.id,t.content_hash,t.provenance from public.generated_content c
  join public.learning_sources s on s.id=c.source_id join public.transcripts t on t.id=c.transcript_id
  where s.source_type='youtube' and s.visibility='published' and s.youtube_video_id=p_video_id
    and c.id=p_content_id and c.output_type='detailed_notes' and c.status='ready'
    and (c.expires_at is null or c.expires_at>now()) and (t.expires_at is null or t.expires_at>now());
$$;

revoke all on function public.ensure_youtube_source(text),
  public.acquire_youtube_transcript(uuid,text,text,text,text,text),public.claim_generation(uuid),
  public.finish_generation(uuid,uuid,jsonb),public.fail_generation(uuid,uuid,text,boolean),
  public.read_youtube_notes(text,uuid) from public,anon,authenticated;
grant execute on function public.ensure_youtube_source(text),
  public.acquire_youtube_transcript(uuid,text,text,text,text,text),public.claim_generation(uuid),
  public.finish_generation(uuid,uuid,jsonb),public.fail_generation(uuid,uuid,text,boolean),
  public.read_youtube_notes(text,uuid) to service_role;
-- CREATE OR REPLACE preserves service-only reserve_generation grants from B2.
