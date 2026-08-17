import {
  BackSide,
  BoxGeometry,
  FrontSide,
  Group,
  Matrix4,
  Mesh,
  PointLight,
  Vector3
} from 'three';

import { settings } from '../config/settings.js';
import { copyColor } from '../utils/color.js';
import { clamp, damp } from '../utils/math.js';
import { LAYER } from '../core/Layers.js';
import { EmitterBox } from './EmitterBox.js';
import { SurfaceSampler } from './SurfaceSampler.js';
import { DistanceField } from './DistanceField.js';
import { EmberSystem } from './EmberSystem.js';
import { BladeHeat } from './BladeHeat.js';
import { VolumetricFireMaterial, FIRE_REACH } from './VolumetricFireMaterial.js';

const _velocity = new Vector3();
const _center = new Vector3();
const _camera = new Vector3();
const _flow = new Vector3();
const _half = new Vector3();
const _hull = new Vector3();
const _identityScale = new Vector3(1, 1, 1);
const _bladeMatrix = new Matrix4();
const _worldToModel = new Matrix4();
const UP = new Vector3(0, 1, 0);

/** Shortest gap between two bakes of the distance field, ms. */
const BAKE_INTERVAL = 130;

/**
 * A weapon on fire.
 *
 * The **emitter box** says which part of the model burns — an oriented volume in
 * the weapon's own frame, so it lies along the blade at any angle the hand holds
 * it and can be dragged, turned and scaled like anything else in the scene. The
 * **surface sampler** flattens the faces it keeps into a triangle pool, and
 * everything else is a different way of reading that same pool:
 *
 *  - `DistanceField` bakes it into "how far is the steel from here", and
 *    `VolumetricFireMaterial` raymarches a black-body volume through that —
 *    which is what makes this the sword burning rather than a box of fire
 *    around it.
 *  - `EmberSystem` picks triangles out of it by area and throws sparks off
 *    them, so every ember leaves an actual face of the model.
 *  - `BladeHeat` makes the steel inside the box incandescent, so the weapon is
 *    a light source rather than a dark prop standing in a flame.
 *
 * All three radiate through the same `blackbody()`, at temperatures on one
 * scale, so a cooling spark, the fringe of the plume and the glowing spine are
 * the same colour when they are the same temperature — the thing that makes the
 * whole effect read as one object rather than three layers.
 *
 * ## What happens each frame
 *
 * The weapon's world matrix is read and kept against the last one. Two things
 * fall out of that pair: the frame every ray is solved in, and the blade's own
 * velocity — which is subtracted from buoyancy to build the direction the gas
 * streams. A still sword plumes straight up; a swung one lays its flame out
 * behind the edge, and the faster the cut the longer and flatter that plume
 * gets. One uniform, and the fire answers to the animation.
 *
 * ## Where it lives in the graph
 *
 * The box and the hull hang off the *weapon*, so they ride the animation with
 * no per-frame transform work. The light hangs off the *scene*, because it lights
 * the character rather than belonging to the sword; `attachTo()` is how it
 * follows the body between the play stage and the character screen.
 */
