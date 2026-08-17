import {
  AdditiveBlending,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial
} from 'three';

import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { terrainGLSL } from '../shaders/lib/terrain.glsl.js';
import { copyColor } from '../utils/color.js';

/** Waves that can be running at once. One blow is one wave; the rest is slack. */
const CAPACITY = 4;

/**
 * Subdivisions of one wave's quad.
 *
 * It is bent onto the height field in the vertex shader, and it is seven metres
 * across — four times the width of a target ring, over ground that can have a
 * whole shoulder of a hill in it. Twelve segments left the wave cutting into
 * slopes; this is the first count that lies on them.
 */
const SEGMENTS = 24;

const _matrix = /* @__PURE__ */ new Matrix4();

/**
 * What the ground does when something very heavy lands on it.
 *
 * Two things, on one quad lying on the terrain: a **wave** racing out from the
 * point of impact and decelerating as it goes, and the **cracks** it opens
 * behind itself — radial splits with a wobble in them, each one a different
 * length, glowing along their floor as though the blow had opened something hot
 * under the soil.
 *
 * The order matters and is the whole reason the two are in one shader: a crack
 * only exists *behind* the front. The wave passes, the ground splits in its
 * wake, and the split then cools. Drawn as two separate effects they would
 * appear together and read as a decal fading in.
 *
 * ## Why it is bent rather than placed
 *
 * The quad is subdivided and every vertex is dropped onto the height field
 * (`shaders/lib/terrain.glsl.js`), exactly as `vfx/TargetRings.js` does it. A
 * seven-metre disc laid flat at the impact's own height would be buried on the
 * uphill side and floating on the downhill one — which is the one thing that
 * gives away a ground effect immediately.
 *
 * ## What it owns
 *
 * A small pool and its own clocks. `burst()` claims a slot and `update()` ages
 * it; when a wave is spent its slot goes back. Nothing else in the project
 * knows how long a wave lasts, and nothing here knows what caused one.
 */
