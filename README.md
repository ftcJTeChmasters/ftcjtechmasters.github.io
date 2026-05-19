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

Create matching Supabase Auth users before signing in locally.

## Demo Accounts

- Coach: `coach@team.local`
- Engineering Head: `engineering@team.local`
- Media Head: `media@team.local`
- Member: `alex@team.local`

## Storage

The app uses Supabase Auth as the source of truth for members, roles, assignments, scores, activity logs, and portfolio entries. The shared `app_state` row stores non-account team data such as meetings, messages, public posts, blogs, About content, and socials. The old browser database cache under `robotics-attendance-hub-v1` is cleared on load so members do not drift between LocalStorage, app_state, and Supabase Auth.

## Supabase Backend

Paste `supabase-backend.sql` into the Supabase SQL editor. You still need this even with Edge Functions: SQL creates the database table, row-level security policies, trigger, and shared app row. The Edge Function is the API layer that reads and writes that table.

Deploy the Edge Function after linking the Supabase project:

```powershell
supabase functions deploy app-state --no-verify-jwt
```

The function lives in `supabase/functions/app-state/index.ts`. It allows public reads for the public site and requires a Supabase Auth session for writes.

If you do not have the Supabase CLI installed globally, run the same deploy through `npx`:

```powershell
npx supabase login
npx supabase functions deploy app-state --project-ref jpfipvcwxwaxehgmjlne --no-verify-jwt
```

If creating users or resetting passwords says the Edge Function cannot be reached, verify that this URL returns JSON in a browser: `https://jpfipvcwxwaxehgmjlne.supabase.co/functions/v1/app-state?id=main`. A Supabase `404` means the function has not been deployed to that project or the `functionName` in `supabase-config.js` does not match.

The Edge Function also supports an emergency backup access path for account recovery. The default PIN is `2718281828459045`; for production, set a different SHA-256 hash as an Edge Function secret named `BACKUP_PIN_SHA256` and redeploy. The hidden browser gesture is: Blogs twice, Home three times, Member login once, then click the top-right corner and enter the 16 digit PIN. The browser sends only the SHA-256 hash to the backend, and the backend must approve it before user management actions work.

Then edit `supabase-config.js` once before deploying:

```js
window.JTECHMASTERS_SUPABASE = {
  enabled: true,
  url: "https://your-project.supabase.co",
  anonKey: "your-public-anon-key",
  table: "app_state",
  functionName: "app-state",
  stateId: "main",
};
```

That file is shipped with the site, so every device uses the same Supabase project without entering the public anon key again. Supabase anon keys are meant to be public in browser apps; the important protection is Row Level Security.

Authentication uses Supabase Auth. Coaches create members from the Members tab with a temporary password; the app creates the Supabase Auth user and stores the member profile in Auth metadata. Coaches can also reset a member's temporary password from the member table. The app reads the member list from Supabase Auth, not from the JSON app_state row. Users with passwords can use the normal login form; users without passwords can use the email sign-in link.

User profile fields can be stored in Supabase Auth metadata. The app reads `name`, `role`, `section`, `subsection`, `assignments`, and `score` from `user_metadata` or `app_metadata`. If Supabase Auth accepts a user but no app profile/metadata exists yet, the app temporarily treats that user as a Coach so you can get into the admin UI and fix setup.

Example Auth metadata:

```json
{
  "name": "Team Coach",
  "role": "Coach",
  "assignments": [{ "section": "All", "subsection": "All" }],
  "score": 7
}
```

Writes are also checked inside the Edge Function. A request must include a valid Supabase Auth session; anonymous terminal requests cannot write data. If the session has no matching app profile, the function applies the same temporary Coach fallback so setup is not locked out.

Coaches can optionally configure Git autosave from the member-only Public Site tab. This writes the browser database to `data/db.json` through the GitHub Contents API using a fine-grained GitHub token with repository Contents read/write permission. The token is stored only in that browser's LocalStorage and is not committed to the repo.

## GitHub Hosting

GitHub Pages can host this app as a static site, but it cannot run a live backend process or database. Supabase provides the live database while the static pages remain deployable to GitHub Pages.

## Permissions

- Coaches can see and edit all sections, create global or section meetings, correct scores, and reverse applied meeting score changes.
- Section Heads can see and edit only their own section and can create section meetings only for their own section.
- Members can see their own score, attendance history, upcoming meetings, messages, and portfolio entries.
- Members can publish public blog/link/social posts and edit the public About Us section from the member-only Public Site tab.
