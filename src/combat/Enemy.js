import {
  AnimationMixer,
  DoubleSide,
  Group,
  MathUtils,
  Matrix4,
  MeshDepthMaterial,
  MeshStandardMaterial,
  RGBADepthPacking,
  Vector3
} from 'three';
import { clone as cloneRigged } from 'three/addons/utils/SkeletonUtils.js';

import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';
import { damp } from '../utils/math.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';
import { Ragdoll, collideRagdolls } from './Ragdoll.js';

/**
 * Which joints each half of a cut body simulates.
 *
 * Both keep `Hips` (a chain needs a root) and `Spine` (the stump either side of
 * the plane). Beyond that they are disjoint, and that is the point: leave the
 * legs in the top half's solver and they land on the ground and hold an
 * invisible pelvis a metre in the air, with the visible torso hanging off it.
 */
const LOWER_JOINTS = new Set([
  'Hips',
  'Spine',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToeBase',
  'LeftToe_End',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToeBase',
  'RightToe_End'
]);

const UPPER_JOINTS = new Set([
  'Hips',
  'Spine',
  'Spine1',
  'Spine2',
  'Neck',
  'Head',
  'HeadTop_End',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand'
]);

/**
 * Which joints each half is *solid* with — see `Ragdoll#collideRagdolls`.
 *
 * A subset of the sets above, and the difference is the whole reason it is a
 * second pair of sets rather than a reuse of the first. `Hips` and `Spine` are
 * simulated by both halves (a chain needs a root, and the stump either side of
 * the plane has to be driven), so on the frame of the cut they sit on top of
 * each other — made solid, the two halves would shove each other across the
 * field before the blade had finished going through. So the top half's copies
 * of them are not solid, and neither is `Spine1`, which is the first joint
 * above the plane and still inside the pelvis it was cut off.
 *
 * What is left on each side is the geometry a viewer can actually see: a pelvis
 * and two legs against a ribcage, a head and two arms.
 */
const LOWER_CONTACTS = new Set([
  'Hips',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToeBase',
  'LeftToe_End',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToeBase',
  'RightToe_End'
]);

const UPPER_CONTACTS = new Set([
  'Spine2',
  'Neck',
  'Head',
  'HeadTop_End',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand'
]);

const UP = /* @__PURE__ */ new Vector3(0, 1, 0);
const DOWN = /* @__PURE__ */ new Vector3(0, -1, 0);

const _cutNormal = /* @__PURE__ */ new Vector3();
const _cutNormalBind = /* @__PURE__ */ new Vector3();
const _cutNormalWorld = /* @__PURE__ */ new Vector3();
const _cutPoint = /* @__PURE__ */ new Vector3();
const _world = /* @__PURE__ */ new Vector3();
const _spray = /* @__PURE__ */ new Vector3();
const _scratch = /* @__PURE__ */ new Vector3();

/** Every bone under a model, in one pass. */
function collectBones(model) {
  const bones = [];
  model.traverse((node) => {
    if (node.isBone) bones.push(node);
  });
  return bones;
}

/**
 * A node's transform relative to one of its ancestors.
 *
 * Composed from the local matrices on the way up rather than read off
 * `matrixWorld`, so it is the same answer whether or not anything has been
 * dropped into a scene yet — and it does not pick up the scale and offset the
 * enemy's own root carries, which is exactly the part that must not be in it.
 */
function matrixRelativeTo(node, ancestor, out) {
  const chain = [];
  for (let current = node; current && current !== ancestor; current = current.parent) {
    chain.push(current);
  }

  out.identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    chain[i].updateMatrix();
    out.multiply(chain[i].matrix);
  }
  return out;
}

/**
 * One body: standing, dying, and going away again.
 *
 * ## Its life
 *
 * `alive` — idling on its own phase of the shared clip, standing on the height
 * field, turning to watch the player. `dead` — the mixer is off and a
 * `Ragdoll` owns every bone, for `corpseTime` seconds. `dissolving` — the same
 * corpse, burning away over `dissolveTime`. Then `gone`, and the manager
 * refills the slot.
 *
 * The handover into the ragdoll is the part worth reading: the animation is not
 * faded out, it is *abandoned* mid-frame, and the solver's first pose is
 * whatever the clip was showing at the moment of the hit. There is no blend
 * because there is nothing to blend — the pose is continuous by construction,
 * which is the only way a death ever looks like it happened to the same body
 * that was standing there.
 *
 * ## Coming apart
 *
 * A blow that `slices` (the slash hit, which comes across with the sword) does not
 * take the path above: the body is duplicated, both copies are handed the same
 * plane and told to keep opposite sides of it, and each gets a ragdoll of its
 * own over the joints its own half actually shows. Two halves, two falls, one
 * skeleton's worth of geometry — and nothing was re-tessellated to do it.
 *
 * The plane lives in **bind** space, not in the posed one. That is the whole
 * trick: a cut measured against the vertex the animator authored stays at the
 * waist however the corpse folds, where a cut measured against the posed vertex
 * would climb the body as it fell and eventually eat it.
 *
 * ## Its look
 *
 * The export carries no textures whatsoever, so the material is authored here
 * rather than imported: a cold near-black body, a fresnel rim (the same device
 * the summoned shadows use, in an ember colour instead of violet) so the
 * silhouette reads against a blue night, and a dissolve that burns the corpse
 * away from the feet up. Every enemy gets its own copy of that material,
 * because the dissolve is per-body — five materials is nothing, and it is what
 * buys each corpse its own clock.
 */
