// A seed into a game: the flags in order, and the names offered beside
// each. Also what counts as a right typed answer. Pure, like seed.js: the
// API builds the same game from the same seed to check a finished one.

import { COUNTRIES } from "./countries.js";
import { difficultyById, regionPool } from "./rules.js";
import { hashString, randomSource } from "./seed.js";

// A whole number below n. The bias from the modulo is under one in a
// million for any list this game has.
const below = (rand, n) => rand() % n;

function shuffled(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = below(rand, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Wrong answers for the flag `answer`, nearest first: the same subregion,
// then the same region, then anywhere, each group shuffled. `spread` says
// how near they start.
function distractors(answer, spread, need, rand) {
  const a = COUNTRIES[answer];
  const all = COUNTRIES.map((_, i) => i).filter((i) => i !== answer);
  const sub = all.filter((i) => COUNTRIES[i].subregion === a.subregion);
  const region = all.filter((i) => COUNTRIES[i].region === a.region && COUNTRIES[i].subregion !== a.subregion);
  const rest = all.filter((i) => COUNTRIES[i].region !== a.region);

  let order;
  if (spread === "subregion") order = [...shuffled(sub, rand), ...shuffled(region, rand), ...shuffled(rest, rand)];
  else if (spread === "region") order = [...shuffled([...sub, ...region], rand), ...shuffled(rest, rand)];
  else order = shuffled(all, rand);
  return order.slice(0, need);
}

// { seed, difficulty, questions: [{ answer, options, colors, retries }] }.
// answer is an index into COUNTRIES; options are indices too, with the
// answer among them, or null when the answer is typed. colors is true when
// the question shows the flag's colours rather than the flag, retries when
// a wrong guess leaves it open. No flag comes up twice in a game.
export function buildGame(seed) {
  const difficulty = difficultyById(seed.difficulty);
  const rand = randomSource(hashString(`flags|${seed.text}`));
  const answers = shuffled(regionPool(seed.region), rand).slice(0, seed.count);

  const questions = answers.map((answer) => {
    if (!difficulty.choices) {
      return { answer, options: null, colors: difficulty.colors === true, retries: difficulty.retries === true };
    }
    const options = distractors(answer, difficulty.spread, difficulty.choices - 1, rand);
    options.splice(below(rand, difficulty.choices), 0, answer);
    return { answer, options };
  });
  return { seed, difficulty, questions };
}

/* ---- typed answers ----
   Forgiving about everything but the country: case, accents, punctuation,
   spaces, "the", "and" against "&", and "St" against "Saint". Any name in
   the country's list counts, its official one and the usual alternatives.
   A small slip is forgiven too, if it is still nearer that country than any
   other. */

// Letters in every script are kept, so "日本", "Россия" and "भारत" match
// their countries; only Latin accents are dropped. Other combining marks
// stay, since in Devanagari or Arabic they are part of the word.
export function normaliseName(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(/\bsaint\b/g, "st")
    .replace(/^the /, "")
    .replace(/ /g, "");
}

// Every name, normalised, to its country. A name two countries share
// counts for neither.
const NAMES = new Map();
const AMBIGUOUS = -1;
COUNTRIES.forEach((c, i) => {
  for (const name of [c.name, ...c.aliases]) {
    const key = normaliseName(name);
    if (key.length < 2) continue;
    const had = NAMES.get(key);
    NAMES.set(key, had === undefined || had === i ? i : AMBIGUOUS);
  }
});

// Edits from a to b, where two letters swapped count as one ("Frnace"),
// giving up past `cap`.
function editDistance(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let before = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j], before[j - 2] + 1);
      }
      if (row[j] < best) best = row[j];
    }
    if (best > cap) return cap + 1;
    before = prev;
    prev = row;
  }
  return prev[b.length];
}

// How many slips a typed answer of this length may have.
const slack = (length) => (length >= 9 ? 2 : length >= 5 ? 1 : 0);

// The country a typed answer names, as an index, or -1.
export function matchAnswer(text) {
  const key = normaliseName(text);
  if (key.length < 2) return -1;
  const exact = NAMES.get(key);
  if (exact !== undefined) return exact;

  const cap = slack(key.length);
  if (!cap) return -1;
  let best = cap + 1;
  let found = -1;
  for (const [name, index] of NAMES) {
    const d = editDistance(key, name, cap);
    if (d < best) {
      best = d;
      found = index;
    } else if (d === best && index !== found) {
      found = AMBIGUOUS;
    }
  }
  return best <= cap && found >= 0 ? found : -1;
}

// Whether a pick answers a question: an option's place for multiple choice,
// or the text typed.
export function isCorrect(question, pick) {
  if (question.options) return Number.isInteger(pick) && question.options[pick] === question.answer;
  return typeof pick === "string" && matchAnswer(pick) === question.answer;
}

/* ---- Expert's retries and hints ---- */

// How a typed guess at a question that allows retries went: "right";
// "wrong", naming another country; "again", a country already tried; or
// "unknown", naming none. Only "wrong" costs anything. `tried` is the set
// of countries guessed so far, and `named` the country this one names.
export function judgeGuess(question, text, tried) {
  const named = matchAnswer(text);
  if (named === question.answer) return { verdict: "right", named };
  if (named < 0) return { verdict: "unknown", named };
  return { verdict: tried.has(named) ? "again" : "wrong", named };
}

// The few subregions that read better with "the".
const WITH_THE = new Set(["Caribbean"]);

// A name with only the letters `keep(i)` says to show, i being a letter's
// place in its word; "Guinea-Bissau" and "d'Ivoire" are two words each.
// Spaces between words stay wide, and anything not a letter shows.
function masked(name, keep) {
  return name
    .split(" ")
    .map((word) => {
      let i = 0;
      return Array.from(word)
        .map((ch) => {
          if (!/\p{L}/u.test(ch)) {
            i = 0;
            return ch;
          }
          return keep(i++) ? ch : "_";
        })
        .join(" ");
    })
    .join("   ");
}

// The first `n` hints for a question, up to HINT_MAX: where the country is,
// the shape of its name, then every other letter.
export function hintsFor(question, n) {
  const c = COUNTRIES[question.answer];
  const all = [
    `It's in ${WITH_THE.has(c.subregion) ? "the " : ""}${c.subregion}.`,
    masked(c.name, (i) => i === 0),
    masked(c.name, (i) => i % 2 === 0),
  ];
  return all.slice(0, n);
}

export const flagUrl = (index) => `/flags/${COUNTRIES[index].code.toLowerCase()}.svg`;
export const countryName = (index) => COUNTRIES[index]?.name ?? "";
