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

## GitHub Hosting

GitHub Pages can host this app as a static site, but it cannot run a live backend process or database. GitHub Actions can run scheduled or build jobs, not a public always-on server. Public posts, social links, and the About Us content are therefore stored in the browser for this static version.

## Permissions

- Coaches can see and edit all sections, create global or section meetings, correct scores, and reverse applied meeting score changes.
- Section Heads can see and edit only their own section and can create section meetings only for their own section.
- Members can see their own score, attendance history, upcoming meetings, messages, and portfolio entries.
- Members can publish public blog/link/social posts and edit the public About Us section from the member-only Public Site tab.