export class Enemy {
  /**
   * @param {object} options
   * @param {import('three').Object3D} options.source the loaded rig, at unit scale
   * @param {import('three').AnimationClip|null} options.clip its idle
   * @param {number} options.scale metres per unit of the export
   * @param {{x: number, y: number, z: number}} options.offset normalisation onto y = 0
   * @param {number} options.localHeight the export's own height, in its own units
   * @param {number} options.forwardYaw yaw of the rig's forward in model space
   * @param {{heightAt: (x: number, z: number) => number}|null} options.terrain
   * @param {{onBlood?: Function}|null} [options.effects] where a cut sends its
   *   blood. Nothing here draws it — see `vfx/BloodBurst.js`.
   */
  constructor({ source, clip, scale, offset, localHeight, forwardYaw, terrain, effects = null }) {
    this.terrain = terrain;
    this.forwardYaw = forwardYaw;
    this.effects = effects;
    /** Heading in radians about world +Y, on the same convention as the player. */
    this.facing = 0;
    this.state = 'alive';
    /** Seconds in the current state. */
    this.timer = 0;
    /** 0 while the body is whole, 1 when it has burned away. */
    this.dissolve = 0;
    /** True once the body has been cut, which is what makes it two of them. */
    this.sliced = false;

    this.root = new Group();
    this.root.name = 'Enemy';

    /** Metres per unit of the export — the dissolve's noise is sized off it. */
    this._scale = scale;
    /** The export's own height, in its own units — the cut is a fraction of it. */
    this._localHeight = Math.max(1e-3, localHeight);
    /**
     * The feet's centre in the *geometry's* own space.
     *
     * The manager hands over the offset that drops that point onto the root's
     * origin, so it is that offset undone — and it is what the cut plane is
     * measured from, since a bind-space plane has to be placed in bind space.
     */
    this._base = new Vector3(-offset.x / scale, -offset.y / scale, -offset.z / scale);
    /** Droplets owed to the stumps, carried between frames. */
    this._dripDebt = 0;

    /* ---- the space the vertices are actually in — see `_measureBind` ---- */
    /** The mesh's own transform: vertex space → the rig's space. */
    this._bindMatrix = new Matrix4();
    /** The rig's up, in vertex space. The dissolve burns along it. */
    this._bindUp = new Vector3(0, 1, 0);
    /** Where the feet are along that axis, and how far the head is from them. */
    this._bindBase = 0;
    this._bindHeight = 1;
    /** Metres per unit of vertex space — what sizes the dissolve's noise. */
    this._bindScale = scale;

    const model = cloneRigged(source);
    model.scale.setScalar(scale);
    model.position.set(offset.x, offset.y, offset.z);
    this.root.add(model);

    // Before the first part, because every part's uniforms are sized off it.
    this._measureBind(model);

    /**
     * The body, as one or two pieces of it.
     *
     * One while it is whole; two once it has been cut, each with its own copy
     * of the mesh, its own materials, its own bones and its own fall.
     * @type {Array<{model: import('three').Object3D, bones: Map<string, import('three').Bone>, materials: import('three').Material[], uniforms: object, ragdoll: Ragdoll|null, cutBone: import('three').Bone|null}>}
     */
    this.parts = [this._makePart(model)];

    this.mixer = new AnimationMixer(this.model);
    this.action = clip ? this.mixer.clipAction(clip) : null;
    if (this.action) {
      // Its own phase and its own pace. Five bodies breathing in unison is the
      // single most artificial thing a crowd can do, and it costs two lines to
      // never do it.
      this.action.play();
      this.action.time = Math.random() * this.action.getClip().duration;
      this.action.setEffectiveTimeScale(0.92 + Math.random() * 0.16);
    }
  }

  get alive() {
    return this.state === 'alive';
  }

  /** The whole body, or the lower half of one that has been cut. */
  get model() {
    return this.parts[0].model;
  }

  /** name → bone, raw and namespace-stripped, exactly as the player's rig is indexed. */
  get bones() {
    return this.parts[0].bones;
  }

