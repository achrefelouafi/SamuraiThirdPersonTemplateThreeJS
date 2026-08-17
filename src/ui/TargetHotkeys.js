import { Vector3 } from 'three';

import { ATTACK_ABILITIES } from '../config/abilities.js';
import { settings } from '../config/settings.js';

const _world = /* @__PURE__ */ new Vector3();
const _view = /* @__PURE__ */ new Vector3();

/**
 * The keys that would land on the body wearing the ring.
 *
 * The ring under a body (`vfx/TargetRings.js`) says *this one is who a press
 * goes to*. It cannot say **which** press, and with two attacks whose ranges
 * differ by more than a metre that is the other half of the answer — a body
 * five metres out is the slash's target and nothing the foot can reach. So the
 * moves that locked it wear their key caps over its head, one per move, lit
 * when the key would actually fire and dimmed when something else has the body.
 *
 * ## Why DOM and not a shader
 *
 * Everything else that marks a body is drawn in the scene, because it is *of*
 * the world — a circle on the ground lies on the ground, a diamond over a head
 * hangs in the air. A key cap is neither: it is the keyboard, quoted back, and
 * it belongs to the HUD along the bottom of the screen rather than to the
 * stage. Drawing it as HTML is also the only way it stays legible at any
 * distance and matches the ability row's own type, which is the whole point of
 * showing a cap instead of an icon.
 *
 * Positioned by projecting the body's head into screen space each frame and
 * moving one absolutely-placed row there. Nothing is created or destroyed while
 * the fight runs: rows are pooled, and each carries a cap per attack from the
 * moment it is built, so a body coming into reach toggles `hidden` rather than
 * building DOM.
 *
 * ## What it owns
 *
 * Nothing but its own fades, exactly like the rings — and they are run off the
 * ring's own `fadeIn`/`fadeOut` so the caps and the circle under them are one
 * gesture rather than two that nearly agree.
 */
export class TargetHotkeys {
  /**
   * @param {object} options
   * @param {import('three').PerspectiveCamera} options.camera
   * @param {HTMLElement} options.domElement the canvas the projection is
   *   measured against — not the window, which may be a different box
   * @param {HTMLElement} [options.parent]
   */
  constructor({ camera, domElement, parent = document.body }) {
    this.camera = camera;
    this.domElement = domElement;

    this.element = document.createElement('div');
    this.element.className = 'target-keys';
    parent.appendChild(this.element);

    /**
     * The row over each body, keyed by the body itself — so there is no slot to
     * leak when one is felled, exactly as in the rings and the markers.
     * @type {Map<object, {row: HTMLElement, caps: Map<string, HTMLElement>, fade: number, seen: boolean}>}
     */
    this._rows = new Map();
    /** Rows whose body is gone, kept for the next one to come into reach. */
    this._pool = [];
  }

  /**
   * Put a row of caps over everyone a move has locked.
   *
   * @param {number} dt seconds, on the simulation's clock
   * @param {Map<object, string[]>} locked body → the config keys of the moves
   *   that would take it, in the order the moves are offered a press
   * @param {Set<string>} ready which of those keys would actually fire now
   */
  update(dt, locked, ready) {
    const config = settings.targetRing;
    const look = config.hotkeys;
    if (!config.enabled || !look.enabled) {
      this.clear();
      return;
    }

    const rise = dt / Math.max(1e-3, config.fadeIn);
    const fall = dt / Math.max(1e-3, config.fadeOut);

    for (const [enemy, keys] of locked) {
      let entry = this._rows.get(enemy);
      if (!entry) {
        entry = this._pool.pop() ?? this._build();
        entry.fade = 0;
        this.element.appendChild(entry.row);
        this._rows.set(enemy, entry);
      }

      entry.fade = Math.min(1, entry.fade + rise);
      entry.seen = true;

      // Which caps this body has earned, and whether each is live. A cap that
      // is only dimmed rather than pulled says the key is the right one and
      // the body is simply busy — which is what the row along the bottom says
      // about the same move at the same moment.
      for (const [id, cap] of entry.caps) {
        const on = keys.includes(id);
        cap.hidden = !on;
        if (on) cap.classList.toggle('is-off', !ready.has(id));
      }
    }

    const rect = this.domElement.getBoundingClientRect();
    const camera = this.camera;
    const height = settings.enemies.height + look.lift;
    const scale = Math.max(0.1, look.scale);

    for (const [enemy, entry] of this._rows) {
      if (!entry.seen) {
        entry.fade -= fall;
        if (entry.fade <= 0) {
          this._release(enemy, entry);
          continue;
        }
      }
      entry.seen = false;

      _world.copy(enemy.position);
      _world.y += height;

      // Behind the lens, rejected in *view* space: `project` divides by a
      // negative w back there and mirrors the point into the frame, so a body
      // behind the camera would otherwise wear its caps in the middle of the
      // screen. The same test `combat/TargetMarking.js` runs, for the same
      // reason.
      _view.copy(_world).applyMatrix4(camera.matrixWorldInverse);
      if (_view.z > -camera.near) {
        entry.row.style.opacity = '0';
        continue;
      }

      _world.project(camera);
      const x = rect.left + (_world.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-_world.y * 0.5 + 0.5) * rect.height;

      // The row's *bottom centre* lands on the point, and it scales about that
      // same corner — so `scale` grows the caps upward off the head rather
      // than sliding them across it.
      entry.row.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale})`;
      entry.row.style.opacity = entry.fade.toFixed(3);
    }
  }

  /** One row, carrying a cap per attack from the start. */
  _build() {
    const row = document.createElement('div');
    row.className = 'target-keys__row';

    /** @type {Map<string, HTMLElement>} */
    const caps = new Map();
    for (const ability of ATTACK_ABILITIES) {
      const cap = document.createElement('span');
      cap.className = 'target-key';
      cap.textContent = ability.hotkey;
      cap.hidden = true;
      row.appendChild(cap);
      caps.set(ability.id, cap);
    }

    return { row, caps, fade: 0, seen: false };
  }

  /** Take a row off screen and keep it for the next body. */
  _release(enemy, entry) {
    this._rows.delete(enemy);
    entry.row.remove();
    entry.fade = 0;
    entry.seen = false;
    this._pool.push(entry);
  }

  /** Take every row off — for the character screen, and for a reset. */
  clear() {
    for (const [enemy, entry] of this._rows) this._release(enemy, entry);
  }

  dispose() {
    this.clear();
    this._pool.length = 0;
    this.element.remove();
  }
}
