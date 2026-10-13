// The question on screen: the flag (or in Expert, a pie of its colours),
// the names to pick from or the box to type in, and the line saying how an
// answer went. Playing alone, playing with others and watching a replay all
// draw through here, so a flag looks the same in each.

import { COUNTRIES } from "./countries.js";
import { FLAG_COLORS } from "./colors.js";
import { flagUrl, countryName, matchAnswer, isCorrect, hintsFor } from "./quiz.js";
import { NONE, SKIP, TIMEOUT, isAnswer } from "./log.js";
import { HINT_MAX } from "./rules.js";
import { helpPercent } from "./score.js";
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

/* ---- Expert's pie chart ----
   Chart.js, vendored and precached like everything else, so Expert plays
   offline. It is a classic script, loaded on the first pie rather than with
   the page, since only Expert needs it. Hovering or touching a slice shows
   its percentage. */

const CHART_SRC = "/js/vendor/chart.umd.min.js";
let chartLib = null;
let pie = null;

function loadChart() {
  if (!chartLib) {
    chartLib = new Promise((resolve, reject) => {
      if (window.Chart) return resolve(window.Chart);
      const script = document.createElement("script");
      script.src = CHART_SRC;
      script.onload = () => (window.Chart ? resolve(window.Chart) : reject(new Error("no Chart")));
      script.onerror = () => reject(new Error("Chart.js did not load"));
      document.head.append(script);
    });
    // A failure is not kept, so the next pie tries again.
    chartLib.catch(() => (chartLib = null));
  }
  return chartLib;
}

async function drawColors(index) {
  const Chart = await loadChart();
  const colors = FLAG_COLORS[COUNTRIES[index].code] ?? [];
  // Read each time, so a theme changed mid game is followed. The edge lets
  // a white slice read against a pale card.
  const edge = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() || "#121815";
  const data = {
    labels: colors.map(() => ""),
    datasets: [
      {
        data: colors.map(([, percent]) => percent),
        backgroundColor: colors.map(([hex]) => hex),
        borderColor: edge,
        borderWidth: 1,
        hoverOffset: 10,
      },
    ],
  };
  const canvas = $("flagPie");
  // Named for what it is, never for whose it is.
  canvas.setAttribute(
    "aria-label",
    `A pie chart of the flag's colours, ${colors.length} slices: ${colors.map(([, p]) => `${p}%`).join(", ")}.`
  );
  if (pie) {
    pie.data = data;
    pie.update();
    return;
  }
  pie = new Chart(canvas, {
    type: "pie",
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Drawn at once, so the clock starts on a whole pie.
      animation: { duration: 0 },
      transitions: { active: { animation: { duration: 150 } } },
      layout: { padding: 12 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: () => "",
            label: (ctx) => ` ${ctx.parsed}%`,
          },
        },
      },
    },
  });
}

// Draws `question` and resolves once its flag, or the pie of its colours,
// is on screen, or failed to load, which is when an answer's clock starts.
// Answering stays off until then unless `interactive` is false anyway.
export function showQuestion(question, { interactive = true, prompt, showKeys = true } = {}) {
  const token = ++shown;
  const stage = $("flagStage");

  $("prompt").textContent =
    prompt ??
    (question.options
      ? "Which country's flag is this?"
      : question.colors
        ? question.retries
          ? "Whose flag has these colours? Type the country, as often as you like."
          : "Whose flag has these colours? Type the country."
        : "Which country's flag is this? Type its name.");
  setFeedback("");
  $("flagNote").textContent = "";
  stage.classList.toggle("colors", question.colors === true);
  showHints(question, 0);
  $("hintBtn").classList.toggle("hidden", !question.retries);

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
      if (!ok) {
        $("flagNote").textContent = question.colors
          ? "The colours did not load. Skip it, or answer anyway."
          : "This flag did not load. Skip it, or answer anyway.";
      }
      if (interactive) setInteractive(true);
      resolve(ok);
    };
    if (question.colors) {
      drawColors(question.answer).then(
        () => done(true),
        () => done(false)
      );
      return;
    }
    drawFlag(question.answer, token, done);
  });
}

