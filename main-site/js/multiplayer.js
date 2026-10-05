// Games with others on the same network: one device hosts with a six
// character code, a link or a QR code, and up to seven others join, over
// net.js (STUN only, per STUN-p2p-spec.md). Three ways to play:
//
//   race    everyone answers every flag; next flag once all have answered
//           or its time is up
//   turns   the flags go round, one player at a time
//   duel    two players; the first right answer takes the flag, and a
//           wrong answer is out for that flag
//
// The host is authoritative. Guests send answers; the host checks and
// scores them and sends the whole game back, 20 times a second and on every
// change. Host and guests draw from the same snapshot, so every screen is
// the same game. Each player's own answers become their own game record:
// their replay, their link, and, on a seed the server picked, their own
// leaderboard entry with their own start ticket.
//
// Messages, beyond the spec's hello, state, bye and full:
//
//   { type: "hello", v, id, name }               guest to host; id is per tab
//   { type: "answer", round, turn, pick, ms }    guest to host
//   { type: "ping" }                             guest to host, the heartbeat
//   { type: "started" }                          host to guest: no new seats now
//   { type: "old", v }                           host to guest: different build

import { Host, Guest, generateCode, isValidCode, normaliseCode, CODE_LENGTH, PROTOCOL_VERSION } from "./net.js";
import * as game from "./game.js";
import * as view from "./view.js";
import { qrToSvg } from "./qr.js";
import { api } from "./api.js";
import { copyText, hydrateIcons, store } from "./ui.js";
import { getSettings } from "./settings.js";
import { MAX_PLAYERS, MODE_LABELS, MP_MODES, TURN_LIMIT_MS, regionById, difficultyById, maxCount } from "./rules.js";
import { newSeed, seedFromText } from "./seed.js";
import { buildGame, isCorrect, countryName } from "./quiz.js";
import { entry, packLog, unpackLog, cleanTyped, isAnswer, LOG_MAX_CHARS, NONE, SKIP, TIMEOUT } from "./log.js";
import { scoreLog } from "./score.js";

const HOST_CODE_KEY = "flagsmatch.hostCode";
const LAST_CODE_KEY = "flagsmatch.lastCode";
const PLAYER_ID_KEY = "flagsmatch.playerId";
const TICKETS_KEY = "flagsmatch.mpTickets";

