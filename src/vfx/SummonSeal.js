import { AdditiveBlending, Color, DoubleSide, Mesh, PlaneGeometry, ShaderMaterial } from 'three';

import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor } from '../utils/color.js';

/**
 * A magic circle, lying flat in the air.
 *
 * One quad, one draw call, and no texture anywhere: every ring, tick, rune and
 * spoke below is arithmetic on the polar coordinate of the fragment. That is
 * not thrift for its own sake — a seal drawn as a sprite is stuck at the
 * resolution it was authored at, and this one is walked *under* at two metres,
 * where a 1K texture is a blurred smear and a `smoothstep` is a clean line.
 *
 * ## What is on it
 *
 * Four bands, from the outside in, each turning at its own rate and against its
 * neighbour — which is the whole reason it reads as machinery rather than as a
 * spinning decal:
 *
 *  - **the rim** — two rings a hair apart, the outer one solid.
 *  - **the ticks** — `ticks` marks around the rim, every fourth one longer. The
 *    measure on a dial, and what gives the eye something to judge the spin by.
 *  - **the runes** — `runes` glyphs, each one a handful of strokes chosen by a
 *    hash of its own index. They are not a font and they do not mean anything;
 *    they are *consistent*, which is the only thing writing has to be to read
 *    as writing at this distance.
 *  - **the spokes and the star** — long radial lines, and two counter-rotated
 *    triangles through the middle.
 *
 * ## Opening
 *
 * The circle draws itself. `open` runs 0..1 and is the fraction of a turn that
 * has been struck so far, with a bright head at the leading edge — so the seal
 * is *written* into the air anticlockwise from the top rather than fading in.
 * The mesh is scaled on the same beat by the owner, so it irises out at the
 * same time. Nothing is drawn ahead of the head, tick and rune alike, which
 * means the pattern arrives in the order a hand would have drawn it.
 *
 * ## What it owns
 *
 * Nothing. It is a mesh and a set of uniforms; where it hangs, how far into the
 * opening it is and when something comes through are all told to it once a
 * frame by `vfx/Judgement.js`. It never allocates after construction.
 */
export class SummonSeal {
  constructor() {
    // Flat in XZ. One quad: the shape is entirely in the fragment shader, so
    // there is nothing for more vertices to describe.
    const geometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // Depth-tested, which is what lets the arm coming through occlude the
      // middle of the circle from below without a line of code: the fist is
      // opaque and drawn first, and it is clipped at exactly this plane.
      depthTest: true,
      // Hung overhead and walked under, so it is seen from both faces.
      side: DoubleSide,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: new Color('#8f5bff') },
        uCoreColor: { value: new Color('#efe4ff') },
        uIntensity: { value: 2.1 },
        /** 0..1 — the fraction of the turn that has been drawn. */
        uOpen: { value: 0 },
        /** 0..1 — how hard it is gathering. Brightens and tightens the haze. */
        uCharge: { value: 0 },
        /** 0..1 — a ripple travelling out from where something came through. */
        uPunch: { value: 0 },
        /** Master, for the close. */
        uFade: { value: 1 },
        uTime: { value: 0 },
        uSpin: { value: 0.22 },
        uTicks: { value: 48 },
        uRunes: { value: 12 },
        uSpokes: { value: 6 },
        uWidth: { value: 0.012 },
        uSoftness: { value: 0.01 },
        uHaze: { value: 0.35 },
        uDetail: { value: 0.45 },
        uPulse: { value: 0.18 },
        uPulseSpeed: { value: 5 },
        /** Reshuffles every glyph on the circle. One number, one new seal. */
        uSeed: { value: 17.3 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'SummonSeal';
    // It follows a body around the world, and it is scaled from nothing on the
    // way in — neither of which a bounding sphere built at the origin survives.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
  }

  /**
   * Where it hangs and which way round it is.
   *
   * @param {number} x world
   * @param {number} y
   * @param {number} z
   * @param {number} yaw radians about +Y — only the runes and ticks can tell,
   *   which is exactly why it is worth turning: two casts in a row should not
   *   put the same glyph over the same shoulder.
   */
  place(x, y, z, yaw = 0) {
    this.mesh.position.set(x, y, z);
    this.mesh.rotation.y = yaw;
  }

