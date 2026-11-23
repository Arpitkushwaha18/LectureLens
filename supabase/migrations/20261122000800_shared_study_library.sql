-- LOCAL FORWARD-ONLY migration. Do not apply to hosted Supabase without approval.
-- Existing learning_sources/transcripts/generation_jobs remain untouched.
create schema if not exists ll_private;
create table public.study_resources (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null,
 request_key text not null check(request_key ~ '^[a-f0-9]{64}$'),
 shared_key text not null check(shared_key ~ '^[a-f0-9]{64}$'),
 output_type text not null check(output_type in('detailed_notes','short_notes','flashcards','mcq_quiz','mindmap','sample_question_paper')),
 title text not null check(char_length(title) between 1 and 180), description text not null check(char_length(description) between 1 and 1000),
 subject text check(char_length(subject) between 1 and 180), language text not null, source_language text not null,
 source_type text not null check(source_type in('youtube','pdf','spreadsheet')),
 visibility text not null default 'private' check(visibility in('private','published')),
 state text not null default 'ready' check(state in('ready','removed')),
 content_version integer not null default 1 check(content_version>0),
 parameters jsonb not null check(jsonb_typeof(parameters)='object'),
 preview text not null check(char_length(preview) between 1 and 400),
 created_at timestamptz not null default clock_timestamp(), published_at timestamptz,
 unique(owner_id,request_key)
);
create unique index study_published_identity on public.study_resources(shared_key) where visibility='published' and state='ready';
create index study_library_filters on public.study_resources(visibility,state,output_type,source_type,language,created_at desc);
create table public.study_resource_entries(
 resource_id uuid not null references public.study_resources(id) on delete restrict,
 kind text not null check(kind in('block','point','card','question','map','paper_section','answer')),
 ordinal integer not null check(ordinal between 0 and 159), data jsonb not null check(jsonb_typeof(data)='object' and octet_length(data::text)<=100000),
 primary key(resource_id,kind,ordinal)
);
create table ll_private.study_provenance(
 resource_id uuid primary key references public.study_resources(id) on delete restrict,
 source_identity text not null, source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 model text not null, prompt_version text not null, provenance jsonb not null,
 -- NEVER raw files or source transcripts. Rights statements are private audit records.
 permission jsonb, published_by uuid, published_at timestamptz
);
create table public.study_quiz_attempts(
 id uuid primary key default gen_random_uuid(), owner_id uuid not null,
 resource_id uuid not null references public.study_resources(id) on delete restrict,
 submission_id uuid not null, answers jsonb not null, score integer not null, total integer not null,
 created_at timestamptz not null default clock_timestamp(),unique(owner_id,resource_id,submission_id)
);
create table ll_private.study_removals(
 id uuid primary key default gen_random_uuid(),resource_id uuid not null references public.study_resources(id),
 actor text not null,reason text not null,created_at timestamptz not null default clock_timestamp()
);
create table ll_private.study_guest_sessions(token_hash text primary key,owner_id uuid not null,created_at timestamptz not null default clock_timestamp());
alter table public.study_resources enable row level security;
alter table public.study_resource_entries enable row level security;
alter table public.study_quiz_attempts enable row level security;
alter table ll_private.study_provenance enable row level security;
alter table ll_private.study_removals enable row level security;
alter table ll_private.study_guest_sessions enable row level security;
create policy library_read on public.study_resources for select to anon,authenticated using(state='ready' and (visibility='published' or owner_id=auth.uid()));
create policy library_entries_read on public.study_resource_entries for select to anon,authenticated using(exists(select 1 from public.study_resources r where r.id=resource_id and r.state='ready' and (r.visibility='published' or r.owner_id=auth.uid())));
create policy personal_attempts_read on public.study_quiz_attempts for select to authenticated using(owner_id=auth.uid());
revoke all on public.study_resources,public.study_resource_entries,public.study_quiz_attempts from public,anon,authenticated;
grant select on public.study_resources,public.study_resource_entries to anon,authenticated;
grant select on public.study_quiz_attempts to authenticated;
grant select,insert,update on public.study_resources,public.study_resource_entries,public.study_quiz_attempts to service_role;
revoke all on ll_private.study_provenance,ll_private.study_removals,ll_private.study_guest_sessions from public,anon,authenticated;
grant select,insert,update on ll_private.study_provenance,ll_private.study_removals,ll_private.study_guest_sessions to service_role;

create function public.study_summary(p_id uuid,p_owner uuid) returns jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('id',r.id,'title',r.title,'description',r.description,'subject',r.subject,'language',r.language,'sourceLanguage',r.source_language,'sourceType',r.source_type,'outputType',r.output_type,'visibility',r.visibility,'version',r.content_version,'createdAt',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'owned',coalesce(r.owner_id=p_owner,false),'preview',r.preview)
 from public.study_resources r where r.id=p_id and r.state='ready' and (r.visibility='published' or r.owner_id=p_owner);
