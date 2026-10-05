# main-site

What Vercel deploys, served at <https://flagsmatch.uwuapps.org>. No build
step: the files are served as they are, and `api/` holds the serverless
functions.

| Path | What it is |
| --- | --- |
| `index.html` | The only page. Its `<head>` is the template for any page added later. |
| `404.html`, `404.css` | The shared not-found page. |
| `sw.js` | Service worker: the offline shell, every flag, and the update bar's waiting worker. |
| `manifest.json` | PWA manifest. |
| `flags/` | Every flag as SVG, from flagcdn.com, by `scripts/vendor-flags.mjs`. |
| `css/theme.css` | The uwuapps theme, verbatim from `uwuapps-theme.md`, time-based mode included. |
| `css/style.css` | Layout, the flag, the answers, the replay. |
| `js/` | ES modules, below. |
| `api/` | The leaderboard API, below. |
| `images/` | Manifest screenshots, at the sizes `manifest.json` gives. |

## js

Every file here is precached; `scripts/check-precache.mjs` fails if one is
not. The first six are pure, with no DOM, and the API imports them too, so
the browser and the server always agree on a game.

| File | What it does |
| --- | --- |
| `countries.js` | The 194 countries: name, region, subregion and other names. Generated; never edit by hand. |
| `rules.js` | Regions, difficulties, flag counts, timing limits, ways to play. |
| `seed.js` | Seeds, and the integer random numbers everything draws from. |
| `quiz.js` | A seed into a game: the flags in order and the names beside each. Typed answer matching. |
| `log.js` | A player's answers, packed into a short string for links and the API. |
| `score.js` | Scoring (below). |
| `view.js` | The question on screen: flag, names or typing box, and how an answer went. |
| `game.js` | The new-game screen, playing alone, the result, submitting, seeds and replay links. |
| `replay.js` | The instant replay. |
| `net.js` | Pairing over PeerJS, STUN only, from `STUN-p2p-spec.md`, as in uwuChess. |
| `multiplayer.js` | Games with others on top of `net.js`: hosting, joining, the three ways to play. |
| `qr.js` | QR encoder for the join link, from uwuPromptr, so it works offline. |
| `api.js`, `leaderboard.js`, `settings.js` | The API client, and the leaderboard and settings windows, after MRT Station Guesser's. |
| `theme.js`, `icons.js`, `ui.js`, `update-bar.js`, `app.js` | Theme, inline SVG icons, modal and storage helpers, the update bar, and boot. |

## The game

**Choosing.** A region (the world, or one of Africa, the Americas, Asia,
Europe and Oceania), a difficulty, and 5, 10, 15 or 20 flags, or any number
up to every flag in the region. No flag comes up twice in a game.

| Difficulty | Answers | Points |
| --- | --- | --- |
| Easy | 4 names, from anywhere | x1 |
| Normal | 4 names from the flag's own region | x1.5 |
| Hard | 6 names, from the flag's neighbours first | x2.25 |
| Expert | No names: type the country | x3 |

Expert forgives case, accents, punctuation, "the", "&" for "and", "St" for
"Saint", and a slip of a letter or two, as long as the slip is still nearer
that country than any other. Any of a country's names counts: its two letter
code (`US`), its official name, abbreviations (`UAE`, `PRC`, `KSA`), older
and short forms (`Burma`, `Turkey`, `Czech`), and its names in its own
languages in any script (`Deutschland`, `日本`, `भारत`). Names the upstream
data lacks are added in `EXTRA_NAMES` in `scripts/vendor-flags.mjs`.

**Keys.** 1 to 6 answer; N, or Enter away from a button, skips a flag or
moves on from an answer. In Expert, Enter answers and Enter on an empty box
skips. Hidden on touch screens, and switchable in Settings.

**Seeds.** A seed looks like `WN20-BXK4-M9TR`: region, difficulty, number of
flags, then the seed proper. It decides every flag and every name offered, so
the same seed is always the same game. It shows during play and at the end,
where it can be copied. Pasting one into the new-game screen sets the
settings it carries; a bare eight characters plays with the settings picked.
A game on a pasted seed is not scored, since its answers could have been seen.

**Scoring.** Integers, the same code on the page and the server:

| | Points |
| --- | --- |
| Each right answer | 100, plus up to 100 for speed: all of it within 2 s, none at 15 s |
| Streak | +10% for each right answer in a row before it, up to +50% |
| Progress | +0% on the first flag, rising evenly to +100% on the last |
| Difficulty | x1, x1.5, x2.25 or x3, as above |
| Finishing | 10 x right answers x accuracy, times the difficulty |

So a game scores more the harder it is, the longer it is, the further into it
an answer comes, and the quicker each answer is.

**Replay.** When a game ends it plays back by itself (a setting turns this
off): each flag, then the answer after as long as it took, so hesitation
shows. Play, pause, a step back or forward, the start and end, a slider, and a
list of every flag marked right, wrong, skipped or out of time to jump to.
0.5x, 1x, 2x or 4x, as wordrain's replay; the speed picked last is remembered.

