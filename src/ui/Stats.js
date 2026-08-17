/**
 * Frame-rate readout, top-left. Toggled with `F`.
 *
 * Deliberately measures its own wall clock rather than reading `Time#delta`:
 * that one is clamped (see `core/Time.js`) and scaled by `global.timeScale`, so
 * it says how far the simulation stepped, not how long the frame took. A stutter
 * is exactly the case where the two disagree.
 *
 * Numbers are averaged over a window and the text is written once per window —
 * a readout that repaints every frame is both unreadable and, at this DOM size,
 * a measurable part of what it is measuring. `peak` carries the spikes the
 * average smooths away, so a single 90 ms hitch still shows up somewhere.
 *
 * The draw-call and triangle counts come from the renderer's own `info` block,
 * which the app already resets once per frame.
 */
export class Stats {
  /**
   * @param {object} [config]
   * @param {HTMLElement} [config.parent]
   * @param {number} [config.interval] seconds of frames per printed update
   * @param {boolean} [config.visible] whether it starts on screen
   */
  constructor({ parent = document.body, interval = 0.5, visible = true } = {}) {
    this.interval = interval;

    this._last = performance.now();
    this._elapsed = 0; // seconds accumulated in the current window
    this._frames = 0;
    this._peak = 0; // longest single frame in the window, ms
    this._calls = 0;
    this._triangles = 0;

    this.root = document.createElement('div');
    this.root.className = 'stats';
    this.root.hidden = !visible;

    this._fps = el('b', 'stats__value');
    this._fps.textContent = '—';
    const headline = el('div', 'stats__headline');
    headline.append(this._fps, el('span', 'stats__unit', 'fps'));

    const rows = el('dl', 'stats__rows');
    this._frame = row(rows, 'frame');
    this._peakOut = row(rows, 'peak');
    this._draws = row(rows, 'draws');
    this._tris = row(rows, 'tris');

    this.root.append(headline, rows);
    parent.appendChild(this.root);
  }

  get visible() {
    return !this.root.hidden;
  }

  /** @returns {boolean} the new visibility */
  toggle() {
    this.root.hidden = !this.root.hidden;
    // Whatever the window had collected is stale by the time it comes back.
    if (this.visible) this._reset(performance.now());
    return this.visible;
  }

  /** Call after a long pause (asset load) so the first window is not skewed. */
  reset() {
    this._reset(performance.now());
  }

  /**
   * Count one frame.
   *
   * @param {{calls: number, triangles: number}} [render] `renderer.info.render`
   *   as it stood at the end of the frame being counted.
   */
  sample(render) {
    const now = performance.now();
    const ms = now - this._last;
    this._last = now;

    // A backgrounded tab parks requestAnimationFrame, and the first frame after
    // it returns is worth seconds. That is not a frame anyone waited through, so
    // it neither counts nor sets the peak.
    if (ms > 1000) return;

    this._elapsed += ms / 1000;
    this._frames += 1;
    if (ms > this._peak) this._peak = ms;
    if (render) {
      this._calls += render.calls;
      this._triangles += render.triangles;
    }

    if (this._elapsed < this.interval) return;
    if (this.visible) this._print();
    this._reset(now);
  }

  _print() {
    const perFrame = this._elapsed / this._frames;
    const fps = 1 / perFrame;

    this._fps.textContent = fps >= 100 ? Math.round(fps) : fps.toFixed(1);
    this._frame.textContent = `${(perFrame * 1000).toFixed(1)} ms`;
    this._peakOut.textContent = `${this._peak.toFixed(1)} ms`;
    this._draws.textContent = Math.round(this._calls / this._frames).toString();
    this._tris.textContent = count(this._triangles / this._frames);

    // Three bands rather than a gradient: the point is to be readable out of the
    // corner of an eye while dragging a slider, not to grade the number.
    this.root.classList.toggle('is-fair', fps < 50 && fps >= 30);
    this.root.classList.toggle('is-poor', fps < 30);
  }

  _reset(now) {
    this._last = now;
    this._elapsed = 0;
    this._frames = 0;
    this._peak = 0;
    this._calls = 0;
    this._triangles = 0;
  }

  dispose() {
    this.root.remove();
  }
}

/* -------------------------------------------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One label/value pair. @returns {HTMLElement} the value cell, to write into */
function row(list, label) {
  const value = el('dd', 'stats__rowValue', '—');
  const wrap = el('div', 'stats__row');
  wrap.append(el('dt', 'stats__rowLabel', label), value);
  list.append(wrap);
  return value;
}

/** Triangle counts run to seven digits; nobody reads those as digits. */
function count(value) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}k`;
  return Math.round(value).toString();
}
