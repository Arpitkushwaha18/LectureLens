-- LOCAL ONLY. Align new transcript/note leases with bounded long-lecture waits.
-- No historical row, status, token, reservation or uncertainty fence is reset.
do $$
declare definition text; signature text;
begin
  definition:=pg_get_functiondef('public.record_automatic_caption_run(uuid,uuid,text)'::regprocedure);
  if position('120 seconds' in definition)=0 then raise exception 'Unexpected transcript lease function';end if;
  execute replace(definition,'120 seconds','180 seconds');
  foreach signature in array array[
    'public.claim_youtube_notebook(text,uuid,text,text,text,integer,boolean)',
    'public.youtube_notebook_evidence(text,uuid,jsonb,jsonb)'
  ] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    if position('240 seconds' in definition)=0 then raise exception 'Unexpected note lease function';end if;
    execute replace(definition,'240 seconds','360 seconds');
  end loop;
end;
$$;