export class WeaponFire {
  /**
   * @param {object} context
   * @param {import('../equipment/EquipmentManager.js').EquipmentManager} context.equipment
   * @param {string} [context.itemId] catalog id of the piece that burns
   */
  constructor({ equipment, itemId = settings.fire.item }) {
    this.equipment = equipment;
    this.itemId = itemId;

    /** World-space half: the firelight, which belongs to the room. */
    this.group = new Group();
    this.group.name = 'WeaponFire';
    this.group.matrixAutoUpdate = false;

    this.light = new PointLight(0xff7a26, 0, 4.5, 2);
    this.light.name = 'FireLight';
    this.light.castShadow = false;
    this.group.add(this.light);

    this.box = new EmitterBox();

    // The hull is only a box big enough to contain the volume on screen: the
    // shape comes from the distance field, and the march window is solved
    // analytically inside it.
    this.field = new DistanceField();
    this.volume = new VolumetricFireMaterial();
    this.hull = new Mesh(new BoxGeometry(1, 1, 1), this.volume);
    this.hull.name = 'FireVolume';
    this.hull.frustumCulled = false;
    this.hull.castShadow = false;
    this.hull.receiveShadow = false;
    this.hull.renderOrder = 10;
    this.hull.visible = false;
    this.hull.layers.set(LAYER.VFX);
    // The hull is half a metre of empty box around the sword. Left pickable it
    // would swallow every click meant for the gear behind it.
    this.hull.raycast = () => {};
    this.hull.userData.isFireVolume = true;
    // Every ray starts at the camera, expressed in the blade's frame — so it has
    // to be *this* draw's camera, with the matrices the renderer is about to draw
    // with. Read during the simulation it is one frame old, and one frame of
    // parallax is a couple of centimetres of shear between the volume and the
    // steel it is wrapped around: the flame slides off the blade on a fast orbit
    // and lags behind a fast swing. `onBeforeRender` fires per draw call, after
    // the camera's world matrix is settled, which leaves nothing to be late.
    this.hull.onBeforeRender = (renderer, scene, camera) => this._syncCamera(camera);
    this.box.object.add(this.hull);

    // Sparks live in the *world*, not on the sword: an ember that has left the
    // steel has to stay where the air left it while the blade swings on.
    this.embers = new EmberSystem();
    this.group.add(this.embers.mesh);

    /** The steel's own glow, patched into the weapon's materials. */
    this.steel = new BladeHeat();

    /**
     * Whether the box transform is being dragged in the viewport.
     *
     * While it is, settings follow the object instead of the other way round —
     * writing a decomposed Euler back onto a quaternion the gizmo is holding is
     * how a rotation drag develops a wobble.
     */
    this.boxLocked = false;

    /** @type {import('three').Object3D|null} */
    this._model = null;
    /** @type {SurfaceSampler|null} */
    this._sampler = null;
    this._matrix = new Matrix4();
    this._worldToBlade = new Matrix4();
    /** the blade frame → world; what puts a marched hit back on screen. */
    this._bladeToWorld = new Matrix4();
    /** model space → the blade frame; what the field is baked in. */
    this._modelToBlade = new Matrix4();
    /** world → the emitter box's unit cube; what fades the steel's glow out. */
    this._worldToBox = new Matrix4();
    this._signature = '';
    this._clock = 0;

    /** Which way the gas is streaming, world space — shared by all three parts. */
    this._flowWorld = new Vector3(0, 1, 0);
    /** How fast that stream is going, m/s. */
    this._streamed = 1;

    /** Smoothed world velocity of the blade — what bends the plume. */
    this._speed = new Vector3();
    this._lastCenter = new Vector3();
    this._hasCenter = false;
    this._bakeDue = true;
    this._bakedAt = -Infinity;
  }

  /** Faces currently selected by the box — what the editor reports. */
  get faceCount() {
    return this._sampler?.pickedCount ?? 0;
  }

  /** Ember slots in flight, for the same readout. */
  get emberCount() {
    return this.embers.liveCount;
  }

  /** The object a `TransformControls` gizmo should attach to. */
  get gizmoTarget() {
    return this.box.object;
  }

  /** Put the firelight into whichever scene is being drawn. */
  attachTo(scene) {
    if (!scene || this.group.parent === scene) return;
    scene.add(this.group);
  }

  /**
   * Re-fit the box around the whole weapon.
   *
   * The bounds come from the sampled triangles rather than from `Box3`, which
   * keeps the box off the effect's own hull — measuring the model with that
   * inside it would grow the box a little every time.
   */
  refit() {
    if (!this._sampler || this._sampler.isEmpty) return false;
    this.box.fit(this._sampler.min, this._sampler.max, settings.fire.box);
    this._signature = '';
    return true;
  }

  /** Gizmo → settings, after a drag has written the object directly. */
  readBackBox() {
    this.box.writeTo(settings.fire.box);
    this._signature = '';
  }

  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt simulation seconds — 0 while paused, which holds the
   *   flame on the frame rather than letting it burn on under a held pose
   * @param {import('three').Scene} scene the one being drawn this frame
   *
   * No camera: everything the march reads from it is picked up at draw time
   * instead (`_syncCamera`), so this can run anywhere in the frame without the
   * volume ending up a frame behind the view.
   */
  update(dt, scene) {
    this.attachTo(scene);

    const config = settings.fire;
    this._clock += dt;
    this.volume.uniforms.uTime.value = this._clock;

    this._bind();
    this._syncBox();

    const live = config.enabled && this._model && this._sampler && !this._sampler.isEmpty;
    this.box.visible = config.box.show && !!this._model;

    if (live) {
      this._model.updateWorldMatrix(true, false);
      this._matrix.copy(this._model.matrixWorld);
      // The frame, the flow and the blade's own velocity first: all three parts
      // of the effect are pointed by them, and they have to agree.
      this._syncFrame(dt);
      this._syncVolume();
      this._syncEmbers(dt);
      this._syncSteel();
    } else {
      this.hull.visible = false;
      this.embers.mesh.visible = false;
      this.steel.cool();
      this._hasCenter = false;
    }

    this._syncLight(live && (this.hull.visible || this.embers.mesh.visible));
  }