  /**
   * @param {object} config `settings.judgement.seal`
   * @param {object} state
   * @param {number} state.open 0..1, the fraction of the circle drawn
   * @param {number} state.scale 0..1 on the radius, so it can iris out
   * @param {number} state.charge 0..1
   * @param {number} state.punch 0..1, decaying, after something came through
   * @param {number} state.fade master
   * @param {number} elapsed the shared clock
   */
  update(config, { open = 0, scale = 1, charge = 0, punch = 0, fade = 1 }, elapsed = 0) {
    const u = this.material.uniforms;

    // Nothing to draw, and nothing to pay for: an invisible mesh is not
    // traversed for a draw call at all.
    this.mesh.visible = fade > 0.001 && scale > 0.001;
    if (!this.mesh.visible) return;

    // The quad is a unit square, so the diameter is the scale. Flat in XZ, so
    // the Y term is left alone.
    const diameter = Math.max(0.01, config.radius) * 2 * scale;
    this.mesh.scale.set(diameter, 1, diameter);

    copyColor(u.uColor.value, config.color);
    copyColor(u.uCoreColor.value, config.coreColor);
    u.uIntensity.value = config.intensity;
    u.uOpen.value = open;
    u.uCharge.value = charge;
    u.uPunch.value = punch;
    u.uFade.value = fade;
    u.uTime.value = elapsed;
    u.uSpin.value = config.spin;
    u.uTicks.value = Math.max(1, Math.round(config.ticks));
    u.uRunes.value = Math.max(1, Math.round(config.runes));
    u.uSpokes.value = Math.max(1, Math.round(config.spokes));
    u.uWidth.value = Math.max(0.001, config.width);
    u.uSoftness.value = Math.max(0.001, config.softness);
    u.uHaze.value = config.haze;
    u.uDetail.value = config.detail;
    u.uPulse.value = config.pulse;
    u.uPulseSpeed.value = config.pulseSpeed;
  }

  /** A fresh set of glyphs, for the next cast. */
  reseed() {
    this.material.uniforms.uSeed.value = Math.random() * 128;
  }