// Puts flag `index` in the image, then calls done(ok), unless another
// question has been drawn by then.
function drawFlag(index, token, done) {
  const img = $("flagImg");
  const stage = $("flagStage");
  const same = onScreen === index;
  // Named for what it is, never for whose it is.
  img.alt = "The flag to name";
  img.onload = () => done(true);
  img.onerror = () => done(false);
  // The same flag again (a replay stepping back and forth): it is there.
  if (same && img.complete && img.naturalWidth > 0) {
    queueMicrotask(() => done(true));
    return;
  }
  // A different flag: the old one goes while the new one is fetched.
  stage.classList.remove("loaded");
  flagBlob(index).then(
    (url) => {
      if (token !== shown) return;
      onScreen = index;
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
}

// Once an Expert answer is in, the flag those colours came from.
function revealFlag(index) {
  const token = shown;
  const stage = $("flagStage");
  stage.classList.remove("colors");
  drawFlag(index, token, () => {
    if (token === shown) stage.classList.add("loaded");
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
  $("hintBtn").disabled = !on || hintsShown >= HINT_MAX;
  if (on && !$("typedForm").classList.contains("hidden")) $("typedInput").focus({ preventScroll: true });
}

/* ---- Expert's retries and hints ---- */

let hintsShown = 0;

// The first `n` of the question's hints, under the answer box, and the
// hint button saying what is left.
export function showHints(question, n) {
  hintsShown = n;
  const list = $("hints");
  list.innerHTML = hintsFor(question, n)
    .map((text, i) => `<li><span class="${i ? "hint-name" : ""}">${escapeHtml(text)}</span></li>`)
    .join("");
  list.classList.toggle("hidden", n === 0);
  $("hintLabel").textContent = n >= HINT_MAX ? "No more hints" : `Hint ${n + 1} of ${HINT_MAX}`;
  if (n >= HINT_MAX) $("hintBtn").disabled = true;
}

const worthLine = (help) => `This flag is now worth ${helpPercent(help)}% of its points.`;

// A hint just given: shown, and what it cost.
export function hintTaken(question, help) {
  showHints(question, help.hints);
  setFeedback(`Hint ${help.hints}. ${worthLine(help)}`);
  $("typedInput").focus({ preventScroll: true });
}

// A guess that did not get it, with the flag left open for another.
// `help` is the wrong guesses and hints so far, counting this one.
export function guessMissed(text, { verdict, named }, help) {
  const input = $("typedInput");
  input.value = "";
  input.classList.remove("shake");
  void input.offsetWidth;
  input.classList.add("shake");
  input.focus({ preventScroll: true });
  if (verdict === "unknown") setFeedback(`"${text}" is not a country this knows. Try again; that one is free.`, "bad");
  else if (verdict === "again") setFeedback(`You already tried ${countryName(named)}. Try another; that one is free.`, "bad");
  else setFeedback(`Not ${countryName(named)}. ${worthLine(help)}`, "bad");
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
// says `say` when it is a string. `help` is Expert's { misses, hints }
// before the answer. Returns whether it was right.
export function showResult(question, value, { say = true, help = null } = {}) {
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
  if (question.colors) revealFlag(question.answer);
  $("hintBtn").disabled = true;
  if (question.retries) showHints(question, help?.hints ?? 0);

  if (typeof say === "string") {
    setFeedback(say, right ? "ok" : value === NONE ? "" : "bad");
  } else if (say) {
    setFeedback(describe(question, value, right, answer) + helpLine(help, right), right ? "ok" : "bad");
  }
  return right;
}

// After Expert's answer line: the help it took, and what that left.
function helpLine(help, right) {
  const parts = [];
  if (help?.misses) parts.push(`${help.misses} wrong guess${help.misses === 1 ? "" : "es"}`);
  if (help?.hints) parts.push(`${help.hints} hint${help.hints === 1 ? "" : "s"}`);
  if (!parts.length) return "";
  return ` ${parts.join(" and ")}${right ? `, so ${helpPercent(help)}% of the points` : ""}.`;
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
