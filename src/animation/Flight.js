import { LoopOnce, LoopRepeat, MathUtils } from 'three';
import { settings } from '../config/settings.js';
import { damp } from '../utils/math.js';

/**
 * Leaving the ground, and staying there.
 *
 * The two jumps are *moves*: they start, they run a clip, they end. This is a
 * **mode** — it is entered and it is left, and in between it owns how the body
 * is posed, how high it is off the floor and how it leans. That difference is
 * why it is not another `Jump`: nothing here has a duration, and the clip
 * underneath it loops forever.
 *
 * ## The three things it owns
 *
 *  - **The pose.** `floating.fbx`, looped, faded over the gait exactly as a
 *    jump is (`weight`, and `takeover` for `Locomotion`'s mask). The clip is an
 *    in-place hover, so it claims the whole gait: there are no legs to leave
 *    running underneath a body that is not walking. Coming down there is a
 *    second clip — `Landing.fbx`, once — started a beat *before* the feet
 *    arrive so its impact frame is the frame they land on, and handed back to
 *    the idle before it has finished standing up (`settings.flight.recover`).
 *  - **The altitude.** `lift` is metres above the *ground*, not an absolute
 *    height, and whoever owns the character's position adds it to the terrain
 *    beneath them — so flying over a hill climbs the hill, and one number here
 *    is the whole of "how high am I". It eases up on take-off, eases back down
 *    on landing, and breathes while it is up there (`bob`).
 *  - **The lean.** A roll into the turn and a nose-down with speed, written to
 *    the character's `tilt` group — the node that exists precisely so that
 *    anything leaning the body cannot fight whatever is turning it. Both are
 *    damped, so the body arrives at its bank a beat after it started turning,
 *    which is what the eye reads as air resisting.
 *
 * It owns nothing horizontal. `ThirdPersonController` flies the body exactly as
 * it walks it — the difference is which speeds it reads and that nothing pushes
 * it out of a body it passes over.
 */
export class Flight {
  /**
   * @param {import('three').AnimationMixer} mixer
   * @param {import('three').AnimationClip|null} clip the float, looped
   * @param {import('./CharacterController.js').CharacterController} character
   * @param {import('three').AnimationClip|null} [landing] the touchdown, once
   */
  constructor(mixer, clip, character, landing = null) {
    this.character = character;

    this.action = null;
    if (clip) {
      this.action = mixer.clipAction(clip);
      this.action.setLoop(LoopRepeat, Infinity);
      this.action.enabled = false;
      this.action.setEffectiveWeight(0);
    }

    this.landing = null;
    if (landing) {
      this.landing = mixer.clipAction(landing);
      this.landing.setLoop(LoopOnce, 1);
      this.landing.clampWhenFinished = true; // hold the stand while it blends out
      this.landing.enabled = false;
      this.landing.setEffectiveWeight(0);
    }

    /** @type {'grounded'|'rising'|'flying'|'landing'} */
    this.state = 'grounded';
    /** How much of the pose the float clip has, 0..1. */
    this.pose = 0;
    /** The same for the touchdown clip. Outlives the mode by its own blend. */
    this.recovery = 0;
    /** Whether the touchdown is still holding the pose rather than releasing it. */
    this.recovering = false;
    /** Metres above the ground the body is being held at. */
    this.lift = 0;

    /** 0..1 through the climb or the descent, whichever is running. */
    this._t = 0;
    /** The eased height, before the bob is added on top of it. */
    this._base = 0;
    /** Seconds since take-off, for the bob — its own clock so it never jumps. */
    this._clock = 0;
    /** Whether the descent has already cued the touchdown clip. */
    this._cued = false;
    /** Where the lean has got to, radians. */
    this._roll = 0;
    this._pitch = 0;
    /** Last frame's heading, so the turn rate can be measured rather than told. */
    this._lastYaw = 0;
  }

  get available() {
    return Boolean(this.action);
  }

  /** This mode's live tuning. Read per frame — the editor writes to it. */
  get config() {
    return settings.flight;
  }

  /** Whether the body is off the ground at all, in either direction. */
  get active() {
    return this.state !== 'grounded';
  }

  /**
   * How much of the pose this mode holds between its two clips, 0..1.
   *
   * `Locomotion` reads this to mask the gait, and it has to cover the recovery
   * as well as the hover: the touchdown outlives the mode by its own length, and
   * an idle bleeding through it would stand the body up twice.
   */
  get weight() {
    return Math.max(this.pose, this.recovery);
  }

  /** Whether the stick should be flying the body rather than walking it. */
  get flying() {
    return this.state === 'rising' || this.state === 'flying';
  }

