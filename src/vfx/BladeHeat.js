import { Color, Matrix4, Vector3 } from 'three';

import { blackbodyGLSL } from '../shaders/lib/blackbody.glsl.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';

/**
 * The steel itself, glowing.
 *
 * Look at any photograph of a burning blade and the thing that sells it is not
 * the flame — it is that the *metal is a light source*. The edge runs as a
 * white-hot filament, the hamon and the handle wrap read as glowing lines
 * because their relief is hotter than the ground around them, and the whole
 * sword sits inside its own halo. Fire alone, with a dark object inside it,
 * always reads as a sprite pasted over a prop; this is what puts the object
 * *inside* the effect.
 *
 * ## What it actually does
 *
 * The weapon's materials are left exactly as they are — lit, textured, shadowed
 * — and one term is added to their emissive radiance:
 *
 *  1. *where* — the same emitter box that decides which faces burn, in world
 *     space, with a soft edge. Slide the box down the blade and the heat retreats
 *     down the blade with the flame, in the same gesture and by the same numbers.
 *  2. *how hot* — a slow two-octave field crawling along the blade, so the heat
 *     is uneven and alive rather than a flat wash.
 *  3. *the edge* — grazing angles run hotter. On a blade the silhouette *is* the
 *     cutting edge and the spine, which is exactly where a real one glows first,
 *     so a Fresnel term costs nothing and lands in the right place.
 *  4. *the relief* — the albedo modulates temperature. Hot metal is not uniform:
 *     the raised diamonds of the tsuka-ito and the temper line are lighter in the
 *     map and come out brighter here, which is what draws the wrap pattern as
 *     glowing lattice instead of an orange blob.
 *
 * Temperature then goes through the shared radiator, so the steel is on the same
 * physical scale as the flame around it: at 1600 K it is the dull red of the
 * plume's fringe, at 3000 K the white of its core, and nobody matched a swatch.
 *
 * ## Why the materials are cloned
 *
 * The GLB shares material instances with the *body* (see `EquipmentLibrary`) —
 * the katana's steel is the same object as the armour's. Patching in place would
 * set the character on fire too. So every material on the burning model is
 * cloned once, the clone is patched, and `detach()` puts the originals back the
 * moment the weapon is unequipped.
 */
export class BladeHeat {
  constructor() {
    this.uniforms = {
      uHeatTime: { value: 0 },
      /** world → the emitter box's unit cube; the flame and the heat share it. */
      uHeatToBox: { value: new Matrix4() },
      // Cold until something says otherwise. The box starts as the identity,
      // which is "the whole world is inside it" — a default of 1 here would set
      // the weapon alight for one frame before the first sync corrects it.
      uHeatAmount: { value: 0 },
      uHeatTempCore: { value: 2600 },
      uHeatTempEdge: { value: 1500 },
      uHeatCurve: { value: 4 },
      uHeatEdge: { value: 1.6 },
      uHeatEdgeSharpness: { value: 3 },
      uHeatDetail: { value: 0.45 },
      uHeatScale: { value: 9 },
      uHeatSpeed: { value: 0.5 },
      uHeatFlow: { value: new Vector3(0, 1, 0) },
      uHeatRelief: { value: 0.8 },
      uHeatFalloff: { value: 0.35 },
      uHeatChar: { value: 0.55 },
      uHeatTint: { value: new Color(1, 1, 1) }
    };

    /** @type {import('three').Object3D|null} */
    this._model = null;
    /** mesh → the material (or array) it had before we touched it. */
    this._original = new Map();
    /** original material → our patched clone, so a shared one is cloned once. */
    this._clones = new Map();
  }

  /** Whether anything is currently patched. */
  get active() {
    return this._model !== null;
  }

  /**
   * Take over the materials of a model.
   *
   * Idempotent per model, so this can be called from the bind path without the
   * caller tracking whether it already ran.
   */
  attach(model) {
    if (this._model === model) return;
    this.detach();
    if (!model) return;

    this._model = model;
    model.traverse((node) => {
      if (!node.isMesh || node.userData.isFireVolume) return;
      const source = node.material;
      if (!source) return;

      this._original.set(node, source);
      node.material = Array.isArray(source)
        ? source.map((material) => this._patched(material))
        : this._patched(source);
    });
  }