  /** Every material this body owns — nothing here is shared with another enemy. */
  get materials() {
    return this.parts.flatMap((part) => part.materials);
  }

  /** The dissolve and the rim, as the whole (or lower) half sees them. */
  get uniforms() {
    return this.parts[0].uniforms;
  }

  /** True once the body has finished burning away and the slot can be reused. */
  get finished() {
    return this.state === 'gone';
  }

  get position() {
    return this.root.position;
  }

  /* ------------------------------------------------------------------ */
  /* placement                                                           */
  /* ------------------------------------------------------------------ */

  /** Drop it on the height field at a world XZ, facing `yaw`. */
  place(x, z, yaw) {
    this.root.position.set(x, this.terrain ? this.terrain.heightAt(x, z) : 0, z);
    this.facing = yaw;
    this.root.rotation.y = yaw - this.forwardYaw;
  }

  /* ------------------------------------------------------------------ */
  /* life                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt
   * @param {import('three').Vector3} player where to look, while it still can
   */
  update(dt, player) {
    this._syncMaterial();

    if (this.state === 'alive') {
      this._live(dt, player);
      return;
    }

    // Dead or dissolving: the solver has the bones, and the clock only decides
    // how much longer the body is on screen. Two solvers, if it came apart.
    for (const part of this.parts) part.ragdoll?.update(dt);
    // And two solvers that know nothing of each other, so the torso would fall
    // straight through the legs it was sitting on. This is the only thing that
    // puts the halves in each other's way, and it runs here rather than inside
    // either solver because this is the one object that owns both of them.
    if (this.sliced && collideRagdolls(this.parts[0]?.ragdoll, this.parts[1]?.ragdoll)) {
      // Only what moved: a half that is asleep was treated as furniture by the
      // pass above and is already posed where it settled.
      for (const part of this.parts) {
        if (!part.ragdoll?.asleep) part.ragdoll?.repose();
      }
    }
    this.timer += dt;
    // Only while it is a corpse: the timer restarts for the burn-away, and a
    // body that started bleeding again as it dissolved would be a puzzle.
    if (this.sliced && this.state === 'dead') this._bleed(dt);

    const config = settings.enemies;
    if (this.state === 'dead') {
      if (this.timer >= config.corpseTime) {
        this.state = 'dissolving';
        this.timer = 0;
        // The depth pass has no idea the body is being burned away, so it would
        // go on casting a whole shadow off a corpse that is half gone. (The
        // *cut* it does know about — see `_makeDepthMaterial`.)
        this._castShadows(false);
      }
      return;
    }

    this.dissolve = Math.min(1, this.timer / Math.max(0.05, config.dissolveTime));
    for (const part of this.parts) part.uniforms.uDissolve.value = this.dissolve;
    if (this.dissolve >= 1) this.state = 'gone';
  }

  _live(dt, player) {
    const config = settings.enemies;

    this.mixer.timeScale = settings.global.animationSpeed;
    this.mixer.update(dt);

    // Re-read the floor every frame rather than at spawn: the terrain sliders
    // are live, and a body left standing in the air the moment someone moves
    // `amplitude` is the kind of thing this stage exists to avoid.
    const position = this.root.position;
    if (this.terrain) position.y = this.terrain.heightAt(position.x, position.z);

    if (!config.watch || !player) return;
    const dx = player.x - position.x;
    const dz = player.z - position.z;
    if (dx * dx + dz * dz > config.watchRadius * config.watchRadius) return;

    // 0 faces +Z, so the heading of a world direction is atan2(x, z).
    const wanted = Math.atan2(dx, dz);
    // Shortest way round, or a body watching someone cross behind it spins.
    const delta =
      MathUtils.euclideanModulo(wanted - this.facing + Math.PI, Math.PI * 2) - Math.PI;
    this.facing = damp(this.facing, this.facing + delta, config.turnRate, dt);
    this.root.rotation.y = this.facing - this.forwardYaw;
  }

