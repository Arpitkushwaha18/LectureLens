-- Admin-uploaded public PDFs only. No user/session/source/generation data.
-- Apply manually; retain historical tables/data (do not deploy their API routes).
create table public.admin_gallery_notes (
 id uuid primary key,
 title text not null check(length(title) between 1 and 180),
 course text not null check(length(course) between 1 and 120),
 semester integer not null check(semester between 1 and 12),
 subject text not null check(length(subject) between 1 and 120),
 description text not null default '' check(length(description)<=1000),
 object_path text not null unique check(object_path = id::text || '.pdf'),
 created_at timestamptz not null default now()
);
create index admin_gallery_filter on public.admin_gallery_notes(course,semester,subject,created_at desc);
alter table public.admin_gallery_notes enable row level security;
revoke all on public.admin_gallery_notes from anon, authenticated;
grant select, insert, delete on public.admin_gallery_notes to service_role;
create function public.admin_gallery_catalog() returns jsonb language sql stable security invoker set search_path=public as $$
 select coalesce(jsonb_agg(row_to_json(t) order by course,semester,subject),'[]'::jsonb)
 from (select distinct course,semester,subject from public.admin_gallery_notes) t;
$$;
revoke all on function public.admin_gallery_catalog() from public, anon, authenticated;
grant execute on function public.admin_gallery_catalog() to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('admin-gallery-pdfs','admin-gallery-pdfs',false,20971520,array['application/pdf'])
on conflict(id) do nothing;
-- Private bucket; only server service-role uploads/signs URLs. Downloads require
-- no visitor account/password. Rollback: disable uploads/routes, preserve files.
