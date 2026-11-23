-- LOCAL ONLY. Forward-only lecture limit upgrade; no historical jobs are reset.
alter table public.transcripts drop constraint transcripts_text_content_check;
alter table public.transcripts add constraint transcripts_text_content_check
  check(char_length(btrim(text_content))>0 and char_length(text_content)<=500000
    and octet_length(text_content)<=2000000);
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.finish_automatic_captions(uuid,uuid,text,jsonb)'::regprocedure);
  if position('between 1 and 100000' in definition)=0 then
    raise exception 'Unexpected automatic transcript function; review before upgrading';
  end if;
  definition:=replace(replace(replace(definition,
    'between 1 and 100000','between 1 and 500000'),'>400000','>2000000'),
    'between 1 and 10000','between 1 and 30000');
  execute definition;
end;
$$;
