import {
  BufferAttribute,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector3
} from 'three';

import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { copyColor, makeColor } from '../utils/color.js';

/** origin(3) velocity(3) seed birth life size — one droplet, one stride. */
const STRIDE = 10;

const _dir = new Vector3();
const _velocity = new Vector3();
const _jitter = new Vector3();

/**
 * The blood: one burst when a body comes apart, then two stumps that run.
 *
 * ## Same engine as the embers, opposite art direction
 *
 * The machinery is `vfx/EmberSystem.js`'s and the notes there are the ones to
 * read: the CPU only ever *births* a droplet — ten floats into a ring buffer,
 * never touched again — and the whole trajectory is a closed form evaluated in
 * the vertex shader, because linear drag under a constant acceleration has an
 * exact solution and integrating it per frame would buy nothing.
 *
 *   p(t) = p₀ + v₀·(1−e^−kt)/k + g·(t − (1−e^−kt)/k)/k
 *
 * Having `v(t)` in the same closed form is what pays for the look here too: the
 * sprite is a capsule stretched along its own screen-space velocity, so a
 * droplet leaving a cut at five metres a second draws as a thrown streak and one
 * falling off a stump draws as a round drop. That is most of what separates
 * blood from confetti.
 *
 * ## Why it is not additive
 *
 * Every other particle system in this project glows, and additive is right for
 * all of them. Blood does not glow — it is the darkest thing in the frame, and
 * additive blending cannot draw a dark thing at all: adding a dark red to a
 * dark night gives a slightly less dark night. So this one alpha-blends, and
 * `brightness` exists only to lift it far enough out of a blue night to read as
 * red rather than as black.
 *
 * `color` is the control the whole system exists to expose. Everything else is
 * how it flies.
 */
export class BloodBurst {
  /** @param {number} capacity hard ceiling on droplets in flight */
  constructor(capacity = 3072) {
    this.capacity = capacity;

    this.data = new Float32Array(capacity * STRIDE);
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);

