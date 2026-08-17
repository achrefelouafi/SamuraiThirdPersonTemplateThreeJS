import { Vector2 } from 'three';
import { settings } from '../config/settings.js';
import { damp } from '../utils/math.js';

const _desired = new Vector2(); // world XZ target velocity, m/s
const _delta = new Vector2(); // the step from the current velocity toward it
const _travel = new Vector2(); // ground covered by the jump this frame, model frame

/**
 * Camera-relative third-person movement.
 *
 * Input is read as a stick, resolved against the camera's azimuth — W is always
 * "away from the camera", so orbiting the rig re-aims the controls the way a
 * third-person game does — and integrated into a velocity rather than applied
 * as a position delta. The velocity is what the animation blend reads, so the
 * legs answer to the body's real speed and keep up through the acceleration
 * ramp instead of snapping to a walk the instant a key goes down.
 *
 * The body turns toward where it is *going*, never toward where the camera is
 * looking: the character owns its heading, and `settings.character.facing` stays
 * the one answer to which way it points.
 *
 * Space, from a run, hands the body to `Jump` (see that file). While it is in
 * the air this class stops reading the stick entirely and only replays the
 * arc's travel — the jump is a commitment, and its landing spot is the answer
 * to where the character ends up. Space at any lesser pace plays the in-place
 * hop over the top instead, and movement carries on underneath it untouched.
 *
 * The attacks (`E` to kick, `R` to jump onto something) are the same shape of
 * thing again, one step further: each locks the stick out *and* takes the
 * transform over outright, because `Attack` has resolved exactly where the body
 * has to stand for the blow to land (see that file). This class stays the only
 * thing that writes a position — the attack says where, this says so. Which
 * moves exist is read off `character.attacks`, so a new one is a clip and a
 * settings block rather than a branch here.
 */
export class ThirdPersonController {
  /**
   * @param {import('./CharacterController.js').CharacterController} character
   * @param {import('../core/Input.js').Input} input
   * @param {import('../core/CameraRig.js').CameraRig} rig
   */
  constructor(character, input, rig) {
    this.character = character;
    this.input = input;
    this.rig = rig;

    /** Ground velocity, m/s. Persistent — this is the thing being integrated. */
    this.velocity = new Vector2(0, 0);
    /** Smoothed speed handed to the blend, m/s. */
    this.speed = 0;

    /**
     * Who there is to hit, and to walk into. Set once the bodies are loaded —
     * everything here is written to tolerate its absence, so the stage runs
     * with no enemies in it at all.
     * @type {import('../combat/EnemyManager.js').EnemyManager|null}
     */
    this.enemies = null;
  }

  /** @param {import('../combat/EnemyManager.js').EnemyManager} enemies */
  setEnemies(enemies) {
    this.enemies = enemies;
  }

