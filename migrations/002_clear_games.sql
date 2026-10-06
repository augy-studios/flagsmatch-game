-- Flags Match: empties the leaderboard and every game, for the change that
-- made Hard a typed game and Expert a typed game on a pie of the flag's
-- colours, at x3 and x4 points.
--
-- A seed rebuilds the same game only under the rules it was played by. Old
-- Hard seeds now build typed games, so their logs no longer read, and the
-- old scores are on the old multipliers. Paste into the Supabase SQL editor
-- and run once. It deletes data and cannot be undone; the schema in
-- 001_flagsmatch_schema.sql is left as it is.

truncate table flagsmatch_leaderboard, flagsmatch_games, flagsmatch_rate_limits restart identity;
