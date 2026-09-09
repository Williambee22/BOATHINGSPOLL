# National Marching Band Poll v1.4

A continuous AP-style Top 25 polling site for high school marching band, built for Railway with Node.js, Express, EJS, and PostgreSQL.

## How voting works

- Anyone can create a normal account; there is no separate voter approval step.
- Every active account has one current ranking ballot.
- Users rank the active bands from 1 through 25.
- Rankings are drag-and-drop on desktop and touch/pen reorderable from the grab handle.
- Saving replaces that user's prior ballot instead of creating another vote.
- The public composite recalculates from every active account's latest saved ballot.
- Scoring is AP-style: #1 gets 25 points, #2 gets 24, down to #25 getting 1 point.
- There are no poll weeks, deadlines, open/close rounds, or weekly resets.

## Homepage graphic

The homepage contains a screenshot-friendly Top 25 graphic with:

- Logo image
- Admin-editable headline
- Full Top 25
- Point totals
- Others Receiving Votes

The headline is only display text. An admin can change it at any time to values such as `BOA THINGS TOP 25`, `BOA THINGS TOP 25 WEEK 4`, or `BOA THINGS PRESEASON TOP 25`. Changing it never resets or creates ballots.

## Admin tools

The admin can:

- Cast and edit an ordinary Top 25 ballot that counts once like any other account.
- Change the homepage graphic title.
- Add one band at a time.
- Bulk import bands using `School Name, ST`, one school per line. Duplicate school/state entries are ignored and the first occurrence wins.
- Activate/deactivate bands.
- See every account's ballot status and exact last-updated timestamp.
- Delete any user's saved ballot without deleting the account; the vote immediately stops counting.
- Reset non-admin passwords and activate/deactivate non-admin accounts.

The starter band list is intentionally empty until the supplied national list is available. A future starter list can be placed in `src/bands.js`.

## Railway deployment

1. Push this folder to GitHub.
2. Create a Railway project and deploy the repository.
3. Add a PostgreSQL service to the same project.
4. Add these variables to the web service:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
SESSION_SECRET=use-a-long-random-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=use-a-strong-password
ADMIN_DISPLAY_NAME=Poll Administrator
NODE_ENV=production
SITE_NAME=National Marching Band Poll
POLL_BRAND=BOA THINGS
```

Railway supplies `PORT` automatically.

## First launch

The app automatically creates its PostgreSQL tables, session table, first admin account, default homepage graphic title, and any bands listed in `src/bands.js`. Existing v1.1 databases are compatible; the old week-start setting, if present, is ignored.

## Security

- Passwords are hashed with bcrypt.
- Sessions are stored in PostgreSQL.
- POST requests use CSRF protection.
- Login and registration are rate-limited.
- Self-registration cannot create administrators.

If fewer than 25 bands are active, users rank every active band. Once at least 25 are active, ballots require exactly 25 different bands.


## Logo image

The homepage poll graphic uses the standalone image file `public/boa-things-logo.png` (512×512 PNG). Replace that file with your real logo later while keeping the same filename, and the site will use it automatically.


## Bulk band import format

Paste one school per line in this format:

```text
Noblesville H.S., IN
Norton H.S., OH
Norwood H.S., OH
O'Fallon Township H.S., IL
Pike County Central H.S., KY
```

The importer uses school name + state to identify duplicates. If the same school appears more than once in a paste, only the first occurrence is used. If that school/state is already in the database, it is skipped rather than added again.
