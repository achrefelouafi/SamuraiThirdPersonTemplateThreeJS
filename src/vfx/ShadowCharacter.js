import {
  AnimationMixer,
  Group,
  LoopOnce,
  LoopRepeat,
  MathUtils,
  MeshStandardMaterial,
  Vector3
} from 'three';
import { clone as cloneRigged } from 'three/addons/utils/SkeletonUtils.js';

import { settings } from '../config/settings.js';
import { frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';
import { damp } from '../utils/math.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';

const _forward = new Vector3();
const _right = new Vector3();

/** Which sides the summons step out onto. ±1 along the body's own right axis. */
const SIDES = [-1, 1];

/**
 * Metres of tolerance on the arrival test — a millimetre.
 *
 * The last step of the approach is clamped to land the body *exactly* on the
 * standoff, and "exactly" is a float: the distance that comes back out of the
 * next `hypot` sits a hair either side of it, and half the time that hair is on
 * the wrong side. What is left to walk is then smaller than one ULP of the
 * coordinate it would be added to, so the position stops changing without the
 * test ever passing — a shadow running on the spot in front of a body it is
 * already standing at, until the timeout takes it away having killed nothing.
 *
 * A millimetre is nothing against the strike's reach and everything against that
 * loop, and it makes arrival a question the arithmetic cannot answer wrongly.
 */
const ARRIVED = 1e-3;

/**
 * Two shadows of the character, summoned to hunt for it.
 *
 * ## What a shadow is
 *
 * A full clone of the rig — body, armour, weapon, everything hanging off a bone
 * — with every material replaced by one black surface. It is the same silhouette
 * moving through the same frames, which is the whole read: two more of *you*
 * standing where you are not.
 *
 * The clone carries its own skeleton (`SkeletonUtils.clone`), which is what buys
 * the two of them somewhere to stand: a skinned mesh in three's default
 * `attached` bind mode cancels its own world matrix out of the skin, so a clone
 * pointed at the original's bones is welded to it and cannot be offset by so
 * much as a millimetre.
 *
 * ## Its life
 *
 * `V` arms the mark rather than summoning (`combat/TargetMarking.js`); the pair
 * steps out on the last lock, one shadow to each body the player picked. Each
 * runs one errand and it is over:
 *
 *  - **emerge** — born standing *inside* the character in its exact pose (every
 *    cloned node's local transform copied off the node it was cloned from, one
 *    vector copy per joint, so a turn or a gait blend lands on the shadow the
 *    same frame it lands on the body) and slid out to a mark beside it.
 *  - **crouch** — the pose copy stops, its own mixer takes the skeleton over,
 *    and it holds a crouch on that mark for `settings.shadowCharacter.crouch`
 *    seconds. This beat is the point of the whole summon: two things step out of
 *    you, settle, take their mark, and only then move.
 *  - **hunt** — one enemy each, never the same one twice, run down at
 *    `hunt.speed` with the body turning into the chase.
 *  - **strike** — one of the player's own attacks, named by
 *    `strike.move` and thrown with that move's numbers. The run does *not* stop
 *    on the animator's mark: it stops far enough out that the move's own warp
 *    window has ground to cover (`_lunge`), and the warp then carries the body
 *    the rest of the way exactly as `animation/Attack.js` carries the player's —
 *    which is what lets a shadow finish with the slide cut, running the body
 *    down, dropping into the slide and opening it on the way past. The frame the
 *    blow lands is read off the action's own clock, and `onStrike` fells the
 *    body with the striking move's own force.
 *  - **dissolve** — a noise burn up the silhouette, the same device the enemies
 *    die by, in the rim's own violet. Then it is gone, and when the last one
 *    goes `active` clears itself so `V` can send them out again.
 *
 * Because the shadows leave the body, they live in world space under `group`
 * (which belongs to the play stage) rather than under the character's transform.
 *
 * ## How it looks
 *
 * One material per shadow, patched once (see the shader at the bottom of this
 * file): the **dark**, which is just the material's own colour, since a shadow
 * is a silhouette; the **fresnel**, a rim on every grazing angle, which is what
 * stops a black body from reading as a hole in the screen; and the **burn**,
 * which only exists while it is leaving.
 *
 * Everything is read from `settings.shadowCharacter` every frame, so the whole
 * look is live under the editor's "Shadow character" folder while the pair is
 * out there.
 */
export class ShadowCharacter {
  /**
   * @param {import('../animation/CharacterController.js').CharacterController} character
   * @param {object} [options]
   * @param {{heightAt: (x: number, z: number) => number}|null} [options.terrain]
   * @param {import('../combat/EnemyManager.js').EnemyManager|null} [options.enemies]
   * @param {((enemy: object, dirX: number, dirZ: number, force: object) => void)|null} [options.onStrike]
   *   The frame a shadow's blow lands, with the settings block of the move that
   *   threw it — a boot and a blade do different things to a body, and which
   *   one this was is the striker's to say. Like `Attack`, this class knows when
   *   the blow connects and nothing about what being hit means.
   */
  constructor(character, { terrain = null, enemies = null, onStrike = null } = {}) {
    this.character = character;
    this.terrain = terrain;
    this.enemies = enemies;
    this.onStrike = onStrike;

    /** Everything they are is under here, in world space. Add it to the scene. */
    this.group = new Group();
    this.group.name = 'ShadowCharacters';

    /** @type {Shadow[]} the summons themselves, in whatever state they are in. */
    this.shadows = [];

    /** Whether a summon is currently on the field — the edge `V` is read on. */
    this._summoned = false;

    /**
     * The bodies the player marked, one per shadow in the order they were
     * locked — see `combat/TargetMarking.js`.
     *
     * Empty for a summon that came from the editor's own checkbox, which is
     * exactly the fallback: with nothing assigned every shadow picks the
     * nearest body it can have, which is what the pair did before there was
     * anything to mark.
     * @type {import('../combat/Enemy.js').Enemy[]}
     */
    this._assigned = [];
  }

  /** Whether the pair is out. The flag lives in settings, so presets keep it. */
  get active() {
    return settings.shadowCharacter.active === true;
  }

  /**
   * The marks the pair is on its way to, for as long as it is on its way.
   *
   * The marker over a body's head is drawn from this while the hunt runs, so a
   * lock the player took stays on the body it was taken on until the shadow
   * that was sent for it gets there.
   */
  get assignments() {
    return this._assigned;
  }

  /**
   * Send them out, at bodies that have already been chosen.
   *
   * @param {Iterable<import('../combat/Enemy.js').Enemy>} [targets] one per
   *   shadow, in order. Any shadow past the end of the list — or one whose mark
   *   is felled before it arrives — takes the nearest body instead.
   */
  summon(targets = null) {
    this._assigned = targets ? Array.from(targets) : [];
    settings.shadowCharacter.active = true;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Call it after the character has been posed for the frame: a shadow still
   * emerging copies the pose that is about to be drawn rather than the last one.
   *
   * @param {number} dt Seconds since the last frame, on the *simulation's* clock
   *   — the hunt is combat, so it slows with the hit-stop and stops with `P`.
   */
  update(dt = 0) {
    const config = settings.shadowCharacter;

    if (!this.character.model) {
      if (this.shadows.length) this.clear();
      this._summoned = false;
      return;
    }

    // `V`, either way round. A summon while they are already out burns them
    // away early rather than queueing a second pair.
    if (config.active && !this._summoned) this._summon();
    else if (!config.active && this._summoned) this.dismiss();

    if (!this.shadows.length) return;

    // Gear is equipped and unequipped while the shadows are standing there, and
    // a clone is a snapshot of the tree. Only worth rebuilding while they are
    // still copying the body: past that they are their own bodies, and throwing
    // one away mid-hunt would cost it its target and its place on the field.
    if (this._emerging() && this._stale()) {
      this._summon();
      if (!this.shadows.length) return;
    }

    for (const shadow of this.shadows) this._advance(shadow, config, dt);

    for (let i = this.shadows.length - 1; i >= 0; i--) {
      if (this.shadows[i].state !== 'gone') continue;
      this._release(this.shadows[i]);
      this.shadows.splice(i, 1);
    }

    // The last one burned away: the summon is spent, and `V` is armed again.
    // Written back into settings because that flag is the one answer to whether
    // the pair is out — the editor's checkbox listens to it.
    if (!this.shadows.length) {
      this._summoned = false;
      settings.shadowCharacter.active = false;
      // The marks went out with them: nothing is on its way anywhere, so the
      // markers over those heads have nothing left to draw.
      this._assigned.length = 0;
    }
  }

  /**
   * Send everyone away, wherever they had got to, and disarm the flag so `V` is
   * a fresh summon rather than a re-entry.
   *
   * @param {{immediate?: boolean}} [options] `immediate` drops them on the spot
   *   instead of burning them away — for leaving the stage, where the burn
   *   would only be paused halfway through and resumed on the way back.
   */
  dismiss({ immediate = false } = {}) {
    if (immediate) {
      this.clear();
    } else {
      for (const shadow of this.shadows) {
        if (shadow.state !== 'dissolve') this._enter(shadow, 'dissolve');
      }
    }
    this._summoned = false;
    settings.shadowCharacter.active = false;
    this._assigned.length = 0;
  }

  /** Drop every clone and its GPU-side skeleton, immediately. */
  clear() {
    for (const shadow of this.shadows) this._release(shadow);
    this.shadows.length = 0;
    this._summoned = false;
  }

  dispose() {
    this.clear();
    this.group.parent?.remove(this.group);
  }

  /* ------------------------------------------------------------------ */
  /* the summon                                                          */
  /* ------------------------------------------------------------------ */

  /** Build (or rebuild) both clones off whatever is currently on the body. */
  _summon() {
    this.clear();

    const model = this.character.model;
    if (!model) return;

    // The mark goes with the *side*, not with the position in the array, so a
    // rebuild mid-emerge (`_stale`) hands the same shadow the same body back.
    for (const [index, side] of SIDES.entries()) {
      const shadow = this._build(side);
      if (!shadow) continue;
      shadow.assigned = this._assigned[index] ?? null;
      this.shadows.push(shadow);
    }
    this._summoned = this.shadows.length > 0;
  }

  /**
   * One clone, dressed, rigged to its own mixer and put on its mark.
   *
   * The clone hangs under a pivot rather than being placed directly: the pivot
   * is the shadow's *body* — where it stands and which way it faces — and the
   * clone under it keeps the model's own normalisation onto y = 0, so the feet
   * stay on the floor at any `scale`.
   *
   * @param {number} side
   */
  _build(side) {
    const character = this.character;
    const model = character.model;
    const root = cloneRigged(model);
    root.name = `ShadowCharacter${side < 0 ? 'Left' : 'Right'}`;

    // Lockstep with the original: `Object3D.clone` copies children in order, so
    // walking the two trees together pairs every node with its source.
    const sources = [];
    const nodes = [];
    parallelTraverse(model, root, (source, node) => {
      if (source === model) return; // the root is placed by hand, not copied
      sources.push(source);
      nodes.push(node);
    });

    const uniforms = this._makeUniforms();
    const materials = {
      // Two instances of one material, differing in nothing but which meshes
      // they are put on. A material used by both a skinned and an unskinned mesh
      // forces three to re-resolve its program on every draw call (it keys
      // `USE_SKINNING` off the object, not the material).
      skinned: this._createMaterial(`ShadowCharacter${side}:skinned`, uniforms),
      static: this._createMaterial(`ShadowCharacter${side}:static`, uniforms)
    };

    // The fire's own furniture came along with the weapon. The volume is a hull
    // marched in the *real* blade's frame and the wireframe is an editing aid;
    // neither belongs to a shadow.
    const cut = [];
    root.traverse((node) => {
      if (node.name === 'FireEmitterBox' || node.userData.isFireVolume) {
        cut.push(node);
        return;
      }
      if (!node.isMesh && !node.isSkinnedMesh) return;
      node.material = node.isSkinnedMesh ? materials.skinned : materials.static;
      node.castShadow = true;
      // Nothing is gained by a black surface receiving a shadow, and the contact
      // pass is aimed at the character.
      node.receiveShadow = false;
      // A shadow running across the field leaves the bounds the mesh was
      // authored with — and its own skeleton — far behind.
      node.frustumCulled = false;
      node.layers.set(LAYER.WORLD);
      // Clicks in the character screen belong to the gear on the real body.
      node.raycast = () => {};
    });

    // What the body's tree looked like when it was cloned. Recorded before the
    // cut, so it can be compared against the live tree without re-deciding which
    // nodes the cut would have taken.
    const census = new Set(sources);

    const dropped = new Set();
    for (const node of cut) {
      node.traverse((child) => dropped.add(child));
      node.parent?.remove(node);
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (!dropped.has(nodes[i])) continue;
      nodes.splice(i, 1);
      sources.splice(i, 1);
    }

    const pivot = new Group();
    pivot.name = `${root.name}Pivot`;
    pivot.add(root);
    this.group.add(pivot);

    // Its own mixer, bound to its own skeleton, playing the clips the character
    // retargeted onto *this* rig — the clone shares its joint names, so a clip
    // lifted onto the body plays on the shadow untouched.
    const mixer = new AnimationMixer(root);
    // Every attack the body has, not only the one `strike.move` currently names:
    // the move is a live setting, and a shadow that was built before it changed
    // must still be able to throw whatever it is now.
    const actions = {
      crouch: this._action(mixer, character.clips.get('crouch')),
      run: this._action(mixer, character.clips.get('run')),
      kick: this._action(mixer, character.clips.get('kick')),
      slashHit: this._action(mixer, character.clips.get('slashHit')),
      crouchSlash: this._action(mixer, character.clips.get('crouchSlash'))
    };
    if (!actions.crouch) {
      console.warn('[ShadowCharacter] no crouch clip — the pair will hunt without settling');
    }
    const wanted = settings.shadowCharacter.strike.move;
    if (!actions[wanted]) {
      console.warn(`[ShadowCharacter] no ${wanted} clip — the pair will finish with whatever it has`);
    }

    const position = this.character.position;
    return {
      side,
      pivot,
      model: root,
      sources,
      nodes,
      census,
      mixer,
      actions,
      materials: [materials.skinned, materials.static],
      uniforms,
      /** Where it is going, in world space. Resolved on the frame it is built. */
      mark: new Vector3(position.x, position.y, position.z),
      /** Heading, radians about world +Y, on the same convention as the player. */
      facing: this.character.facing,
      state: 'emerge',
      /** Seconds in the current state. */
      timer: 0,
      /**
       * The body the *player* marked for this one, if there was one. Written by
       * `_summon`; only `_claim` ever reads it.
       * @type {import('../combat/Enemy.js').Enemy|null}
       */
      assigned: null,
      /** @type {import('../combat/Enemy.js').Enemy|null} */
      target: null,
      /**
       * Which move it is throwing, as a key in `settings` — resolved on the
       * frame it enters the strike and read by nothing before then.
       * @type {string|null}
       */
      strike: null,
      /**
       * The ground the strike covers: where the body was when the move started,
       * the spot the clip wants it on at contact, and the spot on the far side
       * a pass-through finishes at. The same three points `Attack` resolves for
       * the player, resolved once at the same moment — see `_resolveStrikeWarp`.
       */
      warp: {
        active: false,
        from: { x: 0, z: 0, yaw: 0 },
        to: { x: 0, z: 0, yaw: 0 },
        past: { x: 0, z: 0 },
        /** The approach's speed against its own average — see `_resolveStrikeWarp`. */
        pace: 1
      },
      _struck: false
    };
  }

  /** One clip → one action, or null if the character never loaded it. */
  _action(mixer, clip) {
    if (!clip) return null;
    const action = mixer.clipAction(clip);
    action.enabled = false;
    action.setEffectiveWeight(0);
    return action;
  }

  /** Give back one shadow's skeleton and materials. Geometry is shared; it stays. */
  _release(shadow) {
    shadow.mixer.stopAllAction();
    shadow.pivot.parent?.remove(shadow.pivot);
    shadow.pivot.traverse((node) => {
      if (node.isSkinnedMesh) node.skeleton?.dispose();
    });
    for (const material of shadow.materials) material.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* the errand                                                          */
  /* ------------------------------------------------------------------ */

  /** One shadow, one frame. */
  _advance(shadow, config, dt) {
    this._syncMaterial(shadow, config);
    this._placeModel(shadow, config);

    shadow.timer += dt;

    switch (shadow.state) {
      case 'emerge':
        this._emerge(shadow, config, dt);
        break;
      case 'crouch':
        this._crouch(shadow, config, dt);
        break;
      case 'hunt':
        this._hunt(shadow, config, dt);
        break;
      case 'strike':
        this._strike(shadow, config, dt);
        break;
      case 'dissolve':
        this._dissolve(shadow, config, dt);
        break;
      default:
        break;
    }

    if (shadow.state !== 'emerge') {
      shadow.mixer.timeScale = settings.global.animationSpeed;
      shadow.mixer.update(dt);
    }
    shadow.pivot.rotation.y = shadow.facing - this._forwardYaw();
    this._stand(shadow);
  }

  /**
   * Step out of the body.
   *
   * The clone is posed off the character joint by joint and slid from wherever
   * the body is *now* onto its mark, so a player who runs during the summon
   * drags the birth along with them instead of leaving it behind. The mark is
   * fixed in the world the frame the summon lands — that is the ground it will
   * crouch on.
   */
  _emerge(shadow, config, dt) {
    const character = this.character;
    const position = character.position;

    // Sideways and back in the *body's* own frame, so the pair flanks the
    // character through every turn instead of swinging around it. 0 faces +Z,
    // which is what makes the heading's forward `(sin, cos)`.
    const facing = character.facing;
    _forward.set(Math.sin(facing), 0, Math.cos(facing));
    _right.set(Math.cos(facing), 0, -Math.sin(facing));

    shadow.mark
      .copy(position)
      .addScaledVector(_right, shadow.side * config.offset)
      .addScaledVector(_forward, -config.back);

    const t = MathUtils.clamp(shadow.timer / Math.max(config.emerge, 1e-3), 0, 1);
    // Fast off the body, then a settle onto the mark. A linear slide reads as
    // two models being dragged apart; front-loading it is what makes it read as
    // something stepping *out* of the character.
    const step = easeOut(t);

    shadow.facing = facing;
    shadow.pivot.position.lerpVectors(position, shadow.mark, step);

    // The pose, joint by joint — the skeleton, the mounts the gear hangs off and
    // any placement the editor moved this frame.
    const nodes = shadow.nodes;
    const sources = shadow.sources;
    for (let i = 0; i < nodes.length; i++) {
      const source = sources[i];
      const node = nodes[i];
      node.position.copy(source.position);
      node.quaternion.copy(source.quaternion);
      node.scale.copy(source.scale);
      node.visible = source.visible;
    }

    if (t >= 1) this._enter(shadow, 'crouch');
  }

  /**
   * Settle on the mark.
   *
   * The crossfade out of the copied pose is three's own: the crouch fades in
   * from the values its bindings were holding when the action went live, which
   * are the character's last copied pose. There is nothing to blend *from*
   * because the pose is continuous by construction.
   */
  _crouch(shadow, config, dt) {
    if (shadow.timer < Math.max(0, config.crouch)) return;
    // A target is chosen at the end of the beat rather than the start, so the
    // pair leaves the crouch aimed at who is actually still standing.
    this._claim(shadow);
    this._enter(shadow, shadow.target ? 'hunt' : 'dissolve');
  }

  /**
   * Run it down.
   *
   * ## Where it steps, and where it looks, are two different questions
   *
   * They are answered separately here, and that separation is the whole of why
   * this arrives. The step is taken **straight at the body**; the heading only
   * damps toward the same line, and nothing but the pose reads it.
   *
   * Driving the body along its own damped heading is the obvious thing to write
   * and it does not converge. It is a pursuit curve: the closer the chase gets,
   * the faster the heading has to turn to keep the target dead ahead — the
   * demand grows as `speed / distance` — and past some radius it outruns
   * whatever the damping can deliver. The shadow then settles into a stable
   * orbit a hair outside the strike radius and runs rings around an enemy it has
   * already reached, for as long as the timeout allows. No turn rate fixes that;
   * a faster turn only tightens the orbit, and tuning one is a fix that lasts
   * until someone moves a number.
   *
   * Aiming the step instead makes arrival a property of the algorithm: the
   * distance falls by exactly the step every frame, so the body is at the
   * standoff in `distance / speed` seconds and the geometry has no say in it.
   * The heading is then free to lag as far behind as it likes, which is what
   * still gives the approach its curve — the body visibly turns into the run
   * while it travels — without the lag ever being able to cost it the kill.
   *
   * It is the same split `ThirdPersonController` makes: movement resolves
   * against the stick, `turnToward` handles the body, and the player cannot
   * orbit anything either.
   */
  _hunt(shadow, config, dt) {
    const hunt = config.hunt;

    const key = this._strikeMove(shadow);
    if (!key) {
      // Nothing to finish with — the body never loaded an attack this rig can
      // play. Warned about at the summon; there is no errand to run.
      this._enter(shadow, 'dissolve');
      return;
    }

    // The target may have been felled by the player, or by the other shadow,
    // between one frame and the next. A fresh body is a fresh chase, so the
    // clock goes back to zero with it — otherwise a shadow that loses two
    // targets to the player times out and leaves having killed nothing, which
    // is the one thing a summon must never do.
    if (!shadow.target?.alive) {
      this._claim(shadow);
      if (shadow.target) shadow.timer = 0;
    }
    if (!shadow.target || shadow.timer > hunt.timeout) {
      // The only path on which a summon leaves without a kill. It is a real
      // outcome (nothing left standing to run at), but it is also where a
      // chase that cannot close would end up, so it says which it was.
      if (shadow.target) {
        console.warn(
          `[ShadowCharacter] gave up after ${hunt.timeout}s — ` +
            `still ${Math.hypot(
              shadow.target.position.x - shadow.pivot.position.x,
              shadow.target.position.z - shadow.pivot.position.z
            ).toFixed(1)}m short of its target`
        );
      }
      this._enter(shadow, 'dissolve');
      return;
    }

    const position = shadow.pivot.position;
    const dx = shadow.target.position.x - position.x;
    const dz = shadow.target.position.z - position.z;
    const distance = Math.hypot(dx, dz);

    // Where the run ends and the move begins. Not the animator's mark: the
    // move's own warp window is authored as travel (for the slide cut it *is*
    // the move), so the run has to hand over that much ground short of it or
    // the body slides on the spot. See `_lunge`.
    const standoff = settings[key].standoff + hunt.slack + this._lunge(shadow, key);
    if (distance - standoff <= ARRIVED) {
      this._enter(shadow, 'strike');
      return;
    }

    /* ---- where it steps ---- */
    // Straight at the body, and never past the break-in distance in one frame:
    // the last step of the run lands it exactly where the move wants to start.
    const step = Math.min(hunt.speed * dt, distance - standoff);
    position.x += (dx / distance) * step;
    position.z += (dz / distance) * step;

    /* ---- where it looks ---- */
    // 0 faces +Z, so the heading of a world direction is atan2(x, z), taken the
    // shortest way round — a target behind the shoulder must not spin the body
    // the long way to reach it. Nothing but the pose reads this.
    const wanted = Math.atan2(dx, dz);
    const delta = MathUtils.euclideanModulo(wanted - shadow.facing + Math.PI, Math.PI * 2) - Math.PI;
    shadow.facing = damp(shadow.facing, shadow.facing + delta, hunt.turnRate, dt);

    // The same division that keeps the player's feet planted (see
    // `animation/Locomotion.js`): the clip's authored pace against the real one.
    const gait = settings.locomotion;
    const stride = MathUtils.clamp(
      (hunt.speed / Math.max(0.01, gait.clipRunSpeed)) * gait.runAnimSpeed,
      gait.strideMin,
      gait.strideMax
    );
    shadow.actions.run?.setEffectiveTimeScale(stride);
  }

  /**
   * The finisher, read off the action's own clock so the frame the blow lands is
   * the frame that is actually on screen.
   *
   * Whichever of the player's moves `strike.move` names, thrown on that move's
   * own numbers and warped onto the body the same way the player's is. The
   * reach test is taken at contact rather than trusted from the approach: the
   * body may have died to something else on the way in, and a blow that
   * connects with a corpse it never reached is worse than one that misses.
   */
  _strike(shadow, config, dt) {
    const key = shadow.strike;
    const action = key ? shadow.actions[key] : null;
    if (!action) {
      this._enter(shadow, 'dissolve');
      return;
    }

    const move = settings[key];
    const duration = action.getClip().duration;
    const phase = duration > 0 ? MathUtils.clamp(action.time / duration, 0, 1) : 1;

    this._advanceStrikeWarp(shadow, phase, move);

    const target = shadow.target;
    // Nothing to warp onto — a body that died between the run and the swing.
    // The pose is all that is left, so it keeps facing where it was going.
    if (!shadow.warp.active && target && !shadow._struck) {
      const dx = target.position.x - shadow.pivot.position.x;
      const dz = target.position.z - shadow.pivot.position.z;
      if (dx * dx + dz * dz > 1e-6) {
        const wanted = Math.atan2(dx, dz);
        const delta =
          MathUtils.euclideanModulo(wanted - shadow.facing + Math.PI, Math.PI * 2) - Math.PI;
        shadow.facing = damp(shadow.facing, shadow.facing + delta, config.hunt.turnRate, dt);
      }
    }

    if (!shadow._struck && phase >= move.hitAt) {
      shadow._struck = true;
      shadow.target = null;
      const victim = this._victim(shadow, target, move);
      // The blow goes where the body is *pointing* — after the approach those
      // agree, and the pose is the truth when they do not. The move's own block
      // goes with it: what a shadow's blade does to a body is what the player's
      // does, down to whether it comes apart.
      if (victim) this.onStrike?.(victim, Math.sin(shadow.facing), Math.cos(shadow.facing), move);
    }

    // One blow each. Past the recovery there is nothing left for it to do, so it
    // leaves on the follow-through rather than standing about — for the slide
    // cut that is the frame it stands back up on the far side of what it opened.
    if (phase >= move.recoverAt) this._enter(shadow, 'dissolve');
  }

  /**
   * Which move this shadow finishes with — the one `strike.move` names, if the
   * rig actually loaded its clip and settings carry a block for it, and the kick
   * otherwise. Re-asked rather than stored, so switching moves in the editor
   * lands on a pair that is already out there.
   *
   * @returns {string|null} a key into `settings`, or null if it has no attack
   */
  _strikeMove(shadow) {
    const wanted = settings.shadowCharacter.strike.move;
    // `hitAt` is what makes a settings block an attack rather than, say, the
    // number of seconds the pair crouches for.
    if (shadow.actions[wanted] && settings[wanted]?.hitAt != null) return wanted;
    return shadow.actions.kick ? 'kick' : null;
  }

  /**
   * Metres short of the animator's mark the run hands over to the move.
   *
   * A move's warp window is not dead time — it is the frames the clip spends
   * travelling, and for the slide cut it is the whole move: a run into a drop
   * into a slide. Stopping the run on the mark and playing that would be a body
   * sliding on the spot in front of an enemy.
   *
   * So the ground is measured out of the clip instead: the seconds the window
   * lasts at the pace the move is played, times the speed the shadow is already
   * running at. At `strike.lead` 1 that is the distance the run would have
   * covered in the same time, so the hand-over is seamless — the body does not
   * slow down, it drops into the slide at exactly the speed it arrived at.
   *
   * Halved for a move that *stops* on its mark rather than passing through it:
   * a body decelerating from the run to a standstill covers half the ground the
   * same seconds at the same speed would. That is what puts the kick's plant on
   * the mark instead of skidding through it.
   *
   * Capped by the move's own `maxWarp`, which is the same ceiling the player's
   * warp is held to.
   */
  _lunge(shadow, key) {
    const move = settings[key];
    const window = this._warpWindow(shadow, key);
    if (!move || window <= 0) return 0;

    const config = settings.shadowCharacter;
    const lead = Math.max(0, config.strike.lead);
    const brake = move.passThrough > 0 ? 1 : 0.5;
    return Math.min(config.hunt.speed * lead * window * brake, move.maxWarp);
  }

  /** Seconds the move spends travelling, at the pace it is actually played. */
  _warpWindow(shadow, key) {
    const action = shadow.actions[key];
    const move = settings[key];
    if (!action || !move) return 0;
    const duration = action.getClip().duration / Math.max(0.01, move.timeScale ?? 1);
    return duration * MathUtils.clamp(move.warpAt, 0, 1);
  }

  /**
   * Where the strike has to end up — resolved once, on the frame it starts.
   *
   * The same three points `Attack._resolveWarp` resolves for the player, for the
   * same reasons: the contact mark is `standoff` short of the body, the turn is
   * onto the line between the two, and a move with `passThrough` carries on to a
   * third point on the far side rather than stopping in front of what it cut.
   *
   * A target already inside the standoff moves the body nowhere — backing away
   * to make room for an animation is the tell that gives motion warping away.
   *
   * The fourth thing resolved here is the *pace* of the approach, and it is the
   * one the player has no need of: what the body is already doing, against what
   * the leg actually has to cover. At 1 they agree and the leg is travelled at a
   * constant speed; above 1 the leg is shorter than the run would have covered,
   * so the body brakes into the move; below it, it accelerates. This is what
   * makes a shadow that broke into the cut from four metres out read as
   * dropping into it, and one that broke in from ten as diving.
   */
  _resolveStrikeWarp(shadow, key) {
    const move = settings[key];
    const warp = shadow.warp;
    const position = shadow.pivot.position;

    warp.active = false;
    warp.from.x = position.x;
    warp.from.z = position.z;
    warp.from.yaw = shadow.facing;

    const target = shadow.target;
    if (!target) return;

    const dx = target.position.x - position.x;
    const dz = target.position.z - position.z;
    const distance = Math.hypot(dx, dz);

    // 0 faces +Z, so the heading of a world direction is atan2(x, z).
    warp.to.yaw = distance > 1e-4 ? Math.atan2(dx, dz) : warp.from.yaw;

    const step = MathUtils.clamp(distance - move.standoff, 0, move.maxWarp);
    const k = distance > 1e-4 ? step / distance : 0;
    warp.to.x = position.x + dx * k;
    warp.to.z = position.z + dz * k;

    const beyond = move.passThrough > 0 ? move.standoff + move.passThrough : 0;
    const ux = distance > 1e-4 ? dx / distance : Math.sin(warp.to.yaw);
    const uz = distance > 1e-4 ? dz / distance : Math.cos(warp.to.yaw);
    warp.past.x = warp.to.x + ux * beyond;
    warp.past.z = warp.to.z + uz * beyond;

    // Clamped to 2, which is a body coming to a dead stop on the mark: past it
    // the leg would have to travel backwards to lose the speed in time.
    const window = this._warpWindow(shadow, key);
    const leg = Math.hypot(warp.to.x - warp.from.x, warp.to.z - warp.from.z);
    warp.pace =
      leg > 1e-4 && window > 1e-4
        ? MathUtils.clamp((settings.shadowCharacter.hunt.speed * window) / leg, 0, 2)
        : 1;

    warp.active = true;
  }

  /**
   * Carry the body along that line for this frame.
   *
   * The player's version of this eases off a standing pose (`smootherstep`);
   * this one must not, because a shadow arrives at a **run** and a body that
   * stalls for a frame between the last stride and the slide is the one thing
   * that would give the whole move away. So the approach leg leaves at whatever
   * the chase was doing (`warp.pace`, resolved above) and spends the rest of the
   * window making up the difference — one straight line through velocity, which
   * is a quadratic through position. At pace 1 it is exactly the run continuing.
   * Only the pass — the far side, once the blade is through — eases off,
   * coasting the body to a stop as it stands back up.
   *
   * The turn is the player's, unchanged: onto the line, finished within
   * `turnAt` of the window, so the body is pointed down the cut before it has
   * gone far along it.
   */
  _advanceStrikeWarp(shadow, phase, move) {
    const warp = shadow.warp;
    if (!warp.active) return;

    const { from, to, past } = warp;
    const position = shadow.pivot.position;
    const warpAt = Math.max(0.01, move.warpAt);
    const t = MathUtils.clamp(phase / warpAt, 0, 1);

    if (move.passThrough > 0 && phase > warpAt) {
      const passAt = Math.max(warpAt + 0.01, move.passAt ?? 1);
      const u = MathUtils.clamp((phase - warpAt) / (passAt - warpAt), 0, 1);
      const through = 1 - (1 - u) * (1 - u); // through, and coasting to a stop
      position.x = to.x + (past.x - to.x) * through;
      position.z = to.z + (past.z - to.z) * through;
    } else {
      const pace = warp.pace;
      const along = pace * t + (1 - pace) * t * t;
      position.x = from.x + (to.x - from.x) * along;
      position.z = from.z + (to.z - from.z) * along;
    }

    // Shortest way round, so a target that ended up behind the shoulder does not
    // spin the body the long way to reach it.
    const turn = smootherstep(MathUtils.clamp(t / Math.max(0.05, move.turnAt), 0, 1));
    const delta = MathUtils.euclideanModulo(to.yaw - from.yaw + Math.PI, Math.PI * 2) - Math.PI;
    shadow.facing = from.yaw + delta * turn;
  }

  /** Burn away. The uniform is this body's own, so each one has its own clock. */
  _dissolve(shadow, config, dt) {
    const t = shadow.timer / Math.max(0.05, config.dissolve.time);
    shadow.uniforms.uDissolve.value = Math.min(1, t);
    if (t >= 1) shadow.state = 'gone';
  }

  /**
   * Move one shadow into a state, and start whatever it plays there.
   *
   * Every transition goes through here, so the clock and the clip can never
   * disagree about which state the body is in.
   */
  _enter(shadow, state) {
    shadow.state = state;
    shadow.timer = 0;

    switch (state) {
      case 'crouch':
        this._play(shadow, 'crouch', { fade: 0.22 });
        break;
      case 'hunt':
        this._play(shadow, 'run', { fade: 0.2 });
        break;
      case 'strike': {
        // The move is picked here and nowhere else, so the warp, the clip and
        // the contact can never be reading three different moves' numbers.
        const key = this._strikeMove(shadow);
        shadow.strike = key;
        shadow._struck = false;
        shadow.warp.active = false;
        const move = key ? settings[key] : null;
        if (!move) break;
        this._resolveStrikeWarp(shadow, key);
        this._play(shadow, key, {
          fade: move.blendIn,
          loop: LoopOnce,
          timeScale: move.timeScale ?? 1
        });
        break;
      }
      case 'dissolve':
        shadow.warp.active = false;
        shadow.target = null;
        // The depth pass has no idea the body is being cut away, so it would go
        // on casting a whole shadow off a silhouette that is half gone.
        shadow.pivot.traverse((node) => {
          if (node.isMesh || node.isSkinnedMesh) node.castShadow = false;
        });
        break;
      default:
        break;
    }
  }

  /** Play one of a shadow's actions, fading whatever else it was doing out. */
  _play(shadow, key, { fade = 0.2, loop = LoopRepeat, timeScale = 1 } = {}) {
    const action = shadow.actions[key];
    if (!action) return null;

    for (const name of Object.keys(shadow.actions)) {
      const other = shadow.actions[name];
      if (name === key || !other || !other.isRunning()) continue;
      other.fadeOut(fade);
    }

    action.reset();
    action.enabled = true;
    action.setLoop(loop, loop === LoopOnce ? 1 : Infinity);
    // Hold the last frame while it blends out, rather than snapping to the first.
    action.clampWhenFinished = loop === LoopOnce;
    action.setEffectiveTimeScale(timeScale);
    action.setEffectiveWeight(1);
    action.fadeIn(Math.max(fade, 1e-3));
    action.play();
    return action;
  }

  /**
   * Who the foot actually lands on.
   *
   * The body it was aimed at, if it is still standing and still in reach — and
   * otherwise whoever *is* standing in front of it within `reach`. The lock is
   * taken at the crouch and the blow lands seconds later; in between the player
   * can fell it, and a blow swinging through the space where a corpse used to
   * be while a live body stands a metre to the side is the whiff this exists to
   * prevent.
   *
   * "In front of" is the move's own question. A kick lands on what the foot is
   * pointed at, but a pass-through cut is thrown at a body the shadow is drawing
   * *level* with — by `hitAt` it is already alongside, so demanding the victim be
   * ahead of the shoulders would reject the only body the move could ever hit.
   */
  _victim(shadow, preferred, move) {
    const position = shadow.pivot.position;
    const reach = move.reach;
    // Ahead of the foot, or anywhere but behind the heel for a cut in passing.
    const ahead = move.passThrough > 0 ? -0.35 : 0.2;

    if (preferred?.alive) {
      const dx = preferred.position.x - position.x;
      const dz = preferred.position.z - position.z;
      if (Math.hypot(dx, dz) <= reach) return preferred;
    }

    if (!this.enemies) return null;

    const fx = Math.sin(shadow.facing);
    const fz = Math.cos(shadow.facing);
    let best = null;
    let bestDistance = reach;

    for (const enemy of this.enemies.enemies) {
      if (!enemy.alive) continue;
      const dx = enemy.position.x - position.x;
      const dz = enemy.position.z - position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > bestDistance) continue;
      if (distance > 1e-3 && (dx * fx + dz * fz) / distance < ahead) continue;
      bestDistance = distance;
      best = enemy;
    }

    return best;
  }

  /**
   * Pick a body for this shadow — the one the player marked for it, or failing
   * that the nearest one standing that the other is not already running at.
   *
   * The mark comes first because it is the whole point of the summon: the
   * player looked at a body and clicked on it, and a pair that then ran at
   * whoever happened to be closest would make the choice a decoration.
   *
   * The fallback is not a courtesy either. A mark can be felled by the player,
   * or by the other shadow, in the seconds between the click and the crouch
   * ending — and this is re-asked on every one of those frames (see `_hunt`),
   * so a summon spent on a body that is already down never happens. Two shadows
   * converging on one enemy is the other thing it prevents, and it is why this
   * is not simply `findTarget`.
   */
  _claim(shadow) {
    shadow.target = null;
    if (!this.enemies) return;

    const taken = new Set();
    for (const other of this.shadows) {
      if (other !== shadow && other.target) taken.add(other.target);
    }

    const mark = shadow.assigned;
    if (mark?.alive && !taken.has(mark)) {
      shadow.target = mark;
      return;
    }

    const position = shadow.pivot.position;
    let best = null;
    let bestDistance = Infinity;
    for (const enemy of this.enemies.enemies) {
      if (!enemy.alive || taken.has(enemy)) continue;
      const dx = enemy.position.x - position.x;
      const dz = enemy.position.z - position.z;
      const distance = dx * dx + dz * dz;
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = enemy;
    }

    shadow.target = best;
  }

  /* ------------------------------------------------------------------ */
  /* placement                                                           */
  /* ------------------------------------------------------------------ */

  /** Yaw of the rig's own forward in model space — the pivot subtracts it. */
  _forwardYaw() {
    const axis = this.character.forwardAxis;
    return Math.atan2(axis.x, axis.z);
  }

  /**
   * The model's own normalisation onto y = 0, scaled by `config.scale`.
   *
   * Re-read every frame rather than baked in at the summon, because
   * `targetHeight` is a live control and the feet have to stay on the floor
   * while it moves.
   */
  _placeModel(shadow, config) {
    const model = this.character.model;
    const scale = Math.max(config.scale, 0.05);
    shadow.model.position.copy(model.position).multiplyScalar(scale);
    shadow.model.quaternion.copy(model.quaternion);
    shadow.model.scale.copy(model.scale).multiplyScalar(scale);
  }

  /** Drop it on the height field, wherever this frame left it. */
  _stand(shadow) {
    if (!this.terrain) return;
    const position = shadow.pivot.position;
    position.y = this.terrain.heightAt(position.x, position.z);
  }

  /** Whether every shadow is still copying the body. */
  _emerging() {
    return this.shadows.every((shadow) => shadow.state === 'emerge');
  }

  /**
   * Whether the body has nodes the clones do not, or the other way round.
   *
   * Equipping and unequipping rearranges the tree under the rig, and a clone is
   * a snapshot of it. Comparing membership rather than a count catches a swap
   * that happens to leave the same number of nodes behind.
   */
  _stale() {
    const shadow = this.shadows[0];
    if (!shadow) return true;

    const census = shadow.census;
    let count = 0;
    let known = true;
    const model = this.character.model;
    model.traverse((node) => {
      if (node === model) return;
      count++;
      if (!census.has(node)) known = false;
    });
    return !known || count !== census.size;
  }

  /* ------------------------------------------------------------------ */
  /* the look                                                            */
  /* ------------------------------------------------------------------ */

  /** One shadow's own uniforms. The burn is per body, so nothing here is shared. */
  _makeUniforms() {
    const config = settings.shadowCharacter;
    const scale = this.character.modelScale || 1;
    return {
      uFresnelColor: { value: makeColor(config.fresnel.color) },
      uFresnelPower: { value: config.fresnel.power },
      uFresnelEmissive: { value: config.fresnel.emissive },
      // The frame's exposure, by identity — the rim divides itself by it so the
      // colour survives the trip between the two stages' grades. See the note on
      // the shader at the bottom of this file.
      uExposure: frame.uExposure,

      uDissolve: { value: 0 },
      uNoiseScale: { value: config.dissolve.detail * scale },
      // The body's height in the *model's* own space, which is what the vertex
      // patch hands the burn — the metres it stands at divided by the metres one
      // of its own units is worth.
      uModelHeight: { value: Math.max(1e-3, this.character.height / Math.max(scale, 1e-6)) },
      uRise: { value: config.dissolve.rise },
      uEdgeColor: { value: makeColor(config.dissolve.edgeColor) },
      uEdgeEmissive: { value: config.dissolve.edgeEmissive },
      uEdgeWidth: { value: config.dissolve.edgeWidth }
    };
  }

  /** Settings → one shadow's materials and uniforms, live. */
  _syncMaterial(shadow, config) {
    const u = shadow.uniforms;

    for (const material of shadow.materials) {
      copyColor(material.color, config.color);
      material.roughness = config.roughness;
      material.metalness = config.metalness;
    }

    copyColor(u.uFresnelColor.value, config.fresnel.color);
    u.uFresnelPower.value = config.fresnel.power;
    u.uFresnelEmissive.value = config.fresnel.emissive;

    const dissolve = config.dissolve;
    u.uNoiseScale.value = dissolve.detail * (this.character.modelScale || 1);
    u.uRise.value = dissolve.rise;
    copyColor(u.uEdgeColor.value, dissolve.edgeColor);
    u.uEdgeEmissive.value = dissolve.edgeEmissive;
    u.uEdgeWidth.value = dissolve.edgeWidth;
  }

  /** One black, rimmed, dissolvable material. */
  _createMaterial(name, uniforms) {
    const material = new MeshStandardMaterial({
      name,
      color: 0x04050b,
      roughness: 0.9,
      metalness: 0.0
    });

    patchOnBeforeCompile(material, (shader) => {
      // The two named patches below are what keeps this material's program cache
      // key distinct from the enemies' — see `utils/shaderPatch.js`.
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = SHADOW_VERTEX_PATCH(shader.vertexShader);
      shader.fragmentShader = SHADOW_FRAGMENT_PATCH(shader.fragmentShader);
    });
    material.needsUpdate = true;

    return material;
  }
}

/* -------------------------------------------------------------------- */

const easeOut = (t) => 1 - (1 - t) ** 3;

/** Zero velocity *and* acceleration at both ends — as `animation/Attack.js`. */
const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Walk two identically shaped trees together. */
function parallelTraverse(a, b, callback) {
  callback(a, b);
  for (let i = 0; i < a.children.length; i++) {
    parallelTraverse(a.children[i], b.children[i], callback);
  }
}

/* -------------------------------------------------------------------- */

/**
 * The posed position, in the model's own space.
 *
 * Taken after skinning so the burn pattern rides the body rather than standing
 * still in space while the shadow runs through it.
 */
const SHADOW_VERTEX_PATCH = (source) => {
  const head = /* glsl */ `varying vec3 vShadowLocal;`;
  const body = /* glsl */ `
#include <skinning_vertex>
vShadowLocal = transformed;
`;
  return replaceChunk(`${head}\n${source}`, '#include <skinning_vertex>', body);
};

/**
 * The rim and the burn.
 *
 * ## The rim
 *
 * One dot product and one power: every grazing angle emits, which is what draws
 * the silhouette. Without it a black body under a cool key reads as a hole in
 * the screen rather than as something standing there.
 *
 * ### Why it is divided by the exposure
 *
 * The rim is an HDR value — at `emissive` 2.2 its brightest channel is well over
 * 1 — and everything above 1 is the tone mapper's to fold back down. ACES does
 * that per channel *and* desaturates as it goes, so the same colour comes out at
 * a different saturation, and a different hue, for every exposure it is fed at.
 * The two stages do not share one: the play stage grades at 0.98 and the
 * character screen at 0.49, so a rim tuned on the set arrived out in the world
 * twice as hot and washed toward white.
 *
 * Dividing by the exposure the renderer is about to multiply by cancels it: both
 * stages hand the tone mapper the same radiance, and the picker's colour is the
 * colour on screen in either place.
 *
 * ## The burn
 *
 * `discard` rather than alpha, for the same reason the enemies' is: a dissolving
 * body would otherwise have to be sorted against everything else transparent in
 * the frame, and there is no ordering that is right for something standing
 * inside a bank of ground mist.
 *
 * The threshold mixes noise with height so the burn *rises* — pure noise reads
 * as static eating the model and pure height as a wipe. Somewhere between the
 * two is the thing that looks like a shadow coming apart.
 */
const SHADOW_FRAGMENT_PATCH = (source) => {
  const head = /* glsl */ `
${noiseGLSL}
uniform vec3 uFresnelColor;
uniform float uFresnelPower;
uniform float uFresnelEmissive;
uniform float uExposure;
uniform float uDissolve;
uniform float uNoiseScale;
uniform float uModelHeight;
uniform float uRise;
uniform vec3 uEdgeColor;
uniform float uEdgeEmissive;
uniform float uEdgeWidth;
varying vec3 vShadowLocal;
`;

  const body = /* glsl */ `
#include <emissivemap_fragment>

{
  if (uDissolve > 0.0) {
    float n = snoise01(vShadowLocal * uNoiseScale);
    float ny = clamp(vShadowLocal.y / uModelHeight, 0.0, 1.0);
    float burn = mix(n, ny, clamp(uRise, 0.0, 1.0));
    if (burn < uDissolve) discard;
    float edge = 1.0 - smoothstep(uDissolve, uDissolve + max(uEdgeWidth, 1e-3), burn);
    totalEmissiveRadiance += uEdgeColor * edge * (uEdgeEmissive / max(uExposure, 0.01));
  }

  float facing = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));
  facing = clamp(facing, 0.0, 1.0);

  totalEmissiveRadiance +=
    uFresnelColor * pow(facing, max(uFresnelPower, 0.05))
    * (uFresnelEmissive / max(uExposure, 0.01));
}
`;

  return replaceChunk(`${head}\n${source}`, '#include <emissivemap_fragment>', body);
};
