// Reading a game's row, and recording its end, shared by finish and submit.

import { HttpError } from "./http.js";
import { rest, rpc } from "./supabase.js";
import { checkLog, duelConflict } from "./verify.js";
import { unpackLog } from "../../js/log.js";

const COLUMNS =
  "id,client_key,mode,seed,region,difficulty,flag_count,server_seed,room_id,seat,players,created_at,finished_at,log,score,correct,submitted";

export const REFUSALS = {
  not_found: [404, "That game does not exist."],
  not_yours: [403, "That game was started in a different browser."],
  expired: [410, "That game started more than six hours ago."],
  mismatch: [409, "That game already finished with other answers."],
  conflict: [409, "Those answers clash with your opponent's: a flag can only go to one of you."],
  unfinished: [409, "That game has not finished."],
  pasted_seed: [409, "Games on a pasted seed stay off the leaderboard, since the answers could have been seen before."],
  already_submitted: [409, "That game is already on the leaderboard."],
  same_name: [409, "Somebody in that game is already on the leaderboard under that name. Pick another."],
  overlap: [409, "That game was played at the same time as another one already on the leaderboard under this name."],
};

export function refuse(status) {
  const [code, message] = REFUSALS[status] ? [status, REFUSALS[status][1]] : ["server", "Could not record that game."];
  return new HttpError(REFUSALS[status]?.[0] ?? 500, code, message);
}

export async function loadGame(id) {
  const [row] = (await rest(`flagsmatch_games?id=eq.${id}&select=${COLUMNS}`)) ?? [];
  if (!row) throw refuse("not_found");
  return row;
}

// Records the end of a game and its score, once: the server's clock stops
// at the first log that holds up, and any later call must send the same
// log. Returns the row as it now stands.
export async function finishGame(row, key, packed) {
  if (row.client_key !== key) throw refuse("not_yours");
  if (row.log) {
    if (row.log !== packed) throw refuse("mismatch");
    return row;
  }

  const elapsed = Date.now() - Date.parse(row.created_at);
  const { game, entries, score, correct } = checkLog(row, packed, elapsed);

  if (row.mode === "duel") {
    const room = row.room_id ?? row.id;
    const others =
      (await rest(`flagsmatch_games?or=(id.eq.${room},room_id.eq.${room})&id=neq.${row.id}&log=not.is.null&select=log`)) ?? [];
    for (const other of others) {
      const theirs = unpackLog(other.log, game);
      if (theirs && duelConflict(game, entries, theirs) >= 0) throw refuse("conflict");
    }
  }

  const [result] =
    (await rpc("flagsmatch_finish", {
      p_game_id: row.id,
      p_client_key: key,
      p_log: packed,
      p_score: score,
      p_correct: correct,
    })) ?? [];
  if (result?.status !== "ok") throw refuse(result?.status);
  return { ...row, log: packed, score: result.score, correct: result.correct, finished_at: result.finished_at };
}
