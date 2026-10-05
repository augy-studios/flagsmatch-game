#!/usr/bin/env node
// Tests the API's check on a finished game (main-site/api/_lib/verify.js)
// without a database: honest logs pass and score what the page scores,
// forged ones are refused.
//
// Run: node scripts/test-verify.mjs

import { checkLog, duelConflict } from "../main-site/api/_lib/verify.js";
import { buildSeed } from "../main-site/js/seed.js";
import { buildGame } from "../main-site/js/quiz.js";
import { packLog, entry, SKIP, TIMEOUT, NONE } from "../main-site/js/log.js";
import { scoreLog } from "../main-site/js/score.js";

let failed = 0;
function check(what, ok, detail = "") {
  if (!ok) {
    failed++;
    console.error(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
}
// The warnings verify.js logs for refused games are expected here.
console.warn = () => {};

function row(seed, extra = {}) {
  return { id: "test", seed: seed.text, region: seed.region, difficulty: seed.difficulty, flag_count: seed.count, mode: "solo", seat: 0, players: 1, ...extra };
}
function refused(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
}

const seed = buildSeed("W", "N", 10, "BCDFGHJK");
const game = buildGame(seed);
const right = (q, ms = 1500) => entry(q.options.indexOf(q.answer), ms);
const honest = game.questions.map((q, i) => (i === 3 ? entry(SKIP, 2000) : right(q, 1200 + i * 100)));
const spent = honest.reduce((n, e) => n + e.ms, 0);

const ok = checkLog(row(seed), packLog(honest), spent + 9000);
check("honest game passes", ok.correct === 9);
check("server scores as the page does", ok.score === scoreLog(game, honest).score, `${ok.score}`);

check("forged log refused", refused(() => checkLog(row(seed), "AQID", 60000)) === "implausible");
check("too quick an answer refused", refused(() => checkLog(row(seed), packLog(honest.map((e, i) => (i ? e : right(game.questions[0], 200)))), 60000)) === "implausible");
check("more time than the server saw refused", refused(() => checkLog(row(seed), packLog(honest), spent - 6000)) === "implausible");
check("within the clock slack passes", refused(() => checkLog(row(seed), packLog(honest), spent - 4000)) === null);
check("a time limit in a solo game refused", refused(() => checkLog(row(seed), packLog(honest.map((e, i) => (i ? e : entry(TIMEOUT, 15000)))), 60000)) === "implausible");
check("none in a solo game refused", refused(() => checkLog(row(seed), packLog(honest.map((e, i) => (i ? e : entry(NONE, 0)))), 60000)) === "implausible");
check("log for another seed refused", refused(() => checkLog(row(buildSeed("W", "N", 9, "BCDFGHJK")), packLog(honest), 60000)) === "implausible");

// Race: everyone answers, and a flag can time out.
const race = row(seed, { mode: "race", players: 3, seat: 2 });
const raced = honest.map((e, i) => (i === 5 ? entry(TIMEOUT, 15000) : e));
check("race with a timeout passes", refused(() => checkLog(race, packLog(raced), 120000)) === null);
check("race past the flag's time refused", refused(() => checkLog(race, packLog(raced.map((e, i) => (i === 5 ? entry(SKIP, 20000) : e))), 120000)) === "implausible");

// Take turns: seat 1 of 3 answers flags 1, 4, 7.
const turnsRow = row(seed, { mode: "turns", players: 3, seat: 1 });
const mine = honest.map((e, i) => (i % 3 === 1 ? (e.pick === SKIP ? right(game.questions[i]) : e) : entry(NONE, 0)));
check("take turns, own flags only, passes", refused(() => checkLog(turnsRow, packLog(mine), 60000)) === null);
check("take turns, another's flag answered, refused", refused(() => checkLog(turnsRow, packLog(mine.map((e, i) => (i === 0 ? right(game.questions[0]) : e))), 60000)) === "implausible");
check("take turns, own flag left out, refused", refused(() => checkLog(turnsRow, packLog(mine.map((e, i) => (i === 1 ? entry(NONE, 0) : e))), 60000)) === "implausible");
check("take turns scores own flags only", checkLog(turnsRow, packLog(mine), 60000).correct === 3);

// Head to head: a flag can be taken by either player, never both.
const a = game.questions.map((q, i) => (i % 2 ? entry(NONE, 0) : right(q)));
const b = game.questions.map((q, i) => (i % 2 ? right(q) : entry(NONE, 0)));
check("duel halves agree", duelConflict(game, a, b) === -1);
check("duel both taking a flag clash", duelConflict(game, a, a) === 0);
const wrongA = game.questions.map((q, i) => (i % 2 ? entry(q.options.findIndex((o) => o !== q.answer), 900) : right(q)));
check("a wrong answer beside a taken flag is fine", duelConflict(game, wrongA, b) === -1);

// Expert: typed answers, with a minimum time for each character.
const xSeed = buildSeed("E", "X", 3, "BCDFGHJK");
const xGame = buildGame(xSeed);
const { COUNTRIES } = await import("../main-site/js/countries.js");
const typed = xGame.questions.map((q) => entry(COUNTRIES[q.answer].name, 3000));
check("typed game passes", checkLog(row(xSeed), packLog(typed), 20000).correct === 3);
const quick = typed.map((e, i) => (i ? e : entry(COUNTRIES[xGame.questions[0].answer].name, 300)));
check("typing a long name in 300 ms refused", refused(() => checkLog(row(xSeed), packLog(quick), 20000)) === "implausible");

if (failed) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("verify ok: honest games pass and score alike, forged ones are refused.");
