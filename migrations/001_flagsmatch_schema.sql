-- Flags Match (flagsmatch.uwuapps.org) schema, in the shared uwuapps
-- Supabase project. Paste into the Supabase SQL editor and run once. Safe to
-- run again: everything is "if not exists" or "or replace".
--
-- Access model: only the Vercel functions in main-site/api touch these
-- tables, with the service role key. RLS is on with no policies, so an anon
-- key reads nothing.
--
-- The game is not in here. The API rebuilds every finished game from its
-- seed with the same code the browser plays with, checks the answers'
-- times, and works out the score itself; these functions do the checks that
-- need the database.

-- One row per game that could go on the leaderboard: started while online,
-- alone or with others. The row is the start ticket; created_at is the
-- server's clock, which a browser cannot move.
--
-- In a game with others, the host's row is the room and each guest has a
-- row of its own pointing at it, on the same seed, in its own seat.
create table if not exists flagsmatch_games (
  id uuid primary key default gen_random_uuid(),
  client_key text not null,             -- the browser that started it
  mode text not null check (mode in ('solo', 'race', 'turns', 'duel')),
  seed text not null,                   -- "WN20-BXK4-M9TR", canonical form
  region text not null,
  difficulty text not null,
  flag_count int not null check (flag_count between 1 and 500),
  server_seed boolean not null,         -- false for a pasted seed: never ranked
  room_id uuid references flagsmatch_games(id) on delete set null,
  seat smallint not null default 0 check (seat between 0 and 7),
  players smallint not null default 1 check (players between 1 and 8),
  created_at timestamptz not null default now(),
  -- Set once, by the first log that passes the API's checks. Any later
  -- finish or submit must send the same log.
  finished_at timestamptz,
  log text,
  score int check (score >= 0),
  correct int check (correct >= 0),
  submitted boolean not null default false
);

create index if not exists flagsmatch_games_created on flagsmatch_games (created_at);
create index if not exists flagsmatch_games_room on flagsmatch_games (room_id);
-- One guest per seat in a room. The host is seat 0 with no room_id.
create unique index if not exists flagsmatch_games_seat on flagsmatch_games (room_id, seat) where room_id is not null;

create table if not exists flagsmatch_leaderboard (
  id bigserial primary key,
  name text not null,
  score int not null check (score >= 0),
  correct int not null check (correct >= 0),
  flag_count int not null,
  region text not null,
  difficulty text not null,
  mode text not null,
  game_id uuid not null unique references flagsmatch_games(id) on delete cascade,
  room uuid not null,                   -- the host's game id, or its own when alone
  created_at timestamptz not null default now()
);

create index if not exists flagsmatch_lb_name on flagsmatch_leaderboard (lower(name), score desc);
create index if not exists flagsmatch_lb_room on flagsmatch_leaderboard (room);

-- Each name's best game. The earliest of an equal top score wins, and the
-- casing shown is the one attached to that score.
create or replace view flagsmatch_leaderboard_best
with (security_invoker = true) as
select distinct on (lower(name)) name, score, correct, flag_count, region, difficulty, mode, created_at
from flagsmatch_leaderboard
order by lower(name), score desc, created_at asc;

-- Every submitted game added up per name. The casing shown is the most
-- recent one. Ties go to fewer games, then to whoever got there first.
create or replace view flagsmatch_leaderboard_total
with (security_invoker = true) as
select
  (array_agg(name order by created_at desc))[1] as name,
  sum(score)::bigint as total,
  count(*)::int as games,
  max(created_at) as last_at
from flagsmatch_leaderboard
group by lower(name);

-- Fixed window counters for rate limiting by (hashed) IP. There are no
-- accounts to limit against, and Vercel functions share no memory.
create table if not exists flagsmatch_rate_limits (
  bucket text primary key,
  window_start timestamptz not null,
  hits int not null
);

alter table flagsmatch_games enable row level security;
alter table flagsmatch_leaderboard enable row level security;
alter table flagsmatch_rate_limits enable row level security;

-- True while the bucket is under its limit. One statement, so concurrent
-- hits cannot both read the old count.
create or replace function flagsmatch_hit(p_bucket text, p_window_seconds int, p_max int)
returns boolean
language sql
volatile
as $$
  insert into flagsmatch_rate_limits as r (bucket, window_start, hits)
  values (p_bucket, now(), 1)
  on conflict (bucket) do update set
    window_start = case
      when r.window_start < now() - make_interval(secs => p_window_seconds) then now()
      else r.window_start end,
    hits = case
      when r.window_start < now() - make_interval(secs => p_window_seconds) then 1
      else r.hits + 1 end
  returning hits <= p_max;
$$;

