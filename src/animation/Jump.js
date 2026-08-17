import { LoopOnce, MathUtils, Vector2 } from 'three';
import { settings } from '../config/settings.js';

const _offset = new Vector2(); // sampled travel, metres, in the rig's model frame

/**
 * A jump: the clip, its blend over the gait, and any ground it covers.
 *
 * Two of these exist, and which one space reaches is decided by the pace the
 * body is already doing (see `ThirdPersonController`):
 *
 *  - **The running long jump** (`settings.jump`), a committed move rather than
 *    a modifier: it can only be entered from a run, and once it is entered the
 *    stick is dead until the body lands. That is the whole point of it — the arc
 *    is authored, so the player is choosing *where to land*, not steering
 *    through the air.
 *  - **The hop** (`settings.hop`), which travels nowhere and so never has to
 *    take the stick: the controller keeps driving the body through it and the
 *    notes below about travel simply do not apply. It is a pose laid over the
 *    gait, nothing more.
 *
 * Two things make the long jump land somewhere:
 *
 *  - **Travel.** The clip's own hips translation is lifted out at load time
 *    (see `CharacterController#_retarget`) and replayed onto the character's
 *    root instead of the skeleton, so the body covers the ground the animator
 *    drew rather than sliding in place. `settings.jump.distance` renormalises
 *    that curve to an exact number of metres — the shape is the animation's,
 *    the reach is the designer's. A clip exported in place still works: the
 *    forward ease below stands in for the missing curve.
 *  - **Momentum.** The velocity at launch is never cleared, so touching down
 *    continues the run instead of dropping the body into an idle it has to
 *    accelerate out of again.
 *
 * The travel is handed out as a *pending delta* rather than an absolute
 * position: whoever owns movement drains it each frame and integrates it, so
 * this class never writes to the transform and there is still exactly one
 * authority over where the character is.
 */
export class Jump {
  /**
   * @param {import('three').AnimationMixer} mixer
   * @param {import('three').AnimationClip|null} clip
   * @param {{times: Float32Array, x: Float32Array, z: Float32Array, total: number}|null} travel
   *   hips translation lifted off the clip, in the model's own units
   * @param {import('./CharacterController.js').CharacterController} character
   * @param {'jump'|'hop'} configKey which block of `settings` tunes this one.
   *   Held as a key rather than the object so the editor's live edits are read
   *   the frame they are made.
   */
  constructor(mixer, clip, travel, character, configKey = 'jump') {
    this.character = character;
    this.travel = travel;
    this.configKey = configKey;

    this.action = null;
    if (clip) {
      this.action = mixer.clipAction(clip);
      this.action.setLoop(LoopOnce, 1);
      this.action.clampWhenFinished = true; // hold the last frame while it blends out
      this.action.enabled = false;
      this.action.setEffectiveWeight(0);
    }

    /** How much of the pose is the jump's, 0..1. Locomotion is masked by this. */
    this.weight = 0;
    /**
     * True from launch until the feet are back down. For the long jump that is
     * also the window the stick is ignored in; the hop only reads it as "still
     * in the air", to keep a second press from restarting the clip.
     */
    this.locked = false;

    /** Metres per model unit for this jump, resolved at launch. */
    this._unit = 1;
    /** Travel sampled last frame, metres — deltas come from differencing it. */
    this._sampled = new Vector2();
    /** Travel owed to the controller, metres, in the model frame. */
    this._pending = new Vector2();
  }

  get available() {
    return Boolean(this.action);
  }

  /** This jump's live tuning. Read per frame — the editor writes to it. */
  get config() {
    return settings[this.configKey];
  }

  /** Whether the clip covers ground the controller has to be handed. */
  get travels() {
    return Boolean(this.travel) || this.config.distance > 0;
  }

  /**
   * How much of the *travelling* gait this jump claims, 0..1.
   *
   * Not the same as `weight`: a jump can hold the pose outright and still leave
   * some of the walk or run playing under it (`gaitBleed`), which is what stops
   * an in-place clip from planting the legs while the controller carries the
   * body forward. A jump that owns the position wants none of that — it *is*
   * the movement — so the default of no bleed leaves the long jump alone.
   */
  get takeover() {
    return this.weight * (1 - (this.config.gaitBleed ?? 0));
  }

  /**
   * Whether this jump may start right now.
   *
   * Where a run is required the gate is a real run, not the intent to run: the
   * shift key alone would let a standing body launch into a full stride, so the
   * speed the controller has actually reached has to back it up. The hop asks
   * for none of that — it is what the body does when this returns false.
   *
   * @param {number} speed current ground speed, m/s
   * @param {boolean} running whether the run modifier is held
   */
  canStart(speed = 0, running = false) {
    const config = this.config;
    if (!config.enabled || !settings.locomotion.enabled) return false;
    if (!this.action || this.locked) return false;
    if (!config.requiresRun) return true;
    if (!running) return false;
    return speed >= settings.locomotion.runSpeed * config.minRunFraction;
  }

