import {
  AdditiveBlending,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial
} from 'three';

import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';

/** Markers that can be up at once. Two marks and one hover is the real load. */
const CAPACITY = 16;

const _matrix = /* @__PURE__ */ new Matrix4();

/**
 * The diamond over a body's head while the shadows are being aimed.
 *
 * The companion to `vfx/TargetRings.js`, and deliberately its opposite: a ring
 * on the floor says *this one is in reach of a swing*, which is a fact about
 * the geometry. This says *this one has been chosen*, which is a fact about
 * what the player just did — so it sits over the head where a decision belongs,
 * and it is the only thing on screen that survives the body walking out of
 * every attack's cone.
 *
 * ## The two states
 *
 * A marker is drawn for the body currently under the aim (`hovered`) and for
 * every body already locked (`marked`), and the difference between them is one
 * number per instance:
 *
 *  - **hovered** — the outline alone, in `color`. A shape drawn around nothing,
 *    so the body under it is never covered up while the player is still
 *    deciding.
 *  - **locked** — the core fills in, the colour runs to `lockColor`, and it
 *    breathes. The fill is what makes the click *land*: an outline that only
 *    changed hue would be a state change nobody notices mid-fight.
 *
 * The lock eases rather than snaps, and the vertex shader overshoots the size
 * on the way (`pop`) — the marker punches out and settles back, which is the
 * whole of the click's feedback.
 *
 * ## What it owns
 *
 * Nothing but its own fades, exactly like the rings: it is handed the hovered
 * body and the locked list each frame and decides no combat. A marked body that
 * dies simply stops being handed over, and its marker runs down from wherever
 * it had got to.
 *
 * One `InstancedMesh` of screen-aligned quads on the VFX layer, additively
 * blended and drawn with the depth test off — a marker behind a body, a bank of
 * mist or a fold of ground is still the answer to "who did I pick", and losing
 * it there would be worse than the small cheat of drawing through.
 */