-- Records the end of a game the API has checked and scored. The first log
-- to arrive stops the clock and fixes the score; a later call with the same
-- log gets the same answer, and one with a different log is refused.
--
--   not_found   no such game
--   not_yours   sent from a browser other than the one that started it
--   expired     started more than six hours ago
--   mismatch    already finished with a different log
create or replace function flagsmatch_finish(
  p_game_id uuid,
  p_client_key text,
  p_log text,
  p_score int,
  p_correct int
)
returns table (status text, score int, correct int, finished_at timestamptz)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_game flagsmatch_games%rowtype;
begin
  select * into v_game from flagsmatch_games g where g.id = p_game_id for update;

  if not found then
    return query select 'not_found'::text, null::int, null::int, null::timestamptz;
    return;
  end if;
  if v_game.client_key <> p_client_key then
    return query select 'not_yours'::text, null::int, null::int, null::timestamptz;
    return;
  end if;
  if v_game.log is not null then
    if v_game.log <> p_log then
      return query select 'mismatch'::text, null::int, null::int, null::timestamptz;
      return;
    end if;
    return query select 'ok'::text, v_game.score, v_game.correct, v_game.finished_at;
    return;
  end if;
  if v_game.created_at < now() - interval '6 hours' then
    return query select 'expired'::text, null::int, null::int, null::timestamptz;
    return;
  end if;

  update flagsmatch_games g
  set log = p_log, score = p_score, correct = p_correct, finished_at = now()
  where g.id = p_game_id
  returning g.finished_at into v_game.finished_at;

  return query select 'ok'::text, p_score, p_correct, v_game.finished_at;
end;
$$;

-- Puts a finished, checked game on the board under a name the API has
-- already cleaned. The score is the one finish stored, never the caller's.
--
--   not_found          no such game
--   not_yours          sent from a browser other than the one that started it
--   expired            started more than six hours ago
--   unfinished         no log has been accepted for it yet
--   pasted_seed        played on a seed the player chose
--   already_submitted  already on the board
--   same_name          another player in the same game already used this name
--   overlap            played while another game on the board under this
--                      name was also being played
create or replace function flagsmatch_submit(p_game_id uuid, p_client_key text, p_name text)
returns table (status text, best_score int, rank bigint, total bigint, games int, total_rank bigint)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_game flagsmatch_games%rowtype;
  v_room uuid;
  v_best int;
  v_best_at timestamptz;
  v_total bigint;
  v_games int;
begin
  select * into v_game from flagsmatch_games g where g.id = p_game_id for update;

  if not found then
    return query select 'not_found'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_game.client_key <> p_client_key then
    return query select 'not_yours'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_game.created_at < now() - interval '6 hours' then
    return query select 'expired'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_game.log is null then
    return query select 'unfinished'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if not v_game.server_seed then
    return query select 'pasted_seed'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_game.submitted then
    return query select 'already_submitted'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  v_room := coalesce(v_game.room_id, v_game.id);

  -- One submission per name at a time, so two sent together cannot both
  -- miss each other in the checks below.
  perform pg_advisory_xact_lock(hashtext('flagsmatch_submit:' || lower(p_name)));

  if exists (
    select 1 from flagsmatch_leaderboard l
    where l.room = v_room and lower(l.name) = lower(p_name)
  ) then
    return query select 'same_name'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  if exists (
    select 1
    from flagsmatch_leaderboard l
    join flagsmatch_games g on g.id = l.game_id
    where lower(l.name) = lower(p_name)
      and l.room <> v_room
      and g.created_at < v_game.finished_at
      and g.finished_at > v_game.created_at
  ) then
    return query select 'overlap'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  update flagsmatch_games g set submitted = true where g.id = p_game_id;
  insert into flagsmatch_leaderboard (name, score, correct, flag_count, region, difficulty, mode, game_id, room)
  values (p_name, v_game.score, v_game.correct, v_game.flag_count, v_game.region, v_game.difficulty, v_game.mode, p_game_id, v_room);

  select l.score, l.created_at into v_best, v_best_at
  from flagsmatch_leaderboard l
  where lower(l.name) = lower(p_name)
  order by l.score desc, l.created_at asc
  limit 1;

  select sum(l.score)::bigint, count(*)::int into v_total, v_games
  from flagsmatch_leaderboard l
  where lower(l.name) = lower(p_name);

  return query
  select
    'ok'::text,
    v_best,
    (
      select count(*) + 1
      from flagsmatch_leaderboard_best b
      where b.score > v_best or (b.score = v_best and b.created_at < v_best_at)
    ),
    v_total,
    v_games,
    (
      select count(*) + 1
      from flagsmatch_leaderboard_total t
      where lower(t.name) <> lower(p_name)
        and (
          t.total > v_total
          or (t.total = v_total and t.games < v_games)
          -- This name's total was only just reached, so an equal one got there first.
          or (t.total = v_total and t.games = v_games)
        )
    );
end;
$$;

-- Housekeeping, called now and then by /api/game/start: old counters, and
-- games nobody submitted that are past any use.
create or replace function flagsmatch_prune()
returns void
language sql
volatile
as $$
  delete from flagsmatch_rate_limits where window_start < now() - interval '1 day';
  delete from flagsmatch_games g
  where g.created_at < now() - interval '2 days'
    and not exists (select 1 from flagsmatch_leaderboard l where l.game_id = g.id);
$$;

-- Service role only.
revoke all on function flagsmatch_hit(text, int, int) from public, anon, authenticated;
revoke all on function flagsmatch_finish(uuid, text, text, int, int) from public, anon, authenticated;
revoke all on function flagsmatch_submit(uuid, text, text) from public, anon, authenticated;
revoke all on function flagsmatch_prune() from public, anon, authenticated;
grant execute on function flagsmatch_hit(text, int, int) to service_role;
grant execute on function flagsmatch_finish(uuid, text, text, int, int) to service_role;
grant execute on function flagsmatch_submit(uuid, text, text) to service_role;
grant execute on function flagsmatch_prune() to service_role;
