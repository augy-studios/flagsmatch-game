# Flags Match

Name the country from its flag. Pick a region, a difficulty and how many
flags, play alone or with others on the same network, watch the whole game
back as an instant replay, and share it as a link. Every game has a seed that
can be copied and played again, and games on a seed the server picked can go
on a leaderboard.

Live at <https://flagsmatch.uwuapps.org>. A PWA: once opened, it plays
offline, every flag included.

## What runs where

| Part | Runs on |
| --- | --- |
| `main-site/`, the PWA and its leaderboard API (`main-site/api/`) | Vercel, root directory `main-site` |
| Database, `flagsmatch_*` tables | The shared uwuapps Supabase project |
| Games with others | Browser to browser over WebRTC. PeerJS's public broker introduces the devices; nothing of ours is in between |

There is nothing on the VPS.

## Layout

```text
README.md
migrations/      SQL to run in the Supabase SQL editor, in number order
scripts/         pre-deploy checks, tests, and the data vendoring script
main-site/       the site Vercel deploys, including api/
```

The `uwuapps-*.md`, `update-bar-spec.md` and `STUN-p2p-spec.md` files at the
root are the specs this is built to. `main-site/README.md` covers the app
itself.

## First setup

1. Run every file in `migrations/`, in number order, in the Supabase SQL
   editor of the shared uwuapps project. Each is safe to run again. **Never
   edit one that has been run**; a change is a new numbered file.
2. On the Vercel project (root directory `main-site`), set the variables in
   `main-site/.env.example`: `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.
3. Add the domain `flagsmatch.uwuapps.org` to the Vercel project.
4. Deploy.

Without the variables the site still works in full; the API answers
`not_configured` and every game says it is not scored.

## Before every deploy

1. Bump `VERSION` in `main-site/sw.js`. Without it, returning visitors keep
   the previous build and never see the update bar.
2. Run the checks, from the repo root, with Node 20 or later and nothing to
   install:

```text
node scripts/check-sw.mjs          # the worker only activates when asked
node scripts/check-precache.mjs    # everything the app loads, every flag, works offline
node scripts/check-theme.mjs       # pre-paint script matches js/theme.js
node scripts/test-quiz.mjs         # seeds, games, typed answers, logs, scoring
node scripts/test-verify.mjs       # the API's check on a finished game, without a database
```

**If you change `js/countries.js`, `js/rules.js`, `js/seed.js`, `js/quiz.js`,
`js/log.js` or `js/score.js`,** seeds and replay links from before the change
may play a different game, and games played on the old build stop verifying:
the API rebuilds every game with the code it has now. Deploy such changes
when a few failed submissions from open tabs are acceptable.

## The data

`node scripts/vendor-flags.mjs` rebuilds `main-site/js/countries.js` from
[mledoze/countries](https://github.com/mledoze/countries) (ODbL 1.0) and
downloads every flag into `main-site/flags/` from
[flagcdn.com](https://flagcdn.com). It is run by hand, not on deploy; read
its header first, since the order of the list is part of every seed. The
original game fetched both live from restcountries.com, whose v3.1 API has
since been retired, which is what broke it.