export class TargetMarkers {
  constructor() {
    /** Per body: how lit its marker is, and how far into the lock it has gone. */
    this._marks = new Map();

    const geometry = new PlaneGeometry(1, 1);
    geometry.setAttribute('aFade', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
    geometry.setAttribute('aLock', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // See the note above: a marker is an answer, not a piece of the world.
      depthTest: false,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: new Color(settings.shadowCharacter.marking.look.color) },
        uLockColor: { value: new Color(settings.shadowCharacter.marking.look.lockColor) },
        uSize: { value: 0.5 },
        uPop: { value: 0.45 },
        uWidth: { value: 0.09 },
        uSoftness: { value: 0.05 },
        uIntensity: { value: 1.6 },
        uPulse: { value: 0.35 },
        uPulseSpeed: { value: 6 },
        uTime: { value: 0 }
      },
      vertexShader: /* glsl */ `
        uniform float uSize;
        uniform float uPop;
        attribute float aFade;
        attribute float aLock;
        varying vec2 vUv;
        varying float vFade;
        varying float vLock;

        void main() {
          vUv = uv;
          vFade = aFade;
          vLock = aLock;

          // Screen-aligned by construction: the instance contributes its
          // *position* only, and the quad's own corners are added in view space
          // — so the diamond faces the lens from every angle without a single
          // matrix being built on the CPU.
          vec4 view = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          // The punch. Zero at both ends of the lock and widest halfway through,
          // so the marker overshoots on the way in and settles rather than
          // stepping up in one frame.
          float pop = 1.0 + uPop * 4.0 * aLock * (1.0 - aLock);
          view.xy += position.xy * uSize * pop;

          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform vec3 uLockColor;
        uniform float uWidth;
        uniform float uSoftness;
        uniform float uIntensity;
        uniform float uPulse;
        uniform float uPulseSpeed;
        uniform float uTime;
        varying vec2 vUv;
        varying float vFade;
        varying float vLock;

        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          // The L1 distance from the centre: 0 in the middle, 1 on the rhombus
          // through the quad's four edge midpoints. One pair of absolutes is
          // the whole diamond — there is no geometry in this shape at all.
          float d = abs(p.x) + abs(p.y);

          float soft = max(uSoftness, 1e-3);
          float width = max(uWidth, 1e-3);

          // The outline, always. It is what a marker *is*.
          float ring = 1.0 - smoothstep(width, width + soft, abs(d - 0.8));
          // And the core, which only exists once the click has landed.
          float core = (1.0 - smoothstep(0.3 - soft, 0.3 + soft, d)) * vLock;

          // Only a locked marker breathes; a hover that pulsed would read as
          // already being the choice.
          float breath = 1.0 - uPulse * vLock * (0.5 - 0.5 * cos(uTime * uPulseSpeed));
          float a = (ring + core) * vFade * uIntensity * breath;
          if (a < 0.003) discard;

          // Premultiplied against an additive blend: the alpha is the light.
          vec3 color = mix(uColor, uLockColor, vLock);
          gl_FragColor = vec4(color * a, a);
        }
      `
    });

    this.mesh = new InstancedMesh(geometry, this.material, CAPACITY);
    this.mesh.count = 0;
    // They follow bodies around the world; a bounding sphere built at the origin
    // would blink them out at the edges.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    // Over the rings, which are on the floor and cannot be in front of these.
    this.mesh.renderOrder = 3;
    this.mesh.name = 'TargetMarkers';

    this._fades = geometry.getAttribute('aFade');
    this._locks = geometry.getAttribute('aLock');
  }

  /**
   * Draw a marker over whoever is being aimed at and over everyone locked.
   *
   * Neither set is held: a body that dies, is retired or is simply no longer
   * named runs its marker down and is then forgotten, which is why the state is
   * keyed by the body itself — there is no slot to leak.
   *
   * @param {number} dt seconds, on the simulation's clock
   * @param {{position: import('three').Vector3, alive: boolean}|null} hovered
   * @param {Iterable<{position: import('three').Vector3, alive: boolean}>} marked
   * @param {number} elapsed the shared clock, for the breath
   */
  update(dt, hovered, marked, elapsed) {
    const config = settings.shadowCharacter.marking.look;

    const rise = dt / Math.max(1e-3, config.fadeIn);
    const fall = dt / Math.max(1e-3, config.fadeOut);
    // The lock reads as an event, so it closes far faster than it opens back up.
    const lockRate = dt / 0.14;

    for (const enemy of marked) {
      if (!enemy?.alive) continue;
      this._touch(enemy, rise, lockRate, 1);
    }
    if (hovered?.alive && !this._locked(hovered, marked)) {
      this._touch(hovered, rise, lockRate, 0);
    }

    for (const [enemy, mark] of this._marks) {
      if (mark.seen) {
        mark.seen = false;
        continue;
      }
      mark.fade -= fall;
      if (mark.fade <= 0) this._marks.delete(enemy);
    }

    const height = settings.enemies.height + config.lift;
    const fades = this._fades.array;
    const locks = this._locks.array;
    let count = 0;

    for (const [enemy, mark] of this._marks) {
      if (count >= CAPACITY) break;
      const position = enemy.position;
      // Translation only: the size is a uniform, because the quad is grown in
      // view space rather than by the instance's own matrix (see the shader).
      _matrix.identity().setPosition(position.x, position.y + height, position.z);
      this.mesh.setMatrixAt(count, _matrix);
      fades[count] = mark.fade;
      locks[count] = mark.lock;
      count++;
    }

    this.mesh.count = count;
    if (!count) return;

    this.mesh.instanceMatrix.needsUpdate = true;
    this._fades.needsUpdate = true;
    this._locks.needsUpdate = true;

    const uniforms = this.material.uniforms;
    uniforms.uColor.value.set(config.color);
    uniforms.uLockColor.value.set(config.lockColor);
    uniforms.uSize.value = Math.max(0.01, config.size);
    uniforms.uPop.value = config.pop;
    uniforms.uWidth.value = config.width;
    uniforms.uSoftness.value = config.softness;
    uniforms.uIntensity.value = config.intensity;
    uniforms.uPulse.value = config.pulse;
    uniforms.uPulseSpeed.value = config.pulseSpeed;
    uniforms.uTime.value = elapsed;
  }

  /** One body's marker, brought up and eased toward the state it is in. */
  _touch(enemy, rise, lockRate, wanted) {
    let mark = this._marks.get(enemy);
    if (!mark) {
      mark = { fade: 0, lock: wanted, seen: false };
      this._marks.set(enemy, mark);
    }
    mark.fade = Math.min(1, mark.fade + rise);
    mark.lock =
      wanted > mark.lock
        ? Math.min(wanted, mark.lock + lockRate)
        : Math.max(wanted, mark.lock - lockRate);
    mark.seen = true;
  }

  /** Whether the hovered body is one of the locked ones — it wears one marker. */
  _locked(enemy, marked) {
    for (const other of marked) {
      if (other === enemy) return true;
    }
    return false;
  }

  /** Take every marker off — for the character screen, and for a reset. */
  clear() {
    this._marks.clear();
    this.mesh.count = 0;
  }

  dispose() {
    this.clear();
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
