// POST /api/game/finish  { game_id, client_key, log }
//   -> { score, correct, elapsed_ms, server_seed }
// Sent by the page the moment a game ends, so the server's clock stops then
// and not whenever somebody gets round to adding a name. The log is checked
// and scored here; see _lib/verify.js. Sending the same log again returns
// the same answer.

import { endpoint, clientKey, gameId, limit } from "../_lib/http.js";
import { readLog } from "../_lib/verify.js";
import { finishGame, loadGame } from "../_lib/games.js";

export default endpoint("POST", async ({ req, body }) => {
  const id = gameId(body.game_id);
  const key = clientKey(body.client_key);
  const log = readLog(body.log);

  await limit(req, "finish", 600, 60);

  const row = await finishGame(await loadGame(id), key, log);
  return {
    score: row.score,
    correct: row.correct,
    elapsed_ms: Date.parse(row.finished_at) - Date.parse(row.created_at),
    server_seed: row.server_seed === true,
  };
});
