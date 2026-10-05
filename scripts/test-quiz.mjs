#!/usr/bin/env node
// Tests the pure modules the page and the API share: seeds, building a
// game, typed answers, packed logs and scoring. Nothing to install.
//
// Run: node scripts/test-quiz.mjs

import { COUNTRIES } from "../main-site/js/countries.js";
import { REGIONS, DIFFICULTIES, maxCount, MS_MAX } from "../main-site/js/rules.js";
import { newSeed, parseSeed, seedFromText, buildSeed } from "../main-site/js/seed.js";
import { buildGame, matchAnswer, isCorrect, normaliseName } from "../main-site/js/quiz.js";
import { packLog, unpackLog, entry, SKIP, TIMEOUT, NONE } from "../main-site/js/log.js";
import { scoreLog, flagPoints, speedBonus } from "../main-site/js/score.js";

let failed = 0;
function check(what, ok, detail = "") {
  if (!ok) {
    failed++;
    console.error(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
}
const index = (code) => COUNTRIES.findIndex((c) => c.code === code);

/* ---- data ---- */
check("194 countries", COUNTRIES.length === 194, String(COUNTRIES.length));
check("codes unique", new Set(COUNTRIES.map((c) => c.code)).size === COUNTRIES.length);
check("sorted by code", COUNTRIES.every((c, i) => i === 0 || COUNTRIES[i - 1].code < c.code));

// No two countries share a common name once normalised.
const names = new Map();
for (const c of COUNTRIES) {
  const key = normaliseName(c.name);
  check(`name ${c.name} unique`, !names.has(key), names.get(key));
  names.set(key, c.name);
}

/* ---- seeds ---- */
for (let n = 0; n < 200; n++) {
  const r = REGIONS[n % REGIONS.length].id;
  const d = DIFFICULTIES[n % DIFFICULTIES.length].id;
  const count = 1 + (n % maxCount(r));
  const s = newSeed(r, d, count);
  check("new seed round trips", seedFromText(s.text)?.text === s.text, s.text);
  check("seed parses with junk", parseSeed(` ${s.text.toLowerCase().replace(/-/g, " ")} `)?.seed?.text === s.text, s.text);
}
check("count past the region refused", parseSeed("ON15-BCDF-GHJK")?.error === "count");
check("Oceania 14 is fine", parseSeed("ON14-BCDF-GHJK")?.seed?.count === 14);
check("bare body takes settings", parseSeed("bcdf ghjk", { region: "E", difficulty: "H", count: 10 })?.seed?.text === "EH10-BCDF-GHJK");
check("bare body ending a count", parseSeed("WN2-2BCD-FGHJ")?.seed?.text === "WN2-2BCD-FGHJ");
check("vowels refused", parseSeed("WN20-AAAA-AAAA")?.error === "bad");
check("unknown region refused", parseSeed("QN20-BCDF-GHJK")?.error === "bad");
check("non canonical text refused", seedFromText("wn20-bcdf-ghjk") === null);

/* ---- games ---- */
for (const d of DIFFICULTIES) {
  for (const r of REGIONS) {
    const seed = buildSeed(r.id, d.id, maxCount(r.id), "BCDFGHJK");
    const g = buildGame(seed);
    const again = buildGame(seedFromText(seed.text));
    check(`${seed.text} deterministic`, JSON.stringify(g.questions) === JSON.stringify(again.questions));
    const answers = g.questions.map((q) => q.answer);
    check(`${seed.text} no repeats`, new Set(answers).size === answers.length);
    check(`${seed.text} whole region`, answers.length === maxCount(r.id));
    if (r.region) check(`${seed.text} in region`, answers.every((a) => COUNTRIES[a].region === r.region));
    for (const q of g.questions) {
      if (!d.choices) {
        check(`${seed.text} typed has no options`, q.options === null);
        continue;
      }
      check(`${seed.text} option count`, q.options.length === d.choices);
      check(`${seed.text} answer once`, q.options.filter((o) => o === q.answer).length === 1);
      check(`${seed.text} options unique`, new Set(q.options).size === q.options.length);
      if (d.spread !== "world") {
        const near = q.options.filter((o) => COUNTRIES[o].region === COUNTRIES[q.answer].region).length;
        const avail = COUNTRIES.filter((c) => c.region === COUNTRIES[q.answer].region).length;
        check(`${seed.text} wrong answers from the region`, near === Math.min(d.choices, avail));
      }
    }
  }
}
const a = buildGame(buildSeed("W", "N", 20, "BCDFGHJK"));
const b = buildGame(buildSeed("W", "N", 20, "BCDFGHJL"));
check("different seeds differ", JSON.stringify(a.questions) !== JSON.stringify(b.questions));

/* ---- typed answers ---- */
const typed = [
  ["united states", "US"], ["USA", "US"], ["the united states of america", "US"], ["UK", "GB"],
  ["united kingdom", "GB"], ["Ivory Coast", "CI"], ["cote d'ivoire", "CI"], ["Côte d’Ivoire", "CI"],
  ["saint lucia", "LC"], ["St. Lucia", "LC"], ["st kitts and nevis", "KN"], ["Burma", "MM"],
  ["Czech Republic", "CZ"], ["czechia", "CZ"], ["Frnace", "FR"], ["Australa", "AU"], ["Bosnia & Herzegovina", "BA"],
  ["Trinidad and Tobago", "TT"], ["DR Congo", "CD"], ["east timor", "TL"], ["Holland", "NL"],
];
for (const [text, code] of typed) {
  const got = matchAnswer(text);
  check(`typed "${text}"`, got === index(code), got >= 0 ? COUNTRIES[got].code : String(got));
}
check("a slip as near two countries counts for neither", matchAnswer("austrlia") === -1);

// Every two letter code names its own country, in any case.
for (const c of COUNTRIES) {
  const got = matchAnswer(c.code.toLowerCase());
  check(`code ${c.code}`, got === index(c.code), got >= 0 ? COUNTRIES[got].code : String(got));
}
// Abbreviations, short and older forms, and other scripts.
const more = [
  ["uae", "AE"], ["PRC", "CN"], ["car", "CF"], ["PNG", "PG"], ["KSA", "SA"], ["ROK", "KR"], ["BiH", "BA"],
  ["stp", "ST"], ["svg", "VC"], ["czech", "CZ"], ["holy see", "VA"], ["Turkey", "TR"], ["España", "ES"], ["espana", "ES"],
  ["日本", "JP"], ["中国", "CN"], ["भारत", "IN"], ["Россия", "RU"], ["Ελλάδα", "GR"], ["مصر", "EG"], ["대한민국", "KR"],
  ["Deutschland", "DE"], ["Nippon", "JP"],
];
for (const [text, code] of more) {
  const got = matchAnswer(text);
  check(`typed "${text}"`, got === index(code), got >= 0 ? COUNTRIES[got].code : String(got));
}
for (const [text, why] of [["iran", "Iraq is one letter away"], ["xx", "nonsense"], ["", "empty"]]) {
  const got = matchAnswer(text);
  if (text === "iran") check(`typed "${text}" is Iran only`, got === index("IR"), why);
  else check(`typed "${text}" refused`, got === -1, `${why}: ${got >= 0 ? COUNTRIES[got].code : got}`);
}
check("Niger is not Nigeria", matchAnswer("niger") === index("NE") && matchAnswer("nigeria") === index("NG"));
check("Austria is not Australia", matchAnswer("austria") === index("AT") && matchAnswer("australia") === index("AU"));
check("Guinea, three ways", new Set(["guinea", "guinea-bissau", "equatorial guinea"].map(matchAnswer)).size === 3);
check("Dominica is not the Dominican Republic", matchAnswer("dominica") !== matchAnswer("dominican republic"));
check("Sudan is not South Sudan", matchAnswer("sudan") !== matchAnswer("south sudan"));
check("Mali is not Malawi", matchAnswer("mali") !== matchAnswer("malawi"));

/* ---- logs ---- */
const choice = buildGame(buildSeed("W", "H", 6, "BCDFGHJK"));
const entries = [entry(0, 1234), entry(5, 999999), entry(SKIP, 3000), entry(TIMEOUT, 15000), entry(NONE, 0), entry(3, 351)];
const packed = packLog(entries);
const back = unpackLog(packed, choice);
check("log round trips", JSON.stringify(back) === JSON.stringify(entries.map((e) => ({ ...e }))), JSON.stringify(back));
check("ms capped", back?.[1].ms === MS_MAX);
check("short log refused", unpackLog(packLog(entries.slice(0, 5)), choice) === null);
check("short log fine when partial", unpackLog(packLog(entries.slice(0, 5)), choice, { partial: true })?.length === 5);
check("long log refused", unpackLog(packLog([...entries, entry(0, 500)]), choice) === null);
check("option past the choices refused", unpackLog(packLog(entries.map((e, i) => (i ? e : entry(5, 500)))), buildGame(buildSeed("W", "N", 6, "BCDFGHJK"))) === null);
check("typed in a choice game refused", unpackLog(packLog(entries.map((e, i) => (i ? e : entry("France", 900)))), choice) === null);
check("junk refused", unpackLog("!!", choice) === null && unpackLog("", choice) === null && unpackLog(null, choice) === null);

const expert = buildGame(buildSeed("E", "X", 3, "BCDFGHJK"));
const typedEntries = [entry("  côte   d'ivoire  ", 4000), entry("日本", 2000), entry(SKIP, 100)];
const typedBack = unpackLog(packLog(typedEntries), expert);
check("typed log round trips", typedBack?.[0].pick === "côte d'ivoire" && typedBack?.[1].pick === "日本", JSON.stringify(typedBack));
check("choice pick in a typed game refused", unpackLog(packLog([entry(1, 500), ...typedEntries.slice(1)]), expert) === null);

/* ---- scoring ---- */
check("speed full", speedBonus(0) === 100 && speedBonus(2000) === 100);
check("speed none", speedBonus(15000) === 0 && speedBonus(60000) === 0);
check("speed halfway", speedBonus(8500) === 50);
check("first flag, slow, no streak, easy", flagPoints({ ms: 20000, streak: 0, index: 0, count: 20, percent: 100 }) === 100);
check("last flag doubles", flagPoints({ ms: 20000, streak: 0, index: 19, count: 20, percent: 100 }) === 200);
check("best flag", flagPoints({ ms: 500, streak: 9, index: 19, count: 20, percent: 300 }) === 1800);

const g20 = buildGame(buildSeed("W", "E", 20, "BCDFGHJK"));
const perfect = g20.questions.map((q) => entry(q.options.indexOf(q.answer), 1500));
const s = scoreLog(g20, perfect);
check("perfect game counts 20", s.correct === 20 && s.mine === 20);
check("perfect game bonus", s.bonus === 200, String(s.bonus));
const allWrong = g20.questions.map((q) => entry(q.options.findIndex((o) => o !== q.answer), 1500));
check("all wrong scores 0", scoreLog(g20, allWrong).score === 0);
const turns = perfect.map((e, i) => (i % 2 ? entry(NONE, 0) : e));
const t = scoreLog(g20, turns);
check("turns: half the flags are mine", t.mine === 10 && t.correct === 10);
check("turns: streak runs across others' flags", t.turns[18].streak === 10);
const longer = scoreLog(buildGame(buildSeed("W", "E", 40, "BCDFGHJK")), buildGame(buildSeed("W", "E", 40, "BCDFGHJK")).questions.map((q) => entry(q.options.indexOf(q.answer), 1500)));
check("a longer game scores more", longer.score > s.score * 1.9, `${longer.score} vs ${s.score}`);
const hard = buildGame(buildSeed("W", "H", 20, "BCDFGHJK"));
const hardScore = scoreLog(hard, hard.questions.map((q) => entry(q.options.indexOf(q.answer), 1500))).score;
check("harder scores more", hardScore === Math.floor(s.score * 2.25) || Math.abs(hardScore - s.score * 2.25) < 25, `${hardScore} vs ${s.score}`);

if (failed) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("quiz ok: seeds, games, typed answers, logs and scoring.");