  /**
   * Kill it, and throw the body along `(x, z)`.
   *
   * @param {number} x unit direction of the blow
   * @param {number} z
   * @param {{impulse: number, lift: number, spin: number}} force
   * @param {boolean} [slice] whether the blow came down with an edge on it
   * @returns {boolean} false if it was already down
   */
  die(x, z, force, slice = false) {
    if (this.state !== 'alive') return false;

    this.state = 'dead';
    this.timer = 0;
    // Nothing fades. The pose the clip is on *is* the ragdoll's first frame —
    // so the skeleton is brought fully up to date, ancestors included, before
    // it is read: the solver works in world space and every rest length it
    // measures comes off these matrices.
    this.mixer.stopAllAction();
    this.root.updateWorldMatrix(true, true);

    if (slice && settings.slice.enabled && this._cut(x, z)) {
      const cut = settings.slice;
      this._fall(this.parts[0], x, z, force, cut.lower, LOWER_JOINTS, LOWER_CONTACTS);
      this._fall(this.parts[1], x, z, force, cut.upper, UPPER_JOINTS, UPPER_CONTACTS);
      // The two halves start on the same particles, so the top is lifted clear
      // by hand on this one frame; the impulses part them from here.
      this.parts[1].ragdoll?.displace(
        _cutNormalWorld.x * cut.separation,
        _cutNormalWorld.y * cut.separation,
        _cutNormalWorld.z * cut.separation
      );
      // And driven apart along the blow: the top the way the sword went, the
      // legs the other way. Without it both halves leave on the same vector and
      // land in one heap, which reads as a body that fell over rather than one
      // that came apart.
      const split = Math.max(0, cut.split);
      if (split > 0) {
        this.parts[1].ragdoll?.shove(x * split, 0, z * split);
        this.parts[0].ragdoll?.shove(-x * split, 0, -z * split);
      }
      return true;
    }

    this._fall(this.parts[0], x, z, force, null, null, null);
    return true;
  }

  /**
   * Build one half's ragdoll and hand it the blow.
   *
   * @param {object} part
   * @param {{impulse: number, lift: number, spin: number}} force the move's own
   * @param {{impulse: number, lift: number, spin: number}|null} weights what
   *   this half takes of it — null for a body that is still in one piece
   * @param {Set<string>|null} joints which of them this half simulates
   * @param {Set<string>|null} contacts which of *those* the other half can
   *   land on — null for a body that is still in one piece and has nothing to
   *   land on it
   */
  _fall(part, x, z, force, weights, joints, contacts) {
    const ragdoll = new Ragdoll(part.bones, {
      terrain: this.terrain,
      include: joints,
      collide: contacts
    });
    if (!ragdoll.valid) {
      console.warn('[Enemy] no ragdoll could be built from this rig — the body will not fall');
      return;
    }

    part.ragdoll = ragdoll;
    ragdoll.strike(
      x,
      z,
      weights
        ? {
            impulse: force.impulse * weights.impulse,
            lift: force.lift * weights.lift,
            spin: force.spin * weights.spin
          }
        : force
    );
  }

