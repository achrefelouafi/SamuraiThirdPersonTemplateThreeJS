import { Vector3 } from 'three';

import { settings } from '../config/settings.js';

const _world = /* @__PURE__ */ new Vector3();
const _view = /* @__PURE__ */ new Vector3();

/**
 * Pixels a pointer may travel, and milliseconds it may be held, and still count
 * as a click.
 *
 * The left button is already spoken for: `CameraRig` gives it to OrbitControls,
 * so every drag that orbits the camera also ends in a `pointerup` on the
 * canvas. Without this the player could not turn to look at anything without
 * marking whatever the cursor happened to pass over on the way. A click is the
 * button going down and up in the same place, which is exactly what these two
 * numbers say — and it is why the mark is taken on the *up*, not the down.
 */
const CLICK_SLOP = 6;
const CLICK_TIME = 400;

/**
 * Choosing who the shadows are sent at.
 *
 * `V` no longer summons — it *arms*. While this is active the body under the
 * aim wears a marker (`vfx/TargetMarkers.js`), a left click locks it, and the
 * `count`th lock hands the list to `ShadowCharacter#summon` and disarms.
 *
 * ## The aim
 *
 * Screen space, not world space, and that is the whole of it: a body is a
 * candidate when it is near the point on screen the player is aiming at, scored
 * by how near, and the nearest to that point wins. The tolerance is generous
 * (`aim` is a fraction of the screen's *height*), so this is a look rather than
 * a pixel hunt — you turn toward someone and they light up.
 *
 * The aim point is the cursor, and it starts at the centre of the screen. Those
 * are the same gesture with an orbit camera: the pointer is what turns the
 * view, so before it has moved the centre of the frame is where the player is
 * looking, and after it has moved it is under their hand. Nothing has to be
 * explained to make that work.
 *
 * ## What it owns
 *
 * The mode, the aim and the list — and nothing else. It draws nothing (the
 * markers are handed the same two answers every frame) and it summons nothing
 * (`onComplete` carries the list out). It reads the camera and the population;
 * neither reads it.
 *
 * Which is also why there is one of these *per ability* rather than one shared
 * one: the shadows want two bodies out to thirty metres and the fist wants one,
 * and neither has any business knowing about the other. `config` says which
 * block of settings this instance is aimed by, and everything else here is the
 * same machine.
 */
export class TargetMarking {
  /**
   * @param {object} options
   * @param {import('three').PerspectiveCamera} options.camera the view the aim
   *   is resolved in
   * @param {import('./EnemyManager.js').EnemyManager} options.enemies
   * @param {HTMLElement} options.domElement what the pointer is read off
   * @param {(() => {count: number, range: number, aim: number, timeout: number})} [options.config]
   *   the settings block this instance is aimed by, read fresh every frame so
   *   the editor's sliders are live. Defaults to the shadows'.
   * @param {((targets: object[]) => void)|null} [options.onComplete] the full
   *   list, in the order it was locked. Fired once, as the mode disarms.
   * @param {((count: number, wanted: number) => void)|null} [options.onMark]
   * @param {(() => void)|null} [options.onCancel] the player's own cancel, or
   *   the arm expiring — never the completion above.
   */
  constructor({
    camera,
    enemies,
    domElement,
    config = () => settings.shadowCharacter.marking,
    onComplete = null,
    onMark = null,
    onCancel = null
  }) {
    this.camera = camera;
    this.enemies = enemies;
    this.domElement = domElement;
    this.config = config;
    this.onComplete = onComplete;
    this.onMark = onMark;
    this.onCancel = onCancel;

    /** Whether `V` has armed the mode. */
    this.active = false;
    /** Who the aim is on this frame, or null. */
    this.hovered = null;
    /** @type {object[]} the bodies locked so far, in the order they were. */
    this.marks = [];
    /** Seconds since the mode was armed, or since the last lock. */
    this.timer = 0;

    /**
     * The aim point, in NDC. The centre of the screen until the pointer moves.
     */
    this._pointer = { x: 0, y: 0 };
    /** Where and when the button went down, for the click test above. */
    this._down = null;
    /**
     * One buffered click, taken in `update`.
     *
     * The same edge-buffering `core/Input.js` does for a jump, and for the same
     * reason: a click that arrives between two frames must not go missing, and
     * it must be spent on the frame's own idea of what is under the aim rather
     * than on whatever the last frame happened to leave there.
     */
    this._clicked = false;

    this._onPointerMove = (event) => this._trackPointer(event);
    this._onPointerDown = (event) => {
      this._trackPointer(event);
      if (event.button !== 0) return;
      this._down = { x: event.clientX, y: event.clientY, at: performance.now() };
    };
    this._onPointerUp = (event) => {
      const down = this._down;
      this._down = null;
      if (!down || event.button !== 0) return;
      if (performance.now() - down.at > CLICK_TIME) return;
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_SLOP) return;
      this._clicked = true;
    };
    // The pointer leaving the canvas mid-drag is an orbit, not a click.
    this._onPointerCancel = () => {
      this._down = null;
    };