$$;
create function public.study_read(p_id uuid,p_owner uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.study_resources; c jsonb; key text;
begin
 select * into r from public.study_resources where id=p_id and state='ready' and (visibility='published' or owner_id=p_owner);
 if not found then return null;end if;
 c:=r.parameters||jsonb_build_object('version',r.content_version,'title',r.title,'type',r.output_type);
 if r.output_type='detailed_notes' then c:=c||jsonb_build_object('notebook',jsonb_build_object('schemaVersion',2,'title',r.title,'limitations',r.parameters->'limitations','blocks',(select jsonb_agg(data order by ordinal) from public.study_resource_entries where resource_id=r.id and kind='block')));
 else
 key:=case r.output_type when 'short_notes' then 'points' when 'flashcards' then 'cards' when 'mcq_quiz' then 'questions' when 'mindmap' then 'maps' else 'sections' end;
 c:=c||jsonb_build_object(key,(select jsonb_agg(data order by ordinal) from public.study_resource_entries where resource_id=r.id and kind=case r.output_type when 'short_notes' then 'point' when 'flashcards' then 'card' when 'mcq_quiz' then 'question' when 'mindmap' then 'map' else 'paper_section' end));
 if r.output_type='sample_question_paper' then c:=c||jsonb_build_object('answers',(select jsonb_agg(data order by ordinal) from public.study_resource_entries where resource_id=r.id and kind='answer'));end if;
 end if;
 return public.study_summary(r.id,p_owner)||jsonb_build_object('content',c);
end;
$$;
create function public.study_save(p_owner uuid,p_request text,p_shared text,p_meta jsonb,p_content jsonb,p_provenance jsonb) returns uuid language plpgsql security invoker set search_path='' as $$
declare existing uuid; new_id uuid; entries jsonb; kind text; parameters jsonb;
begin
 if p_owner is null or p_content->>'type' is distinct from p_meta->>'outputType' or p_content->>'version'<>'1' then raise exception 'Invalid resource';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_shared,0));
 select id into existing from public.study_resources where shared_key=p_shared and visibility='published' and state='ready';if found then return existing;end if;
 select id into existing from public.study_resources where owner_id=p_owner and request_key=p_request;if found then return existing;end if;
 parameters:=jsonb_build_object('limitations',p_content->'limitations');
 kind:=case p_content->>'type' when 'detailed_notes' then 'block' when 'short_notes' then 'point' when 'flashcards' then 'card' when 'mcq_quiz' then 'question' when 'mindmap' then 'map' else 'paper_section' end;
 entries:=case p_content->>'type' when 'detailed_notes' then p_content->'notebook'->'blocks' when 'short_notes' then p_content->'points' when 'flashcards' then p_content->'cards' when 'mcq_quiz' then p_content->'questions' when 'mindmap' then p_content->'maps' else p_content->'sections' end;
 if jsonb_typeof(entries) is distinct from 'array' or jsonb_array_length(entries) not between 1 and 160 then raise exception 'Invalid entries';end if;
 if p_content->>'type'='sample_question_paper' then parameters:=parameters||jsonb_build_object('instructions',p_content->'instructions','timeMinutes',p_content->'timeMinutes');end if;
 insert into public.study_resources(owner_id,request_key,shared_key,output_type,title,description,subject,language,source_language,source_type,parameters,preview)
 values(p_owner,p_request,p_shared,p_content->>'type',p_content->>'title',p_meta->>'description',p_meta->>'subject',p_meta->>'language',p_meta->>'sourceLanguage',p_meta->>'sourceType',parameters,p_meta->>'preview') returning id into new_id;
 insert into public.study_resource_entries(resource_id,kind,ordinal,data) select new_id,kind,(ordinality-1)::integer,value from jsonb_array_elements(entries) with ordinality;
 if kind='paper_section' then insert into public.study_resource_entries(resource_id,kind,ordinal,data) select new_id,'answer',(ordinality-1)::integer,value from jsonb_array_elements(p_content->'answers') with ordinality;end if;
 insert into ll_private.study_provenance(resource_id,source_identity,source_hash,model,prompt_version,provenance) values(new_id,p_provenance->>'sourceIdentity',p_provenance->>'sourceHash',p_provenance->>'model',p_provenance->>'promptVersion',p_provenance-'sourceIdentity'-'sourceHash'-'model'-'promptVersion');
 return new_id;
end;
$$;
create function public.study_find(p_shared text,p_owner uuid) returns uuid language sql security invoker set search_path='' as $$ select id from public.study_resources where shared_key=p_shared and state='ready' and (visibility='published' or owner_id=p_owner) order by (visibility='published') desc limit 1 $$;
create function public.study_list(p_owner uuid,p_filters jsonb) returns jsonb language sql security invoker set search_path='' as $$
 with selected as(select r.id from public.study_resources r where r.state='ready' and (r.visibility='published' or (p_filters->>'scope'='mine' and r.owner_id=p_owner))
 and (coalesce(p_filters->>'outputType','')='' or r.output_type=p_filters->>'outputType')
 and (coalesce(p_filters->>'sourceType','')='' or r.source_type=p_filters->>'sourceType')
 and (coalesce(p_filters->>'language','')='' or r.language=p_filters->>'language')
 and (coalesce(p_filters->>'subject','')='' or r.subject=p_filters->>'subject')
 and (coalesce(p_filters->>'search','')='' or strpos(lower(r.title||' '||r.description||' '||coalesce(r.subject,'')),lower(p_filters->>'search'))>0)
 order by r.created_at desc,r.id limit 101 offset least(10000,greatest(0,coalesce((p_filters->>'offset')::integer,0))))
 select jsonb_build_object('data',coalesce((select jsonb_agg(public.study_summary(id,p_owner)) from (select id from selected limit 100) s),'[]'::jsonb),'hasMore',(select count(*)>100 from selected));
