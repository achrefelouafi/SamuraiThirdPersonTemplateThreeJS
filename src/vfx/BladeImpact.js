import {
  AdditiveBlending,
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  ShaderMaterial
} from 'three';

import { frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { copyColor, makeColor } from '../utils/color.js';

/** origin(3) velocity(3) seed birth life size kind spin — one sprite, one stride. */
const STRIDE = 12;

/** What a sprite is. The shader branches on it exactly twice. */
const BURST = 0;
const SPARK = 1;

/**
 * What a sword arriving at thirty-eight metres a second looks like.
 *
 * ## Two things out of one buffer
 *
 * A hit is a **burst** — a white core, a ring racing out of it and a star of
 * spikes thrown along the steel — and it is a **shower of sparks** coming off
 * the edge and falling. They are one draw call and one buffer because the only
 * thing that separates them is four numbers and a branch: the burst stands
 * still and animates in the fragment shader, the spark travels and animates by
 * moving. It is the same trick `vfx/DustBurst.js` plays on dust and soil, and
 * the notes there are the ones to read for the machinery — the CPU only ever
 * *births* a sprite (twelve floats into a ring buffer, never touched again) and
 * the trajectory is a closed form evaluated per vertex, because linear drag
 * under a constant acceleration has an exact solution.
 *
 * ## Why the sparks are streaks
 *
 * A spark drawn as a dot at these speeds is a dot: it crosses eight pixels
 * between two frames and the eye reads a stutter. So each one's quad is built
 * in view space **along its own velocity**, stretched by how fast it is
 * actually going — which is a per-particle motion blur for the price of
 * normalising a vec2. It is also what makes the shower read as coming *off* the
 * blade: the streaks all point along the direction the thing was travelling in
 * on the frame it hit, and then bend as gravity takes them.
 *
 * Everything is additive and nothing is lit. This is light, and light does not
 * have a shaded side.
 */
export class BladeImpact {
  /** @param {number} capacity hard ceiling on sprites in flight */
  constructor(capacity = 768) {
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
    geometry.setAttribute('aKind', new InterleavedBufferAttribute(this.buffer, 1, 10));
    geometry.setAttribute('aSpin', new InterleavedBufferAttribute(this.buffer, 1, 11));
    geometry.instanceCount = 0;

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: makeColor('#cfeeff') },
        uRingColor: { value: makeColor('#63c8ff') },
        uSparkColor: { value: makeColor('#ffd9a0') },
        uIntensity: { value: 2.8 },
        uSpikes: { value: 7 },
        uSpikeLength: { value: 1.5 },
        uSparkStretch: { value: 0.055 },
        uDrag: { value: 1.6 },
        uGravity: { value: -16 },
        // Every emissive here is divided by the frame's exposure, for the reason
        // set out on the shadow character's rim: ACES desaturates as it clips,
        // so a colour picked at one exposure arrives at another hue at another.
        uExposure: frame.uExposure
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'BladeImpacts';
    this.mesh.frustumCulled = false;
    // Over the dust and the mist: this is the brightest thing in the frame on
    // the instant it exists, and it should win wherever it overlaps.
    this.mesh.renderOrder = 12;
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
   * Called before anything can emit, so a sprite born later in the same frame
   * is stamped with a clock the shader already agrees with.
   *
   * @param {number} time the simulation's clock — a hit holds through the
   *   hit-stop it caused, which is most of why the freeze reads as impact
   * @param {object} config `settings.flight.blades.impact`
   */
  sync(time, config) {
    const u = this.material.uniforms;

    this._clock = time;
    u.uTime.value = time;
    copyColor(u.uColor.value, config.color);
    copyColor(u.uRingColor.value, config.ringColor);
    copyColor(u.uSparkColor.value, config.sparkColor);
    u.uIntensity.value = config.intensity;
    u.uSpikes.value = Math.max(0, Math.round(config.spikes));
    u.uSpikeLength.value = Math.max(0, config.spikeLength);
    u.uSparkStretch.value = Math.max(0, config.sparkStretch);
    u.uDrag.value = Math.max(0.02, config.sparkDrag);
    u.uGravity.value = config.sparkGravity;
  }

  /**
   * One hit, here, thrown along `(dx, dy, dz)`.
   *
   * The direction is the blade's own heading on the frame it arrived, and it is
   * what the shower is built around: most of the sparks carry on the way the
   * steel was going and the rest spray back off it, which is what separates a
   * strike from an explosion. A sphere of sparks says a bomb went off; a cone
   * says something went *through*.
   *
   * @param {number} x world, at the point of contact
   * @param {number} y
   * @param {number} z
   * @param {number} dx unit direction the blade was travelling
   * @param {number} dy
   * @param {number} dz
   * @param {object} config `settings.flight.blades.impact`
   * @param {number} [strength] master on the counts and the size
   */
  burst(x, y, z, dx, dy, dz, config, strength = 1) {
    if (!config.enabled || strength <= 0) return;

    const startIndex = this._head;

    /* ---- the flash itself ---- */
    this._write(
      x,
      y,
      z,
      0,
      0,
      0,
      Math.max(0.05, config.life),
      Math.max(0.05, config.size) * strength,
      BURST,
      // The star's own bearing. Random per hit so six of them in a second are
      // never the same shape twice.
      Math.random() * Math.PI * 2
    );

    /* ---- and what came off the steel ---- */
    // One burst can never do more than a quarter of the pool: six blades
    // landing inside a second must not let the first spend it all.
    const room = this.capacity >> 2;
    const wanted = Math.min(Math.max(0, Math.round(config.sparks * strength)), room);
    const speed = Math.max(0, config.sparkSpeed);
    const spread = Math.max(0, config.sparkSpread);

    // An orthonormal pair across the blade's heading, to spray about.
    const length = Math.hypot(dx, dy, dz) || 1;
    const fx = dx / length;
    const fy = dy / length;
    const fz = dz / length;
    // Any vector not parallel to the heading will do for the cross; +Y unless
    // the blade came straight down, in which case +X.
    const upX = Math.abs(fy) > 0.94 ? 1 : 0;
    const upY = Math.abs(fy) > 0.94 ? 0 : 1;
    let rx = upY * fz - 0 * fy;
    let ry = 0 * fx - upX * fz;
    let rz = upX * fy - upY * fx;
    const rLength = Math.hypot(rx, ry, rz) || 1;
    rx /= rLength;
    ry /= rLength;
    rz /= rLength;
    // The third axis, so the spray is a cone rather than a fan.
    const ux = fy * rz - fz * ry;
    const uy = fz * rx - fx * rz;
    const uz = fx * ry - fy * rx;

    for (let i = 0; i < wanted; i++) {
      // A fifth of them come back off the blade rather than going on with it.
      const back = i % 5 === 0 ? -0.55 : 1;
      const angle = Math.random() * Math.PI * 2;
      const off = Math.tan(Math.min(1.3, spread)) * Math.random();
      const sin = Math.sin(angle) * off;
      const cos = Math.cos(angle) * off;

      const launch = speed * (0.45 + Math.random() * 1.2);
      this._write(
        x + fx * 0.1,
        y + fy * 0.1,
        z + fz * 0.1,
        (fx * back + rx * sin + ux * cos) * launch,
        (fy * back + ry * sin + uy * cos) * launch + speed * 0.18,
        (fz * back + rz * sin + uz * cos) * launch,
        config.sparkLife * (0.5 + Math.random() * 0.9),
        config.sparkSize * (0.6 + Math.random() * 0.9),
        SPARK,
        0
      );
    }

    this.mesh.geometry.instanceCount = this._written;

    // Only the span just written goes up the bus. A ring that wrapped this
    // frame is two spans, which is still a fraction of restreaming the pool.
    if (this._head > startIndex) {
      this.buffer.addUpdateRange(startIndex * STRIDE, (this._head - startIndex) * STRIDE);
    } else {
      this.buffer.addUpdateRange(startIndex * STRIDE, (this.capacity - startIndex) * STRIDE);
      if (this._head > 0) this.buffer.addUpdateRange(0, this._head * STRIDE);
    }
    this.buffer.needsUpdate = true;
  }

  /** One sprite into the ring. */
  _write(px, py, pz, vx, vy, vz, life, size, kind, spin) {
    const data = this.data;
    const o = this._head * STRIDE;

    data[o] = px;
    data[o + 1] = py;
    data[o + 2] = pz;
    data[o + 3] = vx;
    data[o + 4] = vy;
    data[o + 5] = vz;
    data[o + 6] = Math.random();
    data[o + 7] = this._clock;
    data[o + 8] = Math.max(0.02, life);
    data[o + 9] = Math.max(0.001, size);
    data[o + 10] = kind;
    data[o + 11] = spin;

    this._head = (this._head + 1) % this.capacity;
    if (this._written < this.capacity) this._written++;
  }

  /** Everything in flight, gone — for leaving the stage and for a reset. */
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

/**
 * Where a sprite is, and which way its quad is turned.
 *
 * The burst is a screen-aligned square that never moves. A spark is the same
 * square built along its own velocity **in view space** — the quad's local +Y
 * is the direction it is travelling on screen and its local +X is the thin way
 * across, so the sprite is a streak that points where it is going and gets
 * longer the faster it goes. Both fall out of the same closed-form trajectory;
 * the burst simply has no velocity to be stretched by.
 */
const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uSparkStretch;
uniform float uDrag;
uniform float uGravity;

attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute float aSeed;
attribute float aBirth;
attribute float aLife;
attribute float aSize;
attribute float aKind;
attribute float aSpin;

varying vec2 vShape;
varying float vAge;
varying float vSeed;
varying float vKind;
varying float vSpin;
varying float vHeat;

void main() {
  float age = uTime - aBirth;

  // Not yet born, already spent, or a slot never written. Folded to a
  // degenerate point outside the clip volume, which the rasteriser drops free.
  if (aLife <= 0.0 || age < 0.0 || age >= aLife) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vShape = vec2(0.0);
    vAge = 1.0;
    vSeed = 0.0;
    vKind = 0.0;
    vSpin = 0.0;
    vHeat = 0.0;
    return;
  }

  float u = age / aLife;
  float kind = aKind;

  /* ---- the trajectory, in closed form ---- */
  // The burst has no drag worth the name and no gravity: at k → 0 the impulse
  // below tends to the age itself, and with a zero velocity that is the point
  // it was born at, exactly.
  float k = mix(0.001, uDrag, kind);
  float decay = exp(-k * age);
  float impulse = (1.0 - decay) / k;
  vec3 accel = vec3(0.0, uGravity * kind, 0.0);

  vec3 pos = aOrigin + aVelocity * impulse + accel * (age - impulse) / k;
  vec3 velocity = aVelocity * decay + accel * (1.0 - decay) / k;

  vec4 viewPos = viewMatrix * vec4(pos, 1.0);

  /* ---- the quad ---- */
  vec2 along = vec2(0.0, 1.0);
  // Not "half": that is a reserved word in GLSL ES and the compile fails on it.
  float span = aSize;
  float across = aSize;

  if (kind > 0.5) {
    vec3 viewVel = (viewMatrix * vec4(velocity, 0.0)).xyz;
    // Nearly head-on: there is no direction on screen to point along, and
    // normalising noise would make the streak flicker. It stays a dot, which is
    // what a spark coming at the lens actually looks like.
    float onScreen = length(viewVel.xy);
    if (onScreen > 1e-4) along = viewVel.xy / onScreen;
    span = aSize + onScreen * uSparkStretch;
    // Thinning as it cools, so the shower tapers instead of switching off.
    across = aSize * (1.0 - 0.45 * u);
  }

  vec2 side = vec2(along.y, -along.x);
  viewPos.xy += side * position.x * across + along * position.y * span;

  gl_Position = projectionMatrix * viewPos;

  vShape = position.xy;
  vAge = u;
  vSeed = aSeed;
  vKind = kind;
  vSpin = aSpin;
  // How much of the white is left. Sparks cool fast; the burst is white for the
  // first instant and coloured for the rest of its short life.
  vHeat = pow(1.0 - u, mix(4.0, 2.2, kind));
}
`;

/**
 * One flash, or one spark.
 *
 * The **burst** is three terms and they are all functions of one number, the
 * front, which is where the ring has got to on an `outQuad` — out fast and
 * slowing, the shape of anything spreading through a material:
 *
 *  - the **core**, a hot point that is gone almost before it is seen;
 *  - the **ring**, thinning and dimming as it goes, because the same light is
 *    being carried by an ever longer circumference;
 *  - the **star**, spikes thrown outward on the blade's own bearing, each one
 *    tapering to nothing at its tip. It is what makes the hit read as *steel*
 *    rather than as an explosion: an impact that is radially symmetric has no
 *    direction in it, and this one arrived from somewhere.
 *
 * The **spark** is a capsule with a hot head and a cold tail — brightest at the
 * leading end of its own streak, which is where the light actually is when
 * something incandescent is moving.
 */
const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uRingColor;
uniform vec3 uSparkColor;
uniform float uIntensity;
uniform float uSpikes;
uniform float uSpikeLength;
uniform float uExposure;

varying vec2 vShape;
varying float vAge;
varying float vSeed;
varying float vKind;
varying float vSpin;
varying float vHeat;

void main() {
  float gain = uIntensity / max(uExposure, 0.01);
  vec3 rgb;
  float a;

  if (vKind < 0.5) {
    /* ---- the burst ---- */
    float d = length(vShape);
    if (d > 1.0) discard;

    float t = clamp(vAge, 0.0, 1.0);
    float front = 1.0 - (1.0 - t) * (1.0 - t);

    // The core. A fifth power: it has to be gone by the frame after the one it
    // landed on, or the whole hit reads as a lamp switching on.
    float core = exp(-d * d * 26.0) * pow(1.0 - t, 5.0) * 2.4;

    // The ring, thinning and dimming as it spreads.
    float radius = front * 0.72;
    float width = 0.1 * mix(1.5, 0.5, front);
    float ring = (1.0 - smoothstep(width, width + 0.11, abs(d - radius))) * (1.0 - t);

    // The star, on the blade's own bearing.
    float star = 0.0;
    if (uSpikes > 0.5) {
      float angle = atan(vShape.y, vShape.x) + vSpin;
      float lobe = pow(max(0.0, cos(angle * uSpikes)), 22.0);
      float reach = uSpikeLength * front;
      float taper = 1.0 - smoothstep(0.0, max(reach, 1e-3), d);
      star = lobe * taper * taper * pow(1.0 - t, 2.6) * 1.6;
    }

    rgb = uColor * (core + star) + uRingColor * ring;
    a = (core + star + ring);
    // The first instant is white whatever colour was picked — a flash the eye
    // can find a hue in is a flash that was not bright enough.
    rgb = mix(rgb, vec3(1.0) * (core + star + ring), vHeat * 0.55);
  } else {
    /* ---- one spark ---- */
    // A capsule: soft across, and a head that is much brighter than the tail.
    float across = 1.0 - abs(vShape.x);
    float along = 1.0 - abs(vShape.y);
    float shape = across * across * smoothstep(0.0, 0.5, along);
    // The leading half is where the metal actually is; the rest is the smear it
    // left behind on its way to being here.
    float head = smoothstep(-0.2, 1.0, vShape.y);
    shape *= 0.25 + 0.75 * head;

    rgb = mix(uSparkColor, vec3(1.0), vHeat * 0.8);
    a = shape * (1.0 - smoothstep(0.55, 1.0, vAge)) * 1.5;
  }

  a *= gain;
  if (a < 0.004) discard;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, a);
}
`;
