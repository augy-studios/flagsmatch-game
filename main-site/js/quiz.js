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

// { seed, difficulty, questions: [{ answer, options }] }. answer is an index
// into COUNTRIES; options are indices too, with the answer among them, or
// null when the answer is typed. No flag comes up twice in a game.
export function buildGame(seed) {
  const difficulty = difficultyById(seed.difficulty);
  const rand = randomSource(hashString(`flags|${seed.text}`));
  const answers = shuffled(regionPool(seed.region), rand).slice(0, seed.count);

  const questions = answers.map((answer) => {
    if (!difficulty.choices) return { answer, options: null };
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

export const flagUrl = (index) => `/flags/${COUNTRIES[index].code.toLowerCase()}.svg`;
export const countryName = (index) => COUNTRIES[index]?.name ?? "";