export class ShockRing {
  /**
   * @param {object} [options]
   * @param {{uniforms: object}|null} [options.terrain] the height field to lie
   *   on. Without one the waves stay flat at the height they were born at.
   */
  constructor({ terrain = null } = {}) {
    this.terrain = terrain;

    const geometry = new PlaneGeometry(1, 1, SEGMENTS, SEGMENTS).rotateX(-Math.PI / 2);
    geometry.setAttribute('aAge', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
    geometry.setAttribute('aStrength', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: new Color('#c9a4ff') },
        uCrackColor: { value: new Color('#ff8a3c') },
        uIntensity: { value: 2.6 },
        uWidth: { value: 0.09 },
        uSoftness: { value: 0.12 },
        uCracks: { value: 11 },
        uCrackLength: { value: 0.85 },
        uCrackWidth: { value: 0.02 },
        uCrackGlow: { value: 1.4 },
        uLift: { value: 0.035 }
      },
      vertexShader: VERTEX(terrain),
      fragmentShader: FRAGMENT
    });
    if (terrain) {
      Object.assign(this.material.uniforms, terrain.uniforms);
      this.material.defines.TERRAIN = '';
    }

    this.mesh = new InstancedMesh(geometry, this.material, CAPACITY);
    this.mesh.count = 0;
    // Born wherever the blow landed, which is nowhere near the origin the
    // bounding sphere would be built at.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    // Under the markers and the seal, over the target rings — it is the newest
    // thing on the floor and the one that should win where they overlap.
    this.mesh.renderOrder = 3;
    this.mesh.name = 'ShockRings';

    this._ages = geometry.getAttribute('aAge');
    this._seeds = geometry.getAttribute('aSeed');
    this._strengths = geometry.getAttribute('aStrength');

    /** @type {{x: number, z: number, radius: number, life: number, age: number}[]} */
    this._waves = [];
  }

  /**
   * Open one, here.
   *
   * @param {number} x world
   * @param {number} z
   * @param {object} config `settings.judgement.shock`
   * @param {number} [strength] master on this one wave's brightness and reach
   */
  burst(x, z, config, strength = 1) {
    // The oldest goes rather than the newest being dropped: a wave that has
    // nearly run out is the one nobody is looking at.
    if (this._waves.length >= CAPACITY) this._waves.shift();
    this._waves.push({
      x,
      z,
      radius: Math.max(0.2, config.radius) * strength,
      life: Math.max(0.05, config.life),
      age: 0,
      seed: Math.random() * 64,
      strength
    });
  }

  /**
   * @param {number} dt seconds, on the simulation's clock — a wave is part of
   *   the blow that caused it, so it holds with the hit-stop
   * @param {object} config `settings.judgement.shock`
   */
  update(dt, config) {
    for (let i = this._waves.length - 1; i >= 0; i--) {
      const wave = this._waves[i];
      wave.age += dt;
      if (wave.age >= wave.life) this._waves.splice(i, 1);
    }

    const count = this._waves.length;
    this.mesh.count = count;
    if (!count) return;

    const ages = this._ages.array;
    const seeds = this._seeds.array;
    const strengths = this._strengths.array;

    for (let i = 0; i < count; i++) {
      const wave = this._waves[i];
      // The Y is thrown away in the shader, which resolves it off the height
      // field — this only has to say where on the ground and how far it reaches.
      _matrix.makeScale(wave.radius * 2, 1, wave.radius * 2);
      _matrix.setPosition(wave.x, 0, wave.z);
      this.mesh.setMatrixAt(i, _matrix);
      ages[i] = Math.min(1, wave.age / wave.life);
      seeds[i] = wave.seed;
      strengths[i] = wave.strength;
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this._ages.needsUpdate = true;
    this._seeds.needsUpdate = true;
    this._strengths.needsUpdate = true;

    const u = this.material.uniforms;
    copyColor(u.uColor.value, config.color);
    copyColor(u.uCrackColor.value, config.crackColor);
    u.uIntensity.value = config.intensity;
    u.uWidth.value = Math.max(0.005, config.width);
    u.uSoftness.value = Math.max(0.005, config.softness);
    u.uCracks.value = Math.max(0, Math.round(config.cracks));
    u.uCrackLength.value = config.crackLength;
    u.uCrackWidth.value = Math.max(0.001, config.crackWidth);
    u.uCrackGlow.value = config.crackGlow;
    u.uLift.value = config.lift;
  }

  /** Every wave off, immediately — for leaving the stage, and for a reset. */
  clear() {
    this._waves.length = 0;
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

/* -------------------------------------------------------------------- */

const VERTEX = (terrain) => /* glsl */ `
uniform float uLift;
attribute float aAge;
attribute float aSeed;
attribute float aStrength;
varying vec2 vUv;
varying float vAge;
varying float vSeed;
varying float vStrength;
${terrain ? terrainGLSL : ''}

void main() {
  vUv = uv;
  vAge = aAge;
  vSeed = aSeed;
  vStrength = aStrength;

  // The instance carries where the blow landed and how far it reaches; the
  // height comes from the field itself, per vertex, so a seven-metre wave runs
  // over a slope instead of being buried in it.
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  #ifdef TERRAIN
    world.y = terrainHeightAt(world.xz) + uLift;
  #else
    world.y += uLift;
  #endif

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * The wave, and the cracks behind it.
 *
 * `front` is where the wave has got to, on an `outQuad` — it leaves fast and
 * slows, which is the shape of anything spreading through a material. Every
 * other term is positioned against it: the ring *is* the front, the cracks are
 * only drawn where the front has already been, and the flash is what is left of
 * the moment it started.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uColor;
uniform vec3 uCrackColor;
uniform float uIntensity;
uniform float uWidth;
uniform float uSoftness;
uniform float uCracks;
uniform float uCrackLength;
uniform float uCrackWidth;
uniform float uCrackGlow;

varying vec2 vUv;
varying float vAge;
varying float vSeed;
varying float vStrength;

const float TAU = 6.28318530718;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;

  float t = clamp(vAge, 0.0, 1.0);
  // Out fast, then slowing. A linear front reads as a growing circle; this
  // reads as something spreading.
  float front = 1.0 - (1.0 - t) * (1.0 - t);
  float turn = fract(atan(p.y, p.x) / TAU);

  /* ---- the wave ---- */
  // Thinning and dimming as it spreads: the same energy is being carried by an
  // ever longer circumference, and a ring that stays as bright at seven metres
  // as it was at one reads as a growing decal.
  float w = uWidth * mix(1.4, 0.55, front);
  float ring = 1.0 - smoothstep(w, w + uSoftness, abs(d - front));
  // And a wake behind it, so the front is a wave rather than a hoop.
  float wake = smoothstep(front - 0.35, front, d) * step(d, front) * 0.22;
  float wave = (ring + wake) / (0.35 + front) * (1.0 - t);

  /* ---- the cracks ---- */
  float crack = 0.0;
  if (uCracks > 0.5 && uCrackGlow > 0.0) {
    float cell = turn * uCracks + vSeed;
    float index = floor(cell);
    float h = hash11(index + vSeed * 7.0);
    // Each one a different length, and none of them the same as its neighbour.
    float len = mix(0.3, 1.0, h) * uCrackLength;

    // The wobble. A crack that runs straight out from the middle is a spoke;
    // this pushes it off its own bearing by an amount that wanders with the
    // radius, which is what makes it read as something that tore.
    float wobble = snoise(vec3(d * 4.5, index * 3.7, vSeed)) * 0.17;
    float off = fract(cell) - 0.5 + wobble;

    // Tapering to a point at its far end, and held to a constant width in
    // metres along its length rather than in angle.
    float taper = 1.0 - smoothstep(0.0, len, d);
    float halfW = (uCrackWidth * taper) / max(d, 0.03) / TAU * uCracks;
    crack = 1.0 - smoothstep(halfW, halfW + halfW + 0.004, abs(off));
    // Opened by the wave on its way past, never ahead of it.
    crack *= (1.0 - smoothstep(front - 0.18, front, d)) * step(0.03, d) * step(d, len);
    // And cooling. Slower than the wave, so the ground is still glowing after
    // the shock itself has gone.
    crack *= uCrackGlow * pow(1.0 - t, 1.6);
  }

  /* ---- what is left of the first instant ---- */
  float flash = (1.0 - smoothstep(0.0, 0.26, d)) * pow(1.0 - t, 5.0) * 1.8;

  float gain = uIntensity * vStrength;
  vec3 rgb = uColor * (wave + flash) + uCrackColor * crack;
  float a = (wave + flash + crack) * gain;
  if (a < 0.003) discard;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, a);
}
`;
