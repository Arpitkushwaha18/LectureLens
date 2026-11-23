-- Read-only collision/version inspection. Run before applying either migration.
-- The intended project reference must be verified separately in CLI metadata
-- and Dashboard; current_database() alone is NOT a project identity check.
show server_version;
select current_database(), current_user;
select table_schema, table_name from information_schema.tables
where table_schema = 'public' and table_name in
  ('profiles', 'learning_sources', 'transcripts', 'generated_content', 'generation_jobs');
select nspname from pg_namespace where nspname = 'll_private';
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('reserve_generation', 'ensure_youtube_source',
  'acquire_youtube_transcript', 'claim_generation', 'finish_generation', 'fail_generation', 'read_youtube_notes');
select tgname from pg_trigger where tgname='ll_b2_auth_user_created';
select to_regclass('supabase_migrations.schema_migrations') as migration_history;