  /** Put the originals back and drop the clones. */
  detach() {
    for (const [node, material] of this._original) node.material = material;
    this._original.clear();
    for (const clone of this._clones.values()) clone.dispose();
    this._clones.clear();
    this._model = null;
  }

  /**
   * @param {object} config the `settings.fire.steel` block
   * @param {number} master `settings.fire.intensity`
   * @param {number} time seconds
   * @param {Matrix4} worldToBox world → the emitter box's unit cube
   * @param {Vector3} flow which way the gas is streaming, world space
   */
  update(config, master, time, worldToBox, flow) {
    const u = this.uniforms;
    u.uHeatTime.value = time;
    u.uHeatToBox.value.copy(worldToBox);
    u.uHeatAmount.value = config.enabled ? config.amount * master : 0;
    u.uHeatTempCore.value = config.tempCore;
    u.uHeatTempEdge.value = config.tempEdge;
    u.uHeatCurve.value = config.curve;
    u.uHeatEdge.value = config.edge;
    u.uHeatEdgeSharpness.value = config.edgeSharpness;
    u.uHeatDetail.value = config.detail;
    u.uHeatScale.value = config.scale;
    u.uHeatSpeed.value = config.speed;
    u.uHeatRelief.value = config.relief;
    u.uHeatFalloff.value = config.falloff;
    u.uHeatChar.value = config.char;
    u.uHeatFlow.value.copy(flow);
  }

  /**
   * Let the steel go cold without giving the materials back.
   *
   * What the fire being switched off looks like from here: the weapon keeps its
   * patched clones (so switching back on costs nothing) and the term multiplies
   * out to zero.
   */
  cool() {
    this.uniforms.uHeatAmount.value = 0;
  }

  dispose() {
    this.detach();
  }

  /* ------------------------------------------------------------------ */

  /** One patched clone per source material, reused across meshes. */
  _patched(material) {
    if (!material) return material;
    // The term is added to `totalEmissiveRadiance`, which only exists on the lit
    // materials. An unlit one is left exactly as it was rather than cloned and
    // then patched with a chunk that is not in it.
    if (!material.emissive) return material;
    const existing = this._clones.get(material);
    if (existing) return existing;

    const clone = material.clone();
    // `Material.copy` does not carry own-property `onBeforeCompile`, so anything
    // already injected into this material would be silently dropped by the
    // clone. Carrying it across keeps us additive rather than destructive.
    if (Object.hasOwn(material, 'onBeforeCompile')) {
      clone.onBeforeCompile = material.onBeforeCompile;
      // And the key that says which program that injection belongs to. Without
      // it the clone claims the *default* key — the wrapper's source text, which
      // every patched material in the project shares — and takes over some other
      // system's program. See `utils/shaderPatch.js`.
      if (Object.hasOwn(material, 'customProgramCacheKey')) {
        clone.customProgramCacheKey = material.customProgramCacheKey;
      }
    }
    clone.name = `${material.name || 'material'}:hot`;

    patchOnBeforeCompile(clone, (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = VERTEX_PATCH(shader.vertexShader);
      shader.fragmentShader = FRAGMENT_PATCH(shader.fragmentShader);
    });
    // Every clone patched here injects the same code, so they all share one
    // compiled program (`patchOnBeforeCompile` keys it on the patch's own
    // source) — and nothing outside this file can be handed it by mistake.
    clone.needsUpdate = true;

    this._clones.set(material, clone);
    return clone;
  }
}

/* -------------------------------------------------------------------- */

/**
 * World position, taken after skinning and morphing.
 *
 * `worldpos_vertex` is the one place `transformed` is final and the model matrix
 * is still in scope, and it is present in every built-in material — which is
 * what lets this work on whatever the artist exported the sword with.
 */
