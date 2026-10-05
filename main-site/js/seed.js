// Game seeds. A seed decides everything about a game before it is played:
// which flags come up, in what order, and which wrong answers sit beside
// each one. The same seed is always the same game, which is what lets a
// seed be shared and pasted, a replay be packed into a link, and the API
// check a finished game.
//
// Written as "WN20-BXK4-M9TR": the region (W world, F Africa, A Americas,
// S Asia, E Europe, O Oceania), the difficulty (E easy, N normal, H hard,
// X expert), the number of flags, then the eight characters of the seed
// proper. A bare eight characters is a seed too, played with whatever the
// new-game screen has picked.
//
// Integer arithmetic only, as in uwuChess: Math.random would make a game
// come out differently on the server.

import { REGIONS, DIFFICULTIES, maxCount } from "./rules.js";

// No vowels, and no 0 O 1 I: a seed read aloud cannot be misheard and
// cannot spell a word.
const ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789";
const BODY_LENGTH = 8;
export const SEED_MAX = 20;

// 32 bit string hash (cyrb53's mixing, one half of it).
export function hashString(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

// mulberry32. Returns unsigned 32 bit integers.
export function randomSource(seedNumber) {
  let a = seedNumber >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function randomBody() {
  // Bytes at or above the limit would make some characters likelier.
  const limit = 256 - (256 % ALPHABET.length);
  let body = "";
  while (body.length < BODY_LENGTH) {
    const [byte] = globalThis.crypto.getRandomValues(new Uint8Array(1));
    if (byte < limit) body += ALPHABET[byte % ALPHABET.length];
  }
  return body;
}

const isBody = (s) => s.length === BODY_LENGTH && [...s].every((c) => ALPHABET.includes(c));

// null when the settings are not a game that can be played.
export function buildSeed(region, difficulty, count, body) {
  if (!REGIONS.some((r) => r.id === region)) return null;
  if (!DIFFICULTIES.some((d) => d.id === difficulty)) return null;
  if (!Number.isInteger(count) || count < 1 || count > maxCount(region)) return null;
  if (!isBody(body)) return null;
  const text = `${region}${difficulty}${count}-${body.slice(0, 4)}-${body.slice(4)}`;
  return { region, difficulty, count, body, text };
}

export function newSeed(region, difficulty, count) {
  return buildSeed(region, difficulty, count, randomBody());
}

// Whatever was typed or pasted, forgiving about case, spaces and dashes.
// A full seed carries its own settings; a bare body takes `fallback`'s.
// Returns { seed } or { error } or null for an empty field.
export function parseSeed(input, fallback = null) {
  const raw = String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!raw) return null;
  if (raw.length < BODY_LENGTH) return { error: "short" };
  // The body is always the last eight; the count before it can end in a
  // digit the body also starts with, so it is never read greedily.
  const body = raw.slice(-BODY_LENGTH);
  if (!isBody(body)) return { error: "bad" };
  const prefix = raw.slice(0, -BODY_LENGTH);
  if (!prefix) {
    if (!fallback) return { error: "bad" };
    const seed = buildSeed(fallback.region, fallback.difficulty, fallback.count, body);
    return seed ? { seed, bare: true } : { error: "count" };
  }
  const m = /^([A-Z])([A-Z])(\d{1,3})$/.exec(prefix);
  if (!m) return { error: "bad" };
  const seed = buildSeed(m[1], m[2], Number(m[3]), body);
  if (seed) return { seed, bare: false };
  // A real region and difficulty with too many flags for the region.
  const known = REGIONS.some((r) => r.id === m[1]) && DIFFICULTIES.some((d) => d.id === m[2]);
  return { error: known ? "count" : "bad" };
}

// The canonical text back to a seed, for the API and replay links. null if
// it is not exactly a full seed.
export function seedFromText(text) {
  const parsed = parseSeed(text);
  return parsed?.seed && !parsed.bare && parsed.seed.text === text ? parsed.seed : null;
}
