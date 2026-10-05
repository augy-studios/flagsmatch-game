#!/usr/bin/env node
// Fails on a PRECACHE entry in main-site/sw.js with no file on disk, on a
// module or stylesheet that exists but is not precached, and on FLAG_CODES
// disagreeing with js/countries.js or main-site/flags/, since any of these
// is a hole in offline play.
//
// Run: node scripts/check-precache.mjs

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "main-site");
const source = readFileSync(join(ROOT, "sw.js"), "utf8");

const block = source.match(/const PRECACHE\s*=\s*\[([\s\S]*?)\n\];/);
if (!block) {
  console.error("could not find the PRECACHE array in main-site/sw.js");
  process.exit(1);
}

const entries = block[1]
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "")
  .split("\n")
  .map((line) => line.match(/["']([^"']+)["']/)?.[1])
  .filter(Boolean);

// cleanUrls is on, so "/" is index.html on disk.
const onDisk = (route) => (route === "/" ? "index.html" : route.replace(/^\//, ""));

const seen = new Set();
const missing = [];
const duplicates = [];
for (const route of entries) {
  if (seen.has(route)) duplicates.push(route);
  seen.add(route);
  if (!existsSync(join(ROOT, onDisk(route)))) missing.push(route);
}

const unlisted = [];
for (const [dir, ext] of [["js", ".js"], ["css", ".css"]]) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) continue;
  for (const f of readdirSync(full)) {
    if (!f.endsWith(ext)) continue;
    const route = `/${dir}/${f}`;
    if (!seen.has(route)) unlisted.push(route);
  }
}

// The flags: the worker's list, the data and the files must be one set.
const flagProblems = [];
const listed = source.match(/const FLAG_CODES\s*=\s*"([a-z ]+)"/)?.[1]?.split(" ") ?? [];
if (!listed.length) flagProblems.push("no FLAG_CODES string in sw.js");
const { COUNTRIES } = await import(pathToFileURL(join(ROOT, "js", "countries.js")).href);
const codes = COUNTRIES.map((c) => c.code.toLowerCase());
const files = existsSync(join(ROOT, "flags")) ? readdirSync(join(ROOT, "flags")).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)) : [];
for (const c of codes) {
  if (!listed.includes(c)) flagProblems.push(`${c}: in countries.js, not in FLAG_CODES`);
  if (!files.includes(c)) flagProblems.push(`${c}: in countries.js, no flags/${c}.svg`);
}
for (const c of listed) if (!codes.includes(c)) flagProblems.push(`${c}: in FLAG_CODES, not in countries.js`);
for (const c of files) if (!codes.includes(c)) flagProblems.push(`flags/${c}.svg: not in countries.js`);

if (duplicates.length) console.error(`duplicate PRECACHE entries:\n  - ${duplicates.join("\n  - ")}`);
if (missing.length) console.error(`PRECACHE entries with no file on disk:\n  - ${missing.join("\n  - ")}`);
if (unlisted.length) console.error(`files the app loads that are not precached:\n  - ${unlisted.join("\n  - ")}`);
if (flagProblems.length) console.error(`flags out of step:\n  - ${flagProblems.join("\n  - ")}`);

if (missing.length || duplicates.length || unlisted.length || flagProblems.length) process.exit(1);

console.log(`precache ok: ${entries.length} entries and ${listed.length} flags, all present, nothing left out.`);