const VERTEX_PATCH = (source) =>
  replaceChunk(
    `varying vec3 vHeatWorld;\n${source}`,
    '#include <worldpos_vertex>',
    /* glsl */ `
#include <worldpos_vertex>
vec4 heatWorld = vec4(transformed, 1.0);
#ifdef USE_BATCHING
  heatWorld = batchingMatrix * heatWorld;
#endif
#ifdef USE_INSTANCING
  heatWorld = instanceMatrix * heatWorld;
#endif
vHeatWorld = (modelMatrix * heatWorld).xyz;
`
  );

/**
 * The heat, added to emissive radiance.
 *
 * `emissivemap_fragment` is the last chunk before the lighting model runs, so
 * `totalEmissiveRadiance` is complete and `diffuseColor` is still writable —
 * which is what lets the same term both light the steel and char it.
 */
const FRAGMENT_PATCH = (source) => {
  const head = /* glsl */ `
${noiseGLSL}
${blackbodyGLSL}

uniform float uHeatTime;
uniform mat4 uHeatToBox;
uniform float uHeatAmount;
uniform float uHeatTempCore;
uniform float uHeatTempEdge;
uniform float uHeatCurve;
uniform float uHeatEdge;
uniform float uHeatEdgeSharpness;
uniform float uHeatDetail;
uniform float uHeatScale;
uniform float uHeatSpeed;
uniform vec3 uHeatFlow;
uniform float uHeatRelief;
uniform float uHeatFalloff;
uniform float uHeatChar;
uniform vec3 uHeatTint;

varying vec3 vHeatWorld;
`;

  const body = /* glsl */ `
#include <emissivemap_fragment>

if (uHeatAmount > 0.001) {
  // Where. The unit cube is the emitter box's own space, so this is the exact
  // same volume that decides which triangles are alight — one gizmo aims both.
  vec3 boxed = (uHeatToBox * vec4(vHeatWorld, 1.0)).xyz;
  vec3 fade = 1.0 - smoothstep(
    vec3(0.5 - max(uHeatFalloff, 0.001) * 0.5),
    vec3(0.5),
    abs(boxed)
  );
  float reach = fade.x * fade.y * fade.z;

  if (reach > 0.001) {
    // How hot. Two octaves crawling *along the flow*, so the hot patches drift
    // up the blade the way the flame above them does rather than sitting still
    // and reading as a texture painted on the steel.
    vec3 drift = uHeatFlow * (uHeatTime * uHeatSpeed);
    float field = snoise01(vHeatWorld * uHeatScale - drift) * 0.65
                + snoise01(vHeatWorld * uHeatScale * 2.7 - drift * 1.9) * 0.35;
    float mottle = mix(1.0, field * 1.6, clamp(uHeatDetail, 0.0, 1.0));

    // The edge. On a blade the silhouette is the cutting edge and the spine —
    // the thin metal, which is what actually glows first — so grazing angles
    // running hotter puts the filament exactly where a real one is.
    float facing = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));
    float rim = pow(clamp(facing, 0.0, 1.0), max(uHeatEdgeSharpness, 0.1));

    // The relief. Lighter albedo — the raised diamonds of the wrap, the temper
    // line — comes out hotter, which draws them as glowing lattice instead of
    // letting the whole grip go to one orange blob.
    float luma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    float relief = mix(1.0, 0.45 + 1.1 * luma, clamp(uHeatRelief, 0.0, 1.0));

    float heat = clamp(reach * mottle * relief * (1.0 + uHeatEdge * rim), 0.0, 1.4);
    float kelvin = mix(uHeatTempEdge, uHeatTempCore, clamp(heat, 0.0, 1.0));
    vec3 glow = thermal(kelvin, uHeatTempCore, uHeatCurve) * uHeatTint;

    totalEmissiveRadiance += glow * heat * uHeatAmount;
    // Steel this hot is scaled and sooty: it stops behaving like a mirror and
    // its own radiance is all anyone sees. Without this the reflected key light
    // stays on top of the glow and the blade reads as a lamp behind glass.
    diffuseColor.rgb *= 1.0 - clamp(uHeatChar, 0.0, 1.0) * clamp(heat, 0.0, 1.0);
  }
}
`;

  return replaceChunk(`${head}\n${source}`, '#include <emissivemap_fragment>', body);
};