    const geometry = new InstancedBufferGeometry();
    // One quad, corners in [-1, 1], shared by every instance: the billboard is
    // built in view space, so a vertex only has to say which corner it is.
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3)
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
      // Blood is opaque, but it is also a cloud of tiny sprites that would
      // z-fight each other for nothing. Tested against the world, written by
      // nothing.
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      blending: NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: makeColor(settings.slice.blood.color) },
        uBrightness: { value: 1 },
        uGravity: { value: -16 },
        uDrag: { value: 0.5 },
        uSize: { value: 0.03 },
        uStretch: { value: 0.05 },
        uMaxStretch: { value: 6 },
        uFade: { value: 0.35 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'Blood';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.raycast = () => {};

    this._head = 0;
    this._written = 0;
    this._clock = 0;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Push this frame's uniforms.
   *
   * Called before anything can emit, so a droplet born later in the same frame
   * is stamped with a clock the shader already agrees with.
   *
   * @param {number} time the simulation's clock — so blood freezes with the
   *   hit-stop and with `P`, along with the body it came out of
   */
  sync(time) {
    const config = settings.slice.blood;
    const u = this.material.uniforms;

    this._clock = time;
    u.uTime.value = time;
    copyColor(u.uColor.value, config.color);
    u.uBrightness.value = config.brightness;
    u.uGravity.value = config.gravity;
    u.uDrag.value = Math.max(config.drag, 0.02);
    u.uSize.value = config.size;
    u.uStretch.value = config.stretch;
    u.uMaxStretch.value = config.maxStretch;
    u.uFade.value = config.fade;
  }

  /**
   * Throw `count` droplets out of a point, along a direction.
   *
   * @param {Vector3} origin world space
   * @param {Vector3} direction the way out of the wound; normalised here
   * @param {number} count
   * @param {number} speed metres a second, before the per-droplet scatter
   */
  emit(origin, direction, count, speed) {
    const config = settings.slice.blood;
    if (!config.enabled || count <= 0) return;

    _dir.copy(direction);
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 1, 0);
    else _dir.normalize();

    // One burst can never do more than a quarter of the pool: a stump caught in
    // a stalled tab would otherwise spend the whole ring on one frame.
    const wanted = Math.min(Math.round(count), this.capacity >> 2);
    const data = this.data;
    const life = Math.max(config.life, 0.05);
    const spread = config.spread * speed;
    const startIndex = this._head;

    for (let i = 0; i < wanted; i++) {
      // A spray is not a cone of equal-speed droplets: the fast ones carry, the
      // slow ones fall at the wound, and the range between them is what makes
      // the burst read as pressure rather than as a firework.
      _velocity.copy(_dir).multiplyScalar(speed * (0.35 + Math.random() * 1.15));
      _jitter.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      _velocity.addScaledVector(_jitter, spread * 2);

      const o = this._head * STRIDE;
      data[o] = origin.x + _jitter.x * 0.05;
      data[o + 1] = origin.y + _jitter.y * 0.05;
      data[o + 2] = origin.z + _jitter.z * 0.05;
      data[o + 3] = _velocity.x;
      data[o + 4] = _velocity.y;
      data[o + 5] = _velocity.z;
      data[o + 6] = Math.random();
      data[o + 7] = this._clock;
      data[o + 8] = life * (1 - config.lifeVariance * Math.random());
      data[o + 9] = 1 - config.sizeVariance * Math.random();

      this._head = (this._head + 1) % this.capacity;
      if (this._written < this.capacity) this._written++;
    }

    if (wanted <= 0) return;
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

  /** Kill everything in flight — for a field that has just been cleared. */
  clear() {
    this.data.fill(0);
    this._head = 0;
    this._written = 0;
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
uniform vec3 uColor;
uniform float uBrightness;
uniform float uGravity;
uniform float uDrag;
uniform float uSize;
uniform float uStretch;
uniform float uMaxStretch;
uniform float uFade;

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

void main() {
  float age = uTime - aBirth;

  // Not yet born, already spent, or a slot never written. Folded to a degenerate
  // point outside the clip volume, which the rasteriser drops for free.
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
  float k = max(uDrag, 0.02);
  float decay = exp(-k * age);
  float impulse = (1.0 - decay) / k;
  vec3 accel = vec3(0.0, uGravity, 0.0);

  vec3 pos = aOrigin + aVelocity * impulse + accel * (age - impulse) / k;
  vec3 vel = aVelocity * decay + accel * impulse;

  /* ---- how much of it is left ---- */
  // Full strength for most of the life, then out. A droplet that fades from the
  // moment it is born reads as smoke.
  vColor = uColor * uBrightness;
  vFade = 1.0 - smoothstep(1.0 - clamp(uFade, 0.02, 1.0), 1.0, u);

  /* ---- the billboard, stretched along its own motion ---- */
  vec4 viewPos = viewMatrix * vec4(pos, 1.0);
  vec3 viewVel = (viewMatrix * vec4(vel, 0.0)).xyz;

  vec2 axis = viewVel.xy;
  float speed = length(axis);
  axis = speed > 1e-4 ? axis / speed : vec2(0.0, 1.0);
  vec2 across = vec2(-axis.y, axis.x);

  float stretch = 1.0 + min(uStretch * length(viewVel), uMaxStretch);
  // Droplets shed mass to the air as they fly, and a spray that keeps its
  // sprite size all the way out reads as gravel.
  float size = uSize * aSize * mix(1.0, 0.55, u) * (0.7 + 0.6 * aSeed);

  viewPos.xy += (across * position.x + axis * position.y * stretch) * size;
  gl_Position = projectionMatrix * viewPos;

  // In sprite radii, so the capsule below keeps round caps however far the quad
  // was pulled out.
  vShape = vec2(position.x, position.y * stretch);
  vCap = stretch - 1.0;
}
`;

const FRAGMENT = /* glsl */ `
varying vec2 vShape;
varying float vCap;
varying vec3 vColor;
varying float vFade;

void main() {
  if (vFade <= 0.0) discard;

  // Distance to the sprite's *axis segment* rather than to its centre: that is
  // what makes a stretched droplet a capsule with round caps instead of an
  // ellipse, and it is the difference between a streak and a smear.
  float d = length(vec2(vShape.x, max(abs(vShape.y) - vCap, 0.0)));
  float t = 1.0 - clamp(d, 0.0, 1.0);
  if (t <= 0.0) discard;

  float shape = t * t * (3.0 - 2.0 * t);
  float alpha = shape * vFade;
  if (alpha < 0.004) discard;

  // A wet drop is darkest at its rim and slightly hotter through the middle,
  // where the light gets a shorter path out of it.
  vec3 color = vColor * (0.55 + 0.45 * shape);
  gl_FragColor = vec4(color, alpha);
}
`;
