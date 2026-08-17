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
import { terrainGLSL } from '../shaders/lib/terrain.glsl.js';

/** Rings that can be up at once. More bodies than this and the oldest go without. */
const CAPACITY = 24;

/**
 * Subdivisions of one ring's quad.
 *
 * It lies on the height field, and it is bent onto it in the vertex shader —
 * so this is the only thing deciding how closely a ring a metre and a half
 * across follows a slope. A dozen is already past the point where more shows.
 */
const SEGMENTS = 12;

const _matrix = new Matrix4();

/**
 * The circle under whoever a move would actually go to.
 *
 * Aim assist is invisible by nature — the range and the cone in each attack's
 * settings block decide who a press goes to, and nothing on screen says so.
 * This is what says so: a body wears a ring for exactly as long as
 * `EnemyManager#findTarget` *returns* it for an enabled move, which is the same
 * call the key makes when it is actually pressed. Drawing it from a second,
 * parallel notion of "near enough" would be worse than drawing nothing, because
 * it would lie occasionally.
 *
 * That is why it is one ring and not a floor full of them. Everyone inside the
 * range and the cone is a body the *search* considers; only one of them is the
 * body the swing lands on, and a ring under the other three says a press will
 * go somewhere it will not.
 *
 * ## The look
 *
 * One `InstancedMesh` of flat quads, one per marked body, additively blended
 * and drawn on the VFX layer. The circle is entirely in the fragment shader:
 * the radius raised to `falloff` runs the brightness from nothing at the centre
 * to full at the rim — a fresnel pointed inwards — and a feather takes the
 * outer edge off before it can show its own polygon. Nothing is filled, so it
 * reads as a lock rather than as a shadow.
 *
 * Each quad is bent onto the terrain in the vertex shader rather than placed on
 * the CPU, which is what keeps a ring on a slope lying *along* the slope instead
 * of cutting into the uphill half of it.
 *
 * ## What it owns
 *
 * Nothing but its own fades. It decides no combat: it is handed the bodies each
 * frame, and holds a 0..1 per body so a ring that appears mid-stride comes up
 * over `fadeIn` and one whose body walked out of the cone goes out over
 * `fadeOut`, rather than either popping.
 */
