import { PerspectiveCamera, Vector3, MOUSE, TOUCH } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { settings } from '../config/settings.js';
import { clamp, damp } from '../utils/math.js';
import { LAYER } from './Layers.js';

const _dir = new Vector3();
const _desiredTarget = new Vector3();
const _follow = new Vector3(); // how far the target moved this frame

/**
 * Third-person orbit rig.
 *
 * The distance always resolves back to `settings.camera.distance`, so framing
 * stays consistent no matter where the orbit target drifts. The wheel zooms by
 * writing that same setting rather than by moving the camera, which keeps the
 * settings file the single source of truth — set `distance` from anywhere and
 * the rig glides to it.
 */
export class CameraRig {
  constructor(domElement) {
    this.camera = new PerspectiveCamera(
      settings.camera.fov,
      window.innerWidth / window.innerHeight,
      0.1,
      400
    );
    // Behind the character and slightly off axis, so the opening frame looks out
    // *into the moon* — which is the shot every backlit thing in this scene (the
    // haze's inscatter, the ground mist, the silver on the clouds) is built for.
    // Only the direction matters: the rig resolves the distance back to
    // `settings.camera.distance` on the first update.
    this.camera.position.set(1.7, 2.3, -5.4);
    this.camera.layers.enable(LAYER.VFX);

    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.enableZoom = false; // the wheel drives `settings.camera.distance` instead
    this.controls.minPolarAngle = settings.camera.minPolar;
    this.controls.maxPolarAngle = settings.camera.maxPolar;
    this.controls.rotateSpeed = 0.65;

    // Either button orbits: nothing here needs the left one for anything else.
    this.controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: null, RIGHT: MOUSE.ROTATE };
    this.controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_ROTATE };

    /** The point the rig orbits around — the character's feet. */
    this.anchor = new Vector3(0, 0, 0);

    /**
     * Impact shake: how much is left of it, and where it put the lens last
     * frame.
     *
     * Held as an offset that is *taken back off* the camera at the top of the
     * next update rather than baked into the position. OrbitControls reads its
     * own orbit back out of `camera.position` every frame, so a shake left in
     * there would be mistaken for the user dragging and the whole rig would
     * walk away from its target.
     */
    this._shake = 0;
    this._shakeOffset = new Vector3();
    this._shakeSeed = Math.random() * 100;

    this.controls.target.set(0, settings.camera.targetHeight, 0);
    this.controls.update();

    // Actual distance, eased toward `settings.camera.distance` so a wheel flick
    // glides instead of snapping.
    this.distance = settings.camera.distance;

    this.domElement = domElement;
    this._onWheel = this._onWheel.bind(this);
    domElement.addEventListener('wheel', this._onWheel, { passive: false });

    /**
     * Let the run key coexist with the orbit.
     *
     * OrbitControls reads ctrl/meta/shift on pointer-down and turns a rotate
     * drag into a pan — but panning is off, so it bails and the drag does
     * nothing at all. Holding Shift to run would therefore lock the camera
     * until the button came back up. The modifier gesture has no use here, so
     * the flags are masked off on the way in. Capture on `window` runs before
     * the controls' own listener on the canvas; the mask is per-event, so the
     * real keyboard state the character reads is untouched.
     */
    this._onPointerDownCapture = (event) => {
      if (event.target !== domElement) return;
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return;
      for (const flag of ['shiftKey', 'ctrlKey', 'metaKey']) {
        Object.defineProperty(event, flag, { value: false, configurable: true });
      }
    };
    window.addEventListener('pointerdown', this._onPointerDownCapture, true);
  }

  /** Wheel zoom. Multiplicative, so each notch feels the same at any distance. */
  _onWheel(event) {
    // The character screen parks this rig and takes the pointer; a wheel meant
    // for its own camera must not also dolly the one nobody is looking through.
    if (!this.controls.enabled) return;
    event.preventDefault();

    const cam = settings.camera;
    // Firefox reports lines (deltaMode 1) and pages (2) rather than pixels.
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    const delta = (event.deltaY * scale) / 100;

    cam.distance = clamp(
      cam.distance * Math.exp(delta * 0.12 * cam.zoomSpeed),
      cam.minDistance,
      cam.maxDistance
    );
  }

  /** Point the rig should orbit around (character position). */
  setAnchor(x, y, z) {
    this.anchor.set(x, y, z);
  }

  /**
   * Where the camera sits around the target, radians from +Z.
   *
   * This is the frame movement input is resolved in: "forward" is away from the
   * camera, so orbiting the rig re-aims the controls.
   */
  get azimuth() {
    return this.controls.getAzimuthalAngle();
  }

  /**
   * Kick the lens, in metres. Takes the loudest of whatever is asked for in one
   * frame rather than summing — two impacts do not shake twice as hard.
   */
  shake(amount) {
    this._shake = Math.max(this._shake, amount);
  }

  /**
   * The shake itself: two frequencies per axis so it never reads as a wobble,
   * decaying to nothing in about a third of a second.
   */
  _applyShake(dt) {
    // Real time, so a hit-stop does not also freeze the shake it triggered —
    // the lens keeps moving while the world holds still, which is exactly the
    // effect the pair is going for.
    this._shake = Math.max(0, this._shake - this._shake * Math.min(1, dt * 9) - dt * 0.02);
    if (this._shake <= 1e-4) return this._shakeOffset.set(0, 0, 0);

    const t = (performance.now() * 0.001 + this._shakeSeed) * 42;
    this._shakeOffset.set(
      (Math.sin(t) + Math.sin(t * 1.7)) * 0.5,
      (Math.sin(t * 1.3 + 2.1) + Math.sin(t * 2.3)) * 0.5,
      (Math.sin(t * 0.9 + 4.2) + Math.sin(t * 1.9)) * 0.5
    );
    return this._shakeOffset.multiplyScalar(this._shake);
  }

  update(dt) {
    const cam = settings.camera;

    // Undo last frame's shake before the controls see the position.
    this.camera.position.sub(this._shakeOffset);

    if (this.camera.fov !== cam.fov) {
      this.camera.fov = cam.fov;
      this.camera.updateProjectionMatrix();
    }
    this.controls.minPolarAngle = cam.minPolar;
    this.controls.maxPolarAngle = cam.maxPolar;

    _desiredTarget.copy(this.anchor);
    _desiredTarget.y += cam.targetHeight;

    const target = this.controls.target;
    _follow.set(
      damp(target.x, _desiredTarget.x, cam.damping, dt) - target.x,
      damp(target.y, _desiredTarget.y, cam.damping, dt) - target.y,
      damp(target.z, _desiredTarget.z, cam.damping, dt) - target.z
    );
    target.add(_follow);

    /**
     * Carry the lens with the target, rather than letting the target slide out
     * from under it.
     *
     * OrbitControls re-derives its orbit from `camera.position` every frame: it
     * measures the offset against wherever the target is *now*, so moving the
     * target alone leaves the camera standing still in world space and quietly
     * rewrites the angles it is standing at. Run away from a top-down view and
     * the direction from target to camera swings toward the horizontal and
     * toward the back of the body — which the distance enforcement below then
     * pulls the lens along, ending in a chase shot nobody asked for.
     *
     * Translating the camera by the same delta keeps the offset vector
     * identical, so the azimuth, the pitch and the distance all survive the
     * follow and the only thing that ever changes them is the player's hand.
     */
    this.camera.position.add(_follow);

    this.controls.update();

    // Enforce the orbit distance (the wheel and any code writing the setting
    // both land here).
    this.distance = damp(this.distance, cam.distance, cam.zoomDamping, dt);
    _dir.copy(this.camera.position).sub(this.controls.target);
    const len = _dir.length() || 1;
    _dir.multiplyScalar(1 / len);
    this.camera.position.copy(this.controls.target).addScaledVector(_dir, this.distance);

    this.camera.position.add(this._applyShake(dt));
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.domElement.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('pointerdown', this._onPointerDownCapture, true);
    this.controls.dispose();
  }
}
