# JTeChmasters Attendance Hub

A GitHub Pages compatible attendance and member tracking app for a robotics team.

## Run Locally

Open `index.html` directly, or serve the folder with any static server:

```powershell
python -m http.server 4173
```

Demo password for every seeded account is `demo123`.

## Demo Accounts

- Coach: `coach@team.local`
- Engineering Head: `engineering@team.local`
- Media Head: `media@team.local`
- Member: `alex@team.local`

## Storage

The app stores data in LocalStorage under `robotics-attendance-hub-v1` and the current session in SessionStorage. It is ready for GitHub Pages because there is no build step and no paid backend dependency.

## Permissions

- Coaches can see and edit all sections, create global or section meetings, correct scores, and reverse applied meeting score changes.
- Section Heads can see and edit only their own section and can create section meetings only for their own section.
- Members can see their own score, attendance history, upcoming meetings, messages, and portfolio entries.
