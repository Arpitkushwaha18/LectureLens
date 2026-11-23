-- LOCAL ONLY: review before applying. Four public resource tables are unchanged.
-- Timestamp segments live in transcripts.metadata; manual/text clients remain compatible.
create table ll_private.transcript_extractions (
  source_id uuid not null references public.learning_sources(id) on delete restrict,
  language text not null check (language in ('en','hi')),
  status text not null check (status in ('running','succeeded','failed')),
  token uuid not null default gen_random_uuid(),
  run_id text check (run_id ~ '^[A-Za-z0-9]{1,64}$'),
  leased_until timestamptz not null,
  error_code text check (char_length(error_code) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_id, language)
);
create index transcript_extractions_running on ll_private.transcript_extractions(leased_until) where status='running';
create index transcript_extractions_created on ll_private.transcript_extractions(created_at);
alter table ll_private.transcript_extractions enable row level security;
revoke all on ll_private.transcript_extractions from public, anon, authenticated;
grant select, insert, update on ll_private.transcript_extractions to service_role;

create function public.reserve_transcript_extraction(p_source_id uuid, p_language text)
returns table(disposition text, token uuid)
language plpgsql security invoker set search_path='' as $$
declare job ll_private.transcript_extractions;
begin
  -- Global bounded gate, then parent lock. All completion uses the same parent-first order.
  perform pg_advisory_xact_lock(611210003);
  perform 1 from public.learning_sources where id=p_source_id and source_type='youtube'
    and visibility='published' for update;
  if not found or p_language not in ('en','hi') then raise exception 'Published YouTube source and supported language required'; end if;
  if exists(select 1 from public.transcripts where source_id=p_source_id and language=p_language
    and (expires_at is null or expires_at>now())) then
    return query select 'cached'::text,null::uuid; return;
  end if;
  select * into job from ll_private.transcript_extractions where source_id=p_source_id and language=p_language for update;
  if found then
    if job.status='running' and job.leased_until>clock_timestamp() then
      return query select 'pending'::text,null::uuid;
    else
      -- Never steal an expired paid-call lease. A POST/run may have succeeded remotely.
      update ll_private.transcript_extractions set status='failed', updated_at=clock_timestamp(),
        error_code=coalesce(error_code,'EXTRACTION_RECOVERY_REQUIRED') where source_id=p_source_id and language=p_language;
      return query select 'failed'::text,null::uuid;
    end if;
    return;
  end if;
  if (select count(*) from ll_private.transcript_extractions where status='running' and leased_until>clock_timestamp())>=2
    or (select count(*) from ll_private.transcript_extractions where created_at>now()-interval '1 minute')>=10 then
    return query select 'busy'::text,null::uuid; return;
  end if;
  insert into ll_private.transcript_extractions(source_id,language,status,leased_until)
    values(p_source_id,p_language,'running',clock_timestamp()+interval '120 seconds') returning * into job;
  return query select 'reserved'::text,job.token;
end;
$$;

create function public.record_transcript_run(p_source_id uuid,p_language text,p_token uuid,p_run_id text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  update ll_private.transcript_extractions set run_id=p_run_id,updated_at=clock_timestamp()
    where source_id=p_source_id and language=p_language and token=p_token and status='running'
    and leased_until>clock_timestamp() and run_id is null;
  return found;
end;
$$;

create function public.finish_transcript_extraction(p_source_id uuid,p_language text,p_token uuid,p_text text,p_metadata jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare entry jsonb; joined text; next_version integer;
begin
  perform 1 from public.learning_sources where id=p_source_id and source_type='youtube' and visibility='published' for update;
  if not found then return false; end if;
  perform 1 from ll_private.transcript_extractions where source_id=p_source_id and language=p_language
    and token=p_token and status='running' and leased_until>clock_timestamp() for update;
  if not found then return false; end if;
  if jsonb_typeof(p_metadata) is distinct from 'object' or jsonb_typeof(p_metadata->'segments') is distinct from 'array'
    or jsonb_array_length(p_metadata->'segments') not between 1 and 10000
    or octet_length(p_metadata::text)>2000000 or p_metadata->>'requestedLanguage' is distinct from p_language
    then raise exception 'Invalid extraction metadata'; end if;
  for entry in select value from jsonb_array_elements(p_metadata->'segments') loop
    if jsonb_typeof(entry->'start') is distinct from 'number' or jsonb_typeof(entry->'duration') is distinct from 'number'
      or (entry->>'start')::numeric<0 or (entry->>'duration')::numeric<0
      or jsonb_typeof(entry->'text') is distinct from 'string' or char_length(btrim(entry->>'text'))=0
      then raise exception 'Invalid timestamp segment'; end if;
  end loop;
  select string_agg(value->>'text',' ' order by ordinal) into joined
    from jsonb_array_elements(p_metadata->'segments') with ordinality as entries(value,ordinal);
  if joined is distinct from p_text then raise exception 'Segment text mismatch'; end if;
  -- Same parent-lock/cache rules as acquire_youtube_transcript. Metadata must be
  -- inserted with the text because the existing transcript trigger is immutable.
  if not exists(select 1 from public.transcripts where source_id=p_source_id and language=p_language
    and (expires_at is null or expires_at>now())) then
    if char_length(p_text) not between 1 and 40000 or octet_length(p_text)>80000 then raise exception 'Transcript exceeds MVP limits'; end if;
    select coalesce(max(version),0)+1 into next_version from public.transcripts where source_id=p_source_id and language=p_language;
    insert into public.transcripts(source_id,text_content,language,content_hash,provenance,provider_id,provider_version,version,metadata)
      values(p_source_id,p_text,p_language,encode(sha256(convert_to(p_text,'UTF8')),'hex'),'licensed_provider','apify','faVsWy9VTSNVIhWpR-segments-v1',next_version,p_metadata);
  end if;
  update ll_private.transcript_extractions set status='succeeded',updated_at=clock_timestamp()
    where source_id=p_source_id and language=p_language and token=p_token;
  return true;
end;
$$;

create function public.fail_transcript_extraction(p_source_id uuid,p_language text,p_token uuid,p_code text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  update ll_private.transcript_extractions set status='failed',error_code=left(p_code,64),updated_at=clock_timestamp()
    where source_id=p_source_id and language=p_language and token=p_token and status='running';
  return found;
end;
$$;
revoke all on function public.reserve_transcript_extraction(uuid,text),public.record_transcript_run(uuid,text,uuid,text),
  public.finish_transcript_extraction(uuid,text,uuid,text,jsonb),public.fail_transcript_extraction(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_transcript_extraction(uuid,text),public.record_transcript_run(uuid,text,uuid,text),
  public.finish_transcript_extraction(uuid,text,uuid,text,jsonb),public.fail_transcript_extraction(uuid,text,uuid,text) to service_role;
