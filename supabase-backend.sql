-- JTeChmasters Supabase backend
-- Paste this into the Supabase SQL editor once for the project.
-- It creates the shared app database row and RLS policies.
-- Create Auth users in Supabase Authentication with the same emails as the seeded app profiles.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.app_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

drop policy if exists "app_state_public_read" on public.app_state;
drop policy if exists "app_state_authenticated_insert" on public.app_state;
drop policy if exists "app_state_authenticated_update" on public.app_state;

create policy "app_state_public_read"
on public.app_state for select
using (id = 'main');

create policy "app_state_authenticated_insert"
on public.app_state for insert
to authenticated
with check (id = 'main');

create policy "app_state_authenticated_update"
on public.app_state for update
to authenticated
using (id = 'main')
with check (id = 'main');

create or replace function public.touch_app_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists app_state_touch_updated_at on public.app_state;
create trigger app_state_touch_updated_at
before update on public.app_state
for each row
execute function public.touch_app_state_updated_at();

create or replace function public.list_auth_profiles()
returns jsonb
language sql
security definer
set search_path = auth, public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', users.id::text,
        'authUserId', users.id::text,
        'name', coalesce(
          users.raw_user_meta_data->>'name',
          users.raw_user_meta_data->>'full_name',
          users.raw_user_meta_data->>'display_name',
          users.email,
          'Member'
        ),
        'email', lower(coalesce(users.email, '')),
        'role', coalesce(users.raw_user_meta_data->>'role', 'Member'),
        'section', coalesce(
          users.raw_user_meta_data->>'section',
          users.raw_user_meta_data#>>'{assignments,0,section}',
          'All'
        ),
        'subsection', coalesce(
          users.raw_user_meta_data->>'subsection',
          users.raw_user_meta_data#>>'{assignments,0,subsection}',
          'All'
        ),
        'assignments', coalesce(users.raw_user_meta_data->'assignments', '[{"section":"All","subsection":"All"}]'::jsonb),
        'score', case
          when coalesce(users.raw_user_meta_data->>'score', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
            then (users.raw_user_meta_data->>'score')::numeric
          else 2
        end,
        'portfolio', coalesce(users.raw_user_meta_data->'portfolio', '[]'::jsonb),
        'activityLog', coalesce(users.raw_user_meta_data->'activityLog', '[]'::jsonb),
        'needsPasswordChange', lower(coalesce(users.raw_user_meta_data->>'needsPasswordChange', 'false')) = 'true',
        'isSiteManager', lower(coalesce(users.raw_user_meta_data->>'isSiteManager', 'false')) = 'true'
      )
      order by lower(coalesce(users.email, ''))
    ),
    '[]'::jsonb
  )
  from auth.users
  where users.deleted_at is null;
$$;

revoke all on function public.list_auth_profiles() from public;
grant execute on function public.list_auth_profiles() to service_role;

insert into public.app_state (id, data)
values (
  'main',
  jsonb_build_object(
    'meetings', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid()::text, 'title', 'Engineering Drivebase Review', 'startsAt', (now() + interval '1 day')::text, 'scope', 'Engineering', 'subsection', 'Programming', 'createdBy', 'u-eng-head', 'attendance', '{}'::jsonb, 'applied', false, 'reversed', false, 'scoreChanges', '[]'::jsonb),
      jsonb_build_object('id', gen_random_uuid()::text, 'title', 'Full Team Scrimmage Prep', 'startsAt', (now() + interval '4 days')::text, 'scope', 'Global', 'subsection', 'All', 'createdBy', 'u-coach', 'attendance', '{}'::jsonb, 'applied', false, 'reversed', false, 'scoreChanges', '[]'::jsonb)
    ),
    'messages', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid()::text, 'fromId', 'u-coach', 'toId', 'u-alex', 'audience', jsonb_build_object('type', 'user', 'userId', 'u-alex'), 'at', now(), 'body', 'Bring the latest CAD notes to the next engineering review.', 'read', false)
    ),
    'publicPosts', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid()::text, 'type', 'Update', 'title', 'Season planning is underway', 'body', 'Engineering, media, and outreach are preparing their first sprint goals for the new FTC season.', 'url', '', 'urlLabel', '', 'authorId', 'u-coach', 'publishedAt', now()),
      jsonb_build_object('id', gen_random_uuid()::text, 'type', 'Link', 'title', 'Follow us on Instagram', 'body', 'Match clips, pit photos, and workshop snapshots will be shared through our team socials.', 'url', 'https://www.instagram.com/', 'urlLabel', 'Open Instagram', 'authorId', 'u-media-head', 'publishedAt', now()),
      jsonb_build_object('id', gen_random_uuid()::text, 'type', 'Blog', 'title', 'Build log: first sprint goals', 'body', 'Our first sprint is focused on turning early ideas into testable robot systems. Programming is preparing the drivetrain control plan, CAD is sketching the first layout, and build is checking what parts can be reused from last season.' || E'\n\n' || 'The goal is not to make every decision immediately. We want a simple prototype path, a shared vocabulary across sections, and enough documentation that new members can understand why each design choice exists.', 'url', '', 'urlLabel', '', 'authorId', 'u-eng-head', 'publishedAt', now())
    ),
    'site', jsonb_build_object(
      'aboutTitle', 'About JTeChmasters',
      'aboutBody', 'JTeChmasters is an FTC robotics team building robots, software, media, outreach projects, and match-day confidence together.',
      'socials', jsonb_build_array(
        jsonb_build_object('label', 'Instagram', 'url', 'https://www.instagram.com/'),
        jsonb_build_object('label', 'FIRST FTC', 'url', 'https://www.firstinspires.org/robotics/ftc')
      )
    )
  )
)
on conflict (id) do nothing;

update public.app_state
set data = data - 'users'
where id = 'main' and data ? 'users';
