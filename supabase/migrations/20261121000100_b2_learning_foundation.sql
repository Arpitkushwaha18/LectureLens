-- Additive foundation. A name collision intentionally fails rather than masking a
-- different existing schema. Supabase migration runner supplies the transaction.
create schema ll_private;
revoke all on schema ll_private from public, anon, authenticated;

create table public.learning_sources (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('youtube', 'pdf', 'spreadsheet')),
  youtube_video_id text,
  content_hash text,
  owner_id uuid references auth.users(id) on delete restrict,
  visibility text not null default 'private' check (visibility in ('private', 'published')),
  canonical_identity text not null,
  processing_status text not null default 'pending'
    check (processing_status in ('pending', 'processing', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint learning_source_shape check (
    (source_type = 'youtube' and youtube_video_id is not null and youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
      and char_length(youtube_video_id) = 11 and content_hash is null
      and owner_id is null and visibility = 'published'
      and canonical_identity = 'https://www.youtube.com/watch?v=' || youtube_video_id)
    or
    (source_type in ('pdf', 'spreadsheet') and youtube_video_id is null
      and content_hash is not null and content_hash ~ '^[a-f0-9]{64}$' and char_length(content_hash) = 64
      and owner_id is not null and canonical_identity = 'sha256:' || content_hash)
  )
);
create unique index learning_sources_youtube_unique
  on public.learning_sources(youtube_video_id) where source_type = 'youtube';
-- Identical private bytes uploaded by different students must NOT merge ownership.
create unique index learning_sources_document_owner_unique
  on public.learning_sources(owner_id, source_type, content_hash) where source_type <> 'youtube';
create index learning_sources_owner_idx on public.learning_sources(owner_id);
create index learning_sources_published_idx on public.learning_sources(id) where visibility = 'published';

create table public.transcripts (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.learning_sources(id) on delete restrict,
  text_content text not null check (char_length(btrim(text_content)) > 0 and char_length(text_content) <= 100000),
  language text not null check (language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$' and char_length(language) <= 35),
  provenance text not null check (provenance in ('manual', 'authorized_youtube', 'licensed_provider')),
  provider_id text not null check (provider_id ~ '^[a-z][a-z0-9_-]{0,63}$' and char_length(provider_id) <= 64),
  provider_version text not null check (char_length(btrim(provider_version)) between 1 and 64),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$' and char_length(content_hash) = 64),
  version integer not null default 1 check (version > 0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  obtained_at timestamptz not null default now(),
  expires_at timestamptz check (expires_at > obtained_at),
  created_at timestamptz not null default now(),
  unique (id, source_id),
  unique (source_id, language, version)
);

create table public.generated_content (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.learning_sources(id) on delete restrict,
  transcript_id uuid,
  foreign key (transcript_id, source_id) references public.transcripts(id, source_id) on delete restrict,
  output_type text not null check (output_type in
    ('detailed_notes', 'short_notes', 'flashcards', 'mindmap', 'mcq_quiz', 'sample_question_paper')),
  language text not null check (language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$' and char_length(language) <= 35),
  model_identifier text not null check (char_length(btrim(model_identifier)) between 1 and 128),
  prompt_version text not null check (char_length(btrim(prompt_version)) between 1 and 64),
  output_schema_version integer not null check (output_schema_version > 0),
  generation_settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(generation_settings) = 'object' and octet_length(generation_settings::text) <= 16384),
  cache_identity text not null unique check (char_length(cache_identity) = 64),
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed', 'invalidated')),
  payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  generated_at timestamptz,
  expires_at timestamptz,
  check ((status = 'ready' and payload is not null and jsonb_typeof(payload) = 'object' and generated_at is not null)
    or (status <> 'ready' and payload is null)),
  check (expires_at is null or (generated_at is not null and expires_at > generated_at))
);
create index generated_content_source_idx on public.generated_content(source_id);
create index generated_content_transcript_idx on public.generated_content(transcript_id, source_id);

-- Source/output/configuration are normalized on generated_content, not copied here.
create table public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  generated_content_id uuid not null references public.generated_content(id) on delete restrict,
  idempotency_key text not null check (char_length(idempotency_key) = 64),
  status text not null default 'queued' check (status in ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10 and attempts <= max_attempts),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_token uuid,
  leased_until timestamptz,
  last_error_code text check (char_length(last_error_code) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((status = 'running' and lease_owner is not null and lease_token is not null and leased_until is not null)
    or (status <> 'running' and lease_owner is null and lease_token is null and leased_until is null)),
  check ((status in ('succeeded', 'failed', 'cancelled')) = (finished_at is not null))
);
create unique index generation_jobs_one_active_content
  on public.generation_jobs(generated_content_id) where status in ('queued', 'running', 'retry_wait');
create unique index generation_jobs_one_active_key
  on public.generation_jobs(idempotency_key) where status in ('queued', 'running', 'retry_wait');
create index generation_jobs_due_idx on public.generation_jobs(available_at) where status in ('queued', 'retry_wait');

create function ll_private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end;
$$;
create trigger sources_updated before update on public.learning_sources
  for each row execute function ll_private.touch_updated_at();
create trigger content_updated before update on public.generated_content
  for each row execute function ll_private.touch_updated_at();
create trigger jobs_updated before update on public.generation_jobs
  for each row execute function ll_private.touch_updated_at();

create function ll_private.guard_source_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.id, new.source_type, new.youtube_video_id, new.content_hash, new.owner_id, new.canonical_identity)
    is distinct from (old.id, old.source_type, old.youtube_video_id, old.content_hash, old.owner_id, old.canonical_identity)
  then raise exception 'Source identity is immutable'; end if;
  return new;
end;
$$;
create trigger sources_identity before update on public.learning_sources
  for each row execute function ll_private.guard_source_identity();

create function ll_private.guard_transcript() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'expires_at') is distinct from (to_jsonb(old) - 'expires_at')
  then raise exception 'Create a new transcript version instead of overwriting it'; end if;
  if new.content_hash <> encode(sha256(convert_to(new.text_content, 'UTF8')), 'hex')
  then raise exception 'Transcript hash does not match UTF-8 text'; end if;
  return new;
end;
$$;
create trigger transcripts_identity before insert or update on public.transcripts
  for each row execute function ll_private.guard_transcript();

-- Database-authoritative JSONB serialization makes settings key order irrelevant.
-- Cache version is independent of the B1 and B1.5 shared wire-schema versions.
create function ll_private.canonical_settings(value jsonb) returns jsonb
language sql immutable strict set search_path = '' as $$
  select case jsonb_typeof(value)
    when 'object' then coalesce((select jsonb_object_agg(key, ll_private.canonical_settings(val))
      from jsonb_each(value) as fields(key, val)), '{}'::jsonb)
    when 'array' then coalesce((select jsonb_agg(ll_private.canonical_settings(val) order by position)
      from jsonb_array_elements(value) with ordinality as items(val, position)), '[]'::jsonb)
    when 'number' then to_jsonb(trim_scale((value #>> '{}')::numeric))
    else value end;
$$;
create function ll_private.set_content_cache_identity() returns trigger
language plpgsql set search_path = '' as $$
declare s public.learning_sources; t public.transcripts; identity_document jsonb;
begin
  new.language := lower(btrim(new.language));
  new.model_identifier := btrim(new.model_identifier);
  new.prompt_version := btrim(new.prompt_version);
  new.generation_settings := ll_private.canonical_settings(new.generation_settings);
  if tg_op = 'UPDATE' and
    (new.id, new.source_id, new.transcript_id, new.output_type, new.language, new.model_identifier,
      new.prompt_version, new.output_schema_version, new.generation_settings)
    is distinct from
    (old.id, old.source_id, old.transcript_id, old.output_type, old.language, old.model_identifier,
      old.prompt_version, old.output_schema_version, old.generation_settings)
  then raise exception 'Generation configuration is immutable'; end if;
  select * into strict s from public.learning_sources where id = new.source_id;
  if new.transcript_id is not null then
    select * into strict t from public.transcripts where id = new.transcript_id and source_id = new.source_id;
  elsif s.source_type = 'youtube' then
    raise exception 'YouTube generation requires a versioned transcript';
  end if;
  identity_document := jsonb_build_object(
    'cache_version', 1, 'source_id', s.id, 'source_type', s.source_type,
    'source_identity', s.canonical_identity, 'source_hash', s.content_hash,
    'transcript_id', t.id, 'transcript_hash', t.content_hash, 'transcript_version', t.version,
    'output_type', new.output_type, 'language', new.language, 'model', new.model_identifier,
    'prompt_version', new.prompt_version, 'output_schema_version', new.output_schema_version,
    'settings', new.generation_settings);
  new.cache_identity := encode(sha256(convert_to(identity_document::text, 'UTF8')), 'hex');
  return new;
end;
$$;
create trigger content_cache_identity before insert or update on public.generated_content
  for each row execute function ll_private.set_content_cache_identity();

create function ll_private.guard_job_identity() returns trigger
language plpgsql set search_path = '' as $$
declare expected text;
begin
  if tg_op = 'UPDATE' and (new.id, new.generated_content_id, new.idempotency_key)
    is distinct from (old.id, old.generated_content_id, old.idempotency_key)
  then raise exception 'Job identity is immutable'; end if;
  select cache_identity into strict expected from public.generated_content where id = new.generated_content_id;
  if new.idempotency_key <> expected then raise exception 'Job idempotency key must match content identity'; end if;
  return new;
end;
$$;
create trigger jobs_identity before insert or update on public.generation_jobs
  for each row execute function ll_private.guard_job_identity();

alter table public.learning_sources enable row level security;
alter table public.transcripts enable row level security;
alter table public.generated_content enable row level security;
alter table public.generation_jobs enable row level security;

-- Revoke Supabase defaults on these tables only; do not alter unrelated objects.
revoke all on public.learning_sources, public.transcripts,
  public.generated_content, public.generation_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.learning_sources,
  public.transcripts, public.generated_content, public.generation_jobs to service_role;

-- No browser read/write grants or policies. The MVP uses controlled backend APIs
-- which accept only canonical YouTube IDs and require published YouTube parents.
-- Private documents and job metadata cannot be accessed directly by students.

-- Service-only reservation, NOT generation. The unique content row is the lock
-- boundary; competing transactions block then reuse its valid result/active job.
create function public.reserve_generation(
  p_source_id uuid, p_transcript_id uuid, p_output_type text, p_language text,
  p_model_identifier text, p_prompt_version text, p_output_schema_version integer,
  p_generation_settings jsonb default '{}'::jsonb
) returns table (content_id uuid, job_id uuid, disposition text)
language plpgsql security invoker set search_path = '' as $$
declare candidate public.generated_content; current_content public.generated_content;
  active_job uuid;
begin
  if p_transcript_id is not null and not exists (select 1 from public.transcripts t
    where t.id = p_transcript_id and t.source_id = p_source_id and (t.expires_at is null or t.expires_at > now()))
  then raise exception 'Transcript is unavailable or expired'; end if;
  -- Compute the exact identity using the same trigger as direct backend inserts.
  insert into public.generated_content(source_id, transcript_id, output_type, language,
    model_identifier, prompt_version, output_schema_version, generation_settings)
  values (p_source_id, p_transcript_id, p_output_type, lower(btrim(p_language)),
    btrim(p_model_identifier), btrim(p_prompt_version), p_output_schema_version, p_generation_settings)
  on conflict (cache_identity) do update set cache_identity = excluded.cache_identity
  returning * into candidate;
  select * into strict current_content from public.generated_content
    where id = candidate.id for update;
  if current_content.status = 'ready' and (current_content.expires_at is null or current_content.expires_at > now()) then
    return query select current_content.id, null::uuid, 'reused'::text;
    return;
  end if;
  select id into active_job from public.generation_jobs
    where generated_content_id = current_content.id and status in ('queued', 'running', 'retry_wait');
  if active_job is not null then
    return query select current_content.id, active_job, 'existing_job'::text;
    return;
  end if;
  update public.generated_content set status = 'pending', payload = null, generated_at = null, expires_at = null
    where id = current_content.id;
  insert into public.generation_jobs(generated_content_id, idempotency_key)
    values (current_content.id, current_content.cache_identity) returning id into active_job;
  return query select current_content.id, active_job, 'reserved'::text;
end;
$$;
revoke all on function public.reserve_generation(uuid, uuid, text, text, text, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.reserve_generation(uuid, uuid, text, text, text, text, integer, jsonb) to service_role;
-- Trigger helpers are not API endpoints and cannot be invoked by students.
revoke all on all functions in schema ll_private from public, anon, authenticated;
grant usage on schema ll_private to service_role;
grant execute on all functions in schema ll_private to service_role;