const SNAPSHOT_MS = 50;
const TICK_MS = 100;
const PING_MS = 1000;
const HOST_SILENCE_MS = 8000;
// Time, not missed snapshots: a few missed ones is an ordinary wifi stall,
// and a background host tab only ticks about once a second.
const GUEST_STALE_MS = 2000;
const COUNTDOWN_MS = 3000;
const REVEAL_MS = 2200;
// Guests see each flag a moment after the host does.
const GRACE_MS = 800;
const NAME_MAX = 20;
const PHASES = ["lobby", "starting", "countdown", "question", "reveal", "over"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PASTED = "A game on a pasted seed is not scored for the leaderboard, since its answers could have been seen before.";

const $ = (id) => document.getElementById(id);

let role = null; // "host" | "guest" | null
let host = null;
let guest = null;
let code = "";
let retriedTaken = false;
let reconnects = 0;
let wakeLock = null;

/* ---- who this tab is ----
   Per tab, so two tabs of one browser are two players, and kept for the
   tab's life, so a guest that reloads gets its seat back. */

function makeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let memoryId = null;
function playerId() {
  try {
    let id = sessionStorage.getItem(PLAYER_ID_KEY);
    if (!/^[A-Za-z0-9_-]{16}$/.test(id ?? "")) {
      id = makeId();
      sessionStorage.setItem(PLAYER_ID_KEY, id);
    }
    return id;
  } catch {
    memoryId ??= makeId();
    return memoryId;
  }
}

function cleanName(value) {
  const name = Array.from(String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim())
    .slice(0, NAME_MAX)
    .join("");
  return name || "Player";
}

const myName = () => cleanName(getSettings().name ?? "");

/* ---- start tickets, one per player per game ---- */

function savedTicket(roomId, seat) {
  return store.getJSON(TICKETS_KEY)?.[`${roomId}:${seat}`] ?? null;
}
function saveTicket(roomId, seat, gameId) {
  const all = store.getJSON(TICKETS_KEY) ?? {};
  all[`${roomId}:${seat}`] = gameId;
  // The last few games are all a reload could want.
  store.set(TICKETS_KEY, Object.fromEntries(Object.entries(all).slice(-6)));
}

function unrankedReason(err) {
  if (err?.code === "offline") return "This game started offline, so it is not scored for the leaderboard.";
  if (err?.code === "not_configured") return "The leaderboard is not set up yet, so this game is not scored.";
  if (err?.code === "same_device") return "The host's browser cannot also be a guest on the leaderboard, so this game is not scored.";
  return err?.message || "The leaderboard could not be reached when this game started, so it is not scored.";
}

/* ======================================================================
   The host
   ====================================================================== */

let room = null;

function newRoom(plan, format) {
  return {
    format,
    plan, // { region, difficulty, count, seed: text or null }
    round: 0,
    phase: "lobby",
    players: [{ id: playerId(), name: myName(), link: null, connected: true, lastHeard: Date.now(), entries: [], score: 0, correct: 0 }],
    seed: null,
    game: null,
    roomId: null,
    serverSeed: false,
    ticket: null,
    unranked: null,
    turn: 0,
    turnStart: 0,
    turnEnds: 0,
    phaseEnds: 0,
    winner: -1,
  };
}

const joinLink = (c) => `${location.origin}/?join=${c}`;

export function startHosting() {
  if (role === "host" && host) return;
  const chosen = game.getSetup();
  if (!chosen) return;
  closeAll();
  role = "host";
  room = newRoom({ region: chosen.region, difficulty: chosen.difficulty, count: chosen.count, seed: chosen.seed?.text ?? null }, chosen.format);
  openHost();
}

function openHost() {
  code = readCode(HOST_CODE_KEY) ?? generateCode();
  store.set(HOST_CODE_KEY, code);

  game.showPanel("net");
  $("hostView").classList.remove("hidden");
  $("hostCode").textContent = code;
  $("hostQr").innerHTML = qrToSvg(joinLink(code));
  $("copyLinkLabel").textContent = "Copy link";
  $("newCodeBtn").classList.remove("hidden");
  $("netRetryBtn").classList.add("hidden");
  $("netCancelLabel").textContent = "Cancel";
  setNetStatus(navigator.onLine === false ? "Playing with others needs a connection to pair." : "Setting up the code.");
  renderLobby(snapshotFor(0));

  const mine = new Host({ maxGuests: MAX_PLAYERS.race - 1 });
  host = mine;
  mine.addEventListener("status", ({ detail }) => {
    if (host !== mine) return;
    if (detail.taken && !retriedTaken) {
      // Another tab holds it, or the broker has not let go of it yet.
      retriedTaken = true;
      store.remove(HOST_CODE_KEY);
      reopenHost();
      return;
    }
    if (detail.status === "waiting") retriedTaken = false;
    if (detail.status === "error") setNetStatus(detail.message, true);
    else if (room?.phase === "lobby") setNetStatus(lobbyStatus());
    if (detail.status === "connected") acquireWakeLock();
    renderBar();
  });
  mine.addEventListener("message", ({ detail }) => {
    if (host === mine) onHostMessage(detail.message, detail.from);
  });
  mine.addEventListener("leave", ({ detail }) => {
    if (host === mine) onLinkGone(detail.id);
  });

  mine.start(code).catch(() => {
    if (host !== mine) return;
    host = null;
    setNetStatus("Could not load pairing. Check your connection.", true);
  });
}

function reopenHost() {
  host?.close();
  host = null;
  openHost();
}

function stopHosting() {
  host?.close();
  host = null;
  room = null;
  role = null;
  releaseWakeLock();
}

const connectedPlayers = () => room.players.filter((p) => p.connected);

function lobbyStatus() {
  const n = connectedPlayers().length;
  if (n < 2) return "Waiting for others to join.";
  if (room.format === "duel" && n > 2) return "Head to head is for two players.";
  return `${n} players ready. Start when everyone is in.`;
}

function onLinkGone(peerId) {
  const p = room?.players.find((x) => x.link === peerId);
  if (!p) return;
  p.link = null;
  p.connected = false;
  // Before a game a seat is not held for anybody.
  if (room.phase === "lobby") room.players = room.players.filter((x) => x !== p);
  changed();
}

function onHostMessage(message, from) {
  if (!room) return;
  const p = room.players.find((x) => x.link === from);
  if (p) p.lastHeard = Date.now();

  switch (message.type) {
    case "hello": {
      if (message.v !== PROTOCOL_VERSION) {
        host.send({ type: "old", v: PROTOCOL_VERSION }, from);
        return;
      }
      if (typeof message.id !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(message.id) || message.id === room.players[0].id) return;
      const known = room.players.find((x) => x.id === message.id);
      if (known) {
        // Back after a reload or a dropped link: the same seat.
        const old = known.link && known.link !== from ? host.links.get(known.link) : null;
        known.link = from;
        known.connected = true;
        known.lastHeard = Date.now();
        known.name = cleanName(message.name);
        if (old) host.drop(old);
      } else if (room.phase !== "lobby") {
        refuse(from, "started");
        return;
      } else if (room.players.length >= MAX_PLAYERS[room.format]) {
        refuse(from, "full");
        return;
      } else {
        room.players.push({ id: message.id, name: cleanName(message.name), link: from, connected: true, lastHeard: Date.now(), entries: [], score: 0, correct: 0 });
      }
      if (room.phase === "lobby") setNetStatus(lobbyStatus());
      changed();
      return;
    }
    case "answer": {
      if (!p || message.round !== room.round || message.turn !== room.turn) return;
      const seat = room.players.indexOf(p);
      applyAnswer(seat, message.pick, message.ms);
      return;
    }
    case "bye":
      if (p) {
        p.connected = false;
        p.link = null;
        if (room.phase === "lobby") room.players = room.players.filter((x) => x !== p);
        changed();
      }
      return;
    default:
      // ping, and anything this build does not know: ignored, never thrown on.
      return;
  }
}

function refuse(peerId, type) {
  host.send({ type }, peerId);
  const link = host.links.get(peerId);
  if (link) setTimeout(() => host?.links.get(peerId) === link && host.drop(link), 500);
}

/* ---- running a game ---- */

async function startGame() {
  if (!room || (room.phase !== "lobby" && room.phase !== "over")) return;
  const players = connectedPlayers();
  if (players.length < 2 || (room.format === "duel" && players.length !== 2)) {
    setNetStatus(lobbyStatus(), true);
    return;
  }
  room.players = players.map((p) => ({ ...p, entries: [], score: 0, correct: 0 }));
  room.phase = "starting";
  changed();

  const plan = room.plan;
  let seed = plan.seed ? seedFromText(plan.seed) : null;
  room.roomId = null;
  room.ticket = null;
  room.serverSeed = false;
  room.unranked = seed ? PASTED : null;
  if (!seed) {
    try {
      if (navigator.onLine === false) throw { code: "offline" };
      const t = await api.start({ mode: room.format, players: room.players.length, region: plan.region, difficulty: plan.difficulty, count: plan.count });
      seed = seedFromText(t.seed);
      if (seed) {
        room.roomId = t.game_id;
        room.serverSeed = t.server_seed === true;
        room.ticket = { gameId: t.game_id, serverSeed: room.serverSeed };
      }
    } catch (err) {
      room.unranked = unrankedReason(err);
    }
    if (!room) return;
    seed ??= newSeed(plan.region, plan.difficulty, plan.count);
    room.unranked ??= room.ticket ? null : unrankedReason(null);
  }

  room.round++;
  room.seed = seed;
  room.game = buildGame(seed);
  room.phase = "countdown";
  room.phaseEnds = Date.now() + COUNTDOWN_MS;
  changed();
}

function startTurn(i) {
  const now = Date.now();
  room.turn = i;
  room.phase = "question";
  room.turnStart = now;
  room.turnEnds = now + TURN_LIMIT_MS + GRACE_MS;
  room.winner = -1;
  changed();
}

const activeSeat = () => (room.format === "turns" ? room.turn % room.players.length : -1);

function mayAnswer(seat) {
  if (room.phase !== "question") return false;
  if (room.players[seat]?.entries[room.turn] !== undefined) return false;
  return room.format !== "turns" || seat === activeSeat();
}

function applyAnswer(seat, pick, ms) {
  if (!room || !mayAnswer(seat)) return;
  const q = room.game.questions[room.turn];
  if (pick !== SKIP) {
    if (q.options && !(Number.isInteger(pick) && pick >= 0 && pick < q.options.length)) return;
    if (!q.options && (typeof pick !== "string" || !cleanTyped(pick))) return;
  }
  if (!Number.isFinite(ms) || ms < 0) return;
  const e = entry(pick, Math.min(ms, TURN_LIMIT_MS));
  room.players[seat].entries[room.turn] = e;

  if (room.format === "duel" && isAnswer(e.pick) && isCorrect(q, e.pick)) {
    room.winner = seat;
    reveal();
    return;
  }
  const waiting =
    room.format === "turns"
      ? room.players[activeSeat()].entries[room.turn] === undefined
      : room.players.some((p) => p.connected && p.entries[room.turn] === undefined);
  if (waiting) changed();
  else reveal();
}

// The flag's answers are in, or its time is up. Everyone without an entry
// gets the one the way of playing gives them.
function reveal() {
  const t = room.turn;
  const spent = Math.min(TURN_LIMIT_MS, Date.now() - room.turnStart);
  room.players.forEach((p, seat) => {
    if (p.entries[t] !== undefined) return;
    const theirs = room.format === "turns" ? seat === activeSeat() : !(room.format === "duel" && room.winner >= 0);
    p.entries[t] = theirs ? entry(TIMEOUT, spent) : entry(NONE, 0);
  });
  rescore(false);
  room.phase = "reveal";
  room.phaseEnds = Date.now() + REVEAL_MS;
  changed();
}

function rescore(done) {
  for (const p of room.players) {
    const s = scoreLog(room.game, p.entries, { done });
    p.score = s.score;
    p.correct = s.correct;
  }
}

function over() {
  rescore(true);
  room.phase = "over";
  changed();
}

function hostTick() {
  if (role !== "host" || !room) return;
  const now = Date.now();
  if (room.phase === "countdown" && now >= room.phaseEnds) startTurn(0);
  else if (room.phase === "question") {
    const active = room.format === "turns" ? room.players[activeSeat()] : null;
    if (now >= room.turnEnds || (active && !active.connected && now - room.turnStart > 1500)) reveal();
  } else if (room.phase === "reveal" && now >= room.phaseEnds) {
    if (room.turn + 1 < room.game.questions.length) startTurn(room.turn + 1);
    else over();
  }

  // A guest silent this long has probably gone. Its seat is kept in a game,
  // so it can come back.
  for (const p of [...(room?.players ?? [])]) {
    if (p.link && p.connected && now - p.lastHeard > HOST_SILENCE_MS) {
      const gone = p.link;
      const link = host?.links.get(gone);
      if (link) host.drop(link);
      onLinkGone(gone);
    }
  }
  if (room && room.phase !== "lobby") {
    render(snapshotFor(0));
    renderBar();
  }
}

// The game as seat `seat` sees it. Only its own answers travel, packed.
function snapshotFor(seat) {
  const now = Date.now();
  const t = room.turn;
  const inTurn = room.phase === "question" || room.phase === "reveal";
  const mine = room.players[seat]?.entries ?? [];
  const known = [];
  for (const e of mine) {
    if (e === undefined) break;
    known.push(e);
  }
  return {
    type: "state",
    v: PROTOCOL_VERSION,
    round: room.round,
    phase: room.phase,
    format: room.format,
    plan: { region: room.plan.region, difficulty: room.plan.difficulty, count: room.plan.count },
    seed: room.seed && room.phase !== "lobby" && room.phase !== "starting" ? room.seed.text : null,
    roomId: room.roomId,
    serverSeed: room.serverSeed,
    // Why nobody's game is scored, when the host has no ticket.
    unranked: room.unranked,
    turn: t,
    left: Math.max(0, room.phase === "question" ? room.turnEnds - GRACE_MS - now : room.phaseEnds - now),
    you: seat,
    winner: room.winner,
    players: room.players.map((p) => {
      const e = inTurn ? p.entries[t] : undefined;
      return {
        name: p.name,
        connected: p.connected,
        score: p.score,
        correct: p.correct,
        answered: e !== undefined && e.pick !== NONE,
        right: room.phase === "reveal" && e && e.pick !== NONE ? isAnswer(e.pick) && isCorrect(room.game.questions[t], e.pick) : null,
      };
    }),
    log: packLog(known),
  };
}

function broadcast() {
  if (role !== "host" || !host || !room) return;
  room.players.forEach((p, seat) => {
    if (p.link) host.send(snapshotFor(seat), p.link);
  });
}

function changed() {
  if (!room) return;
  broadcast();
  render(snapshotFor(0));
}

/* ======================================================================
   The guest
   ====================================================================== */

let guestGame = null; // { round, seed, game }
let lastState = 0;
let lastSnap = null;

export async function join(input) {
  const c = normaliseCode(input);
  if (!isValidCode(c)) {
    setNetStatus(`A code is ${CODE_LENGTH} characters.`, true);
    const field = $("joinInput");
    field.classList.remove("shake");
    void field.offsetWidth;
    field.classList.add("shake");
    field.focus();
    return;
  }
  if (role !== "guest" || code !== c) reconnects = 0;
  const inGame = role === "guest" && lastSnap && lastSnap.phase !== "lobby";
  closeAll();
  role = "guest";
  code = c;
  lastState = 0;

  if (!inGame) {
    game.showPanel("net");
    $("hostView").classList.add("hidden");
    $("newCodeBtn").classList.add("hidden");
    $("lobbyStartBtn").classList.add("hidden");
    $("lobbySummary").textContent = "";
    $("lobbyPlayers").innerHTML = "";
    $("netCancelLabel").textContent = "Leave";
  }
  $("netRetryBtn").classList.add("hidden");
  setNetStatus(navigator.onLine === false ? "Playing with others needs a connection to pair." : `Connecting to ${c}.`);

  const mine = new Guest();
  guest = mine;
  mine.addEventListener("status", ({ detail }) => {
    if (guest !== mine) return;
    if (detail.status === "connected") mine.send({ type: "hello", v: PROTOCOL_VERSION, id: playerId(), name: myName() });
    onGuestStatus(detail);
  });
  mine.addEventListener("message", ({ detail }) => {
    if (guest === mine) onGuestMessage(detail.message);
  });

  try {
    await mine.connect(c);
    store.set(LAST_CODE_KEY, c);
  } catch {
    if (guest !== mine) return;
    guest = null;
    setNetStatus("Could not load pairing. Check your connection.", true);
    $("netRetryBtn").classList.remove("hidden");
  }
}

const UNREACHABLE =
  "Could not reach the host. Every device has to be on the same network: join the same wifi, or turn on a hotspot on one and join it from the others. Check the code is still the one on screen.";

function onGuestStatus({ status, message }) {
  const inGame = lastSnap && lastSnap.phase !== "lobby";
  if (status === "connected") {
    reconnects = 0;
    acquireWakeLock();
    if (!inGame) setNetStatus("Connected. Waiting for the host to start.");
  } else if (status === "dropped") {
    // Probably coming back: try again quietly a few times.
    if (reconnects < 3) {
      reconnects++;
      setTimeout(() => role === "guest" && guest?.status === "dropped" && join(code), 1500);
    } else if (!inGame) {
      setNetStatus("The connection dropped.", true);
      $("netRetryBtn").classList.remove("hidden");
    }
  } else if (status === "unreachable" || status === "error") {
    const text = status === "unreachable" ? UNREACHABLE : message;
    if (inGame) renderBar(text);
    else {
      setNetStatus(text, true);
      $("netRetryBtn").classList.remove("hidden");
    }
  }
  renderBar();
}

function validSnapshot(s) {
  return (
    s.type === "state" &&
    Number.isInteger(s.round) &&
    s.round >= 0 &&
    PHASES.includes(s.phase) &&
    MP_MODES.includes(s.format) &&
    s.plan &&
    typeof s.plan === "object" &&
    regionById(s.plan.region) !== null &&
    difficultyById(s.plan.difficulty) !== null &&
    Number.isInteger(s.plan.count) &&
    s.plan.count >= 1 &&
    s.plan.count <= maxCount(s.plan.region) &&
    (s.seed === null || (typeof s.seed === "string" && s.seed.length <= 24)) &&
    (s.roomId === null || (typeof s.roomId === "string" && UUID.test(s.roomId))) &&
    typeof s.serverSeed === "boolean" &&
    (s.unranked === null || (typeof s.unranked === "string" && s.unranked.length <= 300)) &&
    Number.isInteger(s.turn) &&
    s.turn >= 0 &&
    s.turn < s.plan.count &&
    Number.isFinite(s.left) &&
    Number.isInteger(s.you) &&
    Number.isInteger(s.winner) &&
    Array.isArray(s.players) &&
    s.players.length >= 1 &&
    s.players.length <= 8 &&
    s.you >= 0 &&
    s.you < s.players.length &&
    s.players.every(
      (p) =>
        p &&
        typeof p.name === "string" &&
        p.name.length <= NAME_MAX * 2 &&
        typeof p.connected === "boolean" &&
        Number.isInteger(p.score) &&
        p.score >= 0 &&
        Number.isInteger(p.correct) &&
        typeof p.answered === "boolean" &&
        (p.right === null || typeof p.right === "boolean")
    ) &&
    typeof s.log === "string" &&
    s.log.length <= LOG_MAX_CHARS
  );
}

function onGuestMessage(message) {
  switch (message.type) {
    case "state": {
      if (!validSnapshot(message)) return;
      // Rebuilt field by field, so nothing unexpected rides along.
      const s = {
        ...message,
        plan: { region: message.plan.region, difficulty: message.plan.difficulty, count: message.plan.count },
        players: message.players.map((p) => ({ ...p, name: cleanName(p.name) })),
      };
      if (s.seed !== null) {
        const seed = seedFromText(s.seed);
        if (!seed || seed.region !== s.plan.region || seed.difficulty !== s.plan.difficulty || seed.count !== s.plan.count) return;
        if (!guestGame || guestGame.round !== s.round || guestGame.seed.text !== seed.text) {
          guestGame = { round: s.round, seed, game: buildGame(seed), ticket: null, unranked: null };
          requestTicket(guestGame, s);
        }
      }
      lastState = Date.now();
      lastSnap = s;
      render(s);
      renderBar();
      return;
    }
    case "full":
      setNetStatus("That game is full.", true);
      return;
    case "started":
      setNetStatus("That game has already started. Join when the next one does.", true);
      return;
    case "old":
      setNetStatus("The host's device is on a different version. Reload both and try again.", true);
      return;
    default:
      return;
  }
}

// A guest's own start ticket on the host's game, so its answers can go on
// the leaderboard under its own name.
async function requestTicket(g, s) {
  // No room: the host has no ticket either, and says why in `unranked`.
  if (!s.roomId) return;
  const held = savedTicket(s.roomId, s.you);
  if (held) {
    g.ticket = { gameId: held, serverSeed: s.serverSeed };
    return;
  }
  try {
    const t = await api.start({ room: s.roomId, seat: s.you });
    g.ticket = { gameId: t.game_id, serverSeed: t.server_seed === true };
    saveTicket(s.roomId, s.you, t.game_id);
  } catch (err) {
    g.unranked = unrankedReason(err);
  }
}

function leaveGuest() {
  guest?.leave();
  guest = null;
  role = null;
  lastSnap = null;
  guestGame = null;
  store.remove(LAST_CODE_KEY);
  releaseWakeLock();
}

/* ======================================================================
   Both: drawing a snapshot
   ====================================================================== */

// What this device has on screen, so a snapshot 20 times a second only
// redraws what changed.
const drawn = { round: -1, phase: "", turn: -1, revealed: "", resultRound: -1, strip: "", shownAt: null, pending: null, live: null };

function localGame() {
  if (role === "host") return room?.game ? { seed: room.seed, game: room.game, round: room.round } : null;
  return guestGame;
}

function ownEntries(s, g) {
  if (role === "host") return room.players[0].entries.filter((e) => e !== undefined);
  return unpackLog(s.log, g.game, { partial: true }) ?? [];
}

function render(s) {
  if (s.phase === "lobby" || s.phase === "starting") {
    renderLobby(s);
    return;
  }
  const g = localGame();
  if (!g || g.round !== s.round) return;

  if (s.phase === "over") {
    if (drawn.resultRound !== s.round) showOver(s, g);
    return;
  }

  if (drawn.round !== s.round) {
    drawn.round = s.round;
    drawn.turn = -1;
    drawn.revealed = "";
    drawn.strip = "";
    game.enterPlay({ seedText: g.seed.text, others: true });
    $("skipBtn").classList.remove("hidden");
    view.setPickHandler(onLocalPick);
  }

  const mine = ownEntries(s, g);
  const count = g.game.questions.length;
  const score = s.players[s.you].score;
  const streak = scoreLog(g.game, mine, { done: false }).streak;
  game.hud({ turn: s.turn, count, scoreText: `${score.toLocaleString("en")} points`, streak, progress: (s.phase === "reveal" ? s.turn + 1 : s.turn) / count });
  renderStrip(s);

  const timer = $("turnTimer");
  timer.classList.toggle("hidden", s.phase !== "question");
  if (s.phase === "question") timer.firstElementChild.style.width = `${Math.round((100 * s.left) / TURN_LIMIT_MS)}%`;

  if (s.phase === "countdown") {
    if (drawn.phase !== "countdown") {
      $("flagStage").classList.remove("loaded");
      $("options").innerHTML = "";
      $("typedForm").classList.add("hidden");
      $("prompt").textContent = `${MODE_LABELS[s.format]}: ${describePlan(s.plan)}.`;
    }
    view.setFeedback(`Starting in ${Math.max(1, Math.ceil(s.left / 1000))}.`);
    drawn.phase = s.phase;
    return;
  }

  const q = g.game.questions[s.turn];
  if (s.phase === "question") {
    if (drawn.turn !== s.turn || drawn.phase !== "question") {
      drawn.turn = s.turn;
      drawn.pending = null;
      drawn.shownAt = null;
      drawn.live = null;
      const key = `${s.round}:${s.turn}`;
      view.showQuestion(q, { interactive: false, showKeys: getSettings().show_keys }).then(() => {
        if (`${drawn.round}:${drawn.turn}` === key && drawn.phase === "question") {
          drawn.shownAt = performance.now();
          syncLive(lastFor());
        }
      });
      const next = g.game.questions[s.turn + 1];
      if (next) view.preloadFlag(next.answer);
    }
    drawn.phase = s.phase;
    syncLive(s);
    view.setFeedback(questionLine(s));
    return;
  }

  // reveal
  const key = `${s.round}:${s.turn}`;
  if (drawn.revealed !== key) {
    drawn.revealed = key;
    drawn.phase = "reveal";
    drawn.live = false;
    const e = mine[s.turn];
    view.showResult(q, e ? e.pick : NONE, { say: revealLine(s, q, e) });
  }
}

const lastFor = () => (role === "host" ? (room ? snapshotFor(0) : null) : lastSnap);

function describePlan(plan) {
  return `${regionById(plan.region).label}, ${difficultyById(plan.difficulty).label}, ${plan.count} flag${plan.count === 1 ? "" : "s"}`;
}

function myTurn(s) {
  if (s.format === "turns") return s.turn % s.players.length === s.you;
  return true;
}

// Whether this device can answer the flag on screen now.
function canAnswer(s) {
  return (
    s &&
    s.phase === "question" &&
    drawn.shownAt !== null &&
    drawn.pending === null &&
    myTurn(s) &&
    !s.players[s.you].answered &&
    performance.now() - drawn.shownAt < TURN_LIMIT_MS
  );
}

function syncLive(s) {
  const live = Boolean(canAnswer(s));
  if (live === drawn.live) return;
  drawn.live = live;
  view.setInteractive(live);
  $("skipBtn").disabled = !live;
}

function questionLine(s) {
  const me = s.players[s.you];
  if (drawn.pending !== null || me.answered) {
    if (s.format === "duel") return "Answered. Waiting for the other player.";
    if (s.format === "turns") return "Answered.";
    return "Answered. Waiting for the others.";
  }
  if (s.format === "turns") {
    const active = s.players[s.turn % s.players.length];
    return myTurn(s) ? "Your flag." : `${active.name}'s flag.`;
  }
  if (drawn.shownAt !== null && performance.now() - drawn.shownAt >= TURN_LIMIT_MS) return "Out of time.";
  return "";
}

function revealLine(s, q, e) {
  const answer = countryName(q.answer);
  if (s.format === "duel" && s.winner >= 0) {
    return s.winner === s.you ? `You took it: ${answer}.` : `${s.players[s.winner].name} took it. It's ${answer}.`;
  }
  if (s.format === "turns" && !myTurn(s)) {
    const active = s.players[s.turn % s.players.length];
    return `${active.name} ${active.right ? "got it" : "missed it"}. It's ${answer}.`;
  }
  // The usual line for this player's own answer.
  return true;
}

function renderStrip(s) {
  const active = s.format === "turns" ? s.turn % s.players.length : -1;
  const html = s.players
    .map((p, i) => {
      const state =
        s.phase === "reveal" && p.right !== null ? (p.right ? "right" : "wrong") : s.phase === "question" && p.answered ? "answered" : "";
      const classes = [i === s.you ? "you" : "", i === active ? "active" : "", p.connected ? "" : "gone", state].filter(Boolean).join(" ");
      return `<li class="${classes}"><span class="mp-dot" aria-hidden="true"></span><span class="mp-name"></span><span class="mp-score">${p.score.toLocaleString("en")}</span></li>`;
    })
    .join("");
  const key = html + s.players.map((p) => p.name).join("|");
  if (key === drawn.strip) return;
  drawn.strip = key;
  const strip = $("mpStrip");
  strip.innerHTML = html;
  // Names come from other devices: text only, never markup.
  strip.querySelectorAll(".mp-name").forEach((el, i) => {
    const p = s.players[i];
    el.textContent = i === s.you ? `${p.name} (you)` : p.name;
  });
}

function onLocalPick(value) {
  const s = lastFor();
  if (!canAnswer(s)) return;
  const ms = performance.now() - drawn.shownAt;
  drawn.pending = value;
  drawn.live = false;
  view.setInteractive(false);
  $("skipBtn").disabled = true;
  view.markPending(value);
  view.setFeedback("Sent.");
  if (role === "host") applyAnswer(0, value, ms);
  else guest?.send({ type: "answer", round: s.round, turn: s.turn, pick: value, ms: Math.round(ms) });
}

function showOver(s, g) {
  drawn.resultRound = s.round;
  drawn.phase = "over";
  const entries = ownEntries(s, g);
  if (entries.length !== g.game.questions.length) return;
  const standings = s.players
    .map((p, i) => ({ name: p.name, score: p.score, you: i === s.you }))
    .sort((a, b) => b.score - a.score);
  const ticket = role === "host" ? room.ticket : g.ticket;
  const unranked =
    role === "host"
      ? room.unranked
      : s.unranked ?? g.unranked ?? (ticket ? null : "This device could not get a start ticket for the game, so it is not scored.");
  game.showResult({ seed: g.seed, game: g.game, entries, mode: s.format, ticket, unranked, standings }, { role });
}

function renderLobby(s) {
  game.showPanel("net");
  drawn.round = -1;
  drawn.resultRound = -1;
  $("lobbySummary").textContent = `${MODE_LABELS[s.format]}: ${describePlan(s.plan)}.`;
  const list = $("lobbyPlayers");
  list.innerHTML = s.players.map(() => `<li><span class="mp-dot" aria-hidden="true"></span><span class="lobby-name"></span></li>`).join("");
  list.querySelectorAll("li").forEach((li, i) => {
    const p = s.players[i];
    li.classList.toggle("gone", !p.connected);
    li.querySelector(".lobby-name").textContent = `${p.name}${i === s.you ? " (you)" : ""}${i === 0 ? ", hosting" : ""}`;
  });
  const isHost = role === "host";
  const ready = s.players.filter((p) => p.connected).length;
  const enough = ready >= 2 && (s.format !== "duel" || ready === 2);
  $("lobbyStartBtn").classList.toggle("hidden", !isHost);
  $("lobbyStartBtn").disabled = !enough || s.phase === "starting";
  if (s.phase === "starting") setNetStatus("Starting the game.");
  else if (!isHost && guest?.status === "connected") setNetStatus("Connected. Waiting for the host to start.");
}

/* ======================================================================
   Both: connection
   ====================================================================== */

function readCode(key) {
  const value = store.get(key);
  return isValidCode(value) ? normaliseCode(value) : null;
}

function closeAll() {
  host?.close();
  host = null;
  guest?.close();
  guest = null;
  room = null;
  lastSnap = null;
  guestGame = null;
  drawn.round = -1;
  drawn.resultRound = -1;
}

function setNetStatus(text, error = false) {
  const el = $("netStatus");
  el.textContent = text;
  el.classList.toggle("error", error);
}

// The line under the flag during a game.
function renderBar(problem) {
  const bar = $("netBar");
  const playing = role && !$("play").classList.contains("hidden") && $("result").classList.contains("hidden");
  if (!playing) {
    bar.classList.add("hidden");
    return;
  }
  let tone = "busy";
  let text;
  if (role === "host") {
    const gone = room?.players.filter((p) => !p.connected).map((p) => p.name) ?? [];
    tone = gone.length ? "warn" : "ok";
    text = gone.length ? `${gone.join(", ")} disconnected. They can rejoin with ${code}.` : "Hosting";
  } else {
    const fresh = Date.now() - lastState < GUEST_STALE_MS;
    if (guest?.status === "connected" && fresh) {
      tone = "ok";
      text = "Connected to the host";
    } else if (guest?.status === "connected") {
      tone = "warn";
      text = "The connection looks stale.";
    } else if (guest?.status === "connecting" || guest?.status === "dropped") {
      text = "Reconnecting.";
    } else {
      tone = "error";
      text = "Disconnected from the host.";
    }
  }
  if (problem) {
    tone = "error";
    text = problem;
  }
  bar.dataset.tone = tone;
  $("netBarText").textContent = text;
  bar.classList.remove("hidden");
}

async function acquireWakeLock() {
  try {
    if (!wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    }
  } catch {
    // Refused or unsupported: the screen may sleep, nothing else changes.
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function leave() {
  if (role === "host") stopHosting();
  else if (role === "guest") leaveGuest();
  game.backToSetup();
}

const adapter = {
  active: () => role !== null,
  leave,
  again: () => {
    if (role !== "host" || !room) return;
    // A fresh seed for every game after the first, picked by the server.
    room.plan.seed = null;
    startGame();
  },
  skip: () => onLocalPick(SKIP),
};

export function initMultiplayer({ joinCode } = {}) {
  game.setMultiplayer(adapter);

  $("hostBtn").addEventListener("click", () => {
    if (game.soloActive()) return;
    startHosting();
  });
  $("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    join($("joinInput").value);
  });
  $("joinInput").addEventListener("input", (e) => {
    const c = normaliseCode(e.target.value);
    if (c !== e.target.value) e.target.value = c;
  });
  $("copyLinkBtn").addEventListener("click", async () => {
    $("copyLinkLabel").textContent = (await copyText(joinLink(code))) ? "Copied" : "Copy failed";
  });
  $("newCodeBtn").addEventListener("click", () => {
    if (role !== "host") return;
    store.remove(HOST_CODE_KEY);
    room.players = room.players.slice(0, 1);
    reopenHost();
  });
  $("netRetryBtn").addEventListener("click", () => {
    if (role === "guest" || code) join(code);
  });
  $("netCancelBtn").addEventListener("click", leave);
  $("lobbyStartBtn").addEventListener("click", startGame);

  // The steady beat, which doubles as the host's heartbeat.
  setInterval(() => role === "host" && broadcast(), SNAPSHOT_MS);
  setInterval(() => {
    hostTick();
    if (role === "guest" && lastSnap && lastSnap.phase === "question") {
      // The timer bar between snapshots, and the end of this flag's time.
      syncLive(lastSnap);
      const left = Math.max(0, lastSnap.left - (Date.now() - lastState));
      $("turnTimer").firstElementChild.style.width = `${Math.round((100 * left) / TURN_LIMIT_MS)}%`;
    }
    if (role === "guest") renderBar();
  }, TICK_MS);
  setInterval(() => role === "guest" && guest?.send({ type: "ping" }), PING_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (role) acquireWakeLock();
    // Back from the background with a channel that died meanwhile.
    if (role === "guest" && guest?.status === "dropped") join(code);
  });

  // From a join link: a scanned QR code means "join this", so it joins.
  // Otherwise the last code is filled in, ready.
  const fromLink = normaliseCode(joinCode);
  if (isValidCode(fromLink)) {
    $("joinInput").value = fromLink;
    join(fromLink);
  } else {
    const last = readCode(LAST_CODE_KEY);
    if (last) $("joinInput").value = last;
  }
  hydrateIcons($("net"));
}
