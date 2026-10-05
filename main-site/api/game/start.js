// POST /api/game/start
//   alone or hosting: { client_key, mode, region, difficulty, count, seed?, players? }
//   joining a host:   { client_key, room, seat }
//   -> { game_id, seed, server_seed, created_at }
// The start ticket. A game can only go on the leaderboard if it began here,
// which gives it a start time no browser can move. Games started offline
// play the same; they just have no ticket.
//
// With no seed, the server picks one, and only those games can be ranked:
// a pasted seed could have been played before. A guest joining a game with
// other people gets a ticket of its own on the host's seed, from `room`, the
// host's game id, and `seat`, its place in the game.

import { endpoint, HttpError, clientKey, gameId, limit } from "../_lib/http.js";
import { rest, rpc } from "../_lib/supabase.js";
import { newSeed, parseSeed } from "../../js/seed.js";
import { MODES, MP_MODES, MAX_PLAYERS } from "../../js/rules.js";

// How long after the host's start a guest can still join its game.
const JOIN_WINDOW_MS = 15 * 60 * 1000;

const ticket = (row, seed, serverSeed) => ({ game_id: row.id, seed, server_seed: serverSeed, created_at: row.created_at });

async function insert(game) {
  const [row] = await rest("flagsmatch_games?select=id,created_at", { method: "POST", prefer: "return=representation", body: game });
  return row;
}

async function join(key, body) {
  const room = gameId(body.room, "bad_room");
  const seat = body.seat;
  const [host] =
    (await rest(
      `flagsmatch_games?id=eq.${room}&select=id,client_key,mode,seed,region,difficulty,flag_count,server_seed,players,room_id,created_at,finished_at`
    )) ?? [];
  if (!host || host.room_id !== null || !MP_MODES.includes(host.mode)) throw new HttpError(404, "no_room", "That game is not one this can join.");
  if (Date.now() - Date.parse(host.created_at) > JOIN_WINDOW_MS) throw new HttpError(410, "expired", "That game started too long ago to join.");
  if (host.client_key === key) throw new HttpError(409, "same_device", "The host and a guest cannot be the same browser.");
  if (!Number.isInteger(seat) || seat < 1 || seat >= host.players) throw new HttpError(400, "bad_seat");

  // A guest that reloads asks again for the seat it already has.
  const [held] = (await rest(`flagsmatch_games?room_id=eq.${room}&seat=eq.${seat}&select=id,client_key,created_at`)) ?? [];
  if (held) {
    if (held.client_key !== key) throw new HttpError(409, "seat_taken", "Another device already holds that place in the game.");
    return ticket(held, host.seed, host.server_seed);
  }

  const row = await insert({
    client_key: key,
    mode: host.mode,
    seed: host.seed,
    region: host.region,
    difficulty: host.difficulty,
    flag_count: host.flag_count,
    server_seed: host.server_seed,
    room_id: room,
    seat,
    players: host.players,
  });
  return ticket(row, host.seed, host.server_seed);
}

export default endpoint("POST", async ({ req, body }) => {
  const key = clientKey(body.client_key);
  await limit(req, "start", 600, 60);

  if (body.room != null) return join(key, body);

  const mode = body.mode;
  if (!MODES.includes(mode)) throw new HttpError(400, "bad_mode");
  const players = mode === "solo" ? 1 : body.players;
  if (!Number.isInteger(players) || players < 1 || players > MAX_PLAYERS[mode] || (mode !== "solo" && players < 2)) {
    throw new HttpError(400, "bad_players");
  }

  let seed;
  const serverSeed = body.seed == null;
  if (serverSeed) {
    seed = newSeed(body.region, body.difficulty, body.count);
    if (!seed) throw new HttpError(400, "bad_settings");
  } else {
    const parsed = parseSeed(body.seed);
    if (!parsed?.seed || parsed.bare) throw new HttpError(400, "bad_seed");
    seed = parsed.seed;
  }

  const row = await insert({
    client_key: key,
    mode,
    seed: seed.text,
    region: seed.region,
    difficulty: seed.difficulty,
    flag_count: seed.count,
    server_seed: serverSeed,
    players,
  });

  // Now and then, clear out what nobody will submit.
  if (Math.random() < 0.02) rpc("flagsmatch_prune", {}).catch(() => {});

  return ticket(row, seed.text, serverSeed);
});