  /* ------------------------------------------------------------------ */

  /** Follow the equipped weapon, rebuilding whenever the model is replaced. */
  _bind() {
    const slot = this.equipment?.get(settings.fire.item ?? this.itemId) ?? null;
    const model = slot?.model ?? null;
    if (model === this._model) return;

    this.box.detach();
    // The old weapon's materials go back before the new one's are taken over,
    // and its sparks go with it — they were tied to steel that is gone.
    this.steel.detach();
    this.embers.clear();
    this._model = model;
    this._sampler = null;
    this._signature = '';
    this._hasCenter = false;
    this._speed.set(0, 0, 0);
    this.field.ready = false;
    this._bakeDue = true;
    this._bakedAt = -Infinity;
    this.hull.visible = false;

    if (!model) return;

    // The box is attached *after* the surface is measured, so the effect can
    // never end up sampling its own hull. The filter says the same thing again,
    // because that bug would show as fire growing out of its own flame rather
    // than as an error.
    this._sampler = new SurfaceSampler(model, {
      maxEdge: 0.02,
      budget: 24000,
      filter: (node) => node.userData.isFireVolume !== true
    });
    this.box.attach(model);
    // After the sampler, for the same reason the box is: the heat clones the
    // model's materials, and measuring a model whose materials are mid-swap is
    // a class of bug worth simply not being able to have.
    this.steel.attach(model);

    if (settings.fire.box.autoFit) this.refit();
    else this.box.sync(settings.fire.box);
  }

  /** Settings ↔ box, and the triangle selection that depends on it. */
  _syncBox() {
    if (!this._model) return;

    if (this.boxLocked) this.box.writeTo(settings.fire.box);
    else this.box.sync(settings.fire.box);

    const signature = this.box.signature();
    if (signature === this._signature) return;
    this._signature = signature;
    this._sampler?.select((point) => this.box.contains(point));
    // The volume is wrapped around the faces that just changed, so its field is
    // now stale — but a bake is tens of milliseconds and this fires on every
    // frame of a gizmo drag, so it is queued rather than run here.
    this._bakeDue = true;
  }

  /**
   * The frame everything is solved in, and which way the gas is going.
   *
   * Shared by all three parts of the effect and run before any of them: the
   * volume marches in this frame, the embers are thrown along this flow, and the
   * heat crawls up the steel with it. Solving it once is what keeps them from
   * disagreeing about which way is up on a frame where the sword is swinging.
   */
  _syncFrame(dt) {
    const v = settings.fire.volume;
    const box = this.box.object;

    /* ---- the blade's own frame ---- */
    // Rotation and translation only: the box's scale belongs to the half
    // extents, not to the space, or every distance in the shader would be in a
    // different unit down each axis.
    _bladeMatrix.compose(box.position, box.quaternion, _identityScale);
    this._modelToBlade.copy(_bladeMatrix).invert();
    _bladeMatrix.premultiply(this._matrix);
    this._bladeToWorld.copy(_bladeMatrix);
    this._worldToBlade.copy(_bladeMatrix).invert();

    // World → the box's unit cube, which is the same volume `contains()` tests
    // triangles against — so the heat on the steel stops exactly where the fire
    // does, from one gizmo.
    _worldToModel.copy(this._matrix).invert();
    this._worldToBox.multiplyMatrices(this.box.toBox, _worldToModel);

    _half.set(
      this.box.size.x * box.scale.x * 0.5,
      this.box.size.y * box.scale.y * 0.5,
      this.box.size.z * box.scale.z * 0.5
    );

    /* ---- which way the gas goes ---- */
    this.box.getWorldCenter(_center);
    if (this._hasCenter && dt > 0) {
      _velocity.subVectors(_center, this._lastCenter).divideScalar(dt);
      if (_velocity.lengthSq() > 400) _velocity.set(0, 0, 0); // a teleport, not a swing
      this._speed.set(
        damp(this._speed.x, _velocity.x, 0.0001, dt),
        damp(this._speed.y, _velocity.y, 0.0001, dt),
        damp(this._speed.z, _velocity.z, 0.0001, dt)
      );
    }
    this._lastCenter.copy(_center);
    this._hasCenter = true;

    _flow.copy(UP).multiplyScalar(Math.max(v.rise, 0.01)).addScaledVector(this._speed, -v.inherit);
    this._streamed = _flow.length();
    this._flowWorld.copy(_flow).normalize();
  }