export class TargetRings {
  /**
   * @param {object} [options]
   * @param {{uniforms: object}|null} [options.terrain] the height field to lie
   *   on. Without one the rings stay flat at y = 0.
   */
  constructor({ terrain = null } = {}) {
    this.terrain = terrain;

    /** How lit each ring is, 0..1, keyed by the body it belongs to. */
    this._fades = new Map();

    const geometry = new PlaneGeometry(1, 1, SEGMENTS, SEGMENTS).rotateX(-Math.PI / 2);
    const strengths = new Float32Array(CAPACITY);
    geometry.setAttribute('aStrength', new InstancedBufferAttribute(strengths, 1));

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: new Color(settings.targetRing.color) },
        uIntensity: { value: 1 },
        uFalloff: { value: 1 },
        uSoftness: { value: 0.1 },
        uPulse: { value: 0 },
        uLift: { value: 0 },
        uTime: { value: 0 },
        uPulseSpeed: { value: 1 }
      },
      vertexShader: /* glsl */ `
        uniform float uLift;
        attribute float aStrength;
        varying vec2 vUv;
        varying float vStrength;
        ${terrain ? terrainGLSL : ''}

        void main() {
          vUv = uv;
          vStrength = aStrength;

          // The instance carries the ring's diameter and where it stands; the
          // height comes from the field itself, per vertex, so the quad is bent
          // along a slope rather than laid flat across it.
          vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
          #ifdef TERRAIN
            world.y = terrainHeightAt(world.xz) + uLift;
          #else
            world.y += uLift;
          #endif

          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uIntensity;
        uniform float uFalloff;
        uniform float uSoftness;
        uniform float uPulse;
        uniform float uPulseSpeed;
        uniform float uTime;
        varying vec2 vUv;
        varying float vStrength;

        void main() {
          // 0 at the centre of the quad, 1 on the inscribed circle.
          float d = length(vUv * 2.0 - 1.0);
          if (d > 1.0) discard;

          // The gradient, running inwards from the rim. An exponent rather than
          // a band, so there is no inner edge to alias — the light simply runs
          // out on its way to the middle.
          float inward = pow(d, uFalloff);
          // And the outer edge feathered off, or the circle ends on the quad's
          // own hard cut.
          float edge = 1.0 - smoothstep(1.0 - uSoftness, 1.0, d);

          float breath = 1.0 - uPulse * (0.5 - 0.5 * cos(uTime * uPulseSpeed));
          float a = inward * edge * vStrength * uIntensity * breath;
          if (a < 0.002) discard;

          // Premultiplied against an additive blend: the alpha is the light.
          gl_FragColor = vec4(uColor * a, a);
        }
      `
    });
    if (terrain) {
      Object.assign(this.material.uniforms, terrain.uniforms);
      this.material.defines.TERRAIN = '';
    }

    this.mesh = new InstancedMesh(geometry, this.material, CAPACITY);
    this.mesh.count = 0;
    // The rings follow the player around the world; culling them against a
    // bounding sphere built at the origin would blink them out at the edges.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = 2;
    this.mesh.name = 'TargetRings';

    this._strengths = geometry.getAttribute('aStrength');
  }

  /**
   * Raise a ring under everyone named, and drop the rest.
   *
   * The collection is *not* held: a body that dies, is retired or stops being
   * the answer simply stops being handed over, and its fade runs down from
   * wherever it was. Which is why the fades are keyed by the body itself —
   * there is no slot to leak and nothing to clean up when one is gone.
   *
   * Read through `keys()` and `has()`, which a `Set` and a `Map` both answer —
   * so the caller may hand over whichever it already has, rather than keeping a
   * second copy of the same list in the other shape.
   *
   * @param {number} dt seconds, on the simulation's clock
   * @param {{keys: () => Iterable<{position: import('three').Vector3}>, has: (enemy: object) => boolean}} marked
   * @param {number} elapsed the shared clock, for the breath
   */
  update(dt, marked, elapsed) {
    const config = settings.targetRing;
    if (!config.enabled) {
      this._fades.clear();
      this.mesh.count = 0;
      return;
    }

    const rise = dt / Math.max(1e-3, config.fadeIn);
    const fall = dt / Math.max(1e-3, config.fadeOut);

    // Everyone still named comes up; everyone the caller stopped naming goes
    // down, and is forgotten once it is out.
    for (const enemy of marked.keys()) {
      this._fades.set(enemy, Math.min(1, (this._fades.get(enemy) ?? 0) + rise));
    }
    for (const [enemy, fade] of this._fades) {
      if (marked.has(enemy)) continue;
      const next = fade - fall;
      if (next <= 0) this._fades.delete(enemy);
      else this._fades.set(enemy, next);
    }

    const diameter = Math.max(0.01, config.radius) * 2;
    const strengths = this._strengths.array;
    let count = 0;

    for (const [enemy, fade] of this._fades) {
      if (count >= CAPACITY) break;
      const position = enemy.position;
      // The Y is thrown away in the shader, which resolves it off the height
      // field — this only has to say where on the ground and how big.
      _matrix.makeScale(diameter, 1, diameter);
      _matrix.setPosition(position.x, 0, position.z);
      this.mesh.setMatrixAt(count, _matrix);
      strengths[count] = fade;
      count++;
    }

    this.mesh.count = count;
    if (!count) return;

    this.mesh.instanceMatrix.needsUpdate = true;
    this._strengths.needsUpdate = true;

    const uniforms = this.material.uniforms;
    uniforms.uColor.value.set(config.color);
    uniforms.uIntensity.value = config.intensity;
    uniforms.uFalloff.value = Math.max(0.05, config.falloff);
    uniforms.uSoftness.value = Math.min(0.99, Math.max(0.001, config.softness));
    uniforms.uPulse.value = config.pulse;
    uniforms.uPulseSpeed.value = config.pulseSpeed;
    uniforms.uLift.value = config.lift;
    uniforms.uTime.value = elapsed;
  }

  /** Take every ring off — for the character screen, and for a reset. */
  clear() {
    this._fades.clear();
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
