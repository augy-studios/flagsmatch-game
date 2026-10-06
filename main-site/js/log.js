// A player's game as a list of answers, and that list packed into a short
// string. The same string travels in a replay link, goes to the API to be
// checked and scored, and is stored as the record of the game. Pure.
//
// An entry is { pick, ms }: pick is the option's place for multiple choice,
// the text typed for Hard and Expert, or one of the constants below; ms is how long
// it took, to the nearest 10 ms.

import { MS_MAX, MS_STEP, TYPED_MAX } from "./rules.js";

export const SKIP = -1; // passed on the flag
export const TIMEOUT = -2; // the flag's time ran out (games with others only)
export const NONE = -3; // not this player's flag: another's turn, or taken first

const VERSION = 1;
const TAG = { [SKIP]: 0xf0, [TIMEOUT]: 0xf1, [NONE]: 0xf2 };
const TYPED = 0xf3;
const MAX_OPTION = 5;
const TYPED_BYTES = TYPED_MAX * 4;
// The longest game is a few hundred flags; this bounds what is decoded.
export const LOG_MAX_CHARS = 16000;

export const isAnswer = (pick) => (Number.isInteger(pick) && pick >= 0) || typeof pick === "string";

export function quantise(ms) {
  const n = Number.isFinite(ms) ? Math.round(ms / MS_STEP) * MS_STEP : 0;
  return Math.max(0, Math.min(MS_MAX, n));
}

// What a typed answer is stored as: trimmed, spaces collapsed, capped.
export function cleanTyped(text) {
  return Array.from(String(text ?? "").normalize("NFC").replace(/\s+/g, " ").trim())
    .slice(0, TYPED_MAX)
    .join("");
}

export function entry(pick, ms) {
  return { pick: typeof pick === "string" ? cleanTyped(pick) : pick, ms: pick === NONE ? 0 : quantise(ms) };
}

function toBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  if (typeof text !== "string" || text.length > LOG_MAX_CHARS || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function packLog(entries) {
  const bytes = [VERSION];
  for (const { pick, ms } of entries) {
    if (typeof pick === "string") {
      const text = new TextEncoder().encode(cleanTyped(pick)).slice(0, TYPED_BYTES);
      bytes.push(TYPED, text.length, ...text);
    } else {
      bytes.push(pick >= 0 ? pick : TAG[pick]);
    }
    const units = Math.round(quantise(ms) / MS_STEP);
    bytes.push(units >> 8, units & 255);
  }
  return toBase64Url(bytes);
}

// The entries a packed string stands for, checked against the game it is
// said to be a log of: one entry per flag, picks of the kind the game asks
// for. null if anything is off, so a damaged link or a forged log is
// refused rather than half read. `partial` accepts a game still going, as a
// network snapshot carries.
export function unpackLog(packed, game, { partial = false } = {}) {
  const bytes = fromBase64Url(packed);
  if (!bytes || bytes[0] !== VERSION) return null;
  const choices = game.difficulty.choices;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = [];
  let at = 1;

  while (at < bytes.length) {
    if (entries.length >= game.questions.length) return null;
    const tag = bytes[at++];
    let pick;
    if (tag <= MAX_OPTION) {
      if (tag >= choices) return null;
      pick = tag;
    } else if (tag === TYPED) {
      if (choices) return null;
      const length = bytes[at++];
      if (!length || length > TYPED_BYTES || at + length > bytes.length) return null;
      try {
        pick = decoder.decode(bytes.subarray(at, at + length));
      } catch {
        return null;
      }
      at += length;
      if (!pick || pick !== cleanTyped(pick)) return null;
    } else {
      pick = Number(Object.keys(TAG).find((k) => TAG[k] === tag));
      if (!Number.isInteger(pick)) return null;
    }
    if (at + 2 > bytes.length) return null;
    const ms = ((bytes[at] << 8) | bytes[at + 1]) * MS_STEP;
    at += 2;
    if (pick === NONE && ms !== 0) return null;
    entries.push({ pick, ms });
  }
  return entries.length === game.questions.length || partial ? entries : null;
}
