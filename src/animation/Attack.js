import { LoopOnce, MathUtils } from 'three';
import { settings } from '../config/settings.js';

/**
 * One melee attack: the clip, its blend over the gait, and the warp that aims it.
 *
 * There is one of these per move — the kick (`E`) and the slash hit (`R`) are
 * both instances, differing only in the clip they were handed and the
 * `configKey` they read their numbers from. Anything that has to be true of
 * *an* attack lives here; anything that makes one of them feel like itself is a
 * number in `config/settings.js`.
 *
 * ## Why a warp
 *
 * An attack animation is authored against an imaginary opponent at one exact
 * distance and one exact angle. The player is never standing there. There are
 * only three ways out of that, and two of them are wrong: sliding the body with
 * an ease (which reads as skating), or letting the foot swing through empty air
 * a foot short of the target (which reads as a bug).
 *
 * The third is what every third-person game since about 2013 does, and it is
 * what this class implements: **motion warping**. The target is locked at the
 * moment of the press, the spot the animator assumed the character would be
 * standing on is resolved from it (`standoff` metres short, facing it), and the
 * body is carried onto that spot *inside the clip's own approach* — the frames
 * before the leg comes up. By `hitAt` the character is exactly where the clip
 * needs it to be, so the foot lands on the chest rather than near it.
 *
 * The turn finishes first and the step second (`turnAt`), because that is the
 * order a person does it in: you face what you are about to hit, then you close
 * on it.
 *
 * ## What it owns
 *
 * Not the transform. Like `Jump`, this class only *resolves* where the body
 * should be — `warp` is read by `ThirdPersonController`, which is the one
 * authority over position and heading. And like `Jump`, its clock is the
 * action's own, so the whole move obeys `global.animationSpeed`, the pause key
 * and the hit-stop for free.
 *
 * The contact itself is a callback rather than anything this class acts on: it
 * knows the frame the foot is out, and nothing else about what being hit means.
 */
export class Attack {
  /**
   * @param {import('three').AnimationMixer} mixer
   * @param {import('three').AnimationClip|null} clip
   * @param {import('./CharacterController.js').CharacterController} character
   * @param {{configKey?: string, onHit?: (target: object, dirX: number, dirZ: number) => void}} options
   */
  constructor(mixer, clip, character, { configKey = 'kick', onHit = null } = {}) {
    this.character = character;
    this.configKey = configKey;
    /** Called once, on the frame the foot connects with a target still in reach. */
    this.onHit = onHit;

    this.action = null;
    if (clip) {
      this.action = mixer.clipAction(clip);
      this.action.setLoop(LoopOnce, 1);
      this.action.clampWhenFinished = true; // hold the last frame while it blends out
      this.action.enabled = false;
      this.action.setEffectiveWeight(0);
    }

    /** How much of the pose the kick has, 0..1. Locomotion is masked by this. */
    this.weight = 0;
    /** True from the press until control comes back. The stick is dead for it. */
    this.locked = false;

    /**
     * Where the body should be and which way it should point, this frame.
     *
     * `active` is false for a kick thrown at nothing — there is no target to
     * warp onto, so the controller leaves the transform alone and the character
     * swings at the air exactly where it stands.
     */
    this.warp = { active: false, x: 0, z: 0, yaw: 0 };

    /** The body this swing was aimed at. Cleared the moment it is struck. */
    this.target = null;
    this._struck = false;
    /** Where the body started, and the spot the clip wants it to finish on. */
    this._from = { x: 0, z: 0, yaw: 0 };
    this._to = { x: 0, z: 0, yaw: 0 };
    /**
     * Where a pass-through move ends up, on the far side of the body.
     *
     * Only meaningful for a move with `passThrough` — for everything else it is
     * the contact mark itself, and the second leg of the warp has no length.
     */
    this._past = { x: 0, z: 0 };
  }

  get available() {
    return Boolean(this.action);
  }

  /** Live tuning, read per frame so the editor's edits land immediately. */
  get config() {
    return settings[this.configKey];
  }

  /**
   * The kick takes the whole pose.
   *
   * Unlike the hop there is no gait bleeding through: the controller has
   * stopped the body for the length of the move, so a walk cycle underneath
   * would be legs walking on the spot.
   */
  get takeover() {
    return this.weight;
  }

