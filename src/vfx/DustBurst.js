import {
  BufferAttribute,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  NormalBlending,
  ShaderMaterial
} from 'three';

import { frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';

/** origin(3) velocity(3) seed birth life size kind spin — one grain, one stride. */
const STRIDE = 12;

/** What a particle is. The shader mixes every constant between the two. */
const DUST = 0;
const SOIL = 1;

/**
 * The dust and the soil an impact throws up.
 *
 * ## Two populations, one buffer, one draw
 *
 * A ground impact is two materials leaving at once and they behave nothing
 * alike: **dust** is light, slow, enormous and swells as it spreads, and
 * **soil** is dark, fast, small and comes straight back down. Written as two
 * systems they would be two of everything — two buffers, two materials, two
 * draw calls — for a difference that is four numbers. So a particle carries a
 * `kind` and the shader `mix`es drag, gravity, size, growth and colour between
 * the two ends of it. One buffer, one draw, and the two read as different
 * substances because they *are* different substances, not because they are
 * different code.
 *
 * The machinery underneath is `vfx/EmberSystem.js`'s, and its notes are the ones
 * to read: the CPU only ever *births* a grain — twelve floats into a ring
 * buffer, never touched again — and the whole trajectory is a closed form
 * evaluated in the vertex shader, because linear drag under a constant
 * acceleration has an exact solution.
 *
 *   p(t) = p₀ + v₀·(1−e^−kt)/k + a·(t − (1−e^−kt)/k)/k
 *
 * ## Why this one is lit and everything else in the project glows
 *
 * Every other particle system here is additive, because embers, blood mist and
 * arcane light are all things that *emit*. Dust does not. It is a cloud of
 * mineral grains being lit by the moon, and the single thing that separates
 * convincing dust from a grey blob is that it has a **lit side and a shaded
 * side**: each sprite is shaded as a little sphere, its dome normal taken in
 * view space and dotted with the same key direction the world's surfaces use
 * (`frame.uLightDir`). Backlit, the edges brighten instead — which is what
 * happens when you look at a dust cloud with the moon behind it.
 *
 * That is also why the silhouettes are eroded by noise. A soft radial falloff
 * is a smoke puff; the same falloff with a noise field subtracted from it has a
 * torn, billowed edge, and no two grains have the same one because the field is
 * offset by the grain's own seed.
 */
export class DustBurst {
  /** @param {number} capacity hard ceiling on grains in flight */
  constructor(capacity = 1536) {
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
      // Dust is opaque where it is thick, but it is also hundreds of overlapping
      // sprites that would z-fight each other for nothing. Tested against the
      // world, written by nothing.
      depthWrite: false,
      depthTest: true,
      // The quad is spun about its own axis in view space, so its winding is not
      // ours to predict.
      side: DoubleSide,
      blending: NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        // The same key every lit surface in the frame is using — a cloud lit
        // from its own private direction is the tell that it was pasted on.
        uLightDir: frame.uLightDir,
        uColor: { value: makeColor('#b9b2a4') },
        uShadeColor: { value: makeColor('#2b2f3a') },
        uSoilColor: { value: makeColor('#241d17') },
        uDustDrag: { value: 2.6 },
        uSoilDrag: { value: 0.35 },
        uGravity: { value: -17 },
        uLift: { value: 1.5 },
        uDustSize: { value: 0.42 },
        uDustGrow: { value: 3.4 },
        uSoilSize: { value: 0.075 },
        uOpacity: { value: 0.72 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'DustBurst';
    this.mesh.frustumCulled = false;
    // Under the additive effects: the ring and the seal are light, and light
    // goes on top of the things it is lighting.
    this.mesh.renderOrder = 9;
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
   * Called before anything can emit, so a grain born later in the same frame is
   * stamped with a clock the shader already agrees with.
   *
   * @param {number} time the simulation's clock — so the cloud holds with the
   *   hit-stop of the blow that raised it
   * @param {object} config `settings.judgement.dust`
   */
  sync(time, config) {
    const u = this.material.uniforms;

    this._clock = time;
    u.uTime.value = time;
    copyColor(u.uColor.value, config.color);
    copyColor(u.uShadeColor.value, config.shadeColor);
    copyColor(u.uSoilColor.value, config.soilColor);
    u.uDustDrag.value = Math.max(0.02, config.dustDrag);
    u.uSoilDrag.value = Math.max(0.02, config.soilDrag);
    u.uGravity.value = config.gravity;
    u.uLift.value = config.lift;
    u.uDustSize.value = config.dustSize;
    u.uDustGrow.value = config.dustGrow;
    u.uSoilSize.value = config.soilSize;
    u.uOpacity.value = config.opacity;
  }

  /**
   * Throw a ring of it up off the ground.
   *
   * Three things leave at once and they are all the same event: a **ring** of
   * dust racing outward along the floor, a **column** of it climbing where the
   * blow landed, and a scatter of **soil** on ballistic arcs over the top. The
   * ring is what says how hard; the column is what says where; the soil is what
   * says the ground is made of something.
   *
   * @param {number} x world, at the point of impact
   * @param {number} y the *ground* height there — everything is born on it
   * @param {number} z
   * @param {object} config `settings.judgement.dust`
   * @param {number} [strength] master on counts and speeds
   */
  burst(x, y, z, config, strength = 1) {
    if (!config.enabled || strength <= 0) return;

    const puffs = Math.max(0, Math.round(config.puffs * strength));
    const clods = Math.max(0, Math.round(config.clods * strength));
    if (puffs + clods <= 0) return;

    // One burst can never do more than a quarter of the pool: two impacts in
    // the same second must not be able to spend the whole ring on the first.
    const room = this.capacity >> 2;
    const wantedPuffs = Math.min(puffs, room);
    const wantedClods = Math.min(clods, room - wantedPuffs);

    const speed = config.speed * strength;
    const spread = Math.max(0, config.spread);
    const rise = Math.max(0, config.rise);
    const startIndex = this._head;

    /* ---- the ring, and the column in the middle of it ---- */
    // A fifth of the dust goes straight up rather than out. Without it the
    // impact is a flat disc of cloud with a hole where the blow actually was.
    const column = Math.round(wantedPuffs * 0.22);
    for (let i = 0; i < wantedPuffs; i++) {
      const inColumn = i < column;
      // Evenly spaced around the circle and then jittered, rather than random:
      // a ring drawn from a uniform random angle has gaps and clumps in it, and
      // both read as an accident.
      const angle = ((i - column) / Math.max(1, wantedPuffs - column)) * Math.PI * 2 + Math.random() * 0.5;
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);

      const out = inColumn
        ? speed * 0.22 * Math.random()
        : speed * (0.55 + Math.random() * 0.85);
      const up = inColumn
        ? speed * (0.5 + Math.random() * 0.5)
        : speed * rise * (0.45 + Math.random() * 1.1);

      const radius = inColumn ? Math.random() * 0.25 : config.ring * (0.7 + Math.random() * 0.6);

      this._write(
        x + sin * radius,
        y + 0.12 + Math.random() * 0.25,
        z + cos * radius,
        sin * out + (Math.random() - 0.5) * spread * speed,
        up,
        cos * out + (Math.random() - 0.5) * spread * speed,
        config.dustLife * (0.7 + Math.random() * 0.6),
        0.7 + Math.random() * 0.7,
        DUST,
        (Math.random() - 0.5) * 1.4
      );
    }

    /* ---- and the soil over the top of it ---- */
    for (let i = 0; i < wantedClods; i++) {
      const angle = Math.random() * Math.PI * 2;
      // Steeply up, mostly. A clod thrown flat never reads — it leaves the
      // frame before anyone sees it was there.
      const pitch = 0.45 + Math.random() * 1.0;
      const launch = speed * (0.75 + Math.random() * 1.5);
      const flat = Math.cos(pitch) * launch;

      this._write(
        x + (Math.random() - 0.5) * 0.5,
        y + 0.08,
        z + (Math.random() - 0.5) * 0.5,
        Math.sin(angle) * flat,
        Math.sin(pitch) * launch,
        Math.cos(angle) * flat,
        config.soilLife * (0.6 + Math.random() * 0.8),
        0.5 + Math.random() * 1.1,
        SOIL,
        (Math.random() - 0.5) * 9
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

  /** One grain into the ring. */
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
    data[o + 8] = Math.max(0.05, life);
    data[o + 9] = size;
    data[o + 10] = kind;
    data[o + 11] = spin;

    this._head = (this._head + 1) % this.capacity;
    if (this._written < this.capacity) this._written++;
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
uniform vec3 uLightDir;
uniform float uDustDrag;
uniform float uSoilDrag;
uniform float uGravity;
uniform float uLift;
uniform float uDustSize;
uniform float uDustGrow;
uniform float uSoilSize;

attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute float aSeed;
attribute float aBirth;
attribute float aLife;
attribute float aSize;
attribute float aKind;
attribute float aSpin;

varying vec2 vShape;
varying float vSeed;
varying float vKind;
varying float vFade;
varying vec3 vLightView;

void main() {
  float age = uTime - aBirth;

  // Not yet born, already spent, or a slot never written. Folded to a
  // degenerate point outside the clip volume, which the rasteriser drops free.
  if (aLife <= 0.0 || age < 0.0 || age >= aLife) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vShape = vec2(0.0);
    vSeed = 0.0;
    vKind = 0.0;
    vFade = 0.0;
    vLightView = vec3(0.0, 1.0, 0.0);
    return;
  }

  float u = age / aLife;
  float kind = aKind;

  /* ---- the trajectory, in closed form ---- */
  // Drag and acceleration are both mixed between the two substances: dust is
  // held up by the air it is suspended in, soil is not.
  float k = mix(uDustDrag, uSoilDrag, kind);
  float decay = exp(-k * age);
  float impulse = (1.0 - decay) / k;
  vec3 accel = vec3(0.0, mix(uLift, uGravity, kind), 0.0);

  vec3 pos = aOrigin + aVelocity * impulse + accel * (age - impulse) / k;

  /* ---- how big, and how much is left ---- */
  // Dust swells as it spreads — that expansion *is* the read on a dust cloud,
  // and a puff that keeps its birth size reads as a thrown ball of wool. Soil
  // only loses a little as it tumbles away from the lens.
  float dust = uDustSize * mix(0.35, uDustGrow, pow(u, 0.55));
  float soil = uSoilSize * (1.0 - 0.3 * u);
  float size = mix(dust, soil, kind) * aSize;

  // Dust arrives over a moment and leaves over half its life; soil is simply
  // there and then gone. Fading a clod out slowly makes it read as more dust.
  float dustFade = smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.45, 1.0, u));
  float soilFade = smoothstep(0.0, 0.03, u) * (1.0 - smoothstep(0.8, 1.0, u));
  vFade = mix(dustFade, soilFade, kind);

  /* ---- the billboard, spun about its own axis ---- */
  vec4 viewPos = viewMatrix * vec4(pos, 1.0);
  float angle = aSpin * age + aSeed * 6.2831853;
  float c = cos(angle);
  float s = sin(angle);
  vec2 corner = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
  viewPos.xy += corner * size;
  gl_Position = projectionMatrix * viewPos;

  vShape = position.xy;
  vSeed = aSeed;
  vKind = kind;
  // The world's key, in the space the sprite's own normal is built in.
  vLightView = normalize((viewMatrix * vec4(uLightDir, 0.0)).xyz);
}
`;

/**
 * One grain: a torn silhouette, shaded as a little sphere.
 *
 * The two halves of the look are here and nowhere else. The **silhouette** is a
 * radial falloff with a noise field subtracted from it, offset by the grain's
 * own seed — which is what turns a circle into something billowed, and what
 * stops a hundred sprites from being a hundred copies of one sprite. The
 * **shading** takes the dome normal of the sprite in view space and lights it
 * with the frame's own key, so the cloud has a moonlit face and a dark one, and
 * lights up around its edges when the moon is behind it.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uColor;
uniform vec3 uShadeColor;
uniform vec3 uSoilColor;
uniform float uOpacity;

varying vec2 vShape;
varying float vSeed;
varying float vKind;
varying float vFade;
varying vec3 vLightView;

void main() {
  if (vFade <= 0.0) discard;

  float d = length(vShape);
  if (d > 1.0) discard;

  /* ---- the silhouette ---- */
  // Two octaves is enough: one gives lobes, two gives lobes with bites out of
  // them, and a third is invisible at the size these are drawn.
  vec3 field = vec3(vShape * 1.9, vSeed * 31.7);
  float n = snoise01(field) * 0.65 + snoise01(field * 2.7 + 11.0) * 0.35;

  // Both are eaten into by the noise, and both have to be — a clod that keeps
  // its quad's inscribed circle is a perfectly round black dot, which is the
  // single most obvious tell a particle system has. What separates the two is
  // the *edge*: dust feathers away over half its radius and soil stops dead, so
  // one reads as suspended powder and the other as a lump of ground.
  float bite = mix(0.42, 0.5, vKind);
  float edge = mix(0.5, 0.08, vKind);
  float shape = smoothstep(0.0, edge, (1.0 - d) - bite * (1.0 - n));
  if (shape <= 0.001) discard;

  /* ---- the shading ---- */
  // The sprite as a hemisphere facing the lens. It is a lie that costs one
  // square root and buys the single thing that makes dust read as volume.
  vec3 normal = vec3(vShape, sqrt(max(0.0, 1.0 - d * d)));
  // Wrapped rather than clamped: a grain of dust is lit from every side by the
  // sky, so its dark half is dim, not black.
  float lambert = dot(normal, vLightView) * 0.5 + 0.5;

  // And the backlight. Where the key points toward the lens, the thin edges of
  // a cloud scatter light forward and glow — which is most of why dust looks
  // expensive in a night shot.
  float back = clamp(-vLightView.z, 0.0, 1.0);
  float rim = pow(1.0 - abs(normal.z), 2.5) * back * 0.9;

  vec3 dust = mix(uShadeColor, uColor, lambert * lambert) + uColor * rim;
  // Soil catches the same moon, and has to: a clod lit by nothing is a hole in
  // the frame rather than a piece of earth in the air.
  vec3 soil = uSoilColor * (0.5 + 1.5 * lambert * lambert);
  vec3 color = mix(dust, soil, vKind);

  float alpha = shape * vFade * uOpacity * mix(1.0, 1.25, vKind);
  if (alpha < 0.004) discard;

  gl_FragColor = vec4(color, alpha);
}
`;
