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

The app can use Supabase as the shared backend for account info, meetings, messages, public posts, blogs, About content, socials, attendance scores, and portfolio entries. It keeps a LocalStorage copy under `robotics-attendance-hub-v1` as the browser cache/fallback, and the current signed-in member is kept in SessionStorage.

## Supabase Backend

Run this SQL in the Supabase SQL editor:

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

Then edit `supabase-config.js` once before deploying:

```js
window.JTECHMASTERS_SUPABASE = {
  enabled: true,
  url: "https://your-project.supabase.co",
  anonKey: "your-public-anon-key",
  table: "app_state",
  stateId: "main",
};
```

That file is shipped with the site, so every device uses the same Supabase project without entering the public anon key again. Supabase anon keys are meant to be public in browser apps; the important protection is Row Level Security. The simple policies above allow public read/write to the shared app row for this static app. For stronger production security, use Supabase Auth and role-based policies.

Coaches can optionally configure Git autosave from the member-only Public Site tab. This writes the browser database to `data/db.json` through the GitHub Contents API using a fine-grained GitHub token with repository Contents read/write permission. The token is stored only in that browser's LocalStorage and is not committed to the repo.

## GitHub Hosting

GitHub Pages can host this app as a static site, but it cannot run a live backend process or database. Supabase provides the live database while the static pages remain deployable to GitHub Pages.

## Permissions

- Coaches can see and edit all sections, create global or section meetings, correct scores, and reverse applied meeting score changes.
- Section Heads can see and edit only their own section and can create section meetings only for their own section.
- Members can see their own score, attendance history, upcoming meetings, messages, and portfolio entries.
- Members can publish public blog/link/social posts and edit the public About Us section from the member-only Public Site tab.