  /**
   * Whether this attack may start right now.
   *
   * The gate is that the body is on the ground and not already swinging
   * *anything* — every attack is a different clip on the same skeleton, and two
   * of them holding the pose at once is a soup rather than a combo. Re-entering
   * one from its own recovery would stutter the pose for the same reason.
   *
   * Everything here is about the *body*. Whether there is anyone to swing at is
   * the other half of the question and it is not asked here: this class has no
   * idea the enemies exist, and the one call that can answer it — `findTarget`
   * with this move's range and cone — belongs to whoever owns them. The
   * controller asks it on the press and the HUD reads the same answer back out
   * of `App#_readyMoves`.
   */
  canStart() {
    if (!this.config.enabled || !settings.locomotion.enabled) return false;
    if (!this.action || this.locked) return false;
    // Both feet on the floor. An attack thrown out of a jump is a different
    // clip, and this one plants a leg on ground that would not be there.
    if (this.character?.jump?.locked || this.character?.hop?.locked) return false;
    // Nor over another attack still running — including one only blending out,
    // which is why `locked` is the test rather than the weight.
    for (const other of this.character?.attacks ?? []) {
      if (other !== this && other.locked) return false;
    }
    return true;
  }

  /**
   * Commit to the swing.
   *
   * `target` may still be null and the clip still plays, warping nowhere — but
   * nothing reaches here that way any more: the controller will not start a
   * move it found nobody for. The path is kept because the class should not
   * fall over on a caller that has no enemies to offer it, not because a swing
   * at the air is something the player can ask for.
   *
   * @param {{position: import('three').Vector3}|null} target
   */
  start(target = null) {
    if (!this.action) return false;

    this.action.reset();
    this.action.enabled = true;
    this.action.setEffectiveWeight(0);
    this.action.setEffectiveTimeScale(this.config.timeScale ?? 1);
    this.action.play();

    this.weight = 0;
    this.locked = true;
    this._struck = false;
    this.target = target;
    this._resolveWarp(target);
    return true;
  }

  /**
   * Work out where the body has to end up for the clip to land.
   *
   * Done once, at the press: the destination is a fixed point on the ground, so
   * the approach is a straight line the player can read rather than a homing
   * curve that re-aims every frame. A target already inside `standoff` moves
   * the body nowhere — it only turns, because backing *away* to make room for
   * an animation is the tell that gives motion warping away.
   *
   * A move with `passThrough` resolves a second point past the first, down the
   * same line: it does not stop in front of what it hits, it goes through it.
   */
  _resolveWarp(target) {
    const position = this.character.position;
    const from = this._from;
    const to = this._to;

    from.x = position.x;
    from.z = position.z;
    from.yaw = this.character.facing;

    if (!target) {
      this.warp.active = false;
      return;
    }

    const config = this.config;
    const dx = target.position.x - position.x;
    const dz = target.position.z - position.z;
    const distance = Math.hypot(dx, dz);

    // 0 faces +Z, so the heading of a world direction is atan2(x, z).
    to.yaw = distance > 1e-4 ? Math.atan2(dx, dz) : from.yaw;

    // How far to close: everything but the standoff, and never more than the
    // warp is allowed to move the body in one clip.
    const step = MathUtils.clamp(distance - config.standoff, 0, config.maxWarp);
    const k = distance > 1e-4 ? step / distance : 0;
    to.x = position.x + dx * k;
    to.z = position.z + dz * k;

    // And how far past it, for a move that goes through rather than up to: the
    // standoff it was going to stop at, plus the ground it should end up on
    // behind the body. Measured from the contact mark rather than from the
    // target, so a warp cut short by `maxWarp` still travels its own length
    // instead of teleporting the shortfall.
    const beyond = config.passThrough > 0 ? config.standoff + config.passThrough : 0;
    const ux = distance > 1e-4 ? dx / distance : Math.sin(to.yaw);
    const uz = distance > 1e-4 ? dz / distance : Math.cos(to.yaw);
    this._past.x = to.x + ux * beyond;
    this._past.z = to.z + uz * beyond;

    this.warp.active = true;
    this.warp.x = from.x;
    this.warp.z = from.z;
    this.warp.yaw = from.yaw;
  }

