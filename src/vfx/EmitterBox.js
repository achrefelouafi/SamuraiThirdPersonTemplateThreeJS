import {
  BoxGeometry,
  EdgesGeometry,
  Euler,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3
} from 'three';
import { LAYER } from '../core/Layers.js';

const _euler = new Euler();
const _quaternion = new Quaternion();
const _scale = new Vector3();
const _point = new Vector3();

/**
 * The volume the fire comes out of: an oriented box, living in the weapon's
 * own frame.
 *
 * Being a child of the model is the whole trick. The katana's local axes *are*
 * the blade's axes, so a box that starts as the model's bounding box already
 * lies along the sword whatever angle the hand is holding it at, and it keeps
 * doing so through every frame of an animation without anyone tracking a
 * rotation. Moving, turning or scaling it is then a plain local transform —
 * which is exactly what a `TransformControls` gizmo writes, so the box can be
 * dragged in the viewport and typed into the editor with no conversion either
 * way (see `WeaponFire#readBackBox`).
 *
 * Two things come out of it: `contains()`, which decides whose faces are on
 * fire, and `toBox`, the matrix the blade's glow shader uses to fade itself out
 * at the box's edges.
 */
export class EmitterBox {
  constructor(color = 0xff8a2b) {
    /** The transform itself — what the gizmo attaches to. */
    this.object = new Object3D();
    this.object.name = 'FireEmitterBox';
    // This subtree lives *under the weapon model* and is not part of the weapon.
    // Anything walking a model's meshes — the surface sampler that decides which
    // faces burn, the blade storm that clones the sword — has to be able to tell
    // the fire's own furniture from the sword, and this flag is how. It is set on
    // the transform rather than only on what hangs off it so that pruning here
    // prunes the whole subtree.
    this.object.userData.isFireVolume = true;

    /** Full extents in metres, before `object.scale`. */
    this.size = new Vector3(0.1, 0.1, 0.1);

    this.helper = new LineSegments(
      new EdgesGeometry(new BoxGeometry(1, 1, 1)),
      new LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false })
    );
    this.helper.renderOrder = 997;
    this.helper.layers.set(LAYER.VFX);
    this.helper.visible = false;
    // An editing aid, not a target: clicks belong to the gear underneath it.
    this.helper.raycast = () => {};
    this.object.add(this.helper);

    /** model-local → the unit cube the box occupies. Rebuilt by `sync()`. */
    this.toBox = new Matrix4();
    this._compose = new Matrix4();
  }

  set visible(value) {
    this.helper.visible = value;
  }

  get visible() {
    return this.helper.visible;
  }

  /** Put the box under a weapon model. */
  attach(model) {
    if (this.object.parent === model) return;
    this.object.parent?.remove(this.object);
    model?.add(this.object);
  }

  detach() {
    this.object.parent?.remove(this.object);
  }

  /**
   * Fit the box around a span of the model, in the model's own frame.
   *
   * @param {Vector3} min
   * @param {Vector3} max
   * @param {object} config the `settings.fire.box` block, written in place
   * @param {number} [padding] metres added to every side, so the surface is
   *   comfortably inside rather than exactly on the boundary
   */
  fit(min, max, config, padding = 0.004) {
    if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) return;

    config.x = (min.x + max.x) * 0.5;
    config.y = (min.y + max.y) * 0.5;
    config.z = (min.z + max.z) * 0.5;
    config.rotX = 0;
    config.rotY = 0;
    config.rotZ = 0;
    config.scaleX = 1;
    config.scaleY = 1;
    config.scaleZ = 1;
    config.sizeX = Math.max(max.x - min.x, 0.001) + padding * 2;
    config.sizeY = Math.max(max.y - min.y, 0.001) + padding * 2;
    config.sizeZ = Math.max(max.z - min.z, 0.001) + padding * 2;

    this.sync(config);
  }

  /** Settings → transform. The editor's numbers and the gizmo's agree here. */
  sync(config) {
    const object = this.object;
    object.position.set(config.x, config.y, config.z);
    object.rotation.set(
      MathUtils.degToRad(config.rotX),
      MathUtils.degToRad(config.rotY),
      MathUtils.degToRad(config.rotZ)
    );
    object.scale.set(
      Math.max(config.scaleX, 0.001),
      Math.max(config.scaleY, 0.001),
      Math.max(config.scaleZ, 0.001)
    );
    this.size.set(config.sizeX, config.sizeY, config.sizeZ);
    this._refresh();
  }

  /**
   * Transform → settings. The gizmo writes the object, so this is how the
   * panel's numbers are recovered rather than predicted.
   */
  writeTo(config) {
    const object = this.object;
    config.x = object.position.x;
    config.y = object.position.y;
    config.z = object.position.z;
    _euler.setFromQuaternion(object.quaternion, 'XYZ');
    config.rotX = MathUtils.radToDeg(_euler.x);
    config.rotY = MathUtils.radToDeg(_euler.y);
    config.rotZ = MathUtils.radToDeg(_euler.z);
    config.scaleX = object.scale.x;
    config.scaleY = object.scale.y;
    config.scaleZ = object.scale.z;
    this._refresh();
  }

  /** Is this model-space point inside the box? */
  contains(point) {
    _point.copy(point).applyMatrix4(this.toBox);
    return (
      Math.abs(_point.x) <= 0.5 && Math.abs(_point.y) <= 0.5 && Math.abs(_point.z) <= 0.5
    );
  }

  /** The box centre, in world space. */
  getWorldCenter(target) {
    return this.object.getWorldPosition(target);
  }

  /**
   * A signature of everything that changes which faces are inside.
   *
   * Comparing this against last frame's is what keeps the triangle selection
   * off the per-frame path: it only re-runs on a frame where the box actually
   * moved, which during a gizmo drag is every frame and otherwise is none.
   */
  signature() {
    const p = this.object.position;
    const q = this.object.quaternion;
    const s = this.object.scale;
    return `${p.x},${p.y},${p.z},${q.x},${q.y},${q.z},${q.w},${s.x},${s.y},${s.z},${this.size.x},${this.size.y},${this.size.z}`;
  }

  /* ------------------------------------------------------------------ */

  /** Re-derive the local matrix, the drawn cube and the containment test. */
  _refresh() {
    const object = this.object;
    object.updateMatrix();
    this.helper.scale.copy(this.size);

    // The unit-cube space folds `size` in on top of the object's own transform,
    // so a point maps straight into [-0.5, 0.5] and both the CPU test and the
    // glow shader can work in the same normalised space.
    _scale.set(
      object.scale.x * Math.max(this.size.x, 1e-5),
      object.scale.y * Math.max(this.size.y, 1e-5),
      object.scale.z * Math.max(this.size.z, 1e-5)
    );
    _quaternion.copy(object.quaternion);
    this._compose.compose(object.position, _quaternion, _scale);
    this.toBox.copy(this._compose).invert();
  }

  dispose() {
    this.detach();
    this.helper.geometry.dispose();
    this.helper.material.dispose();
  }
}