  /** Commit to the jump. Nothing checks `canStart` for you. */
  start() {
    if (!this.action) return false;

    const config = this.config;
    // The rig's scale is stable for the length of one jump, so resolving the
    // unit here rather than per frame keeps a live `targetHeight` edit from
    // stretching the arc out from under the body mid-air.
    const scale = this.character?.modelScale || 1;
    const total = this.travel?.total ?? 0;
    // A positive `distance` is an exact reach: divide it across the authored
    // curve so the shape survives and only the size changes.
    this._unit = config.distance > 0 && total > 1e-5 ? config.distance / total : scale;

    this.action.reset();
    this.action.enabled = true;
    this.action.setEffectiveWeight(0);
    this.action.setEffectiveTimeScale(1);
    this.action.play();

    this.weight = 0;
    this.locked = true;
    this._sampled.set(0, 0);
    this._pending.set(0, 0);
    return true;
  }

  /**
   * Advance the state machine.
   *
   * Timing is read off the action rather than kept here, so the jump obeys
   * `global.animationSpeed` and the pause key for free — the travel is tied to
   * the frame of animation actually on screen, not to a parallel clock that
   * could drift away from it.
   */
  update(dt) {
    const action = this.action;
    if (!action || (!this.locked && this.weight <= 0)) return;

    const config = this.config;
    const duration = action.getClip().duration;
    const phase = duration > 0 ? MathUtils.clamp(action.time / duration, 0, 1) : 1;

    if (this.locked) {
      // A jump with nothing to replay skips this entirely rather than
      // accumulating zeroes: the controller is still driving the body, and the
      // hop has no business adding to what it decides.
      if (this.travels) {
        this._sample(action.time, phase, _offset);
        this._pending.add(_offset).sub(this._sampled);
        this._sampled.copy(_offset);
      }
      // Past the landing the clip is only recovering, and its shuffle is not
      // travel — the body is standing where it came down.
      if (phase >= config.landAt) this.locked = false;
    }

    // A linear ramp rather than a damped one: the fade has to *finish*, and an
    // exponential tail would leave a few percent of the gait bleeding through
    // the jump for its whole length.
    const target = this.locked ? 1 : 0;
    const rising = target > this.weight;
    const step = dt / Math.max(1e-3, rising ? config.blendIn : config.blendOut);
    this.weight = rising
      ? Math.min(target, this.weight + step)
      : Math.max(target, this.weight - step);
    action.setEffectiveWeight(this.weight);

    if (!this.locked && this.weight <= 0) {
      action.stop();
      action.enabled = false;
    }
  }

  /**
   * Take the ground the jump has covered since the last call, in metres, in the
   * *model's* frame — the caller rotates it by the body's heading.
   * @param {Vector2} out receives (x, z)
   */
  consumeTravel(out) {
    out.copy(this._pending);
    this._pending.set(0, 0);
    return out;
  }

  /**
   * Land it here, wherever the clip had got to: the hold ends and the pose
   * blends back out on its own timing. For handing the body to another jump
   * without a pop — unlike `cancel`, which cuts.
   */
  release() {
    this.locked = false;
  }

  /** Abandon the jump without landing it — for resets and teardown. */
  cancel() {
    this.locked = false;
    this.weight = 0;
    this._pending.set(0, 0);
    this._sampled.set(0, 0);
    if (this.action) {
      this.action.stop();
      this.action.enabled = false;
      this.action.setEffectiveWeight(0);
    }
  }

  /**
   * Where the body should be, relative to launch, at this point in the clip.
   *
   * Falls back to an ease along the rig's own forward when the clip was
   * exported in place: a jump that lands where it took off is not a jump, so a
   * missing curve is filled in rather than obeyed.
   *
   * @param {number} time the action's own clock, seconds — the curve's timeline
   * @param {number} phase the same, normalised, for the fallback ease
   * @param {Vector2} out receives the offset from launch, in metres
   */
  _sample(time, phase, out) {
    const config = this.config;
    const travel = this.travel;

    if (!travel || travel.total <= 1e-5) {
      const forward = this.character?.forwardAxis;
      const reach = config.distance > 0 ? config.distance : 0;
      const eased = smootherstep(MathUtils.clamp(phase / Math.max(0.01, config.landAt), 0, 1));
      return out.set((forward?.x ?? 0) * reach * eased, (forward?.z ?? 1) * reach * eased);
    }

    // The track's own timeline, walked from the front: the keys are a few dozen
    // at most, and reading them in order is what keeps the sampled offset
    // monotonic — a delta that went backwards would drag the body back.
    const { times, x, z } = travel;
    let i = 1;
    while (i < times.length - 1 && times[i] < time) i++;
    const t0 = times[i - 1];
    const t1 = times[i];
    const k = t1 > t0 ? MathUtils.clamp((time - t0) / (t1 - t0), 0, 1) : 0;

    return out.set(
      MathUtils.lerp(x[i - 1], x[i], k) * this._unit,
      MathUtils.lerp(z[i - 1], z[i], k) * this._unit
    );
  }
}

/** Zero velocity *and* acceleration at both ends, so the launch does not snap. */
function smootherstep(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