  /**
   * How much of the *travelling* gait this claims.
   *
   * All of it. The float is an in-place hover and the controller is carrying
   * the body through the air; a run left bleeding through it would be a pair of
   * legs sprinting six metres above the ground.
   */
  get takeover() {
    return this.weight;
  }

  /** Whether the mode can be entered right now. */
  canStart() {
    return Boolean(this.action) && this.config.enabled && !this.active;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Leave the ground. Nothing checks `canStart` for you.
   * @returns {boolean} whether the mode was actually entered
   */
  start() {
    if (!this.action || this.active) return false;

    this.action.reset();
    this.action.enabled = true;
    this.action.setEffectiveWeight(this.pose);
    this.action.setEffectiveTimeScale(1);
    this.action.play();

    // Taking off out of a landing that is still standing up: release it rather
    // than cutting it, so it fades under the float on its own blend.
    this.recovering = false;

    this.state = 'rising';
    this._t = 0;
    this._clock = 0;
    this._lastYaw = this.character.facing;
    return true;
  }

  /**
   * Come back down, from wherever it had got to.
   *
   * The descent starts at the height the body is *actually* at rather than at
   * the cruise height, so landing out of a climb is a shorter fall than landing
   * out of a cruise — and neither of them snaps.
   */
  stop() {
    if (!this.active || this.state === 'landing') return;
    const config = this.config;
    // Where in a full descent this height corresponds to, so the ease picks up
    // mid-curve instead of restarting from the top.
    const height = Math.max(0.01, config.height);
    this._t = 1 - Math.sqrt(MathUtils.clamp(this._base / height, 0, 1));
    this.state = 'landing';
    this._cued = false;
  }

  /** Drop the mode on the spot — for leaving the stage, and for teardown. */
  cancel() {
    this.state = 'grounded';
    this.pose = 0;
    this.recovery = 0;
    this.recovering = false;
    this.lift = 0;
    this._base = 0;
    this._t = 0;
    this._cued = false;
    this._roll = 0;
    this._pitch = 0;
    this._level();
    for (const action of [this.action, this.landing]) {
      if (!action) continue;
      action.stop();
      action.enabled = false;
      action.setEffectiveWeight(0);
    }
  }

  /* ------------------------------------------------------------------ */

  /**
   * Advance the mode.
   *
   * @param {number} dt seconds, simulation clock
   * @param {number} speed the body's ground speed this frame, m/s — the pitch
   *   and part of the bank are read off it
   */
  update(dt, speed = 0) {
    const action = this.action;
    if (!action || (!this.active && this.weight <= 0 && !this.recovering)) return;

    const config = this.config;

    /* ---- the climb, and the fall out of it ---- */
    if (this.state === 'rising') {
      this._t = Math.min(1, this._t + dt / Math.max(0.05, config.takeoff));
      // Out fast and settling, which is what a thing that has just pushed off
      // the ground does. `outCubic`, inline: this is the only easing here.
      this._base = config.height * (1 - Math.pow(1 - this._t, 3));
      if (this._t >= 1) this.state = 'flying';
    } else if (this.state === 'flying') {
      // Held against the *live* height, so dragging the slider carries the body
      // up rather than leaving it hovering at the height it took off for.
      this._base = damp(this._base, config.height, 0.001, dt);
    } else if (this.state === 'landing') {
      const fall = Math.max(0.05, config.land);
      this._t = Math.min(1, this._t + dt / fall);
      // In slow and accelerating — the body is falling, not being lowered.
      this._base = config.height * (1 - this._t * this._t);
      // The clip opens on a body that is already falling, so it is cued off the
      // time *left* in the descent rather than off the touchdown: started `lead`
      // seconds early, its impact frame is the frame the feet arrive on.
      if (!this._cued && (1 - this._t) * fall <= Math.max(0, config.recover?.lead ?? 0)) {
        this._cued = true;
        this._touchdown();
      }
      if (this._t >= 1) {
        this._base = 0;
        this.state = 'grounded';
      }
    }

    // The breath, on top of whatever the climb resolved. An offset rather than
    // something integrated into the height: added to `_base` it would wander
    // upward a little on every frame the sine spent positive.
    this._clock += dt;
    const breath = this.state === 'flying' ? 1 : this.pose;
    // Never below the floor: on the last frames of a landing `_base` is zero
    // and the breath is all that is left, and half of a sine is negative.
    this.lift = Math.max(
      0,
      this._base + Math.sin(this._clock * config.bobSpeed * Math.PI * 2) * config.bob * breath
    );

    /* ---- the pose over the gait ---- */
    const target = this.flying ? 1 : 0;
    const rising = target > this.pose;
    const step = dt / Math.max(1e-3, rising ? config.blendIn : config.blendOut);
    this.pose = rising ? Math.min(target, this.pose + step) : Math.max(target, this.pose - step);
    action.setEffectiveWeight(this.pose);

    this._lean(dt, speed, config);
    this._recover(dt, config);

    if (!this.active && this.pose <= 0) {
      action.stop();
      action.enabled = false;
      this._level();
    }
  }

  /**
   * Start the touchdown clip, from the top.
   *
   * Called from the descent rather than from the ground — see the cue above.
   * A landing already running is restarted: the only way to be here twice is a
   * take-off and a second landing inside one recovery, and the second one is
   * the one the feet are doing.
   */
  _touchdown() {
    const action = this.landing;
    if (!action || this.config.recover?.enabled === false) return;
    action.reset();
    action.enabled = true;
    action.setEffectiveWeight(this.recovery);
    action.setEffectiveTimeScale(1);
    action.play();
    this.recovering = true;
  }

  /**
   * Advance the touchdown, and hand the body back to the gait.
   *
   * The clip is released at `exitAt` rather than at its last frame: the tail of
   * a landing is a body standing up, and standing up is what the idle already
   * is — so the two are crossed over each other instead of played in sequence,
   * and what the eye reads is one movement that ends in a stance.
   */
  _recover(dt, config) {
    const action = this.landing;
    if (!action || (!this.recovering && this.recovery <= 0)) return;

    const recover = config.recover ?? {};
    if (this.recovering) {
      const duration = action.getClip().duration;
      const phase = duration > 0 ? MathUtils.clamp(action.time / duration, 0, 1) : 1;
      if (phase >= MathUtils.clamp(recover.exitAt ?? 1, 0.05, 1)) this.recovering = false;
    }

    // Linear, and for the same reason the float's fade is: an exponential tail
    // would leave a few percent of a landing under the idle indefinitely.
    const target = this.recovering ? 1 : 0;
    const rising = target > this.recovery;
    const step = dt / Math.max(1e-3, rising ? (recover.blendIn ?? 0.1) : (recover.blendOut ?? 0.3));
    this.recovery = rising
      ? Math.min(target, this.recovery + step)
      : Math.max(target, this.recovery - step);
    action.setEffectiveWeight(this.recovery);

    if (!this.recovering && this.recovery <= 0) {
      action.stop();
      action.enabled = false;
    }
  }

  /** Put the body back upright, now — the one thing this wrote that persists. */
  _level() {
    const tilt = this.character?.tilt;
    if (tilt) tilt.rotation.set(0, 0, 0);
  }

  /**
   * Roll into the turn, drop the nose with the speed.
   *
   * The bank is taken from how fast the *heading* is changing rather than from
   * the stick, which is the only version of this that stays honest: the body
   * turns toward where it is going at its own rate (`character.turnToward`), so
   * reading the input would lean it before it had begun to turn and leave it
   * level while it was still coming round.
   *
   * Both angles are faded out by the float's own weight, so a body halfway back
   * onto the ground is halfway back to upright and there is no frame where a
   * landed character is standing at an angle.
   */
  _lean(dt, speed, config) {
    const yaw = this.character.facing;
    // Shortest way round: a heading crossing the -Z seam is not a 360° turn.
    const delta = MathUtils.euclideanModulo(yaw - this._lastYaw + Math.PI, Math.PI * 2) - Math.PI;
    this._lastYaw = yaw;

    const rate = dt > 1e-4 ? delta / dt : 0;
    const fast = MathUtils.clamp(speed / Math.max(0.5, config.speed), 0, 1.4);

    // Turning left rolls the body left. The rate is clamped rather than scaled,
    // so a spin on the spot banks exactly as hard as a wide fast turn does.
    const bank = -MathUtils.clamp(rate * 0.55, -1, 1) * config.bank * (0.35 + 0.65 * fast);
    const pitch = fast * config.pitch;

    // `leanRate` as a time constant: the fraction of the gap left after one
    // second is e^-rate, so 4 is "there in about a second" and 12 is a snap.
    const rest = Math.exp(-Math.max(0.1, config.leanRate));
    this._roll = damp(this._roll, bank, rest, dt);
    this._pitch = damp(this._pitch, pitch, rest, dt);

    const tilt = this.character.tilt;
    if (!tilt) return;
    // The tilt node sits under the root, so these are in the *body's* frame: x
    // is the nose, z is the roll axis down the spine.
    // The float's own weight, not the mode's: a body in the landing clip is
    // taking its weight on its feet, and it takes it upright.
    tilt.rotation.set(this._pitch * this.pose, 0, this._roll * this.pose);
  }
}