  /** Off, immediately — for leaving the stage. */
  clear() {
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/* -------------------------------------------------------------------- */

const VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * The whole seal.
 *
 * Everything below works in a unit disc — `p` in [-1, 1], `r` the radius and
 * `turn` the angle as a fraction of one revolution starting at the top. Two
 * helpers do all the drawing: `band`, a soft line at a value, and `seg`, the
 * distance to a line segment, which is what the glyphs are made of.
 *
 * Widths are given in *radius* units and divided by `r` wherever they are used
 * as angles, so a stroke is the same thickness at the rim as it is at the
 * middle. Without that every radial mark on the circle is a wedge.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uIntensity;
uniform float uOpen;
uniform float uCharge;
uniform float uPunch;
uniform float uFade;
uniform float uTime;
uniform float uSpin;
uniform float uTicks;
uniform float uRunes;
uniform float uSpokes;
uniform float uWidth;
uniform float uSoftness;
uniform float uHaze;
uniform float uDetail;
uniform float uPulse;
uniform float uPulseSpeed;
uniform float uSeed;

varying vec2 vUv;

const float TAU = 6.28318530718;

/** A soft line of half-width w, centred on "centre". */
float band(float x, float centre, float w, float soft) {
  return 1.0 - smoothstep(w, w + soft, abs(x - centre));
}

/** How near p is to the segment a-to-b, as a stroke of half-width w. */
float seg(vec2 p, vec2 a, vec2 b, float w, float soft) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return 1.0 - smoothstep(w, w + soft, length(pa - ba * h));
}

/**
 * A radial stroke every 1/count of a turn.
 *
 * w is a thickness in radius units; dividing it by r turns it into an angle
 * that keeps the mark the same width however far out it is drawn.
 */
float rays(float turn, float count, float phase, float r, float w, float soft) {
  float s = fract(turn * count + phase);
  float halfW = (w / max(r, 0.02)) / TAU * count;
  return 1.0 - smoothstep(halfW, halfW + soft * count * 0.25, abs(s - 0.5));
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;

  // 0 at the top, running anticlockwise. The seal is written in this direction.
  float turn = fract(atan(p.y, p.x) / TAU + 0.25);

  float w = uWidth;
  float soft = uSoftness;
  float spin = uTime * uSpin;

  /* ---- what has been drawn so far ---- */
  // Nothing exists ahead of the head, so the pattern arrives in the order a
  // hand would have struck it. At uOpen 1 the whole circle is past the head.
  float drawn = uOpen >= 1.0 ? 1.0 : 1.0 - smoothstep(uOpen - 0.03, uOpen, turn);
  // And the head itself: a bright point running round the rim as it writes.
  float pen = uOpen >= 1.0 ? 0.0 : band(turn, uOpen, 0.004, 0.02) * smoothstep(0.0, 0.05, uOpen);

  float lines = 0.0;
  float core = 0.0;

  /* ---- the rim ---- */
  lines += band(r, 0.975, w, soft);
  lines += band(r, 0.925, w * 0.6, soft) * 0.55;

  /* ---- the ticks ---- */
  {
    float phase = spin;
    float index = floor(turn * uTicks + phase);
    // Every fourth mark reaches further in, which is what turns a fringe into
    // a scale you can read the rotation off.
    float major = step(3.5, mod(index, 4.0));
    float inner = mix(0.945, 0.905, major);
    float reach = step(inner, r) * step(r, 0.972);
    lines += rays(turn, uTicks, phase, r, w * 0.55, soft) * reach * mix(0.5, 0.95, major);
  }

  /* ---- the runes ---- */
  // Against the ticks, and slower: two bands turning the same way read as one
  // band, and the counter-rotation is most of what makes the thing look built.
  {
    float mid = 0.745;
    float phase = -spin * 0.55;
    float cell = turn * uRunes + phase;
    float index = floor(cell);
    // The glyph's own little frame: x runs across the sector as an arc length,
    // y out from the middle of the band — both in radius units, so a rune is
    // the same size and shape wherever it happens to have turned to.
    vec2 q = vec2((fract(cell) - 0.5) * (TAU * mid / uRunes), r - mid);

    if (abs(q.y) < 0.13 && abs(q.x) < 0.13) {
      float h = hash11(index + uSeed);
      float h2 = hash11(index * 3.1 + uSeed + 11.0);
      float gw = w * 0.7;

      // The spine, always. Everything else is a coin toss, and the tosses are
      // stable per glyph — so a rune is the same rune every time it comes round.
      float g = seg(q, vec2(0.0, -0.075), vec2(0.0, 0.075), gw, soft);
      if (h < 0.72) g = max(g, seg(q, vec2(-0.055, 0.035), vec2(0.055, 0.035), gw, soft));
      if (h2 < 0.6) g = max(g, seg(q, vec2(-0.05, -0.03), vec2(0.05, -0.03), gw, soft));
      if (h2 > 0.72) g = max(g, seg(q, vec2(-0.05, 0.075), vec2(0.05, -0.02), gw, soft));
      if (h > 0.55) g = max(g, seg(q, vec2(0.04, -0.075), vec2(0.04, -0.05), gw * 1.5, soft));

      lines += g * 0.9;
    }

    // The two rails the writing sits between.
    lines += band(r, 0.878, w * 0.5, soft) * 0.45;
    lines += band(r, 0.612, w * 0.5, soft) * 0.45;
  }

  /* ---- the spokes and the star ---- */
  {
    float phase = spin * 1.7;
    float reach = step(0.30, r) * step(r, 0.60);
    lines += rays(turn, uSpokes, phase, r, w * 0.8, soft) * reach * 0.7;

    // Two triangles, turned against each other. The distance to a regular
    // polygon is one fold of the angle and one cosine — a hexagram for the
    // price of two lines of arithmetic.
    float an = 3.14159265 / 3.0;
    float t1 = mod(atan(p.y, p.x) + spin * 1.1 + an, 2.0 * an) - an;
    float t2 = mod(atan(p.y, p.x) - spin * 1.1 + an, 2.0 * an) - an;
    lines += band(r * cos(t1), 0.26, w * 0.7, soft) * step(r, 0.56) * 0.8;
    lines += band(r * cos(t2), 0.26, w * 0.7, soft) * step(r, 0.56) * 0.8;

    lines += band(r, 0.30, w * 0.6, soft) * 0.5;
  }

  /* ---- the light pooled inside ---- */
  // Mottled, so the glow inside the circle is alive rather than a flat disc,
  // and pulled in tight as the thing gathers.
  {
    float n = snoise01(vec3(p * 2.6, uTime * 0.35 + uSeed));
    float mottle = mix(1.0, 0.45 + 1.1 * n, clamp(uDetail, 0.0, 1.0));
    float pool = pow(1.0 - clamp(r, 0.0, 1.0), mix(2.6, 1.4, uCharge));
    core += pool * uHaze * mottle * (0.5 + uCharge);
  }

  /* ---- something came through ---- */
  // A ripple leaving the middle, and the rim lighting up behind it. Both die
  // with uPunch, which the owner runs down over a fraction of a second.
  if (uPunch > 0.001) {
    float wave = band(r, uPunch, 0.05, 0.11) * (1.0 - uPunch);
    core += wave * 1.5;
    lines += wave * 0.7;
  }

  /* ---- put together ---- */
  float breath = 1.0 - uPulse * (0.5 - 0.5 * cos(uTime * uPulseSpeed));
  float gain = uIntensity * uFade * breath * (1.0 + uCharge * 0.6);

  // The lines are the seal's own colour; the head, the pool and the ripple run
  // to the core colour, so the circle is violet and what is happening *in* it
  // is white. One picker for each, and they never fight.
  vec3 rgb = uColor * (lines * drawn) + uCoreColor * (core * drawn + pen * 2.2);
  float a = (lines * drawn + core * drawn + pen * 2.2) * gain;
  if (a < 0.003) discard;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, a);
}
`;
