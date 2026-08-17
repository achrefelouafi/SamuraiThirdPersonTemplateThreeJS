import {
  AddEquation,
  Color,
  CustomBlending,
  FrontSide,
  Matrix4,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { blackbodyGLSL } from '../shaders/lib/blackbody.glsl.js';

/**
 * How far past the flame's nominal thickness the shred can push density.
 * The proxy hull has to contain this or the volume is sliced off flat.
 */
export const FIRE_REACH = 1.6;

/**
 * The katana burning, raymarched as a black-body volume.
 *
 * The mesh this is applied to is **not** the flame — it is only a box that
 * contains it. Every fragment fires a ray from the camera through itself and
 * integrates emission and absorption through the field described below, which
 * is why the result has a genuine interior instead of being a stack of sprites:
 * the near face of the flame occludes its own far face, the core is white-hot
 * where the gas is thickest, and the whole thing turns to smoke at the tips.
 *
 * ## What the flame is wrapped around
 *
 * `DistanceField` bakes the faces the emitter box kept into a small 3D texture
 * of "how far is the steel from here". That is what makes this the *sword*
 * burning rather than a box of fire around it: the density is a function of
 * that distance, so the flame sheathes the blade, thins over the guard and
 * stops dead wherever the box stopped selecting faces.
 *
 * ## The four layers, coarsest first
 *
 *  1. *sheath* — density falls off with distance from the steel, over a
 *     thickness that widens with the gas's age. What that age is measured from
 *     is the whole trick: one extra tap back down the flow says whether this gas
 *     is *above* the blade or merely beside it, so the coating is drawn out into
 *     a plume off every flank of a sword held at any angle. Box extents alone
 *     cannot say it — a diagonal blade lies mostly along the flow.
 *  2. *silhouette* — one very low frequency octave swells and pinches that
 *     thickness. Without it the outline stays a smooth offset of the blade
 *     however much fine turbulence is piled on top.
 *  3. *turbulence* — five progressively domain-warped octaves, rotated between
 *     octaves to kill lattice alignment, each drifting downwind faster than the
 *     last so fine detail outruns the coarse shapes it rides on and tears into
 *     licking tongues.
 *  4. *shred* — erosion is weak against the steel and violent at the fringe, so
 *     the flame keeps a solid burning sheath while its edge dissolves into
 *     strands and detached wisps.
 *
 * ## Why it is shaded by temperature rather than by a palette
 *
 * Fire is not a colour, it is a temperature: the red fringe, orange body and
 * white core are what a grey body emits between about 1500 K and 3500 K, and
 * the enormous brightness range across them is the T⁴ of Stefan-Boltzmann. Both
 * fall out of `blackbody()` and `uEmissionCurve` instead of being dialled in,
 * which is why the flame holds together at any exposure.
 *
 * The corollary — the least obvious thing in this shader — is that radiated
 * power goes as a *high power* of temperature, so whatever drives temperature
 * has its contrast multiplied several-fold on screen. Point that amplifier at
 * turbulent noise and it lands on the noise's level sets, which are nested
 * closed loops, and the flame renders as polished agate: contour lines wrapping
 * every blob. So the temperature is carried by the distance field — geometry,
 * with no level sets of its own — and the noise is only allowed to *nudge* it,
 * from its two coarsest octaves alone (`uHeatFollow`).
 *
 * ## Which way the flame goes
 *
 * `uFlow` is not world up. It is the direction the gas actually streams, which
 * the CPU builds each frame from buoyancy *minus* the blade's own velocity: a
 * still sword plumes straight up, and a swung one lays its flame out behind the
 * edge. One uniform, and the flame answers to the animation.
 *
 * ## Two ways of asking "how far is the burning thing"
 *
 * Everything above is written against one function, `steelDistance()`, and the
 * shader does not care where its answer comes from. There are two sources:
 *
 *  - a **baked distance field** (`capsules: 0`, the katana's), which is exact to
 *    the model's triangles and costs one texture fetch — but has to be re-baked
 *    on the CPU whenever the surface moves, so it belongs to rigid props;
 *  - a **capsule skeleton** (`capsules: n`, the shadows'), a handful of tapered
 *    segments evaluated analytically, which costs a short loop per sample but
 *    follows a skinned body through every frame of animation for the price of
 *    uploading two vec4s per bone.
 *
 * A skinned character cannot use the first: the bake is tens of milliseconds and
 * the pose changes every frame. So the body is approximated instead of measured,
 * and everything downstream — sheath, plume, shred, temperature — is identical.
 */
export class VolumetricFireMaterial extends ShaderMaterial {
  /**
   * @param {object} [options]
   * @param {number} [options.capsules] how many capsule slots to compile in. 0
   *   (the default) wraps the flame around a baked `DistanceField` instead.
   */
  constructor({ capsules = 0 } = {}) {
    // The two sources need different uniforms, and a `sampler3D` left null is a
    // validation error on some drivers rather than an unused binding — so only
    // the one in use is declared.
    const shape =
      capsules > 0
        ? {
            /** xyz = end, w = radius there, in the blade frame. */
            uCapA: { value: new Float32Array(capsules * 4) },
            uCapB: { value: new Float32Array(capsules * 4) },
            uCapCount: { value: 0 },
            /** Metres the union is rounded over, so limbs melt into one body. */
            uWeld: { value: 0.08 }
          }
        : {
            uField: { value: null },
            uFieldMin: { value: new Vector3(-0.5, -0.5, -0.5) },
            uFieldSize: { value: new Vector3(1, 1, 1) },
            uBand: { value: 0.2 }
          };

    super({
      // Not `glslVersion: GLSL3`, even though the `sampler3D` below needs ES
      // 3.0: three compiles every ShaderMaterial as `#version 300 es` already,
      // and asking for it explicitly is what *removes* the `gl_FragColor` and
      // `varying` compatibility defines this shader is written against.
      transparent: true,
      depthWrite: false,
      // The march is carried by a proxy box half a metre bigger than the flame,
      // so testing the *hull's* depth is what put fire in front of the body: the
      // box's near face is well in front of a blade the character is standing
      // over. The shader writes `gl_FragDepth` at the flame's own visible front
      // instead, so the hardware test compares the body against the fire rather
      // than against its bounding box. It costs early-Z on the hull — a fragment
      // hidden behind the character now marches before it is rejected — which is
      // a few hundred pixels of a small on-screen box.
      // `WeaponFire` flips the side to a back-face march when the camera is
      // inside the hull; with the depth coming from the volume, that no longer
      // has to give up the depth test to do it.
      side: FrontSide,
      depthTest: true,
      // A real flame both emits and blocks, so this is premultiplied "over"
      // rather than the additive blending sprite effects use.
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      uniforms: {
        uTime: { value: 0 },
        uSeed: { value: Math.random() * 20 },

        /* the blade, and the frame everything is solved in */
        uWorldToBlade: { value: new Matrix4() },
        // The way back out, for putting the flame's front into the depth buffer.
        // `projectionMatrix` is a vertex-stage built-in, so the fragment stage
        // needs its own copy rather than three's.
        uBladeToWorld: { value: new Matrix4() },
        uProjection: { value: new Matrix4() },
        uCameraBlade: { value: new Vector3() },
        ...shape,
        uHalf: { value: new Vector3(0.05, 0.05, 0.45) },
        uHull: { value: new Vector3(0.3, 0.3, 0.7) },

        /* shape */
        uFlow: { value: new Vector3(0, 1, 0) },
        uThickness: { value: 0.05 },
        uPlume: { value: 2.4 },
        uSpread: { value: 1.1 },
        uLength: { value: 0.55 },
        uSoftness: { value: 0.45 },
        uShred: { value: 1.4 },
        uBulge: { value: 0.3 },
        uBulgeScale: { value: 7.0 },
        uDetachment: { value: 0.55 },

        /* motion */
        uBuoyancy: { value: 1.6 },
        uNoiseFrequency: { value: 14.0 },
        uNoiseStrength: { value: 0.85 },
        uWarp: { value: 0.22 },
        uTongue: { value: 2.2 },
        uLick: { value: 1.6 },
        uWisp: { value: 0.8 },
        uFlicker: { value: 0.5 },
        uOctaves: { value: 5 },

        /* temperature & radiance */
        uTempCore: { value: 3100 },
        uTempEdge: { value: 1500 },
        uEmissionCurve: { value: 3.4 },
        uHeatFocus: { value: 0.9 },
        uHeatFalloff: { value: 1.3 },
        uHeatFollow: { value: 0.22 },
        uTailHeat: { value: 0.3 },
        uPalette: { value: 0 },
        uScatter: { value: 1.2 },
        uScatterFalloff: { value: 3.0 },

        /* rendering */
        uDensity: { value: 2.2 },
        uSoot: { value: 1.4 },
        uCoreClarity: { value: 0.55 },
        uEmission: { value: 3.2 },
        uOpacity: { value: 1 },
        uSteps: { value: 40 },

        uColorCore: { value: new Color('#fff6d8') },
        uColorMid: { value: new Color('#ffb02e') },
        uColorEdge: { value: new Color('#ff3d10') },
        uColorSmoke: { value: new Color('#181616') }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT(capsules)
    });

    /** How many capsule slots were compiled in; 0 for the baked field. */
    this.capsuleCount = capsules;
  }
}

/* -------------------------------------------------------------------- */

const VERTEX = /* glsl */ `
uniform mat4 uWorldToBlade;
varying vec3 vBlade;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  // Every ray is solved in the blade's own frame: axis-aligned against the box,
  // metric, and moving with the animation for free.
  vBlade = (uWorldToBlade * world).xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT_HEAD = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform mat4 uBladeToWorld;
uniform mat4 uProjection;
uniform vec3 uCameraBlade;
uniform vec3 uHalf;
uniform vec3 uHull;

uniform vec3 uFlow;
uniform float uThickness;
uniform float uPlume;
uniform float uSpread;
uniform float uLength;
uniform float uSoftness;
uniform float uShred;
uniform float uBulge;
uniform float uBulgeScale;
uniform float uDetachment;

uniform float uBuoyancy;
uniform float uNoiseFrequency;
uniform float uNoiseStrength;
uniform float uWarp;
uniform float uTongue;
uniform float uLick;
uniform float uWisp;
uniform float uFlicker;
uniform float uOctaves;

uniform float uTempCore;
uniform float uTempEdge;
uniform float uEmissionCurve;
uniform float uHeatFocus;
uniform float uHeatFalloff;
uniform float uHeatFollow;
uniform float uTailHeat;
uniform float uPalette;
uniform float uScatter;
uniform float uScatterFalloff;

uniform float uDensity;
uniform float uSoot;
uniform float uCoreClarity;
uniform float uEmission;
uniform float uOpacity;
uniform float uSteps;

uniform vec3 uColorCore;
uniform vec3 uColorMid;
uniform vec3 uColorEdge;
uniform vec3 uColorSmoke;

varying vec3 vBlade;

/* How much light has to be stopped before the gas counts as the flame's front
   for depth purposes — 15%. Low enough that a tongue reads as being where it
   looks like it is, high enough that the invisible haze around it does not. */
const float FLAME_FRONT = 0.85;

${noiseGLSL}
${blackbodyGLSL}

/* A volume march needs a *cheap* field: trilinear value noise on a hashed
   lattice, roughly a third of the cost of the simplex the surface shaders use
   and indistinguishable once five octaves of it are warped and advected. */
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);

  float a = hash13(i);
  float b = hash13(i + vec3(1.0, 0.0, 0.0));
  float c = hash13(i + vec3(0.0, 1.0, 0.0));
  float d = hash13(i + vec3(1.0, 1.0, 0.0));
  float e = hash13(i + vec3(0.0, 0.0, 1.0));
  float g = hash13(i + vec3(1.0, 0.0, 1.0));
  float h = hash13(i + vec3(0.0, 1.0, 1.0));
  float k = hash13(i + vec3(1.0, 1.0, 1.0));

  return mix(
    mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
    mix(mix(e, g, f.x), mix(h, k, f.x), f.y),
    f.z
  );
}

/* Value noise lives on an axis-aligned lattice, so stacking octaves along the
   same axes lines their features up into a visible grid. */
const mat3 OCTAVE_ROT = mat3(
   0.00,  0.80,  0.60,
  -0.80,  0.36, -0.48,
  -0.60, -0.48,  0.64
);

/**
 * Turbulent flame field, 0..1.
 *
 * Three things separate it from a plain fbm, two of them free because they
 * reuse octave values already paid for: progressive domain warping (each octave
 * displaced by the one before, which folds the field over itself — straight fbm
 * makes clouds, warped fbm makes billowing sheets), buoyant shear (every octave
 * drifts downwind faster than the last, so fine detail outruns the coarse
 * shapes it rides on and tears into tongues), and inter-octave rotation.
 *
 * @param ridge out — sharp filaments from the two finest octaves, for shredding
 *              the fringe into strands.
 * @param coarse out — the field truncated to its two largest scales. Temperature
 *              reads off this rather than the full field; see the class notes.
 */
float flameFbm(vec3 p, vec3 rise, out float ridge, out float coarse) {
  float v = 0.0;
  float a = 0.5;
  float norm = 0.0;
  float scale = 1.0;
  ridge = 0.0;
  coarse = 0.5;

  for (int i = 0; i < 5; i++) {
    if (float(i) >= uOctaves) break;

    float n = vnoise(p);
    v += a * n;
    norm += a;
    if (i == 1) coarse = v / norm;
    // Ridges from the finest octaves alone: averaging the coarse ones in gives
    // broad ridges that trace the field's iso-lines, and those read as contour
    // lines drawn on the flame rather than as strands in it.
    if (i >= 3) ridge = max(ridge, 1.0 - abs(n * 2.0 - 1.0));

    p = OCTAVE_ROT * p * 2.17 + (n - 0.5) * uWarp * vec3(1.7, 0.9, 1.3);
    scale *= 2.17;
    p -= rise * scale * (1.0 + 0.6 * float(i));
    a *= 0.55;
  }

  return v / max(norm, 1e-4);
}
`;

/**
 * How far the steel is from a point in the blade's frame, read out of the baked
 * field.
 *
 * Past the edge of the grid the texture clamps, which means the last voxel's
 * distance is smeared out to infinity in every direction — and since that voxel
 * is only a band away from the blade, the flame grows a faint rectangular fog
 * in the exact shape of the grid. Adding the distance back to the grid instead
 * says the true thing: out here there is no steel at all.
 */
const SOURCE_FIELD = /* glsl */ `
precision highp sampler3D;

uniform sampler3D uField;
uniform vec3 uFieldMin;
uniform vec3 uFieldSize;
uniform float uBand;

float steelDistance(vec3 p) {
  vec3 uvw = (p - uFieldMin) / uFieldSize;
  vec3 outside = max(abs(uvw - 0.5) - 0.5, 0.0) * uFieldSize;
  return texture(uField, clamp(uvw, 0.0, 1.0)).r * uBand + length(outside);
}
`;

/**
 * The same question answered off a capsule skeleton instead.
 *
 * Each capsule is a segment with a radius at either end, so a limb tapers the
 * way the body it stands for does. They are unioned with a *smooth* minimum
 * rather than a plain one, and that is not cosmetic: a hard union leaves a
 * crease along every joint, the distance gradient turns a corner there, and the
 * flame draws a bright seam down the inside of every elbow and hip. Rounding the
 * union over `uWeld` metres is what makes the set read as one body.
 *
 * The loop is bounded by a compile-time count and cut short by a uniform
 * compare, so a rig with fewer capsules than slots costs only the compare —
 * every lane in the warp takes the same branch.
 */
const SOURCE_CAPSULES = (count) => /* glsl */ `
uniform vec4 uCapA[${count}];
uniform vec4 uCapB[${count}];
uniform int uCapCount;
uniform float uWeld;

float steelDistance(vec3 p) {
  float k = max(uWeld, 1e-4);
  float d = 1e4;

  for (int i = 0; i < ${count}; i++) {
    if (i >= uCapCount) break;

    vec3 a = uCapA[i].xyz;
    vec3 ba = uCapB[i].xyz - a;
    vec3 pa = p - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
    float seg = length(pa - ba * h) - mix(uCapA[i].w, uCapB[i].w, h);

    float t = clamp(0.5 + 0.5 * (d - seg) / k, 0.0, 1.0);
    d = mix(d, seg, t) - k * t * (1.0 - t);
  }

  // The field the march is written against is unsigned — 0 on the surface and
  // growing outward — so the inside of the body is simply "at the burn".
  return max(d, 0.0);
}
`;

const FRAGMENT_TAIL = /* glsl */ `
/**
 * Density of the flame at a point in the blade's frame.
 *
 * @param heat out — normalised temperature, 1 against the steel, 0 at the
 *             perturbed outer surface.
 * @param bath out — how strongly this point is lit by the flame around it, for
 *             the single-scatter term.
 */
float flameSample(vec3 p, out float heat, out float bath) {
  heat = 0.0;
  bath = 0.0;

  // Squash space along the flow before asking how far the steel is: gas a long
  // way downwind still finds the blade close, which is what draws a coating out
  // into a plume.
  //
  // Only what is *past the blade* is compressed. Scaling the whole coordinate
  // instead — the obvious version — folds the katana itself into a stub a third
  // of its length, and every point beside the blade then reports the distance
  // to some other part of it: the flame comes out as one fat sausage with no
  // sword in it. support is the blade's own extent along the flow, so inside
  // that span the lookup is left exactly alone.
  float along = dot(p, uFlow);
  vec3 lateral = p - uFlow * along;
  float support = dot(uHalf, abs(uFlow));
  float excess = max(along - support, 0.0);
  float squashed = along - excess * (1.0 - 1.0 / max(uPlume, 1.0));
  vec3 probe = lateral + uFlow * squashed;
  float dist = steelDistance(probe);

  // The widest the sheath can be made by age and by the silhouette lobes,
  // doubled — past it the edge cull further down rejects the sample whatever
  // the rest of this function works out. Answering here instead saves
  // the second field tap, and out here is where most of a ray is spent: the
  // hull has to be big enough for the plume's full reach, so the great majority
  // of samples are in empty gas. Free on the katana, and half the cost of the
  // march on a body, where every tap is a loop over the capsules.
  if (dist > uThickness * (1.0 + uSpread) * (1.0 + abs(uBulge)) * 2.0) return 0.0;

  // One tap back down the flow, and the most important one in the shader.
  //
  // Gas *above* the blade finds the steel nearer when it drops; gas beside the
  // blade finds it the same distance whichever way along the flow it moves. So
  // this one difference is what separates a plume from a coating — and on a
  // sword it is the *only* thing that can. The box's own extent cannot: a blade
  // held at any angle but flat lies mostly *along* the flow, so the excess above
  // is zero over almost all of it, and a flame driven by that alone comes out
  // as a uniform sheath with no tongues anywhere except off the very tip.
  float below = steelDistance(probe - uFlow * uThickness);
  float climbing = clamp((dist - below) / max(uThickness, 1e-4), 0.0, 1.0);

  // How far downwind of the steel this gas has travelled: the flame's own age,
  // and what every cooling and tearing term below is driven by. Either it is
  // past the end of the blade, or it has climbed off the flank — whichever has
  // carried it further from the burn.
  float climbed = climbing * dist / max(uThickness * uPlume, 1e-4);
  float age = clamp(max(excess / max(uLength, 0.02), climbed), 0.0, 1.0);

  float thickness = uThickness * (1.0 + uSpread * age);

  // Metre-scale lobes in the silhouette. Without them the outline stays a
  // smooth offset of the blade however much fine turbulence is piled on.
  float lobe = vnoise(p * uBulgeScale + vec3(uSeed, uTime * 0.35, 0.0)) * 2.0 - 1.0;
  thickness *= 1.0 + uBulge * lobe;

  float q = dist / max(thickness, 1e-4);
  float edge = 1.0 - q;
  if (edge < -1.0) return 0.0;

  // Noise domain, anchored to the blade so the fire travels with the sword,
  // stretched along the flow so every structure is drawn out into a tongue, and
  // sheared outward: gas at the fringe is unconfined and has been climbing
  // longer than gas against the steel, which is what makes the edge lick.
  vec3 np = (lateral + uFlow * (along / max(uTongue, 0.05))) * uNoiseFrequency;
  np -= uFlow * (uLick * q * q);
  vec3 rise = uFlow * (uTime * uBuoyancy * 0.06);
  np -= uFlow * (uTime * uBuoyancy);

  float ridge, coarse;
  float n = flameFbm(np, rise, ridge, coarse) * 2.0 - 1.0;
  coarse = coarse * 2.0 - 1.0;

  // Filaments belong to the fringe; in the body they only mottle a sheath that
  // should read as one continuous sheet of burning gas. Note the sign: the ridge
  // peaks *on* an iso-line, so adding it draws the flame in bright closed loops
  // like a contour map. Subtracting deepens the gaps between lobes instead,
  // which is what actually separates the fringe into strands.
  float fringe = smoothstep(0.25, 1.0, q);
  float turbulent = n * 0.75 + (0.5 - ridge) * uWisp * fringe;

  // The heart of the flame is barely touched by the noise while the fringe is
  // torn apart by it. That contrast is most of what reads as fire. The falloff
  // past REACH is what bounds how far outside the sheath density can be pushed,
  // and therefore how big the proxy hull has to be.
  float shred = mix(mix(0.22, 1.0, age), 1.8 * uShred, smoothstep(0.05, 1.0, q))
              * (1.0 - smoothstep(1.15, 1.6, q));
  float erosion = uNoiseStrength * shred * (1.0 + 1.3 * age);
  float field = edge + turbulent * erosion;
  field -= uDetachment * age * 0.6;              // the tips tear into puffs

  // Temperature gets its own, deliberately blunter field — see the class notes
  // on why this is not simply the density.
  float heatField = edge + coarse * uHeatFollow * uNoiseStrength * shred
                  - uDetachment * age * 0.6;

  float d = smoothstep(0.0, clamp(uSoftness, 0.05, 1.0), field);
  if (d <= 0.0) return 0.0;

  float interior = clamp(heatField * uHeatFocus, 0.0, 1.0);
  // Spent gas has mixed: it no longer has a hot core and a cool skin, it is all
  // roughly one temperature and simply dimming. Flattening the profile with age
  // is also what keeps the thin tips from rendering as nested shells.
  interior = mix(interior, 0.55, age * age * 0.7);
  float cool = mix(1.0, uTailHeat, pow(age, 0.7));
  heat = clamp(pow(interior, max(uHeatFalloff, 0.05)) * cool, 0.0, 1.0);

  // Cool gas close to the burn is bathed in its light; without this the sooty
  // fringe goes flat black instead of glowing.
  bath = exp(-max(q - 0.4, 0.0) * uScatterFalloff) * (1.0 - heat);

  return d * uDensity;
}

void main() {
  vec3 ro = uCameraBlade;
  vec3 rd = normalize(vBlade - ro);

  // Slab test against the hull, in the box's own axes. The march window comes
  // from this rather than from the hull's triangles, so the geometry only has
  // to *cover* the volume on screen — it never shapes it.
  vec3 inv = 1.0 / rd;
  vec3 s0 = (-uHull - ro) * inv;
  vec3 s1 = ( uHull - ro) * inv;
  vec3 lo = min(s0, s1);
  vec3 hi = max(s0, s1);
  float tEnter = max(max(lo.x, lo.y), lo.z);
  float tExit = min(min(hi.x, hi.y), hi.z);
  tEnter = max(tEnter, 0.0);
  if (tExit <= tEnter) discard;

  float steps = clamp(uSteps, 8.0, 64.0);
  float baseStep = (tExit - tEnter) / steps;
  // Dither the entry: a fixed start turns the slices into visible onion rings,
  // a per-pixel offset turns them into grain the bloom eats.
  float t = tEnter + baseStep * hash13(vec3(gl_FragCoord.xy, fract(uTime) * 64.0));

  // One flicker for the whole ray — the flame brightens and dims as a body, not
  // per sample. Two rates: a slow roll from the bulk of the gas, a fast tremor
  // from the burn itself.
  float flickN = vnoise(vec3(uTime * 5.3, uSeed, 0.0)) * 0.7
               + vnoise(vec3(uTime * 13.1, uSeed * 2.0, 5.0)) * 0.3;
  float flick = clamp(1.0 + uFlicker * 0.6 * (flickN * 2.0 - 1.0), 0.4, 1.7);

  vec3 acc = vec3(0.0);
  float transmittance = 1.0;
  // Where along the ray the flame becomes something you can see — the surface
  // the depth buffer should hold this pixel at. tFirst is the first sample
  // with any density at all, and is only the fallback for a wisp so thin it
  // never reaches FLAME_FRONT: pinning the depth to the very first faint sample
  // would put the whole plume at the near edge of its own haze, and the fire
  // would win against the body again.
  float tFront = -1.0;
  float tFirst = -1.0;
  // The hull is wide enough for the noise to push the volume out to its full
  // reach, which leaves most rays crossing a lot of empty space. Coasting
  // through it at a coarser stride — and dropping back the moment anything is
  // hit — buys back the cost of that headroom.
  float stride = 1.0;

  for (int i = 0; i < 64; i++) {
    if (t >= tExit || transmittance < 0.012) break;

    float heat, bath;
    float d = flameSample(ro + rd * t, heat, bath);
    float stepSize = baseStep * stride;

    if (d > 0.002) {
      stride = 1.0;
      stepSize = baseStep;
      if (tFirst < 0.0) tFirst = t;

      float kelvin = mix(uTempEdge, uTempCore, heat);
      // The palette blend keeps the editor's four stops meaningful without
      // letting them fight the physics: 0 is a pure radiator, 1 the ramp.
      vec3 artistic = gradient4(uColorCore, uColorMid, uColorEdge, uColorSmoke,
                                pow(1.0 - heat, 0.85));
      vec3 tint = mix(blackbody(kelvin), artistic, clamp(uPalette, 0.0, 1.0));

      // Stefan-Boltzmann. This exponent is what gives the volume its internal
      // dynamic range: a white-hot core many times brighter than the red gas a
      // centimetre outside it.
      vec3 emission = tint * radiance(kelvin, uTempCore, uEmissionCurve);

      // Single scatter: the sooty gas wrapped around the burn does not radiate,
      // it reflects. Without this the fringe collapses to flat black.
      emission += mix(uColorEdge, uColorMid, bath) * uScatter * bath * bath * 0.06;

      acc += emission * uEmission * flick * d * transmittance * stepSize;

      // Soot extinction. Squared in heat, so only genuinely white-hot gas turns
      // clear: fading it linearly thins the merely warm gas on the near face
      // too, and that gas is what draws the dark filaments across the interior.
      transmittance *= exp(-d * uSoot * mix(1.0, uCoreClarity, heat * heat) * stepSize);
      if (tFront < 0.0 && transmittance < FLAME_FRONT) tFront = t;
    } else {
      stride = min(stride * 1.6, 2.4);
    }

    t += stepSize;
  }

  float alpha = clamp((1.0 - transmittance) * uOpacity, 0.0, 1.0);
  vec3 color = acc * uOpacity;
  if (alpha < 0.002 && max(color.r, max(color.g, color.b)) < 0.002) discard;

  // The pixel sits where the flame's front is, not where the proxy box is. This
  // is one depth for the whole ray, so a ray that runs *through* the character —
  // flame in front of the shoulder and more flame behind it — is drawn whole
  // rather than clipped mid-march. Occlusion is therefore decided by the near
  // face of the gas, which is the surface being looked at, and the error is
  // confined to gas the near face was already hiding.
  float tDepth = tFront >= 0.0 ? tFront : max(tFirst, tEnter);
  vec4 clip = uProjection * viewMatrix * uBladeToWorld * vec4(ro + rd * tDepth, 1.0);
  // Behind the eye — the camera is standing inside the flame. Nothing can be in
  // front of that, so claim the near plane instead of dividing by a negative w.
  gl_FragDepth = clip.w > 1e-6 ? clamp(clip.z / clip.w, -1.0, 1.0) * 0.5 + 0.5 : 0.0;

  gl_FragColor = vec4(color, alpha);
}
`;

/**
 * The whole shader, with whichever distance source was asked for spliced into
 * the middle of it. Everything on both sides of that splice is shared source,
 * which is what keeps a burning sword and a burning body the same fire.
 */
const FRAGMENT = (capsules) =>
  `${FRAGMENT_HEAD}\n${capsules > 0 ? SOURCE_CAPSULES(capsules) : SOURCE_FIELD}\n${FRAGMENT_TAIL}`;
