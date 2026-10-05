// The leaderboard API. Games are played entirely in the browser; the API
// hands out start tickets, and checks and scores finished games.

const KEY_STORAGE = "flagsmatch.clientKey";
// A start ticket that has not come back by now is not worth waiting for:
// the game starts without one, and says it is not scored.
const START_TIMEOUT_MS = 6000;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// A random id tying this browser's submissions to the games it started. Not
// an identity: it grants nothing and is never shown.
function makeKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let memoryKey = null;

export function clientKey() {
  try {
    let key = localStorage.getItem(KEY_STORAGE);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key ?? "")) {
      key = makeKey();
      localStorage.setItem(KEY_STORAGE, key);
    }
    return key;
  } catch {
    memoryKey ??= makeKey();
    return memoryKey;
  }
}

async function call(method, path, body, { timeout = 0 } = {}) {
  const controller = timeout ? new AbortController() : null;
  const timer = controller && setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller?.signal,
    });
  } catch {
    throw new ApiError(0, "offline", "That needs a connection.");
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // An HTML error page from the platform, not the API.
  }
  if (!response.ok) throw new ApiError(response.status, data?.error ?? "server", data?.message);
  return data;
}

export const api = {
  // No seed: the server picks one. With `room`, a guest's ticket on a host's game.
  start: (body) => call("POST", "/api/game/start", { ...body, client_key: clientKey() }, { timeout: START_TIMEOUT_MS }),
  finish: (gameId, log) => call("POST", "/api/game/finish", { game_id: gameId, log, client_key: clientKey() }),
  submit: (gameId, log, name) => call("POST", "/api/game/submit", { game_id: gameId, log, name, client_key: clientKey() }),
  checkName: (name) => call("POST", "/api/leaderboard/name", { name }),
  leaderboard: (board) => call("GET", `/api/leaderboard?board=${encodeURIComponent(board)}`),
};