    domElement.addEventListener('pointermove', this._onPointerMove);
    domElement.addEventListener('pointerdown', this._onPointerDown);
    domElement.addEventListener('pointerup', this._onPointerUp);
    domElement.addEventListener('pointercancel', this._onPointerCancel);
  }

  /** How many bodies this run wants. At least one, or there is nothing to take. */
  get wanted() {
    return Math.max(1, Math.round(this.config().count));
  }

  /* ------------------------------------------------------------------ */

  /** Arm it. Anything left over from a previous run goes. */
  begin() {
    this.end();
    this.active = true;
    // Whatever was clicked to get here is not a mark.
    this._clicked = false;
    return this.wanted;
  }

  /** Disarm and drop everything, silently — the caller says what happened. */
  end() {
    this.active = false;
    this.hovered = null;
    this.marks.length = 0;
    this.timer = 0;
    this._down = null;
  }

  /** The player's own cancel, and the one that says so. */
  cancel() {
    if (!this.active) return;
    this.end();
    this.onCancel?.();
  }

  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt seconds, on the simulation's clock
   * @param {import('three').Vector3} player where the range is measured from
   */
  update(dt, player) {
    // Always taken, armed or not: a click left in the buffer would be spent the
    // next time the mode came up, on a body the player never aimed at.
    const clicked = this._clicked;
    this._clicked = false;

    if (!this.active) return;

    // A body felled (by the player, or by the other shadow) or burned away
    // between two frames is no longer a mark. Nothing has to be told; it simply
    // stops being in the list.
    for (let i = this.marks.length - 1; i >= 0; i--) {
      if (!this.marks[i].alive) this.marks.splice(i, 1);
    }

    const config = this.config();
    this.hovered = this._aim(player, config);

    if (clicked && this.hovered) {
      const at = this.marks.indexOf(this.hovered);
      // A second click on a body already locked lets it go — the only way back
      // out of a mistake short of throwing the whole arm away.
      if (at >= 0) this.marks.splice(at, 1);
      else this.marks.push(this.hovered);

      this.timer = 0;
      this.onMark?.(this.marks.length, this.wanted);

      if (this.marks.length >= this.wanted) {
        const targets = this.marks.slice();
        this.end();
        this.onComplete?.(targets);
        return;
      }
    }

    // The arm expires. Pressing `V` and then walking off should not leave the
    // next click, minutes later, marking someone.
    this.timer += dt;
    if (config.timeout > 0 && this.timer > config.timeout) this.cancel();
  }

  /**
   * The body nearest the aim point on screen, within tolerance and in range.
   *
   * @param {import('three').Vector3|null} player
   * @param {{range: number, aim: number}} config
   */
  _aim(player, config) {
    const camera = this.camera;
    const pointer = this._pointer;
    const aspect = camera.aspect || 1;
    const range = Math.max(0, config.range);

    // Aimed at the chest rather than the feet: the marker is over the head and
    // the ring is under the feet, so the middle of the body is the one point
    // that belongs to neither and reads as "the body".
    const chest = settings.enemies.height * 0.6;

    let best = null;
    let bestScore = Math.max(0.02, config.aim);

    for (const enemy of this.enemies.enemies) {
      if (!enemy.alive) continue;

      if (player && range > 0) {
        const dx = enemy.position.x - player.x;
        const dz = enemy.position.z - player.z;
        if (dx * dx + dz * dz > range * range) continue;
      }

      _world.copy(enemy.position);
      _world.y += chest;

      // Behind the lens, rejected in *view* space. `project` divides by a
      // negative w back there and mirrors the body into the frame, so a
      // candidate directly behind the camera would otherwise score as if it
      // were in front of it.
      _view.copy(_world).applyMatrix4(camera.matrixWorldInverse);
      if (_view.z > -camera.near) continue;

      _world.project(camera);

      // NDC is square and the picture is not, so the x gap is stretched back
      // out by the aspect — which makes the tolerance a circle on the *screen*
      // rather than an ellipse. Halved because NDC spans 2 across the frame:
      // the score is a fraction of the screen's height, which is what `aim` is.
      const dx = (_world.x - pointer.x) * aspect;
      const dy = _world.y - pointer.y;
      const score = Math.hypot(dx, dy) * 0.5;
      if (score >= bestScore) continue;

      bestScore = score;
      best = enemy;
    }

    return best;
  }

  /** Canvas pixels → NDC, against the element's own box rather than the window. */
  _trackPointer(event) {
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  dispose() {
    this.end();
    const element = this.domElement;
    element.removeEventListener('pointermove', this._onPointerMove);
    element.removeEventListener('pointerdown', this._onPointerDown);
    element.removeEventListener('pointerup', this._onPointerUp);
    element.removeEventListener('pointercancel', this._onPointerCancel);
  }
}
