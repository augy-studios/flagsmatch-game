// The check every finished game gets before it is scored: rebuild the game
// from its seed with the same code the page plays by, read the log against
// it, and hold the log's times against the server's clock. No database
// here, so scripts/test-verify.mjs can run it.
//
// The page plays the game, so the answers come from the page. What this
// stops is a log no person could have made: answers faster than anyone can
// read a flag, more time spent answering than the server saw pass, or
// answers in the wrong places for the way the game was played. It cannot
// stop somebody reading the flag's file name in devtools; it is meant to
// stop scripted and forged games, not to prove who clicked.

import { HttpError } from "./http.js";
import { seedFromText } from "../../js/seed.js";
import { buildGame } from "../../js/quiz.js";
import { unpackLog, NONE, TIMEOUT, isAnswer, LOG_MAX_CHARS } from "../../js/log.js";
import { scoreLog } from "../../js/score.js";
import { CLOCK_SLACK_MS, MIN_ANSWER_MS, MIN_TYPED_MS, MS_PER_TYPED_CHAR, TURN_LIMIT_MS } from "../../js/rules.js";

export function readLog(value) {
  if (typeof value !== "string" || !value || value.length > LOG_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpError(400, "bad_log");
  }
  return value;
}

// The reason stays in the server's logs. Telling the caller which bound a
// game broke would only help tune the next attempt.
function implausible(row, reason) {
  console.warn(`implausible game ${row.id}: ${reason}`);
  return new HttpError(422, "implausible", "That game's answers do not add up, so it was not scored.");
}

// The game a row was started as.
export function gameFor(row) {
  const seed = seedFromText(row.seed);
  if (!seed || seed.region !== row.region || seed.difficulty !== row.difficulty || seed.count !== row.flag_count) {
    throw new HttpError(500, "server", "That game's seed could not be read.");
  }
  return buildGame(seed);
}

const minimumMs = (pick) =>
  typeof pick === "string" ? MIN_TYPED_MS + Array.from(pick).length * MS_PER_TYPED_CHAR : MIN_ANSWER_MS;

// { entries, score, correct } for a log that holds up, or an HttpError 422.
// elapsedMs is the server's time from the start ticket to now.
export function checkLog(row, packed, elapsedMs) {
  const game = gameFor(row);
  const entries = unpackLog(packed, game);
  if (!entries) throw implausible(row, "log does not unpack against the seed");

  let spent = 0;
  for (let i = 0; i < entries.length; i++) {
    const { pick, ms } = entries[i];
    spent += ms;

    // Whose flag this was, by the way the game was played.
    if (row.mode === "turns") {
      const mine = i % row.players === row.seat;
      if (mine === (pick === NONE)) throw implausible(row, `flag ${i}: ${mine ? "own turn left out" : "another's turn answered"}`);
    } else if (row.mode !== "duel" && pick === NONE) {
      throw implausible(row, `flag ${i}: none in a ${row.mode} game`);
    }
    if (pick === TIMEOUT && row.mode === "solo") throw implausible(row, `flag ${i}: a time limit in a solo game`);

    if (isAnswer(pick) && ms < minimumMs(pick)) throw implausible(row, `flag ${i}: answered in ${ms} ms`);
    if (row.mode !== "solo" && ms > TURN_LIMIT_MS) throw implausible(row, `flag ${i}: ${ms} ms past the flag's time`);
  }
  if (spent > elapsedMs + CLOCK_SLACK_MS) throw implausible(row, `${spent} ms answering in ${elapsedMs} ms`);

  const result = scoreLog(game, entries);
  return { game, entries, score: result.score, correct: result.correct };
}

// Head to head: a flag goes to the first right answer, so two players in
// one game can never both have it. `others` are the other side's entries.
export function duelConflict(game, entries, others) {
  const mine = scoreLog(game, entries).turns;
  const theirs = scoreLog(game, others).turns;
  return mine.findIndex((t, i) => t.correct && theirs[i]?.correct);
}