  /**
   * Point the volume at the blade: the field it is wrapped around, the hull it
   * is marched inside, and the shape the flow draws it into.
   */
  _syncVolume() {
    const config = settings.fire;
    const v = config.volume;
    const u = this.volume.uniforms;
    const box = this.box.object;

    this.hull.visible = v.enabled && config.intensity > 0.001;
    if (!this.hull.visible) return;

    u.uWorldToBlade.value.copy(this._worldToBlade);
    // The way back: the shader projects the flame's own front into the depth
    // buffer, so it needs the blade frame put back on screen.
    u.uBladeToWorld.value.copy(this._bladeToWorld);
    u.uHalf.value.copy(_half);

    _flow.copy(this._flowWorld).transformDirection(this._worldToBlade);
    u.uFlow.value.copy(_flow);

    /* ---- shape ---- */
    const thickness = Math.max(v.thickness, 0.002);
    // A fast swing has more burning gas behind it, so the plume grows with the
    // speed the flow direction was just built from.
    const length =
      v.length * (0.6 + 0.4 * clamp(this._streamed / Math.max(v.rise, 0.01), 1, 4));
    u.uThickness.value = thickness;
    u.uPlume.value = v.plume;
    u.uSpread.value = v.spread;
    u.uLength.value = length;
    u.uSoftness.value = v.softness;
    u.uShred.value = v.shred;
    u.uBulge.value = v.bulge;
    u.uBulgeScale.value = v.bulgeScale;
    u.uDetachment.value = v.detachment;

    u.uBuoyancy.value = v.buoyancy;
    u.uNoiseFrequency.value = v.noiseFrequency;
    u.uNoiseStrength.value = v.noiseStrength;
    u.uWarp.value = v.warp;
    u.uTongue.value = v.tongue;
    u.uLick.value = v.lick;
    u.uWisp.value = v.wisps;
    u.uFlicker.value = v.flicker;
    u.uOctaves.value = v.octaves;

    u.uTempCore.value = v.tempCore;
    u.uTempEdge.value = v.tempEdge;
    u.uEmissionCurve.value = v.emissionCurve;
    u.uHeatFocus.value = v.heatFocus;
    u.uHeatFalloff.value = v.heatFalloff;
    u.uHeatFollow.value = v.heatFollow;
    u.uTailHeat.value = v.tailHeat;
    u.uPalette.value = v.palette;
    u.uScatter.value = v.scatter;
    u.uScatterFalloff.value = v.scatterFalloff;

    u.uDensity.value = v.density;
    u.uSoot.value = v.soot;
    u.uCoreClarity.value = v.coreClarity;
    u.uEmission.value = v.glow * config.intensity;
    u.uOpacity.value = v.opacity;
    u.uSteps.value = v.steps;

    copyColor(u.uColorCore.value, v.colorCore);
    copyColor(u.uColorMid.value, v.colorMid);
    copyColor(u.uColorEdge.value, v.colorEdge);
    copyColor(u.uColorSmoke.value, v.colorSmoke);

    /* ---- the field the flame is wrapped around ---- */
    // How far the field is worth knowing. Everything past the sheath's own
    // reach is empty, and the band is what a byte per voxel is spent on, so
    // padding it costs resolution exactly where the flame meets the steel.
    //
    // It has to cover the plume rising off the *flank* of the blade, not just
    // the sheath: past the band every lookup reads "far away", and a flame that
    // outgrows it is sliced off along a dead flat ceiling.
    const band = thickness * (1 + v.spread) * (1 + v.bulge) * FIRE_REACH + 0.008;
    // Never mid-drag: the gizmo raises a box change on every frame of a gesture,
    // and a bake is tens of milliseconds. The wireframe follows the box live,
    // the volume keeps the shape it had, and it catches up on the frame the
    // handle is let go.
    if (this._bakeDue && !this.boxLocked && performance.now() - this._bakedAt > BAKE_INTERVAL) {
      this._bakedAt = performance.now();
      this._bakeDue = false;
      this.field.build(this._sampler, this._modelToBlade, _half, band);
    }
    if (!this.field.ready) {
      this.hull.visible = false;
      return;
    }
    u.uField.value = this.field.texture;
    u.uFieldMin.value.copy(this.field.min);
    u.uFieldSize.value.copy(this.field.size);
    u.uBand.value = this.field.band;

    /* ---- the hull ---- */
    // Wide enough to contain the sheath everywhere, and further along the flow
    // where the plume actually runs. Anything the field can reach and the hull
    // cannot is sliced off along a dead straight edge.
    const lateral = thickness * (1 + v.spread) * (1 + v.bulge) * FIRE_REACH;
    const downwind = Math.max(length + lateral * v.plume - lateral, 0);
    _hull.set(
      _half.x + lateral + downwind * Math.abs(_flow.x),
      _half.y + lateral + downwind * Math.abs(_flow.y),
      _half.z + lateral + downwind * Math.abs(_flow.z)
    );
    u.uHull.value.copy(_hull);
    this.hull.scale.set(
      (_hull.x * 2) / Math.max(box.scale.x, 1e-4),
      (_hull.y * 2) / Math.max(box.scale.y, 1e-4),
      (_hull.z * 2) / Math.max(box.scale.z, 1e-4)
    );
  }

