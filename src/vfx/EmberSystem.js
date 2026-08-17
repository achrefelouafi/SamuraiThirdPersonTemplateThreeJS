import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  ShaderMaterial,
  Vector3
} from 'three';

import { blackbodyGLSL } from '../shaders/lib/blackbody.glsl.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';

/** origin(3) velocity(3) seed birth life size — one ember, one stride. */
const STRIDE = 10;

const _point = new Vector3();
const _normal = new Vector3();
const _velocity = new Vector3();
const _jitter = new Vector3();

/**
 * The sparks: burning scale thrown off the steel, one per triangle picked.
 *
 * Every ember is born on an **actual face of the weapon** — `SurfaceSampler`
 * picks a triangle inside the emitter box with probability proportional to its
 * area and returns a uniform point on it together with that face's normal. So
 * they leave the blade along its surface, they are dense where the model is
 * broad and sparse where it is thin, and dragging the box down the grip stops
 * them coming off the grip. Nothing here knows the shape of a sword; it knows
 * the shape of *this* sword, because it reads it.
 *
 * ## Why this is not a particle system in the usual sense
 *
 * The CPU only ever *births* an ember: it writes ten floats into a ring buffer
 * and never touches them again. The whole trajectory is then a closed form
 * evaluated in the vertex shader — linear drag with a constant buoyant
 * acceleration has an exact solution, so position and velocity at any age come
 * out of one `exp()` rather than out of an integration step. Which means: no
 * per-frame array walk, no bandwidth spent restreaming positions, no dependence
 * on framerate, and the motion is continuous under any timestep.
 *
 *   p(t) = p₀ + v₀·(1−e^−kt)/k + a·(t − (1−e^−kt)/k)/k
 *   v(t) = v₀·e^−kt + a·(1−e^−kt)/k
 *
 * Having `v(t)` in closed form is what pays for the look: the sprite is stretched
 * along its own screen-space velocity, so a fast spark draws as a streak with
 * round caps and a slow one as a round point — the motion blur real embers have
 * in a photograph, and the single clearest tell between this and a sheet of
 * additive dots.
 *
 * ## Colour
 *
 * Not tinted. An ember is a lump of incandescent carbon that cools as it flies,
 * so it goes through `blackbody()` from birth temperature to death temperature
 * and its brightness follows the same T⁴ the flame's does — which is why the
 * near ones are white, the drifting ones deep red, and why they sit in the same
 * light as the volume without anyone matching two palettes.
 */
export class EmberSystem {
  /** @param {number} capacity hard ceiling on live embers */
  constructor(capacity = 4096) {
    this.capacity = capacity;

    this.data = new Float32Array(capacity * STRIDE);
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);

