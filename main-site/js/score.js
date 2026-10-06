// Scoring. Each right answer earns points that grow with how quickly it
// came, how many came right before it, how far into the game it is, and
// the difficulty; a finished game adds a bonus that grows with its length
// and accuracy. The API recomputes this from the log and never takes a
// score from a browser.
//
// Integers throughout, so the page and the server always agree.
//
//   per flag     100, plus up to 100 for speed: all of it within 2 s,
//                shrinking evenly to none at 15 s
//   streak       +10% for each right answer in a row before it, up to +50%
//   progress     +0% on the first flag, rising evenly to +100% on the last
//   difficulty   x1 Easy, x1.5 Normal, x3 Hard, x4 Expert
//   the game     10 x right answers x accuracy, times the difficulty

import { isCorrect } from "./quiz.js";
import { NONE, isAnswer } from "./log.js";

const BASE = 100;
const SPEED_MAX = 100;
const SPEED_FULL_MS = 2000;
const SPEED_NONE_MS = 15000;
const STREAK_STEP = 10;
const STREAK_CAP = 5;
const GAME_BONUS = 10;

export function speedBonus(ms) {
  if (ms <= SPEED_FULL_MS) return SPEED_MAX;
  if (ms >= SPEED_NONE_MS) return 0;
  return Math.floor((SPEED_MAX * (SPEED_NONE_MS - ms)) / (SPEED_NONE_MS - SPEED_FULL_MS));
}

// What one right answer is worth. `streak` is the right answers in a row
// before it, `index` its place in the game of `count` flags.
export function flagPoints({ ms, streak, index, count, percent }) {
  const speed = BASE + speedBonus(ms);
  const run = 100 + Math.min(streak, STREAK_CAP) * STREAK_STEP;
  const progress = 100 + (count > 1 ? Math.floor((100 * index) / (count - 1)) : 0);
  return Math.floor((speed * run * progress * percent) / 1000000);
}

// The bonus for a finished game: `mine` is how many flags were this
// player's to answer, which is all of them unless others shared the game.
export function gameBonus(correct, mine, percent) {
  if (!mine) return 0;
  return Math.floor((GAME_BONUS * correct * correct * percent) / (mine * 100));
}

// A log so far, scored. turns[i] is { correct, points } for each entry;
// NONE entries are not this player's and leave the streak alone. `done`
// adds the game bonus.
export function scoreLog(game, entries, { done = entries.length === game.questions.length } = {}) {
  const percent = game.difficulty.percent;
  const count = game.questions.length;
  let streak = 0;
  let total = 0;
  let correct = 0;
  let mine = 0;
  const turns = entries.map((e, index) => {
    if (e.pick === NONE) return { correct: false, points: 0, mine: false };
    mine++;
    const right = isAnswer(e.pick) && isCorrect(game.questions[index], e.pick);
    let points = 0;
    if (right) {
      points = flagPoints({ ms: e.ms, streak, index, count, percent });
      streak++;
      correct++;
      total += points;
    } else {
      streak = 0;
    }
    return { correct: right, points, mine: true, streak };
  });
  const bonus = done ? gameBonus(correct, mine, percent) : 0;
  return { score: total + bonus, flags: total, bonus, correct, mine, streak, turns };
}