  /* ------------------------------------------------------------------ */
  /* the cut                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Where this export's *vertices* live, which is not where its skeleton does.
   *
   * The cut is resolved against `position` — the attribute, untouched by a
   * single bone — and that attribute is in the mesh's own object space, not the
   * rig's. On this body the two are three axes and a factor of a hundred apart:
   * the mesh carries a Z-up, ×100 conversion on its own transform, so the
   * vertex a metre up the body reads `z = 1.0` while everything measured off
   * the rig reads `y = 100`.
   *
   * A plane built in the rig's numbers therefore misses the mesh entirely — it
   * lands far outside it, one half keeps every vertex and the other keeps none,
   * and a body that was cut falls over looking exactly like one that was not.
   * That was the whole of the bug.
   *
   * So the mesh's transform is measured once, here, and every plane is pushed
   * through it (`_toBindPlane`) before a shader sees it. The same measurement
   * gives the dissolve the axis it has to burn along and the scale its noise is
   * sized in, which is why that used to take the body in one flat pop rather
   * than rising up it.
   */
  _measureBind(model) {
    let mesh = null;
    model.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;
      node.updateMatrix();
      if (!mesh) mesh = node;
      // One plane is shared by every material on a half, so a second mesh in a
      // different space would be cut somewhere else entirely.
      else if (!mesh.matrix.equals(node.matrix)) {
        console.warn(
          '[Enemy] this export has meshes in different object spaces — the cut follows the first'
        );
      }
    });
    if (mesh) matrixRelativeTo(mesh, model, this._bindMatrix);

    // The rig's up and the body's extent along it, in the space the vertices are
    // in. Two planes rather than an axis and a number: the same conversion that
    // places the cut places these, so the three cannot drift apart.
    const feet = this._toBindPlane(UP, this._base.y, this._bindUp);
    const head = this._toBindPlane(UP, this._base.y + this._localHeight, _scratch);
    this._bindBase = feet;
    this._bindHeight = Math.max(1e-4, head - feet);
    this._bindScale = (this._localHeight * this._scale) / this._bindHeight;
  }

  /**
   * A plane in the rig's space → the same plane in the mesh's vertex space.
   *
   * Planes do not transform like points. Push a normal through a matrix that
   * scales or rotates and it stops being perpendicular to its own plane; the
   * *transpose* is what carries it, and that falls straight out of the algebra
   * — `dot(n, M·v) = d` is `dot(Mᵀ·n, v) = d`, once the translation has been
   * taken off the offset. Normalising afterwards is what keeps
   * `dot(position, normal) - offset` a distance, which is the unit the cut's
   * hot edge is measured in.
   *
   * @param {Vector3} normal unit, in the rig's space
   * @param {number} offset `dot(normal, point)` for any point on the plane
   * @param {Vector3} out the plane's normal in vertex space, written here
   * @returns {number} the offset that goes with it
   */
  _toBindPlane(normal, offset, out) {
    const e = this._bindMatrix.elements;
    out.set(
      e[0] * normal.x + e[1] * normal.y + e[2] * normal.z,
      e[4] * normal.x + e[5] * normal.y + e[6] * normal.z,
      e[8] * normal.x + e[9] * normal.y + e[10] * normal.z
    );
    const shifted = offset - (e[12] * normal.x + e[13] * normal.y + e[14] * normal.z);

    const length = out.length();
    // A degenerate mesh transform: nothing sensible to convert into, so the
    // plane is handed back as it came and the cut is at least not nonsense.
    if (length < 1e-9) {
      out.copy(normal);
      return offset;
    }
    out.multiplyScalar(1 / length);
    return shifted / length;
  }

  /**
   * Part the body along a plane, and stand a second copy of it up to hold the
   * other side.
   *
   * The plane is resolved in the *rig's* space first, because that is the space
   * the blow arrives in and the space `height` and `tilt` are meant in: `height`
   * up the export from the feet, tipped `tilt` degrees away along the blow so
   * the cut reads as a swing rather than as a bandsaw. The blow is in world
   * space and the root only ever turns about Y, so undoing that one yaw is the
   * whole of that conversion.
   *
   * It is then pushed into the mesh's vertex space (`_toBindPlane`), which is
   * where a shader can test it — and, critically, a space no bone can move, so
   * a cut measured at the waist stays at the waist however the corpse folds.
   *
   * @returns {boolean} false if there was nothing to duplicate
   */
  _cut(x, z) {
    const cut = settings.slice;
    const yaw = this.root.rotation.y;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    // World → the model's frame: R(-yaw) on a horizontal vector.
    const dirX = x * cos - z * sin;
    const dirZ = x * sin + z * cos;

    // Up, tipped away along the blow. `tilt` is the only thing keeping the two
    // halves from meeting again in a perfectly flat plane as they settle.
    const tilt = MathUtils.degToRad(cut.tilt);
    _cutNormal.set(-dirX * Math.sin(tilt), Math.cos(tilt), -dirZ * Math.sin(tilt)).normalize();

    _cutPoint.copy(this._base);
    _cutPoint.y += MathUtils.clamp(cut.height, 0.05, 0.95) * this._localHeight;
    // The rig's plane, and then the only one a shader can use.
    const bindOffset = this._toBindPlane(_cutNormal, _cutNormal.dot(_cutPoint), _cutNormalBind);

    const upper = cloneRigged(this.parts[0].model);
    this.root.add(upper);
    this.parts.push(this._makePart(upper));
    // The clone has to be in the world before the solver reads a bone off it.
    this.root.updateWorldMatrix(true, true);

    for (const [index, part] of this.parts.entries()) {
      const u = part.uniforms;
      // −1 keeps what is under the plane, +1 what is over it.
      u.uCutSide.value = index === 0 ? -1 : 1;
      u.uCutNormal.value.copy(_cutNormalBind);
      u.uCutOffset.value = bindOffset;
      u.uCutEdgeWidth.value = Math.max(1e-4, cut.edgeWidth * this._bindHeight);
      part.cutBone = part.bones.get('Spine') ?? part.bones.get('Hips') ?? null;
    }

    this.sliced = true;
    this._dripDebt = 0;

    /* ---- what the rest of the frame gets to see of it ---- */
    // Where the cut is, in the world. Taken off the joint nearest the plane
    // rather than by pushing the plane's own point through the model's matrix:
    // a bone's world position is unambiguous, and the geometry's space is only
    // the model's space as long as nobody exports a mesh with a transform on it.
    const waist = this.parts[0].cutBone;
    if (waist) waist.getWorldPosition(_world);
    else _world.copy(this.root.position).y += cut.height * this._localHeight * this._scale;
    // The plane's normal in world space — the direction the top half is lifted
    // clear along on the frame it parts (see `die`).
    _cutNormalWorld.copy(_cutNormal).applyAxisAngle(UP, yaw);

    const blood = settings.slice.blood;
    if (blood.enabled) {
      // Out along the blow and a little upward — a burst that goes straight up
      // reads as a fountain, and one that goes straight out as a hose.
      _spray.set(x, 0.55, z).normalize();
      this.effects?.onBlood?.(_world, _spray, blood.burst, blood.speed);
    }
    return true;
  }

  /** Both stumps, running for `bleedTime` and thinning out as they go. */
  _bleed(dt) {
    const blood = settings.slice.blood;
    if (!blood.enabled || dt <= 0 || !this.effects?.onBlood) return;

    const bleedTime = Math.max(0.05, blood.bleedTime);
    if (this.timer >= bleedTime) return;

    // Heaviest on the frame the body parts, and gone by the time it has stopped
    // moving. A stump that bleeds at a constant rate reads as plumbing.
    const falloff = 1 - this.timer / bleedTime;
    this._dripDebt += blood.drip * falloff * falloff * dt;
    const count = Math.floor(this._dripDebt);
    if (count < 1) return;
    this._dripDebt -= count;

    for (const [index, part] of this.parts.entries()) {
      if (!part.cutBone) continue;
      part.cutBone.getWorldPosition(_world);
      // The legs are lying cut-face up and pump what is left of it upward; the
      // torso is lying on top of its own wound and simply runs.
      this.effects.onBlood(_world, index === 0 ? UP : DOWN, Math.max(1, count >> 1), blood.dripSpeed);
    }
  }

  /**
   * Take it off the field without killing it — for a count that was turned
   * down while five bodies were standing. It burns away on the spot rather
   * than blinking out, because a body that simply stops existing is the one
   * thing the eye always catches.
   */
  retire() {
    if (this.state === 'dissolving' || this.state === 'gone') return;
    this.state = 'dissolving';
    this.timer = 0;
    this.mixer.stopAllAction();
    this._castShadows(false);
  }

  /** Whichever pieces of the body there are, in or out of the depth pass. */
  _castShadows(on) {
    for (const part of this.parts) {
      part.model.traverse((node) => {
        if (node.isMesh || node.isSkinnedMesh) node.castShadow = on;
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* look                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * One piece of body: its own materials, its own uniforms, its own bones.
   *
   * Everything a half needs to be shaded and simulated on its own is built
   * here, so cutting the body in two is `_makePart(clone)` and a plane.
   */
  _makePart(model) {
    const part = {
      model,
      bones: new Map(),
      materials: [],
      uniforms: this._makeUniforms(),
      ragdoll: null,
      /** The joint nearest the cut — where this half bleeds from. */
      cutBone: null
    };

    this._dress(part);
    for (const node of collectBones(model)) {
      part.bones.set(node.name, node);
      const short = node.name.split(':').pop().replace(/^mixamorig/i, '');
      if (short && !part.bones.has(short)) part.bones.set(short, node);
    }

    return part;
  }

  /** The dissolve, the rim and the cut, shared by every material on one piece. */
  _makeUniforms() {
    const look = settings.enemies.look;
    const cut = settings.slice;
    return {
      uDissolve: { value: 0 },
      // Everything here is in the mesh's vertex space, not the rig's — the two
      // shaders only ever see that one. See `_measureBind`.
      uNoiseScale: { value: look.dissolveDetail * this._bindScale },
      uUpAxis: { value: this._bindUp.clone() },
      uBaseHeight: { value: this._bindBase },
      uModelHeight: { value: this._bindHeight },
      uRise: { value: look.dissolveRise },
      uEdgeColor: { value: makeColor(look.edgeColor) },
      uEdgeEmissive: { value: look.edgeEmissive },
      uEdgeWidth: { value: look.edgeWidth },
      uRimColor: { value: makeColor(look.rimColor) },
      uRimPower: { value: look.rimPower },
      uRimEmissive: { value: look.rimEmissive },

      /** 0 while the body is whole; ±1 for the side of the plane it keeps. */
      uCutSide: { value: 0 },
      /** The plane, in the geometry's *bind* space — see `_cut`. */
      uCutNormal: { value: new Vector3(0, 1, 0) },
      uCutOffset: { value: 0 },
      uInteriorColor: { value: makeColor(cut.interiorColor) },
      uInteriorEmissive: { value: cut.interiorEmissive },
      uCutEdgeColor: { value: makeColor(cut.edgeColor) },
      uCutEdgeEmissive: { value: cut.edgeEmissive },
      uCutEdgeWidth: { value: cut.edgeWidth * this._bindHeight }
    };
  }

  /** Replace every imported material with this piece's own, patched, copy. */
  _dress(part) {
    const converted = new Map();

    part.model.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;

      node.castShadow = true;
      node.receiveShadow = true;
      // A ragdoll leaves the bounds the mesh was authored with far behind.
      node.frustumCulled = false;
      node.layers.set(LAYER.WORLD);
      // The cut is a `discard`, and the depth pass would otherwise go on
      // casting a whole body's shadow off half of one.
      node.customDepthMaterial = this._makeDepthMaterial(part);

      const source = Array.isArray(node.material) ? node.material : [node.material];
      const result = source.map((material) => {
        if (!material) return material;
        if (!converted.has(material)) converted.set(material, this._makeMaterial(material, part));
        return converted.get(material);
      });

      node.material = Array.isArray(node.material) ? result : result[0];
    });
  }

  /**
   * One imported FBX material → one authored, dissolvable, cuttable body surface.
   *
   * The export's own colour map is kept if it has one (it does not, today) so
   * that dropping a textured enemy in later still works; everything else is the
   * art direction in `settings.enemies.look`.
   *
   * Double-sided from birth, and deliberately: the back faces are what fill the
   * hollow a cut opens, and a body that only became double-sided at the moment
   * it was cut would recompile its shader on the frame of the blow — which is
   * the one frame in the whole game that cannot afford it.
   */
  _makeMaterial(source, part) {
    const look = settings.enemies.look;
    const material = new MeshStandardMaterial({
      name: `Enemy:${source.name || 'body'}`,
      color: makeColor(look.color),
      map: source.map ?? null,
      normalMap: source.normalMap ?? null,
      roughness: look.roughness,
      metalness: look.metalness,
      side: DoubleSide
    });

    patchOnBeforeCompile(material, (shader) => {
      Object.assign(shader.uniforms, part.uniforms);
      shader.vertexShader = VERTEX_PATCH(shader.vertexShader);
      shader.fragmentShader = FRAGMENT_PATCH(shader.fragmentShader);
    });
    material.needsUpdate = true;

    part.materials.push(material);
    return material;
  }

  /**
   * The same cut, for the shadow map.
   *
   * Only the plane: the burn-away is not here because a dissolving corpse has
   * already been taken out of the depth pass entirely (`update`), and a noise
   * tap per shadow texel to say the same thing twice is not worth its compile.
   */
  _makeDepthMaterial(part) {
    const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

    patchOnBeforeCompile(material, (shader) => {
      Object.assign(shader.uniforms, part.uniforms);
      shader.vertexShader = replaceChunk(
        `varying vec3 vEnemyBind;\n${shader.vertexShader}`,
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvEnemyBind = position;'
      );
      shader.fragmentShader = replaceChunk(
        `uniform float uCutSide;\nuniform vec3 uCutNormal;\nuniform float uCutOffset;\nvarying vec3 vEnemyBind;\n${shader.fragmentShader}`,
        '#include <alphatest_fragment>',
        `#include <alphatest_fragment>
if (uCutSide != 0.0 && (dot(vEnemyBind, uCutNormal) - uCutOffset) * uCutSide < 0.0) discard;`
      );
    });

    return material;
  }

  /** Settings → this body's uniforms. Live, so the look is editable on screen. */
  _syncMaterial() {
    const look = settings.enemies.look;
    const cut = settings.slice;

    for (const part of this.parts) {
      const u = part.uniforms;

      for (const material of part.materials) {
        copyColor(material.color, look.color);
        material.roughness = look.roughness;
        material.metalness = look.metalness;
      }

      copyColor(u.uRimColor.value, look.rimColor);
      u.uRimPower.value = look.rimPower;
      u.uRimEmissive.value = look.rimEmissive;
      copyColor(u.uEdgeColor.value, look.edgeColor);
      u.uEdgeEmissive.value = look.edgeEmissive;
      u.uEdgeWidth.value = look.edgeWidth;
      u.uRise.value = look.dissolveRise;
      u.uNoiseScale.value = look.dissolveDetail * this._bindScale;

      // The cut's own look, so the meat and the hot line stay editable while a
      // corpse is lying there in two pieces. The plane itself is not re-read:
      // it was resolved from the blow, and nothing may move it afterwards.
      copyColor(u.uInteriorColor.value, cut.interiorColor);
      u.uInteriorEmissive.value = cut.interiorEmissive;
      copyColor(u.uCutEdgeColor.value, cut.edgeColor);
      u.uCutEdgeEmissive.value = cut.edgeEmissive;
    }
  }

  /* ------------------------------------------------------------------ */

  /**
   * Geometry is shared with every other clone and with the source, so only what
   * belongs to this body — its materials and its own skeletons — is released.
   */
  dispose() {
    // Before anything is released: things outside the population hold bodies
    // for seconds at a time — a shadow running at its mark, a marker over a
    // head — and they all ask the same question. A disposed body that still
    // answered `alive` would be run at, and kicked, after it had left the field
    // (`respawnAll` while a summon is out is the way that happens).
    this.state = 'gone';
    this.mixer?.stopAllAction();
    this.root.parent?.remove(this.root);

    for (const part of this.parts) {
      part.model.traverse((node) => {
        if (node.isSkinnedMesh) node.skeleton?.dispose();
        node.customDepthMaterial?.dispose();
        node.customDepthMaterial = undefined;
      });
      for (const material of part.materials) material.dispose();
      part.materials.length = 0;
      part.bones.clear();
      part.ragdoll = null;
    }
    this.parts.length = 1; // the shell stays valid; it simply owns nothing now
  }
}

/* -------------------------------------------------------------------- */

/**
 * Two positions, and the difference between them is the whole design.
 *
 * `vEnemyLocal` is taken *after* skinning, so the dissolve pattern rides the
 * body rather than standing still in space while a corpse falls through it.
 *
 * `vEnemyBind` is the vertex as the animator authored it, before a single bone
 * touched it — which is the only space a cut plane can live in. Measured after
 * skinning, a plane at the waist would be a plane at a *height*, and a corpse
 * folding over would carry its chest down through it and lose the chest.
 */
const VERTEX_PATCH = (source) => {
  const head = /* glsl */ `
varying vec3 vEnemyLocal;
varying vec3 vEnemyBind;
`;
  const body = /* glsl */ `
#include <skinning_vertex>
vEnemyLocal = transformed;
vEnemyBind = position;
`;
  return replaceChunk(`${head}\n${source}`, '#include <skinning_vertex>', body);
};

/**
 * The rim and the burn.
 *
 * `discard` rather than alpha: a dissolving corpse would otherwise have to be
 * sorted against everything else transparent in the frame, and there is no
 * ordering that is right for a body lying inside a bank of ground mist. Cutting
 * the fragment costs nothing and stays in the depth buffer's good graces.
 *
 * The threshold mixes noise with height so the burn *rises* — a pure noise
 * dissolve reads as static eating the model, and a pure height one reads as a
 * wipe. Somewhere between the two is the thing that looks like burning.
 */
const FRAGMENT_PATCH = (source) => {
  const head = /* glsl */ `
${noiseGLSL}
uniform float uDissolve;
uniform float uNoiseScale;
uniform vec3 uUpAxis;
uniform float uBaseHeight;
uniform float uModelHeight;
uniform float uRise;
uniform vec3 uEdgeColor;
uniform float uEdgeEmissive;
uniform float uEdgeWidth;
uniform vec3 uRimColor;
uniform float uRimPower;
uniform float uRimEmissive;
uniform float uCutSide;
uniform vec3 uCutNormal;
uniform float uCutOffset;
uniform vec3 uInteriorColor;
uniform float uInteriorEmissive;
uniform vec3 uCutEdgeColor;
uniform float uCutEdgeEmissive;
uniform float uCutEdgeWidth;
varying vec3 vEnemyLocal;
varying vec3 vEnemyBind;
`;

  const body = /* glsl */ `
#include <emissivemap_fragment>

{
  // The cut, before anything else: half of this body is not here at all, and
  // there is no sense shading it. Signed so that positive is the side this copy
  // was told to keep, whichever side of the plane that is.
  if (uCutSide != 0.0) {
    float side = (dot(vEnemyBind, uCutNormal) - uCutOffset) * uCutSide;
    if (side < 0.0) discard;

    // The body is a shell, so what a cut exposes is the *inside* of the far
    // wall — which is exactly the back faces the material is double-sided for.
    // Painting them as meat is the whole of the cross-section: no cap geometry,
    // no re-tessellation, and it is right from every angle for free.
    if (!gl_FrontFacing) {
      diffuseColor.rgb = uInteriorColor;
      totalEmissiveRadiance += uInteriorColor * uInteriorEmissive;
    }

    // And the line the steel left along the surface it went through.
    float lip = 1.0 - smoothstep(0.0, max(uCutEdgeWidth, 1e-4), side);
    totalEmissiveRadiance += uCutEdgeColor * lip * uCutEdgeEmissive;
  }

  if (uDissolve > 0.0) {
    float n = snoise01(vEnemyLocal * uNoiseScale);
    // How far up the *body* this fragment is -- not its y, because the mesh's
    // own space need not be Y-up, and on this export it is not.
    float ny = clamp((dot(vEnemyLocal, uUpAxis) - uBaseHeight) / uModelHeight, 0.0, 1.0);
    float burn = mix(n, ny, clamp(uRise, 0.0, 1.0));
    if (burn < uDissolve) discard;
    float edge = 1.0 - smoothstep(uDissolve, uDissolve + max(uEdgeWidth, 1e-3), burn);
    totalEmissiveRadiance += uEdgeColor * edge * uEdgeEmissive;
  }

  // The rim draws the silhouette, and the inside of a body has none — running
  // it on the back faces would put a bright ember edge around the meat.
  if (gl_FrontFacing) {
    float facing = clamp(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0);
    totalEmissiveRadiance += uRimColor * pow(facing, max(uRimPower, 0.05)) * uRimEmissive;
  }
}
`;

  return replaceChunk(`${head}\n${source}`, '#include <emissivemap_fragment>', body);
};
