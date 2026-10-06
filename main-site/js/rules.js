// The game's settings and limits, in one place for the page and the API.
// Pure: no DOM, nothing browser only, since api/ imports it too.

import { COUNTRIES } from "./countries.js";

// The one letter id is what a seed carries; see seed.js.
export const REGIONS = [
  { id: "W", label: "World", region: null },
  { id: "F", label: "Africa", region: "Africa" },
  { id: "A", label: "Americas", region: "Americas" },
  { id: "S", label: "Asia", region: "Asia" },
  { id: "E", label: "Europe", region: "Europe" },
  { id: "O", label: "Oceania", region: "Oceania" },
];

// choices: how many names to pick from, 0 for typing the answer.
// spread: where the wrong answers come from. colors: a pie chart of the
// flag's colours in place of the flag. percent: what every point in the
// game is multiplied by.
export const DIFFICULTIES = [
  { id: "E", label: "Easy", choices: 4, spread: "world", percent: 100, about: "Four names, from anywhere in the world." },
  { id: "N", label: "Normal", choices: 4, spread: "region", percent: 150, about: "Four names from the same part of the world." },
  { id: "H", label: "Hard", choices: 0, spread: null, percent: 300, about: "No names to pick from: type the country." },
  { id: "X", label: "Expert", choices: 0, spread: null, colors: true, percent: 400, about: "No flag, only a pie chart of its colours: type the country." },
];

export const COUNT_PRESETS = [5, 10, 15, 20];

export const regionById = (id) => REGIONS.find((r) => r.id === id) ?? null;
export const difficultyById = (id) => DIFFICULTIES.find((d) => d.id === id) ?? null;

// Indices into COUNTRIES a game in this region draws its flags from.
export function regionPool(regionId) {
  const region = regionById(regionId)?.region;
  const out = [];
  COUNTRIES.forEach((c, i) => {
    if (!region || c.region === region) out.push(i);
  });
  return out;
}

export const maxCount = (regionId) => regionPool(regionId).length;

/* ---- timing ----
   Every answer carries how long it took, measured from the moment the flag
   was on screen, to the nearest 10 ms. The score pays for speed, and the
   API holds those times against its own clock. */

export const MS_STEP = 10;
// Two bytes of 10 ms in a packed log.
export const MS_MAX = 65535 * MS_STEP;
// Quicker than this, nobody read the flag. A typed answer also needs time
// for each character.
export const MIN_ANSWER_MS = 350;
export const MIN_TYPED_MS = 250;
export const MS_PER_TYPED_CHAR = 40;
// A typed answer's length cap, in characters.
export const TYPED_MAX = 32;
// How long a flag lasts in a game with other people. Alone there is no limit.
export const TURN_LIMIT_MS = 15000;
// How long the page shows the right answer before the next flag.
export const FEEDBACK_MS = 900;
// What the API allows between the page's clock and its own.
export const CLOCK_SLACK_MS = 5000;

/* ---- ways to play ---- */

// solo: one person. race: everyone answers every flag. turns: players
// take the flags in turn. duel: two players, first right answer takes it.
export const MODES = ["solo", "race", "turns", "duel"];
export const MP_MODES = ["race", "turns", "duel"];
export const MAX_PLAYERS = { solo: 1, race: 8, turns: 8, duel: 2 };
export const MODE_LABELS = { solo: "Solo", race: "Race", turns: "Take turns", duel: "Head to head" };