  /**
   * The view, taken at the moment of the draw rather than during the sim.
   *
   * Called from the hull's `onBeforeRender`, so `camera` is the one this draw
   * call is going through and its world matrix is already up to date — including
   * whatever the orbit rig did after the fire was last updated. That matters
   * more than it sounds: the ray origin is the camera *in the blade's frame*, so
   * a stale one is wrong twice over — once because the eye has moved, and once
   * because the blade has swung under it — and the volume comes out sheared off
   * the steel in the direction of whichever moved faster.
   *
   * Cheap enough to run per draw: a matrix copy, a point transform and three
   * compares.
   */
  _syncCamera(camera) {
    if (!camera) return;
    const u = this.volume.uniforms;

    u.uProjection.value.copy(camera.projectionMatrix);

    _camera.setFromMatrixPosition(camera.matrixWorld);
    _camera.applyMatrix4(this._worldToBlade);
    u.uCameraBlade.value.copy(_camera);

    // Inside the hull there are no front faces to march from, so the volume
    // would vanish at the moment it fills the screen. The back faces carry the
    // march instead — and since the depth the fragment writes comes from the
    // flame rather than from the face it entered through, that no longer costs
    // the depth test the way marching a hull surface would.
    const hull = u.uHull.value;
    const inside =
      Math.abs(_camera.x) < hull.x &&
      Math.abs(_camera.y) < hull.y &&
      Math.abs(_camera.z) < hull.z;
    const side = inside ? BackSide : FrontSide;
    if (this.volume.side !== side) {
      this.volume.side = side;
      this.volume.needsUpdate = true;
    }
  }

  /**
   * Throw sparks off the faces that are alight.
   *
   * The birth positions come out of the same triangle pool the distance field
   * is baked from, so the sparks and the flame are selected by one box and
   * cannot disagree about what is burning.
   */
  _syncEmbers(dt) {
    const config = settings.fire;
    const e = config.embers;

    const on = e.enabled && config.intensity > 0.001;
    this.embers.mesh.visible = on;
    if (!on) return;

    this.embers.sync(this._clock, e, this._flowWorld);
    this.embers.setEmission(e.emission * config.intensity);
    this.embers.emit(
      dt,
      this._sampler,
      this._matrix,
      this._flowWorld,
      this._speed,
      e,
      config.intensity
    );
  }

  /** Heat the steel the box is holding. */
  _syncSteel() {
    this.steel.update(
      settings.fire.steel,
      settings.fire.intensity,
      this._clock,
      this._worldToBox,
      this._flowWorld
    );
  }

  /**
   * The fire as a lamp: parked at the box, flickering, out when it is out.
   *
   * Turned down rather than hidden, and never removed. A scene's material
   * programs are keyed on how many lights are in it, so hiding this one would
   * recompile every shader on the stage each time the fire was switched — an
   * intensity of zero costs a multiply and nothing else.
   */
  _syncLight(live) {
    const config = settings.fire.light;
    const on = live && config.enabled && config.intensity > 0 && settings.fire.intensity > 0;
    if (!on) {
      this.light.intensity = 0;
      return;
    }

    this.box.getWorldCenter(_center);
    this.light.position.copy(_center);
    this.light.distance = config.distance;
    this.light.decay = config.decay;
    copyColor(this.light.color, config.color);

    const t = this._clock;
    const wobble =
      Math.sin(t * 17.3) * 0.5 + Math.sin(t * 11.1 + 1.7) * 0.3 + Math.sin(t * 29.7) * 0.2;
    this.light.intensity =
      config.intensity * settings.fire.intensity * Math.max(0, 1 + config.flicker * wobble);
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    this.hull.geometry.dispose();
    this.volume.dispose();
    this.field.dispose();
    this.embers.dispose();
    this.steel.dispose();
    this.box.dispose();
    this.group.parent?.remove(this.group);
    this.light.dispose();
    this._sampler = null;
    this._model = null;
  }
}