  update(dt) {
    const config = settings.locomotion;
    if (dt <= 0) return;

    const axis = this.input.sample();
    const running = this.input.running;
    // The jump is a movement state, so it is advanced from here — the same place
    // that owns the position it moves. `Locomotion` only reads the weight it
    // resolves, later in the frame.
    const jump = this.character.jump;
    const hop = this.character.hop;
    const attacks = this.character.attacks ?? [];

    // Every buffered press is taken now, before anything below can return —
    // jumping or not, able to answer it or not. One left in the buffer fires
    // later, which is a move the player asked for two seconds ago. The first
    // attack that was asked for *and* can start wins; only one of them ever
    // holds the body at a time (`Attack#canStart`).
    const jumpPressed = this.input.consumeJump();
    let requested = null;
    for (const move of attacks) {
      if (this.input.consumeAttack(move.configKey) && !requested) requested = move;
    }

    // The hover, before anything else can have the body. It is advanced even
    // when it is not up, because a mode that has just been left is still fading
    // its pose out over the gait — and while it *is* up it takes the stick
    // outright: nothing below this line can run, which is what makes flight the
    // one ability that excludes every other one.
    const flight = this.character.flight;
    flight?.update(dt, this.speed);
    if (flight?.flying) {
      this._fly(dt, axis, running);
      return;
    }

    hop?.update(dt);
    if (jump) {
      jump.update(dt);
      if (this._applyJumpTravel(jump)) return; // airborne: the stick is dead
    }

    // The attacks, before the stick is read: whichever is running takes the body
    // over for the length of the move, so anything the player presses under it
    // is noise.
    let holding = null;
    for (const move of attacks) {
      move.update(dt);
      if (move.locked) holding = move;
    }
    if (holding) {
      this._applyAttackWarp(holding, dt);
      return;
    }

    // An attack needs someone to be for. A swing at empty air used to play, on
    // the grounds that a whiff is information — but the range and the cone are
    // what the move *is*, and a key that fires from anywhere teaches that they
    // are not. So the press is spent and the body carries on walking, which is
    // the same answer the dimmed plate in the HUD gave before the key went
    // down (see `App#_syncAbilities`).
    if (requested?.canStart()) {
      const target = this._findAttackTarget(requested);
      if (target) {
        requested.start(target);
        this._applyAttackWarp(requested, dt);
        return;
      }
    }

    // One press, two answers: the long jump if the body is already running hard
    // enough to sell it, the hop otherwise. The hop falls straight through to
    // the movement below rather than returning — it covers no ground of its own,
    // so the stick has to keep carrying the body or a walking jump would stop
    // dead in the air.
    if (jumpPressed) {
      if (jump?.canStart(this.speed, running)) {
        // A hop still fading would fight the arc for the pose; released rather
        // than cancelled so it hands over across its own blend instead of
        // snapping off the body mid-air.
        hop?.release();
        jump.start();
        return;
      }
      if (hop?.canStart()) hop.start();
    }

    // Where the camera is looking, flattened. The rig orbits at `azimuth`
    // measured from +Z, so the horizontal offset from target to camera is
    // (sin, cos) and the direction *away* from the camera is its negation.
    const azimuth = this.rig.azimuth;
    const sin = Math.sin(azimuth);
    const cos = Math.cos(azimuth);

    // forward = -(sin, cos), right = (cos, -sin) — see the camera basis above.
    _desired.set(axis.y * -sin + axis.x * cos, axis.y * -cos + axis.x * -sin);

    const wanted = config.enabled ? (running ? config.runSpeed : config.walkSpeed) : 0;
    _desired.multiplyScalar(wanted);

    // Stopping is sharper than starting: the deceleration ramp is what stops the
    // body sliding past the point the key was released.
    const rate = _desired.lengthSq() > 0 ? config.acceleration : config.deceleration;
    _delta.copy(_desired).sub(this.velocity);
    const step = rate * dt;
    if (_delta.length() <= step) this.velocity.copy(_desired);
    else this.velocity.addScaledVector(_delta.normalize(), step);

    /* ---- integrate ---- */
    const position = this.character.position;
    position.x += this.velocity.x * dt;
    position.z += this.velocity.y * dt;

    // Then push back out of anyone standing there. It is only a cylinder, but
    // walking *through* a body is the single fastest way to tell a player that
    // nothing on screen is really there — and the kick's own standoff is wider
    // than this, so the two never argue over the same metre of ground.
    if (settings.enemies.collide) this.enemies?.pushOut(position, settings.enemies.bodyRadius);

    /* ---- heading ---- */
    const speed = this.velocity.length();
    if (speed > config.idleThreshold) {
      // 0 faces +Z, so the heading of a world direction is atan2(x, z).
      const heading = Math.atan2(this.velocity.x, this.velocity.y);
      this.character.turnToward(heading, settings.character.turnRate, dt);
    }

    // Smoothing here rather than in the blend keeps one authority over "how fast
    // is the body moving", which both the legs and any HUD can read.
    this.speed = damp(this.speed, speed, 0.0001, dt);
    this.character.locomotion?.setSpeed(this.speed < config.idleThreshold ? 0 : this.speed);
  }

