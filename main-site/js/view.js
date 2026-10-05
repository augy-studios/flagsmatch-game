// The question on screen: the flag, the names to pick from or the box to
// type in, and the line saying how an answer went. Playing alone, playing
// with others and watching a replay all draw through here, so a flag looks
// the same in each.

import { flagUrl, countryName, matchAnswer, isCorrect } from "./quiz.js";
import { NONE, SKIP, TIMEOUT, isAnswer } from "./log.js";
import { escapeHtml } from "./ui.js";

const $ = (id) => document.getElementById(id);

let pickHandler = null;
let shown = 0;
let onScreen = -1; // the country whose flag the image holds

/* ---- flags as blobs ----
   The image never points at /flags/<code>.svg, which would name the answer
   to anybody inspecting the page. Each flag is fetched (from the service
   worker's cache, so offline too) and shown from a blob: URL that says
   nothing. Kept for the page's life: 194 flags at most, a few megabytes,
   and a replay or a second game reuses them. The network panel still shows
   the fetch; this keeps the answer out of the page, not out of devtools. */

const blobs = new Map(); // country index -> Promise of a blob: URL

function flagBlob(index) {
  let url = blobs.get(index);
  if (!url) {
    url = fetch(flagUrl(index))
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.arrayBuffer();
      })
      // Typed here rather than trusting the response, since an SVG blob
      // without its type does not draw in an <img>.
      .then((bytes) => URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" })));
    // A failure is not kept, so the next showing tries again.
    url.catch(() => blobs.delete(index));
    blobs.set(index, url);
  }
  return url;
}

// Fetches a flag ahead of its question, so it is ready the moment it is due.
export function preloadFlag(index) {
  flagBlob(index).catch(() => {});
}

// Whoever is playing now: a solo game, a game with others, or nobody while
// a replay shows. Called with an option's place, the text typed, or SKIP.
export function setPickHandler(fn) {
  pickHandler = fn;
}

export function pick(value) {
  pickHandler?.(value);
}

// Draws `question` and resolves once its flag is on screen, or failed to
// load, which is when an answer's clock starts. Answering stays off until
// then unless `interactive` is false anyway.
export function showQuestion(question, { interactive = true, prompt, showKeys = true } = {}) {
  const token = ++shown;
  const img = $("flagImg");
  const stage = $("flagStage");
  const same = onScreen === question.answer;

  $("prompt").textContent =
    prompt ?? (question.options ? "Which country's flag is this?" : "Which country's flag is this? Type its name.");
  setFeedback("");
  $("flagNote").textContent = "";
  // Named for what it is, never for whose it is.
  img.alt = "The flag to name";

  const options = $("options");
  const typed = $("typedForm");
  if (question.options) {
    options.innerHTML = question.options
      .map(
        (c, i) =>
          `<button type="button" class="answer" data-pick="${i}" disabled aria-keyshortcuts="${i + 1}">` +
          `<span class="answer-key" aria-hidden="true">${i + 1}</span>` +
          `<span class="answer-name">${escapeHtml(countryName(c))}</span></button>`
      )
      .join("");
    options.classList.toggle("six", question.options.length > 4);
    options.classList.toggle("show-keys", showKeys);
    options.classList.remove("hidden");
    typed.classList.add("hidden");
  } else {
    options.innerHTML = "";
    options.classList.add("hidden");
    typed.classList.remove("hidden");
    const input = $("typedInput");
    input.value = "";
    input.readOnly = false;
    input.classList.remove("right", "wrong");
  }
  setInteractive(false);

  return new Promise((resolve) => {
    const done = (ok) => {
      if (token !== shown) return;
      stage.classList.add("loaded");
      if (!ok) $("flagNote").textContent = "This flag did not load. Skip it, or answer anyway.";
      if (interactive) setInteractive(true);
      resolve(ok);
    };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    // The same flag again (a replay stepping back and forth): it is there.
    if (same && img.complete && img.naturalWidth > 0) {
      queueMicrotask(() => done(true));
      return;
    }
    // A different flag: the old one goes while the new one is fetched.
    stage.classList.remove("loaded");
    flagBlob(question.answer).then(
      (url) => {
        if (token !== shown) return;
        onScreen = question.answer;
        // Setting the same URL again fires no load event.
        if (img.src === url && img.complete) done(img.naturalWidth > 0);
        else img.src = url;
      },
      () => {
        if (token !== shown) return;
        onScreen = -1;
        img.removeAttribute("src");
        done(false);
      }
    );
  });
}

export function setInteractive(on) {
  $("options")
    .querySelectorAll(".answer")
    .forEach((b) => {
      b.disabled = !on;
    });
  $("typedInput").disabled = !on;
  $("typedBtn").disabled = !on;
  if (on && !$("typedForm").classList.contains("hidden")) $("typedInput").focus({ preventScroll: true });
}

// An answer sent and not yet confirmed, in a game with others.
export function markPending(value) {
  if (Number.isInteger(value)) $("options").querySelector(`[data-pick="${value}"]`)?.classList.add("picked");
}

export function setFeedback(text, tone = "") {
  const el = $("feedback");
  el.textContent = text;
  el.dataset.tone = tone;
}

// Marks how `value` answered `question`: the right name ringed, a wrong
// pick crossed. Says so in the feedback line unless `say` is false, or
// says `say` when it is a string. Returns whether it was right.
export function showResult(question, value, { say = true } = {}) {
  const answer = countryName(question.answer);
  const right = isAnswer(value) && isCorrect(question, value);

  if (question.options) {
    $("options")
      .querySelectorAll(".answer")
      .forEach((b) => {
        const i = Number(b.dataset.pick);
        b.disabled = true;
        b.classList.toggle("right", question.options[i] === question.answer);
        b.classList.toggle("wrong", i === value && !right);
        b.classList.toggle("picked", i === value);
      });
  } else {
    const input = $("typedInput");
    input.value = typeof value === "string" ? value : "";
    input.readOnly = true;
    input.disabled = true;
    $("typedBtn").disabled = true;
    input.classList.toggle("right", right);
    input.classList.toggle("wrong", typeof value === "string" && !right);
  }

  if (typeof say === "string") {
    setFeedback(say, right ? "ok" : value === NONE ? "" : "bad");
  } else if (say) {
    setFeedback(describe(question, value, right, answer), right ? "ok" : "bad");
  }
  return right;
}

function describe(question, value, right, answer) {
  if (right) return `Right, it's ${answer}.`;
  if (value === SKIP) return `Skipped. It's ${answer}.`;
  if (value === TIMEOUT) return `Out of time. It's ${answer}.`;
  if (value === NONE) return `It's ${answer}.`;
  if (typeof value === "string") {
    const named = matchAnswer(value);
    if (named >= 0) return `${countryName(named)} has a different flag. It's ${answer}.`;
    return `"${value}" is not a country this knows. It's ${answer}.`;
  }
  return `Not ${countryName(question.options[value])}. It's ${answer}.`;
}

export function initView() {
  $("options").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pick]");
    if (btn && !btn.disabled) pick(Number(btn.dataset.pick));
  });
  $("typedForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if ($("typedInput").disabled) return;
    const text = $("typedInput").value.trim();
    // An empty answer is a skip, so Enter alone passes on a flag.
    pick(text ? text : SKIP);
  });
}