  /**
   * Advance the swing: the warp, the contact and the blend.
   *
   * Read off the action's own clock rather than a parallel one, so the frame
   * the foot connects is the frame that is actually on screen — which is what
   * lets the hit-stop be triggered from here and still line up with the pose.
   */
  update(dt) {
    const action = this.action;
    if (!action || (!this.locked && this.weight <= 0)) return;

    const config = this.config;
    // Re-read rather than left as `start` set it, so the pace is a live slider
    // like everything else. Every time below is normalised, so changing it
    // mid-swing shortens the move without moving where the blow lands in it.
    action.setEffectiveTimeScale(config.timeScale ?? 1);

    const duration = action.getClip().duration;
    const phase = duration > 0 ? MathUtils.clamp(action.time / duration, 0, 1) : 1;

    if (this.locked) {
      this._advanceWarp(phase, config);

      if (!this._struck && phase >= config.hitAt) {
        this._struck = true;
        this._strike(config);
      }

      // Past the recovery the clip is only settling back onto its feet; the
      // player has the body again.
      if (phase >= config.recoverAt) {
        this.locked = false;
        this.warp.active = false;
      }
    }

    // A linear ramp, for the same reason the jump's is: the fade has to
    // *finish*, and an exponential tail would leave a few percent of the gait
    // showing through the kick for its whole length.
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

  /** Interpolate the approach for this frame. Turn first, step second. */
  _advanceWarp(phase, config) {
    if (!this.warp.active) return;

    const from = this._from;
    const to = this._to;
    const warpAt = Math.max(0.01, config.warpAt);
    const t = MathUtils.clamp(phase / warpAt, 0, 1);
    const turn = smootherstep(MathUtils.clamp(t / Math.max(0.05, config.turnAt), 0, 1));

    if (config.passThrough > 0) {
      // Two legs of one straight line — the contact mark is on the way to the
      // far side, not the end of the trip. The easing is split rather than
      // shared so the body never stops on the mark: it accelerates onto it,
      // carries that speed through the frames the blade is out, and only runs
      // out of it once it is past. A smootherstep on each leg would put a dead
      // frame exactly where the cut is, and the slide would read as two moves.
      const past = this._past;
      if (phase <= warpAt) {
        const move = t * t; // off the standing pose, arriving at speed
        this.warp.x = from.x + (to.x - from.x) * move;
        this.warp.z = from.z + (to.z - from.z) * move;
      } else {
        const passAt = Math.max(warpAt + 0.01, config.passAt ?? 1);
        const u = MathUtils.clamp((phase - warpAt) / (passAt - warpAt), 0, 1);
        const move = 1 - (1 - u) * (1 - u); // through, and coasting to a stop
        this.warp.x = to.x + (past.x - to.x) * move;
        this.warp.z = to.z + (past.z - to.z) * move;
      }
    } else {
      // Zero velocity at both ends: the body eases off its standing pose and
      // arrives without a stop, which is what keeps the approach from reading
      // as a slide.
      const move = smootherstep(t);
      this.warp.x = from.x + (to.x - from.x) * move;
      this.warp.z = from.z + (to.z - from.z) * move;
    }

    // Shortest way round, so a target behind the shoulder does not spin the
    // body the long way to reach it.
    const delta = MathUtils.euclideanModulo(to.yaw - from.yaw + Math.PI, Math.PI * 2) - Math.PI;
    this.warp.yaw = from.yaw + delta * turn;
  }

  /**
   * The foot is out. Hand the target over, if it is still there to be hit.
   *
   * The reach test is taken *now* rather than trusted from the press: the
   * target may have died to something else in the meantime, and a kick that
   * connects with a corpse it never reached is worse than one that misses.
   */
  _strike(config) {
    const target = this.target;
    this.target = null;
    if (!target || target.alive === false) return;

    const position = this.character.position;
    const dx = target.position.x - position.x;
    const dz = target.position.z - position.z;
    if (Math.hypot(dx, dz) > config.reach) return;

    // The blow goes where the body is *pointing*, not where the target happens
    // to be — after the warp those agree, and when they do not it is because
    // the player turned, in which case the pose is the truth.
    const yaw = this.character.facing;
    this.onHit?.(target, Math.sin(yaw), Math.cos(yaw));
  }

  /** Abandon the swing — for resets, the character screen and teardown. */
  cancel() {
    this.locked = false;
    this.weight = 0;
    this.target = null;
    this._struck = false;
    this.warp.active = false;
    if (this.action) {
      this.action.stop();
      this.action.enabled = false;
      this.action.setEffectiveWeight(0);
    }
  }
}

/** Zero velocity *and* acceleration at both ends, so the approach does not snap. */
function smootherstep(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
