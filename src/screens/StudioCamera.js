import { PerspectiveCamera, MOUSE, TOUCH, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { damp } from '../utils/math.js';

const _offset = new Vector3();
const _axis = new Vector3(0, 1, 0);

/**
 * The character screen's camera: a free inspection orbit.
 *
 * Deliberately unlike `CameraRig` next door. That one is a third-person follow
 * whose distance always resolves back to a setting, because a gameplay camera
 * has one right framing and drifting off it is a bug. This one is the opposite
 * kind of tool — the whole job is getting the lens wherever a placement needs
 * checking — so it pans, it dollies wherever the wheel puts it, and it keeps
 * whatever frame the user left it in.
 *
 * What it adds on top of a plain orbit is `flyTo`: framing presets (whole body,
 * bust, head, the piece being tuned) that glide rather than cut, and abandon
 * themselves the moment the pointer touches the canvas — a camera that fights
 * the hand is worse than one that never moved.
 */
export class StudioCamera {
  /**
   * @param {HTMLElement} domElement the canvas
   */
  constructor(domElement) {
    this.camera = new PerspectiveCamera(
      settings.studio.camera.fov,
      window.innerWidth / window.innerHeight,
      0.05,
      200
    );
    this.camera.position.set(2.0, 1.5, 2.6);
    this.camera.layers.enable(LAYER.VFX); // the studio haze

    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.75;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.7;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = settings.studio.camera.minDistance;
    this.controls.maxDistance = settings.studio.camera.maxDistance;
    // Just under the floor at the bottom, just short of straight down at the
    // top: a hero shot is never taken from directly overhead.
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = 1.62;
    this.controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
    this.controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
    this.controls.target.set(0, settings.studio.camera.targetHeight, 0);
    this.controls.enabled = false; // off until the screen is shown
    this.controls.update();

    /** Where a framing preset is gliding to, or null when the hand is in charge. */
    this._goalTarget = new Vector3();
    this._goalDistance = 0;
    this._flying = false;

    // Any manual input abandons the flight — see the class note.
    this._onPointerDown = () => this.cancelFlight();
    this._onWheel = () => this.cancelFlight();
    this.domElement = domElement;
    domElement.addEventListener('pointerdown', this._onPointerDown);
    domElement.addEventListener('wheel', this._onWheel, { passive: true });
  }

  setEnabled(enabled) {
    this.controls.enabled = enabled;
  }

  /**
   * Glide to a frame.
   *
   * @param {Vector3} target what to look at
   * @param {number} distance how far off it to sit, metres
   */
  flyTo(target, distance) {
    this._goalTarget.copy(target);
    this._goalDistance = Math.max(
      settings.studio.camera.minDistance,
      Math.min(settings.studio.camera.maxDistance, distance)
    );
    this._flying = true;
  }

  cancelFlight() {
    this._flying = false;
  }

  /** The shipped frame: the whole body, three-quarters on. */
  reset() {
    const camera = settings.studio.camera;
    this.controls.target.set(0, camera.targetHeight, 0);
    this.camera.position.set(
      Math.sin(0.7) * camera.distance,
      camera.targetHeight + camera.distance * 0.28,
      Math.cos(0.7) * camera.distance
    );
    this.cancelFlight();
    this.controls.update();
  }

  /**
   * @param {number} dt real seconds — the camera keeps moving while paused
   */
  update(dt) {
    const config = settings.studio.camera;

    if (this.camera.fov !== config.fov) {
      this.camera.fov = config.fov;
      this.camera.updateProjectionMatrix();
    }
    this.controls.minDistance = config.minDistance;
    this.controls.maxDistance = config.maxDistance;

    if (this._flying) this._advanceFlight(dt, config);
    else if (config.autoOrbit !== 0 && dt > 0) this._advanceAutoOrbit(dt, config);

    this.controls.update();
  }

  /** Ease target and radius toward the goal, and stop once both are there. */
  _advanceFlight(dt, config) {
    const target = this.controls.target;
    target.set(
      damp(target.x, this._goalTarget.x, config.damping, dt),
      damp(target.y, this._goalTarget.y, config.damping, dt),
      damp(target.z, this._goalTarget.z, config.damping, dt)
    );

    _offset.copy(this.camera.position).sub(target);
    const distance = _offset.length() || 1e-4;
    const next = damp(distance, this._goalDistance, config.damping, dt);
    this.camera.position.copy(target).addScaledVector(_offset.multiplyScalar(1 / distance), next);

    if (
      target.distanceToSquared(this._goalTarget) < 1e-6 &&
      Math.abs(next - this._goalDistance) < 1e-3
    ) {
      this._flying = false;
    }
  }

  /**
   * Idle drift.
   *
   * OrbitControls has no public setter for the azimuth, but it rebuilds its
   * spherical from the camera's own position every update — so turning the
   * position about the target *is* the supported way to drive it.
   */
  _advanceAutoOrbit(dt, config) {
    const angle = config.autoOrbit * Math.PI * 2 * dt;
    _offset.copy(this.camera.position).sub(this.controls.target);
    _offset.applyAxisAngle(_axis, angle);
    this.camera.position.copy(this.controls.target).add(_offset);
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.domElement.removeEventListener('pointerdown', this._onPointerDown);
    this.domElement.removeEventListener('wheel', this._onWheel);
    this.controls.dispose();
  }
}
