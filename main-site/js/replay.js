// The instant replay: a finished game played back flag by flag, with each
// answer arriving after as long as it took, so hesitation shows. Play,
// pause, a step either way, a slider, and a list of every flag to jump to.
// Speeds as wordrain's and uwuChess's: 0.5x, 1x, 2x or 4x, remembered.
//
// A game of N flags has 2N steps: flag i on screen (step 2i), then its
// answer (step 2i + 1).

import * as view from "./view.js";
import { countryName } from "./quiz.js";
import { NONE, SKIP, TIMEOUT } from "./log.js";
import { scoreLog } from "./score.js";
import { escapeHtml, hydrateIcons, store } from "./ui.js";

const SPEEDS = [0.5, 1, 2, 4];
const SPEED_STORAGE = "flagsmatch.replaySpeed";
// At 1x: an answer stays up this long before the next flag. A long think is
// cut to THINK_CAP_MS, so a replay never sits still for minutes.
const ANSWER_HOLD_MS = 1300;
const THINK_CAP_MS = 8000;
const NONE_MS = 700;

const $ = (id) => document.getElementById(id);

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

export class Replay {
  // hud({ turn, count, scoreText, streak, progress }) draws the chips above.
  constructor({ hud }) {
    this.hud = hud;
    this.timer = null;
    this.active = false;
    this.record = null;
    this.pos = 0;
    const saved = Number(store.get(SPEED_STORAGE));
    this.speed = SPEEDS.includes(saved) ? saved : 1;
    this.syncSpeed();

    $("rpSpeed").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-speed]");
      if (btn) this.setSpeed(Number(btn.dataset.speed));
    });
    $("rpStart").addEventListener("click", () => this.jump(0));
    $("rpBack").addEventListener("click", () => this.step(-1));
    $("rpForward").addEventListener("click", () => this.step(1));
    $("rpEnd").addEventListener("click", () => this.jump(this.last));
    $("rpPlay").addEventListener("click", () => (this.timer ? this.pause() : this.play()));
    $("rpScrub").addEventListener("input", (e) => this.jump(Number(e.target.value)));
    $("turnList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-turn]");
      if (btn) this.jump(Number(btn.dataset.turn) * 2 + 1);
    });
    document.addEventListener("keydown", (e) => this.onKey(e));
  }

  get last() {
    return this.record ? this.record.entries.length * 2 - 1 : 0;
  }

  // record: { game, entries, mode, shared }. Starts at the end, or from the
  // first flag and playing when `autoplay` is set.
  load(record, { autoplay = false } = {}) {
    this.pause();
    this.active = true;
    this.record = record;
    const { game, entries } = record;
    this.turns = scoreLog(game, entries).turns;
    this.final = scoreLog(game, entries);
    // Points so far after each answer, for the chip.
    let running = 0;
    this.running = this.turns.map((t) => (running += t.points));

    $("rpScrub").max = String(this.last);
    $("turnList").innerHTML = entries
      .map((e, i) => {
        const t = this.turns[i];
        const [mark, icon, what] =
          e.pick === NONE
            ? ["none", "minus", "not yours"]
            : t.correct
              ? ["ok", "check", "right"]
              : e.pick === SKIP
                ? ["skip", "skip", "skipped"]
                : e.pick === TIMEOUT
                  ? ["bad", "clock", "out of time"]
                  : ["bad", "close", "wrong"];
        return (
          `<li><button type="button" class="turn-btn" data-turn="${i}" aria-label="Flag ${i + 1}, ${escapeHtml(countryName(game.questions[i].answer))}, ${what}">` +
          `<span class="turn-mark ${mark}" data-icon="${icon}"></span>` +
          `<span class="turn-num">${i + 1}</span><span class="turn-name">${escapeHtml(countryName(game.questions[i].answer))}</span></button></li>`
        );
      })
      .join("");
    hydrateIcons($("turnList"));

    if (autoplay && entries.length) {
      this.show(0);
      this.play();
    } else {
      this.show(this.last);
    }
  }

  stop() {
    this.pause();
    this.active = false;
  }

  show(p) {
    const { game, entries, mode, shared } = this.record;
    p = Math.max(0, Math.min(this.last, p));
    this.pos = p;
    const turn = p >> 1;
    const answered = p % 2 === 1;
    const q = game.questions[turn];
    const e = entries[turn];

    view.showQuestion(q, { interactive: false, showKeys: false });
    if (answered) {
      let say = true;
      if (e.pick === NONE) {
        say = `${mode === "duel" ? "The other player took this one." : "Another player's flag."} It's ${countryName(q.answer)}.`;
      }
      view.showResult(q, e.pick, { say });
    } else {
      view.setFeedback(e.pick === NONE ? "" : "Thinking.");
    }

    const total = entries.length;
    $("rpScrub").value = String(p);
    $("rpLabel").textContent =
      `Flag ${turn + 1} of ${total}` + (answered && e.pick !== NONE ? `, answered in ${seconds(e.ms)}` : "");
    $("rpBack").disabled = $("rpStart").disabled = p === 0;
    $("rpForward").disabled = $("rpEnd").disabled = p === this.last;

    const list = $("turnList");
    list.querySelectorAll(".turn-btn").forEach((b) => {
      const on = Number(b.dataset.turn) === turn;
      b.classList.toggle("current", on);
      if (on) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
    // Keep the current flag in view within the list, not the page.
    const current = list.querySelector(".turn-btn.current");
    if (current) {
      const top = current.offsetTop - list.offsetTop;
      if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - 30) list.scrollTop = top - 40;
    }

    // What the chips said at this point in the game. A shared replay shows
    // right answers, not points: a link can be edited, so its score proves
    // nothing.
    const done = answered ? turn + 1 : turn;
    const atEnd = p === this.last;
    const right = this.turns.slice(0, done).filter((t) => t.correct).length;
    const points = (done ? this.running[done - 1] : 0) + (atEnd ? this.final.bonus : 0);
    // The streak after this player's last answer so far; others' flags
    // leave it alone.
    const lastMine = this.turns.slice(0, done).findLast((t) => t.mine);
    const streak = lastMine?.streak ?? 0;
    this.hud({
      turn,
      count: total,
      scoreText: shared ? `${right} right` : `${points.toLocaleString("en")} points`,
      streak,
      progress: done / total,
    });
  }

  step(delta, fromTimer = false) {
    if (!fromTimer) this.pause();
    const next = this.pos + delta;
    if (next < 0 || next > this.last) return false;
    this.show(next);
    return true;
  }

  jump(p) {
    this.pause();
    this.show(p);
  }

  // How long step p stays up when playing.
  holdFor(p) {
    const e = this.record.entries[p >> 1];
    let ms;
    if (p % 2 === 0) ms = e.pick === NONE ? NONE_MS : Math.min(e.ms, THINK_CAP_MS);
    else ms = e.pick === NONE ? NONE_MS : ANSWER_HOLD_MS;
    return ms / this.speed;
  }

  // Remembered in this browser. A replay that is playing picks the new
  // pace up from its next step, without restarting.
  setSpeed(speed) {
    if (!SPEEDS.includes(speed)) return;
    this.speed = speed;
    store.set(SPEED_STORAGE, String(speed));
    this.syncSpeed();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = setTimeout(this.ticking, this.holdFor(this.pos));
    }
  }

  syncSpeed() {
    document.querySelectorAll("#rpSpeed [data-speed]").forEach((el) => {
      el.setAttribute("aria-checked", String(Number(el.dataset.speed) === this.speed));
    });
  }

  play() {
    clearTimeout(this.timer);
    // Played to the end already: start over.
    if (this.pos >= this.last) this.show(0);
    this.syncPlayButton(true);
    const tick = () => {
      if (!this.step(1, true) || this.pos >= this.last) {
        this.pause();
        return;
      }
      this.timer = setTimeout(tick, this.holdFor(this.pos));
    };
    this.ticking = tick;
    this.timer = setTimeout(tick, this.holdFor(this.pos));
  }

  pause() {
    clearTimeout(this.timer);
    this.timer = null;
    this.ticking = null;
    this.syncPlayButton(false);
  }

  syncPlayButton(playing) {
    const btn = $("rpPlay");
    btn.setAttribute("aria-label", playing ? "Pause" : "Play");
    btn.querySelector("[data-icon]").setAttribute("data-icon", playing ? "pause" : "play");
    hydrateIcons(btn);
  }

  onKey(e) {
    if (!this.active || $("replayBar").classList.contains("hidden")) return;
    if (document.querySelector(".modal-backdrop:not(.hidden)")) return;
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === "ArrowLeft") this.step(-1);
    else if (e.key === "ArrowRight") this.step(1);
    else if (e.key === " " && !e.target.closest("button, a")) {
      if (!e.repeat) this.timer ? this.pause() : this.play();
    } else return;
    e.preventDefault();
  }
}
