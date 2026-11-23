-- LOCAL ONLY. Preserve 00300 history and all existing transcripts/reservations.
-- The reservation gate/leases remain provider-independent. Do not reset old failures.
-- Usage belongs in private state, never in publicly readable transcript metadata.
alter table ll_private.transcript_extractions add column usage jsonb;

create or replace function public.finish_transcript_extraction(p_source_id uuid,p_language text,p_token uuid,p_text text,p_metadata jsonb)
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
    or p_metadata->>'providerId' is distinct from 'transcriptfetch'
    or coalesce(p_metadata->>'returnedLanguage','') !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
    or char_length(p_metadata->>'returnedLanguage')>35
    or lower(split_part(p_metadata->>'returnedLanguage','-',1)) is distinct from p_language
    or coalesce(p_metadata->>'providerVersion','') !~ '^sdk-[0-9]+\.[0-9]+\.[0-9]+-captions-v1$'
    then raise exception 'Invalid extraction metadata'; end if;
  if p_metadata ? 'usage' then
    if jsonb_typeof(p_metadata->'usage') is distinct from 'object'
      or jsonb_typeof(p_metadata->'usage'->'creditsSpent') is distinct from 'number'
      or (p_metadata->'usage'->>'creditsSpent')::numeric<0
      or jsonb_typeof(p_metadata->'usage'->'bytes') is distinct from 'number'
      or (p_metadata->'usage'->>'bytes')::numeric<0
      or jsonb_typeof(p_metadata->'usage'->'balance') not in ('number','null')
      or not (p_metadata->'usage' ? 'balance')
      or (p_metadata->'usage'->>'balance')::numeric<0
      then raise exception 'Invalid private usage'; end if;
  end if;
  for entry in select value from jsonb_array_elements(p_metadata->'segments') loop
    if jsonb_typeof(entry->'start') is distinct from 'number' or jsonb_typeof(entry->'duration') is distinct from 'number'
      or (entry->>'start')::numeric<0 or (entry->>'duration')::numeric<0
      or (entry->>'start')::numeric+(entry->>'duration')::numeric>14400
      or jsonb_typeof(entry->'text') is distinct from 'string' or char_length(btrim(entry->>'text'))=0
      then raise exception 'Invalid timestamp segment'; end if;
  end loop;
  select string_agg(value->>'text',' ' order by ordinal) into joined
    from jsonb_array_elements(p_metadata->'segments') with ordinality as entries(value,ordinal);
  if joined is distinct from p_text then raise exception 'Segment text mismatch'; end if;
  if not exists(select 1 from public.transcripts where source_id=p_source_id and language=p_language
    and (expires_at is null or expires_at>now())) then
    if char_length(p_text) not between 1 and 40000 or octet_length(p_text)>80000 then raise exception 'Transcript exceeds MVP limits'; end if;
    select coalesce(max(version),0)+1 into next_version from public.transcripts where source_id=p_source_id and language=p_language;
    insert into public.transcripts(source_id,text_content,language,content_hash,provenance,provider_id,provider_version,version,metadata)
      values(p_source_id,p_text,p_language,encode(sha256(convert_to(p_text,'UTF8')),'hex'),'licensed_provider',
        p_metadata->>'providerId',p_metadata->>'providerVersion',next_version,p_metadata-'usage');
  end if;
  update ll_private.transcript_extractions set status='succeeded',updated_at=clock_timestamp(),usage=p_metadata->'usage'
    where source_id=p_source_id and language=p_language and token=p_token;
  return true;
end;
$$;
revoke all on function public.finish_transcript_extraction(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.finish_transcript_extraction(uuid,text,uuid,text,jsonb) to service_role;