$$;
create function public.study_publish(p_id uuid,p_owner uuid,p_permission jsonb) returns uuid language plpgsql security invoker set search_path='' as $$
declare r public.study_resources;existing uuid;
begin
 if p_permission->>'confirmRights' is distinct from 'true' or p_permission->>'confirmPlatformTerms' is distinct from 'true' or coalesce(p_permission->>'basis','') not in('own_work','licensed','permission','public_domain') or char_length(coalesce(p_permission->>'statement','')) not between 1 and 1000 then raise exception 'Publishing rights required';end if;
 select * into r from public.study_resources where id=p_id and owner_id=p_owner and state='ready' for update;if not found then raise exception 'Resource unavailable';end if;
 perform pg_advisory_xact_lock(hashtextextended(r.shared_key,0));
 select id into existing from public.study_resources where shared_key=r.shared_key and visibility='published' and state='ready';if found then return existing;end if;
 update ll_private.study_provenance set permission=p_permission,published_by=p_owner,published_at=clock_timestamp() where resource_id=r.id;
 update public.study_resources set visibility='published',published_at=clock_timestamp() where id=r.id;
 return r.id;
end;
$$;
create function public.study_remove(p_id uuid,p_actor text,p_reason text) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 if char_length(p_reason) not between 20 and 1000 then raise exception 'Removal reason required';end if;
 update public.study_resources set state='removed' where id=p_id;if not found then return false;end if;
 insert into ll_private.study_removals(resource_id,actor,reason) values(p_id,p_actor,p_reason);return true;
end;
$$;
create function public.study_submit_quiz(p_id uuid,p_owner uuid,p_submission uuid,p_answers jsonb) returns uuid language plpgsql security invoker set search_path='' as $$
declare attempt uuid;q record;score integer:=0;total integer:=0;answer integer;
begin
 if not exists(select 1 from public.study_resources where id=p_id and output_type='mcq_quiz' and state='ready' and (visibility='published' or owner_id=p_owner)) then raise exception 'Quiz unavailable';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text||p_submission::text,0));
 select id into attempt from public.study_quiz_attempts where owner_id=p_owner and resource_id=p_id and submission_id=p_submission;if found then return attempt;end if;
 if jsonb_typeof(p_answers) is distinct from 'array' or jsonb_array_length(p_answers)<>(select count(*) from public.study_resource_entries where resource_id=p_id and kind='question') then raise exception 'Invalid answers';end if;
 for q in select ordinal,data from public.study_resource_entries where resource_id=p_id and kind='question' order by ordinal loop
 answer:=(p_answers->>q.ordinal)::integer;
 if answer is not null and (answer<0 or answer>=jsonb_array_length(q.data->'options')) then raise exception 'Invalid option';end if;
 total:=total+(q.data->>'marks')::integer;if answer=(q.data->>'answerIndex')::integer then score:=score+(q.data->>'marks')::integer;end if;
 end loop;
 insert into public.study_quiz_attempts(owner_id,resource_id,submission_id,answers,score,total) values(p_owner,p_id,p_submission,p_answers,score,total) returning id into attempt;return attempt;
end;
$$;
create function public.study_attempts(p_id uuid,p_owner uuid) returns jsonb language sql security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'resourceId',resource_id,'score',score,'total',total,'percentage',round(100.0*score/total,2),'answers',answers,'createdAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by created_at desc),'[]'::jsonb) from (select * from public.study_quiz_attempts where resource_id=p_id and owner_id=p_owner order by created_at desc limit 30) s;
$$;
-- RPCs take a SERVER-VERIFIED principal. Anonymous/authenticated clients cannot
-- call them with a forged owner_id. Public reads use RLS above or the API.
revoke all on function public.study_summary(uuid,uuid),public.study_read(uuid,uuid),public.study_save(uuid,text,text,jsonb,jsonb,jsonb),public.study_find(text,uuid),public.study_list(uuid,jsonb),public.study_publish(uuid,uuid,jsonb),public.study_remove(uuid,text,text),public.study_submit_quiz(uuid,uuid,uuid,jsonb),public.study_attempts(uuid,uuid) from public,anon,authenticated;
grant execute on function public.study_summary(uuid,uuid),public.study_read(uuid,uuid),public.study_save(uuid,text,text,jsonb,jsonb,jsonb),public.study_find(text,uuid),public.study_list(uuid,jsonb),public.study_publish(uuid,uuid,jsonb),public.study_remove(uuid,text,text),public.study_submit_quiz(uuid,uuid,uuid,jsonb),public.study_attempts(uuid,uuid) to service_role;