    const geometry = new InstancedBufferGeometry();
    // One quad, corners in [-1, 1], shared by every instance: the billboard is
    // built in view space, so the only thing a vertex has to carry is which
    // corner of the sprite it is.
    geometry.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        3
      )
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('aOrigin', new InterleavedBufferAttribute(this.buffer, 3, 0));
    geometry.setAttribute('aVelocity', new InterleavedBufferAttribute(this.buffer, 3, 3));
    geometry.setAttribute('aSeed', new InterleavedBufferAttribute(this.buffer, 1, 6));
    geometry.setAttribute('aBirth', new InterleavedBufferAttribute(this.buffer, 1, 7));
    geometry.setAttribute('aLife', new InterleavedBufferAttribute(this.buffer, 1, 8));
    geometry.setAttribute('aSize', new InterleavedBufferAttribute(this.buffer, 1, 9));
    geometry.instanceCount = 0;

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // Depth-tested, so an ember behind the character is occluded by it. Not
      // depth-*written*, because a spark blocks nothing.
      depthTest: true,
      // The quad is built in view space from a velocity that can point either
      // way across the screen, so its winding is not ours to predict.
      side: DoubleSide,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uUp: { value: new Vector3(0, 1, 0) },
        uBuoyancy: { value: 1.4 },
        uDrag: { value: 1.1 },
        uTurbulence: { value: 0.5 },
        uTurbScale: { value: 3.2 },
        uTurbSpeed: { value: 0.6 },
        uSize: { value: 0.007 },
        uShrink: { value: 0.45 },
        uStretch: { value: 0.05 },
        uMaxStretch: { value: 7 },
        uTempBirth: { value: 2900 },
        uTempDeath: { value: 1200 },
        uCurve: { value: 4 },
        uCool: { value: 0.75 },
        uEmission: { value: 6 },
        uTwinkle: { value: 0.55 },
        uCoreGain: { value: 5 },
        uTint: { value: new Color(1, 1, 1) }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'FireEmbers';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.raycast = () => {};

    this._head = 0;
    this._written = 0;
    this._debt = 0;
    this._clock = 0;
  }

  /** How many embers could still be alive right now. */
  get liveCount() {
    return this.mesh.geometry.instanceCount;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Push this frame's uniforms.
   *
   * @param {number} time the effect's clock, seconds — the same one the volume
   *   marches on, so pausing the sim freezes the sparks in mid-air with it
   * @param {object} config the `settings.fire.embers` block
   * @param {Vector3} flow which way the gas is streaming, world space
   */
  sync(time, config, flow) {
    const u = this.material.uniforms;
    this._clock = time;
    u.uTime.value = time;
    u.uUp.value.copy(flow);
    u.uBuoyancy.value = config.buoyancy;
    u.uDrag.value = Math.max(config.drag, 0.05);
    u.uTurbulence.value = config.turbulence;
    u.uTurbScale.value = config.turbulenceScale;
    u.uTurbSpeed.value = config.turbulenceSpeed;
    u.uSize.value = config.size;
    u.uShrink.value = config.shrink;
    u.uStretch.value = config.stretch;
    u.uMaxStretch.value = config.maxStretch;
    u.uTempBirth.value = config.tempBirth;
    u.uTempDeath.value = config.tempDeath;
    u.uCurve.value = config.curve;
    u.uCool.value = config.cool;
    u.uTwinkle.value = config.twinkle;
    u.uCoreGain.value = config.core;
  }

  /** Master brightness, folded in separately so `intensity` can dim it. */
  setEmission(value) {
    this.material.uniforms.uEmission.value = Math.max(value, 0);
  }

  /**
   * Birth embers on the selected faces.
   *
   * @param {number} dt seconds; 0 while paused, which stops births as well as
   *   motion rather than dumping a burst on the frame the pause is lifted
   * @param {import('./SurfaceSampler.js').SurfaceSampler} sampler
   * @param {import('three').Matrix4} toWorld the weapon's world matrix
   * @param {Vector3} flow gas direction, world space
   * @param {Vector3} bladeVelocity the weapon's own world velocity
   * @param {object} config the `settings.fire.embers` block
   * @param {number} master `settings.fire.intensity`
   */
  emit(dt, sampler, toWorld, flow, bladeVelocity, config, master) {
    if (dt <= 0 || !sampler || sampler.pickedCount === 0) return;

    // Faster steel throws more scale off: the swing feeds the emission the same
    // way it feeds the plume, from one measured velocity.
    const swung = 1 + config.swing * bladeVelocity.length();
    const rate = config.rate * master * swung;
    this._debt += rate * dt;
    let count = Math.floor(this._debt);
    if (count <= 0) return;
    this._debt -= count;
    // One frame can never do more than refill the pool — a long hitch would
    // otherwise spend its whole backlog on embers that are born already dead.
    count = Math.min(count, Math.ceil(this.capacity * 0.25));

    const data = this.data;
    const life = Math.max(config.life, 0.05);
    const startIndex = this._head;
    let born = 0;

    for (let i = 0; i < count; i++) {
      if (!sampler.sample(_point, _normal)) break;

      // Model space → the world the ember lives in. It is *let go* here: the
      // sword can swing away and its sparks stay where the air left them.
      _point.applyMatrix4(toWorld);
      _normal.transformDirection(toWorld);

      _velocity
        .copy(_normal)
        .multiplyScalar(config.eject * (0.55 + Math.random() * 0.9))
        .addScaledVector(flow, config.rise * (0.6 + Math.random() * 0.8))
        .addScaledVector(bladeVelocity, config.inherit);

      // A spread that is uniform on the sphere: three gaussians would be
      // correct, but for a jitter this small the difference is invisible and
      // this is three multiplies.
      _jitter.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      _velocity.addScaledVector(_jitter, config.spread * 2);

      const o = this._head * STRIDE;
      data[o] = _point.x + _normal.x * config.standoff;
      data[o + 1] = _point.y + _normal.y * config.standoff;
      data[o + 2] = _point.z + _normal.z * config.standoff;
      data[o + 3] = _velocity.x;
      data[o + 4] = _velocity.y;
      data[o + 5] = _velocity.z;
      data[o + 6] = Math.random();
      data[o + 7] = this._clock;
      data[o + 8] = life * (1 - config.lifeVariance * Math.random());
      data[o + 9] = 1 - config.sizeVariance * Math.random();

      this._head = (this._head + 1) % this.capacity;
      if (this._written < this.capacity) this._written++;
      born++;
    }

    if (born === 0) return;
    this.mesh.geometry.instanceCount = this._written;

    // Only the span just written goes up the bus. A ring that wrapped this frame
    // is two spans, which is still a fraction of restreaming the pool.
    if (this._head > startIndex) {
      this.buffer.addUpdateRange(startIndex * STRIDE, (this._head - startIndex) * STRIDE);
    } else {
      this.buffer.addUpdateRange(startIndex * STRIDE, (this.capacity - startIndex) * STRIDE);
      if (this._head > 0) this.buffer.addUpdateRange(0, this._head * STRIDE);
    }
    this.buffer.needsUpdate = true;
  }

  /** Kill everything in flight — on unequip, so sparks do not outlive the sword. */
  clear() {
    this.data.fill(0);
    this._head = 0;
    this._written = 0;
    this._debt = 0;
    this.mesh.geometry.instanceCount = 0;
    this.buffer.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

/* -------------------------------------------------------------------- */

const VERTEX = /* glsl */ `
uniform float uTime;
uniform vec3 uUp;
uniform float uBuoyancy;
uniform float uDrag;
uniform float uTurbulence;
uniform float uTurbScale;
uniform float uTurbSpeed;
uniform float uSize;
uniform float uShrink;
uniform float uStretch;
uniform float uMaxStretch;
uniform float uTempBirth;
uniform float uTempDeath;
uniform float uCurve;
uniform float uCool;
uniform float uEmission;
uniform float uTwinkle;
uniform vec3 uTint;

attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute float aSeed;
attribute float aBirth;
attribute float aLife;
attribute float aSize;

varying vec2 vShape;
varying float vCap;
varying vec3 vColor;
varying float vFade;

${noiseGLSL}
${blackbodyGLSL}

void main() {
  float age = uTime - aBirth;

  // Not yet born, already spent, or a slot that has never been written. Folded
  // to a degenerate point outside the clip volume, which the rasteriser drops
  // before it costs a fragment.
  if (aLife <= 0.0 || age < 0.0 || age >= aLife) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vShape = vec2(0.0);
    vCap = 0.0;
    vColor = vec3(0.0);
    vFade = 0.0;
    return;
  }

  float u = age / aLife;

  /* ---- the trajectory, in closed form ---- */
  // Linear drag against a constant buoyant acceleration. Exact, so the path does
  // not depend on the timestep and nothing has to be integrated per frame.
  float k = max(uDrag, 0.05);
  float decay = exp(-k * age);
  float impulse = (1.0 - decay) / k;
  vec3 accel = uUp * uBuoyancy;

  vec3 pos = aOrigin + aVelocity * impulse + accel * (age - impulse) / k;
  vec3 vel = aVelocity * decay + accel * impulse;

  /* ---- the air it is flying through ---- */
  // Displacement rather than force: three noise taps buy the wandering, curling
  // path a spark takes through hot air, and integrating it would buy nothing
  // visible for three times the cost.
  vec3 q = pos * uTurbScale - uUp * (uTime * uTurbSpeed) + aSeed * 41.0;
  vec3 wobble = vec3(
    snoise(q),
    snoise(q + vec3(19.7, 3.1, 7.7)),
    snoise(q + vec3(43.3, 11.9, 29.1))
  );
  float grown = uTurbulence * pow(age, 1.25);
  pos += wobble * grown;
  // The streak has to follow the wander, or a curling ember draws its blur
  // along the straight line it would have taken.
  vel += wobble * uTurbulence * 0.8;

  /* ---- how hot it still is ---- */
  float cooled = pow(u, max(uCool, 0.05));
  float kelvin = mix(uTempBirth, uTempDeath, cooled);

  // Embers tumble, and a tumbling flake shows a hot face and then an edge. Two
  // incommensurate rates so the pattern never repeats within a life.
  float tumble = sin(uTime * (13.0 + aSeed * 27.0) + aSeed * 61.0) * 0.6
               + sin(uTime * (41.0 + aSeed * 17.0) + aSeed * 13.0) * 0.4;
  float flicker = max(1.0 + uTwinkle * tumble, 0.05);

  vColor = thermal(kelvin, uTempBirth, uCurve) * uTint * uEmission * flicker;
  // Born into existence over the first breath, and gone before the far end of
  // the life so nothing pops out. The rest of the dying is the cooling above.
  vFade = smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.55, 1.0, u));

  /* ---- the billboard, stretched along its own motion ---- */
  vec4 viewPos = viewMatrix * vec4(pos, 1.0);
  vec3 viewVel = (viewMatrix * vec4(vel, 0.0)).xyz;

  vec2 axis = viewVel.xy;
  float speed = length(axis);
  axis = speed > 1e-4 ? axis / speed : vec2(0.0, 1.0);
  vec2 across = vec2(-axis.y, axis.x);

  float stretch = 1.0 + min(uStretch * length(viewVel), uMaxStretch);
  float size = uSize * aSize * mix(1.0, uShrink, u);

  viewPos.xy += (across * position.x + axis * position.y * stretch) * size;
  gl_Position = projectionMatrix * viewPos;

  // Handed to the fragment in sprite radii, so the capsule below is round at
  // the caps however far the quad was pulled out.
  vShape = vec2(position.x, position.y * stretch);
  vCap = stretch - 1.0;
}
`;

const FRAGMENT = /* glsl */ `
uniform float uCoreGain;

varying vec2 vShape;
varying float vCap;
varying vec3 vColor;
varying float vFade;

void main() {
  if (vFade <= 0.0) discard;

  // Distance to the sprite's *axis segment*, not to its centre: that is what
  // makes a stretched ember a capsule with round caps instead of an ellipse,
  // and it is the difference between a streak and a smear.
  float d = length(vec2(vShape.x, max(abs(vShape.y) - vCap, 0.0)));
  float t = 1.0 - clamp(d, 0.0, 1.0);
  if (t <= 0.0) discard;

  float shape = t * t * (3.0 - 2.0 * t);
  // Two lobes: a very tight core that survives the tone map as a white point,
  // and a broad soft halo that is what the bloom pass actually picks up.
  float core = pow(shape, 8.0);
  float halo = shape * shape;

  vec3 color = vColor * (core * uCoreGain + halo) * vFade;
  if (max(color.r, max(color.g, color.b)) < 0.0005) discard;

  gl_FragColor = vec4(color, 1.0);
}
`;
