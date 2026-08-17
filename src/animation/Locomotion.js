import { LoopRepeat, MathUtils } from 'three';
import { settings } from '../config/settings.js';
import { damp } from '../utils/math.js';

/**
 * The idle / walk / run blend.
 *
 * All three clips play all the time; only their weights move. That is what
 * makes the transitions continuous — there is no moment where one action is
 * stopped and another started, so a stop-start-stop input can never catch the
 * body mid-fade with nothing playing.
 *
 * Two things keep the feet on the ground:
 *
 *  - **Phase lock.** Walk is the master cycle and run is slaved to its
 *    normalised phase every frame, so the two clips always contact the floor on
 *    the same foot at the same instant. Crossfading two free-running gait cycles
 *    is what produces the four-legged shuffle in the middle of the blend.
 *  - **Stride rate.** Playback is scaled by how fast the body is *actually*
 *    travelling against the speed the clip was authored for
 *    (`clipWalkSpeed`/`clipRunSpeed`), so raising `walkSpeed` or `runSpeed` in
 *    the editor re-times the legs instead of skating them.
 */
export class Locomotion {
  /**
   * @param {import('three').AnimationMixer} mixer
   * @param {{idle: import('three').AnimationClip, walk: import('three').AnimationClip, run: import('three').AnimationClip}} clips
   * @param {{weight: number, takeover: number}[]} overrides full-body moves that
   *   mask the gait while they hold the pose — the two jumps and the kick. Only
   *   those two numbers are read, so anything that resolves them qualifies.
   */
  constructor(mixer, clips, overrides = []) {
    this.mixer = mixer;
    this.overrides = overrides.filter(Boolean);

    this.idle = this._action(clips.idle);
    this.walk = this._action(clips.walk);
    this.run = this._action(clips.run);

    /** Ground speed the blend is resolving toward, m/s. */
    this.speed = 0;
    /** Smoothed weights, so a shove on the input does not pop the pose. */
    this.weights = { idle: 1, walk: 0, run: 0 };

    if (this.idle) this.idle.weight = 1;
  }

  _action(clip) {
    if (!clip) return null;
    const action = this.mixer.clipAction(clip);
    action.setLoop(LoopRepeat, Infinity);
    action.enabled = true;
    action.setEffectiveWeight(0);
    action.play();
    return action;
  }

  /** Ground speed in m/s, from the controller. */
  setSpeed(speed) {
    this.speed = Math.max(0, speed);
  }

  /**
   * Park the blend on the first frame of the idle, now rather than over a fade.
   *
   * `update` damps every weight so a shove on the input cannot pop the pose,
   * which is right for a body being driven and wrong for one about to be *held*
   * still: a pose frozen mid-fade is a soup of three clips, and gear aligned
   * against it is aligned against nothing. Rewinding the clips as well makes the
   * held frame the same one every time, so a placement judged in one session is
   * judged against the same silhouette in the next.
   */
  rest() {
    this.speed = 0;
    this.weights = { idle: 1, walk: 0, run: 0 };
    for (const key of ['idle', 'walk', 'run']) {
      const action = this[key];
      if (!action) continue;
      action.setEffectiveWeight(this.weights[key]);
      action.setEffectiveTimeScale(1);
      action.time = 0;
    }
  }

  /**
   * Resolve weights and stride rate for this frame.
   *
   * Must run *before* the mixer is updated: the phase lock reads `walk.time`,
   * and writing `run.time` after the update would leave the run one frame stale
   * against the walk it is supposed to be locked to.
   */
  update(dt) {
    const config = settings.locomotion;
    const speed = this.speed;

    // Two nested blends: idle → walk below walking pace, then walk → run above
    // it. Expressed as one product so the three weights always sum to 1.
    const toWalk = MathUtils.clamp(speed / Math.max(0.01, config.walkSpeed), 0, 1);
    const toRun = MathUtils.clamp(
      (speed - config.walkSpeed) / Math.max(0.01, config.runSpeed - config.walkSpeed),
      0,
      1
    );

    const target = {
      run: toRun,
      walk: (1 - toRun) * toWalk,
      idle: (1 - toRun) * (1 - toWalk)
    };

    // The jump takes the pose over rather than replacing the blend: the gait is
    // still resolving underneath at whatever speed the body launched with, so
    // landing rejoins a run in stride instead of popping out of an idle. Only
    // one jump is ever up, but the two overlap by a blend or two when a hop is
    // still fading as a long jump launches — the loudest of them wins the pose.
    //
    // Standing and travelling are masked separately, because a jump may leave
    // some of the gait deliberately alive (`takeover`): an in-place clip that
    // took the whole pose would plant the legs while the controller keeps
    // carrying the body, which looks like a stop it never made. What survives is
    // the walk or the run — the idle has no motion to preserve.
    const standing = 1 - this._jumpWeight();
    const travelling = 1 - this._jumpTakeover();
    const mask = { idle: standing, walk: travelling, run: travelling };

    for (const key of ['idle', 'walk', 'run']) {
      this.weights[key] = damp(this.weights[key], target[key], config.blendRate, dt);
      this[key]?.setEffectiveWeight(this.weights[key] * mask[key]);
    }

    // The pace the blended pose travels at when played at rate 1 — the *clips'*
    // authored speeds, not the designer's `walkSpeed`/`runSpeed`. Dividing the
    // real speed by that is the multiplier that keeps the feet planted: double
    // the run speed and the legs turn over twice as fast to cover it.
    const nominal = MathUtils.lerp(
      Math.max(0.01, config.clipWalkSpeed),
      Math.max(0.01, config.clipRunSpeed),
      toRun
    );
    // …then the per-gait trim, blended on the same curve as the weights, so the
    // walk end of the blend can be re-timed without dragging the run with it.
    // The division is only as good as the two clip speeds above; this is the
    // knob for the part of the mismatch those numbers do not explain. Trim
    // before the clamp, so a trimmed rate is still bounded.
    const trim = MathUtils.lerp(config.walkAnimSpeed, config.runAnimSpeed, toRun);
    const stride =
      speed > config.idleThreshold
        ? MathUtils.clamp((speed / nominal) * trim, config.strideMin, config.strideMax)
        : 1;

    this.walk?.setEffectiveTimeScale(stride);
    this.run?.setEffectiveTimeScale(stride);

    this._lockPhase();
  }

  /** How much of the pose the full-body moves have taken between them, 0..1. */
  _jumpWeight() {
    let weight = 0;
    for (const move of this.overrides) weight = Math.max(weight, move.weight);
    return Math.min(1, weight);
  }

  /** The same, less whatever gait each of them chose to leave playing. */
  _jumpTakeover() {
    let weight = 0;
    for (const move of this.overrides) weight = Math.max(weight, move.takeover);
    return Math.min(1, weight);
  }

  /** Slave the run cycle to the walk's normalised phase (see the class note). */
  _lockPhase() {
    if (!this.walk || !this.run) return;
    const walkDuration = this.walk.getClip().duration;
    const runDuration = this.run.getClip().duration;
    if (walkDuration <= 0 || runDuration <= 0) return;

    const phase = (this.walk.time % walkDuration) / walkDuration;
    this.run.time = phase * runDuration;
  }

  /** Whichever clip currently dominates — for HUDs and debugging. */
  get state() {
    if (this._jumpWeight() > 0.5) return 'jump';
    const { idle, walk, run } = this.weights;
    if (run >= walk && run >= idle) return 'run';
    return walk >= idle ? 'walk' : 'idle';
  }
}