  /**
   * Fly the body.
   *
   * The same machine as the walk — camera-relative stick, integrated into the
   * same velocity, turned toward where it is going — on three different
   * numbers: faster, looser on both ends of the ramp, and slower to come round.
   * That last one is most of what makes it *feel* like flight rather than like
   * walking at altitude: a body with momentum in the air takes a moment to
   * change its mind, and the bank that arrives with the turn (see
   * `animation/Flight.js`) is drawn off exactly that lag.
   *
   * Two things the walk does are missing, and both are the point of being off
   * the ground: nothing pushes the body out of the enemies it passes over, and
   * the height is not written here at all — `Flight` resolves metres above the
   * terrain and whoever owns the position adds it (see `App#frame`).
   */
  _fly(dt, axis, running) {
    const config = settings.flight;
    const azimuth = this.rig.azimuth;
    const sin = Math.sin(azimuth);
    const cos = Math.cos(azimuth);

    // forward = -(sin, cos), right = (cos, -sin) — the camera basis, as above.
    _desired.set(axis.y * -sin + axis.x * cos, axis.y * -cos + axis.x * -sin);
    _desired.multiplyScalar(config.enabled ? (running ? config.boost : config.speed) : 0);

    const rate = _desired.lengthSq() > 0 ? config.acceleration : config.deceleration;
    _delta.copy(_desired).sub(this.velocity);
    const step = rate * dt;
    if (_delta.length() <= step) this.velocity.copy(_desired);
    else this.velocity.addScaledVector(_delta.normalize(), step);

    const position = this.character.position;
    position.x += this.velocity.x * dt;
    position.z += this.velocity.y * dt;

    const speed = this.velocity.length();
    if (speed > settings.locomotion.idleThreshold) {
      this.character.turnToward(Math.atan2(this.velocity.x, this.velocity.y), config.turnRate, dt);
    }

    this.speed = damp(this.speed, speed, 0.0001, dt);
    // The gait is fully masked by the hover's pose (`Flight#takeover`), so this
    // is only what the blend is left resolving underneath — but it has to stay
    // honest, because the frame the body lands is the frame it comes back.
    this.character.locomotion?.setSpeed(
      this.speed < settings.locomotion.idleThreshold ? 0 : this.speed
    );
  }

  /**
   * Move the body along the jump's arc, and say whether it is still flying.
   *
   * The travel arrives in the *model's* frame, so it is turned by the body's
   * heading on the way out — that is what makes the jump go where the character
   * was facing when it launched, whatever the camera has done since.
   *
   * Neither `velocity` nor `speed` is touched while airborne. Holding them is
   * what carries the run through the landing, and it is also why the gait
   * blending underneath the jump stays on the run clip.
   *
   * @returns {boolean} true while the controls are locked out
   */
  _applyJumpTravel(jump) {
    jump.consumeTravel(_travel);

    if (_travel.x !== 0 || _travel.y !== 0) {
      // Rotate by the root's yaw: the model sits under it unrotated, so this is
      // the same transform its own vertices get.
      const yaw = this.character.root.rotation.y;
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const position = this.character.position;
      position.x += _travel.x * cos + _travel.y * sin;
      position.z += -_travel.x * sin + _travel.y * cos;
    }

    return jump.locked;
  }

  /**
   * Put the body where the kick needs it, and stop it dead.
   *
   * The velocity is cleared rather than damped: the character has planted a
   * foot, and any residual run under the pose would carry it through the target
   * it just stopped in front of. The speed handed to the blend is faded instead
   * of cut, so the gait underneath settles into the idle the kick recovers to.
   */
  _applyAttackWarp(attack, dt) {
    const warp = attack.warp;
    if (warp.active) {
      const position = this.character.position;
      position.x = warp.x;
      position.z = warp.z;
      // `facing` is the one answer to which way the body points, and the
      // character re-reads it every frame — so the turn goes through it.
      settings.character.facing = warp.yaw;
      this.character.setFacing(warp.yaw);
    }

    this.velocity.set(0, 0);
    this.speed = damp(this.speed, 0, 0.0001, dt);
    this.character.locomotion?.setSpeed(0);
  }

  /**
   * Who this swing is for.
   *
   * Nearest first, but only inside the cone: a blow that snaps onto something
   * behind the shoulder is a blow the player did not aim. Each move brings its
   * own range and cone — the slash reaches past what a foot can — and both
   * are live tuning, because "which enemy did I mean" is the single most felt
   * number in a melee system.
   *
   * `null` is now an answer with teeth: it does not mean "swing anyway", it
   * means the move does not happen (see `update`).
   *
   * @param {import('./Attack.js').Attack} attack
   */
  _findAttackTarget(attack) {
    if (!this.enemies) return null;
    const config = attack.config;
    return this.enemies.findTarget(this.character.position, this.character.facing, {
      range: config.range,
      cone: config.cone
    });
  }

  /** Drop the character back on the origin, stationary. */
  reset() {
    this.character.jump?.cancel();
    this.character.hop?.cancel();
    this.character.flight?.cancel();
    for (const move of this.character.attacks ?? []) move.cancel();
    this.velocity.set(0, 0);
    this.speed = 0;
    this.character.position.set(0, 0, 0);
    this.character.locomotion?.setSpeed(0);
  }
}