**Sharing a replay.** Share replay makes a link such as
`/?watch=AQEAPwMAZQ&seed=WE5-2GS9-6TPQ&mode=s`, through the device's share
sheet where it has one and the clipboard otherwise. The link is the whole
game: the seed, and each answer with its time, packed a few bytes each.
Nothing is stored anywhere, and a link opens offline once the site has been
visited. A shared replay shows right answers but no score, since a link can
be edited; Play this seed plays it, unscored.

## Playing with others

Per `STUN-p2p-spec.md`: STUN only, no TURN relay, so **every device has to
be on the same network**, the same wifi or one device's hotspot. One device
hosts with a six character code, a link or a QR code; the others join. PeerJS
loads from cdnjs only when somebody hosts or joins, and is never cached. The
host holds the game and sends it in full 20 times a second; guests send
answers. A guest that reloads or drops rejoins with the same code and gets
its seat back.

| Way | Players | How it goes |
| --- | --- | --- |
| Race | 2 to 8 | Everyone answers every flag. The next comes once all have answered or its 15 seconds are up. |
| Take turns | 2 to 8 | The flags go round, one player at a time, 15 seconds each. |
| Head to head | 2 | The first right answer takes the flag; a wrong answer is out for that flag. |

The host picks the settings. Each player's own answers are their own game:
their replay, their link, and their own leaderboard entry under their own
name, scored the same way as alone (in Take turns, from their own flags).

## The leaderboard and anti-cheat

Two boards, as MRT Station Guesser's: each name's best game, and every game
added up. A game counts only if it started while online on a seed the server
picked: starting asks `/api/game/start` for a ticket, whose time is the
server's. Games started offline, or on a pasted seed, play the same and say
they are not scored.

The page sends the answers, never a score. The API rebuilds the game from
its seed with the same code the page plays by, works out the score itself,
and refuses (`implausible`, reason kept in the logs) a log that:

- does not match the seed's game, flag for flag;
- has an answer quicker than 350 ms, or a typed one quicker than 250 ms plus
  40 ms a character;
- spends longer answering than the server saw pass since the ticket;
- has answers in the wrong places for the way it was played: another
  player's turn answered, or a time limit in a game alone.

The database then refuses a submission that:

| Code | When |
| --- | --- |
| `not_yours` | comes from a browser other than the one that started the game |
| `mismatch` | sends a different log from the one the game already finished with |
| `conflict` | in head to head, claims a flag the other player already took |
| `pasted_seed` | was played on a seed the player chose |
| `same_name` | uses a name another player in the same game already used |
| `overlap` | was played at the same time as another game under the same name |
| `same_device` | joins a game from the host's own browser (refused at start) |

Starting is limited to 60 games an address per 10 minutes, finishing to 60
and submitting to 30.

None of this stops a person reading the flag's file name in devtools. It is
meant to stop scripted, replayed and forged games, not to prove who clicked.

## Offline and updates

Everything the page loads is precached, all 194 flags and the Jua font
included, so the site opens and plays with no connection. The flags sit in
their own cache, kept across versions, so a deploy does not download them
again. Only the leaderboard and games with others need the network. Nothing
under `/api/` is ever cached.

A new service worker installs and waits. The update bar offers Reload or Not
now, and nothing reloads until the reader asks. Bump `VERSION` in `sw.js` on
every change to anything in this directory, and `FLAGS_VERSION` when a flag
changes.

## API

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /api/game/start` | `client_key, mode, region, difficulty, count, players, seed?` | `game_id, seed, server_seed, created_at` |
| `POST /api/game/start` (guest) | `client_key, room, seat` | the same, on the host's seed |
| `POST /api/game/finish` | `game_id, client_key, log` | `score, correct, elapsed_ms, server_seed` |
| `POST /api/game/submit` | `game_id, client_key, name, log` | `name, score, correct, rank, best_score, total, games, total_rank` |
| `POST /api/leaderboard/name` | `name` | `name`, cleaned, or a `400` saying why not |
| `GET /api/leaderboard` | `?board=best` or `?board=total` | `board, entries`, cached 30 s |

`mode` is `solo`, `race`, `turns` or `duel`. With no `seed`, start picks one.
`room` is the host's `game_id`, and `seat` the guest's place, 1 up. Finish is
sent the moment a game ends, so the server's clock stops then; submit
finishes the game first if that never arrived. Errors are
`{ error, message? }` with a matching status.

## Environment variables (Vercel)

Documented in `.env.example`. `.vercelignore` keeps every env file out of
deployments, since anything in this directory would otherwise be served.

| Variable | Used for |
| --- | --- |
| `SUPABASE_URL` | The shared uwuapps project. |
| `SUPABASE_SERVICE_KEY` | Service role key. Server side only, never sent to a browser. |
