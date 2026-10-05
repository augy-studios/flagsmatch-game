// POST /api/game/submit  { game_id, client_key, name, log }
//   -> { name, score, correct, rank, best_score, total, games, total_rank }
// Puts a finished game on the leaderboard under a name. A game the page
// could not report as finished (it went offline at the end) is finished
// here first, from the same log. The score is the server's, from the log;
// none is taken from the request.

import { endpoint, HttpError, clientKey, gameId, limit } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { rpc } from "../_lib/supabase.js";
import { readLog } from "../_lib/verify.js";
import { finishGame, loadGame, refuse } from "../_lib/games.js";

export default endpoint("POST", async ({ req, body }) => {
  const id = gameId(body.game_id);
  const key = clientKey(body.client_key);
  const name = cleanName(body.name);
  const log = readLog(body.log);

  await limit(req, "submit", 600, 30);

  const row = await finishGame(await loadGame(id), key, log);
  if (!row.server_seed) throw refuse("pasted_seed");

  const [result] = (await rpc("flagsmatch_submit", { p_game_id: id, p_client_key: key, p_name: name })) ?? [];
  if (result?.status !== "ok") throw result ? refuse(result.status) : new HttpError(500, "server");

  return {
    name,
    score: row.score,
    correct: row.correct,
    rank: Number(result.rank),
    best_score: result.best_score,
    total: Number(result.total),
    games: result.games,
    total_rank: Number(result.total_rank),
  };
});
