# JTeChmasters Attendance Hub

A GitHub Pages compatible attendance and member tracking app for a robotics team.

## Run Locally

Open `index.html` directly, or serve the folder with any static server:

```powershell
python -m http.server 4173
```

Static public routes are folder-based so GitHub Pages can serve them without a backend:

- `/` or `/index.html` for the member app and public homepage
- `/blogs/` for public blog/update posts
- `/blogs/post/?id=POST_ID` for a full long-form blog article
- `/about/` for the editable About Us page

Demo password for every seeded account is `demo123`.

## Demo Accounts

- Coach: `coach@team.local`
- Engineering Head: `engineering@team.local`
- Media Head: `media@team.local`
- Member: `alex@team.local`

## Storage

The app stores data in LocalStorage under `robotics-attendance-hub-v1` and the current session in SessionStorage. It is ready for GitHub Pages because there is no build step and no paid backend dependency.

## Supabase Backend

Run this SQL in the Supabase SQL editor, then configure the project URL and anon key in the coach-only Public Site tab:

```sql
create table if not exists public.app_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

create policy "app_state_select"
on public.app_state for select
using (id = 'main');

create policy "app_state_insert"
on public.app_state for insert
with check (id = 'main');

create policy "app_state_update"
on public.app_state for update
using (id = 'main')
with check (id = 'main');
```

This uses the public anon key from the browser, so it is convenient but not strong security. For stronger production security, use Supabase Auth and role-based policies instead of public write access.

Coaches can optionally configure Git autosave from the member-only Public Site tab. This writes the browser database to `data/db.json` through the GitHub Contents API using a fine-grained GitHub token with repository Contents read/write permission. The token is stored only in that browser's LocalStorage and is not committed to the repo.

## GitHub Hosting

GitHub Pages can host this app as a static site, but it cannot run a live backend process or database. GitHub Actions can run scheduled or build jobs, not a public always-on server. Public posts, social links, and the About Us content are therefore stored in the browser for this static version.

## Permissions

- Coaches can see and edit all sections, create global or section meetings, correct scores, and reverse applied meeting score changes.
- Section Heads can see and edit only their own section and can create section meetings only for their own section.
- Members can see their own score, attendance history, upcoming meetings, messages, and portfolio entries.
- Members can publish public blog/link/social posts and edit the public About Us section from the member-only Public Site tab.
