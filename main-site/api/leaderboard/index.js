// GET /api/leaderboard?board=best|total
//   best  (default) -> { board, entries: [{ rank, name, score, correct, count, region, difficulty, mode }] }
//   total           -> { board, entries: [{ rank, name, total, games }] }
// Public, no login, one row per name, cached briefly at the edge.

import { endpoint, HttpError } from "../_lib/http.js";
import { rest } from "../_lib/supabase.js";

const LIMIT = 100;

const BOARDS = {
  best: {
    query: `flagsmatch_leaderboard_best?select=name,score,correct,flag_count,region,difficulty,mode&order=score.desc,created_at.asc&limit=${LIMIT}`,
    row: (r) => ({
      name: r.name,
      score: r.score,
      correct: r.correct,
      count: r.flag_count,
      region: r.region,
      difficulty: r.difficulty,
      mode: r.mode,
    }),
  },
  total: {
    query: `flagsmatch_leaderboard_total?select=name,total,games&order=total.desc,games.asc,last_at.asc&limit=${LIMIT}`,
    // bigint sums arrive as numbers well within range for this game.
    row: (r) => ({ name: r.name, total: Number(r.total), games: r.games }),
  },
};

export default endpoint("GET", async ({ req, res }) => {
  const board = req.query?.board ?? "best";
  const spec = BOARDS[board];
  if (!spec) throw new HttpError(400, "bad_board", "board is best or total.");

  const rows = await rest(spec.query);
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=60");
  return { board, entries: (rows ?? []).map((r, i) => ({ rank: i + 1, ...spec.row(r) })) };
});
