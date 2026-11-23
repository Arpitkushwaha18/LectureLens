-- LOCAL ONLY: requires explicit approval before applying to a hosted project.
-- Forward-only function upgrades. Existing resources, cache identities and jobs remain unchanged.
do $$
declare signature text; definition text;
begin
  foreach signature in array array[
    'public.acquire_youtube_transcript(uuid,text,text,text,text,text)',
    'public.finish_transcript_extraction(uuid,text,uuid,text,jsonb)'
  ] loop
    definition := pg_get_functiondef(signature::regprocedure);
    if position('between 1 and 40000' in definition)=0 then
      raise exception 'Unexpected existing transcript function; review before upgrading';
    end if;
    definition := replace(replace(replace(definition,
      'between 1 and 40000','between 1 and 100000'),'>80000','>400000'),
      'Transcript exceeds MVP limits','Transcript exceeds 100,000-character limit; split the source');
    execute definition;
  end loop;
end;
$$;

create or replace function public.claim_generation(p_job_id uuid) returns uuid
language plpgsql security invoker set search_path='' as $$
declare token uuid; content_id uuid; current_content public.generated_content;
begin
  select generated_content_id into content_id from public.generation_jobs where id=p_job_id;
  select * into current_content from public.generated_content where id=content_id;
  if not found then return null; end if;
  -- Serialize paid claims across model/prompt identities for the SAME source/output.
  perform pg_advisory_xact_lock(hashtextextended(current_content.source_id::text || ':' ||
    current_content.transcript_id::text || ':' || current_content.output_type,0));
  if exists(select 1 from public.generation_jobs j join public.generated_content c on c.id=j.generated_content_id
    where j.id<>p_job_id and c.source_id=current_content.source_id
      and c.transcript_id=current_content.transcript_id and c.output_type=current_content.output_type
      and (j.status='running' or (j.status='failed' and j.last_error_code in
        ('GEMINI_UNCERTAIN','GEMINI_TIMEOUT','GEMINI_CONNECTION')))) then return null; end if;
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
  return token;
end;
$$;
revoke all on function public.claim_generation(uuid) from public,anon,authenticated;
grant execute on function public.claim_generation(uuid) to service_role;
