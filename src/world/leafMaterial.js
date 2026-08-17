import {
  ClampToEdgeWrapping,
  Color,
  DoubleSide,
  MeshStandardMaterial,
  SRGBColorSpace,
  Vector2
} from 'three';
import { settings } from '../config/settings.js';
import { frame } from '../core/FrameUniforms.js';
import { getColor } from '../utils/color.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/**
 * The five maps of the ambientCG LeafSet024 set, and the one fact about them
 * that the whole system is built on: **it is a 3 × 3 sheet of nine different
 * leaves**, not one leaf. So a leaf here is a quad that reads one ninth of the
 * sheet, picked per instance, and a field of five thousand of them is nine
 * shapes at a hundred rotations rather than one shape stamped out five thousand
 * times — which is the difference between litter and wallpaper, for the price of
 * a single extra float per instance.
 */
const URLS = {
  map: './textures/leafs/LeafSet024_1K-JPG_Color.jpg',
  normalMap: './textures/leafs/LeafSet024_1K-JPG_NormalGL.jpg',
  roughnessMap: './textures/leafs/LeafSet024_1K-JPG_Roughness.jpg',
  alphaMap: './textures/leafs/LeafSet024_1K-JPG_Opacity.jpg'
};

/** Leaves per side of the sheet. Nine variants. */
export const LEAF_ATLAS = 3;

/**
 * The quad a leaf is drawn on, in leaf-lengths.
 *
 * Portrait, because the cells are: a square quad would stretch every blade
 * sideways by the aspect the sheet already encodes. Local X runs across the
 * leaf and local Y along it, which is what lets the placement code below talk
 * about a "tangent" (across) and a "bitangent" (along) and mean it.
 */
export const LEAF_QUAD = { width: 0.74, height: 1.0 };

/**
 * Load the sheet.
 *
 * Clamped rather than repeating, because every instance reads a *sub-rectangle*
 * of it — a wrapping fetch at the edge of cell 8 would come back with cell 0.
 * Mips are kept: leaves are small on screen and the far field of a litter this
 * dense is almost entirely minified, so turning them off would trade a little
 * bleeding between neighbouring cells for a whole field of aliasing. The bleed
 * is answered instead by `atlasInset`, which keeps every cell's UVs a little
 * inside its own borders.
 *
 * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
 * @param {import('../core/Renderer.js').Renderer} renderer for the anisotropy cap
 */
export async function loadLeafTextures(assets, renderer) {
  const entries = await Promise.all(
    Object.entries(URLS).map(async ([slot, url]) => [slot, await assets.loadTexture(url)])
  );

  const maxAniso = renderer?.gl.capabilities.getMaxAnisotropy?.() ?? 1;
  const textures = {};
  for (const [slot, texture] of entries) {
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.anisotropy = maxAniso;
    // TextureLoader assumes linear data; only the colour sheet is authored sRGB.
    if (slot === 'map') texture.colorSpace = SRGBColorSpace;
    textures[slot] = texture;
  }
  return textures;
}

/**
 * The uniform block both populations share, by identity.
 *
 * The litter on the floor and the leaves in the air are the same leaves in the
 * same light — so the grade, the backlight and the atlas inset are one write per
 * frame for both, and they cannot drift apart.
 */
export function createLeafLook() {
  return {
    uLeafTint: { value: new Color(1, 1, 1) },
    uLeafTintAmount: { value: 0 },
    uLeafBacklight: { value: new Color(0, 0, 0) },
    uLeafBacklightPower: { value: 5 },
    uAtlasInset: { value: 0.02 },
    uLightDir: frame.uLightDir
  };
}

/** Re-read the shared look out of `settings.leaves`. */
export function syncLeafLook(look, config) {
  look.uLeafTint.value.copy(getColor(config.tint));
  look.uLeafTintAmount.value = Math.min(Math.max(config.tintAmount, 0), 1);
  look.uLeafBacklight.value
    .copy(getColor(config.backlightColor))
    .multiplyScalar(Math.max(0, config.backlight));
  look.uLeafBacklightPower.value = Math.max(0.5, config.backlightPower);
  look.uAtlasInset.value = Math.min(Math.max(config.atlasInset, 0), 0.2);
}

/* -------------------------------------------------------------------- */

/**
 * The baked height field, read the way a leaf has to read it.
 *
 * The floor already bakes the terrain into a texture and reads it with one
 * NEAREST fetch per vertex, because its vertices *are* the baked lattice
 * (`world/TerrainCache.js`). A leaf is not on that lattice — it is at an
 * arbitrary point between four of its texels — so a NEAREST fetch would stand
 * it on a staircase and, on any real slope, half the field would be buried and
 * the other half hovering. Four taps and a bilinear blend put it on the surface
 * the floor actually draws, and the same blend hands back the interpolated
 * normal, which is what the leaf lies *flat against*.
 *
 * Four vertex fetches per leaf is nothing — the field is one draw call and the
 * alternative is per-instance CPU work on every leaf every frame.
 */
export const leafGroundGLSL = /* glsl */ `
uniform sampler2D uTerrainCache;
uniform vec2  uTerrainCacheOrigin;
uniform float uTerrainCacheSpacing;
uniform float uTerrainCacheTexel;
uniform float uHasCache;

/** vec4(surface normal, height) under a world XZ. */
vec4 leafGround(vec2 xz) {
  if (uHasCache < 0.5) return vec4(0.0, 1.0, 0.0, 0.0);

  vec2 cell = (xz - uTerrainCacheOrigin) / uTerrainCacheSpacing;
  vec2 base = floor(cell);
  vec2 f = cell - base;
  vec2 uv0 = (base + 0.5) * uTerrainCacheTexel;
  float d = uTerrainCacheTexel;

  vec4 a = texture2D(uTerrainCache, uv0);
  vec4 b = texture2D(uTerrainCache, uv0 + vec2(d, 0.0));
  vec4 c = texture2D(uTerrainCache, uv0 + vec2(0.0, d));
  vec4 e = texture2D(uTerrainCache, uv0 + vec2(d, d));
  return mix(mix(a, b, f.x), mix(c, e, f.x), f.y);
}
`;

/** The cache's own uniforms by identity, or inert ones if there is no cache. */
export function leafCacheUniforms(cache) {
  if (cache) return { ...cache.uniforms, uHasCache: { value: 1 } };
  return {
    uTerrainCache: { value: null },
    uTerrainCacheOrigin: { value: new Vector2() },
    uTerrainCacheSpacing: { value: 1 },
    uTerrainCacheTexel: { value: 1 },
    uHasCache: { value: 0 }
  };
}

/* -------------------------------------------------------------------- */

/**
 * What a population has to answer for one leaf, and the scaffold that draws it.
 *
 * A population supplies exactly one function — `LeafPlacement leafPlace()` —
 * and everything else about a leaf is the same whether it is lying in the mud
 * or falling through the air: the same sheet, the same nine variants, the same
 * grade, the same backlight, the same dissolve. So the two systems share one
 * material factory and differ only in the arithmetic that says where a leaf is
 * and which way it is turned.
 *
 * The frame is handed over whole (`tangent`, `bitangent`, `normal`) rather than
 * as a yaw, because a leaf in flight is tumbling about an arbitrary axis and a
 * leaf on the ground is lying flat against a slope — neither is expressible as
 * a rotation about world Y, and building the basis at the call site is what lets
 * both be exact.
 */
const PLACEMENT_GLSL = /* glsl */ `
struct LeafPlacement {
  vec3  centre;     // world position of the leaf's middle
  vec3  tangent;    // across the blade, unit
  vec3  bitangent;  // along the blade, unit
  vec3  normal;     // out of its face, unit
  float size;       // metres along the blade
  float cut;        // alpha cutoff on top of the material's own — 1 erases it
  vec2  cell;       // which of the nine leaves, as (column, row)
};

/** Rodrigues rotation of v about a unit axis. */
vec3 leafSpin(vec3 v, vec3 axis, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return v * c + cross(axis, v) * s + axis * (dot(axis, v) * (1.0 - c));
}
`;

const VARYINGS_GLSL = /* glsl */ `
varying float vLeafCut;
varying vec3  vLeafNormal;
varying vec3  vLeafWorld;
`;

/**
 * Build the material a population of leaves is drawn with.
 *
 * **Opaque, alpha-tested, one draw call.** Nothing about a leaf wants blending:
 * it is a hard-edged cut-out, and testing rather than blending means it writes
 * depth, needs no sorting, and can be drawn in any order — which is the only
 * reason five thousand of them is affordable. The usual price of alpha testing
 * is a crawling, aliased edge, and that is paid off with alpha-to-coverage
 * against the composer's MSAA target (`settings.post.samples`): the cut-out edge
 * is resolved at sample rate instead of pixel rate and comes out as clean as a
 * blended one, with none of the ordering.
 *
 * That same cutoff is then used as a **dissolve**. A per-instance threshold is
 * raised toward 1 and the leaf erodes away rather than fading — which is how the
 * far field thins out, how a leaf in the air is born and dies, and how one
 * drifting into the lens gets out of the way. All three would otherwise need
 * transparency, and transparency would need sorting.
 *
 * @param {object} options
 * @param {object} options.textures the four maps from `loadLeafTextures`
 * @param {object} options.look the shared uniform block, by identity
 * @param {object} options.uniforms this population's own block
 * @param {string} options.vertexGLSL must define `LeafPlacement leafPlace()`
 * @param {import('./Environment.js').Environment} [options.environment]
 * @param {import('./Atmosphere.js').Atmosphere} [options.atmosphere]
 */
export function createLeafMaterial({
  textures,
  look,
  uniforms,
  vertexGLSL,
  environment = null,
  atmosphere = null
}) {
  const material = new MeshStandardMaterial({
    ...textures,
    // Thin, and seen from both faces — a leaf lying on a slope is looked at
    // edge-on as often as not, and one in the air shows whichever side it has
    // tumbled onto. three flips the shading normal for the back face itself.
    side: DoubleSide,
    metalness: 0,
    roughness: 0.8,
    alphaTest: 0.45,
    dithering: true,
    // The leaves are in the same air as the ground they lie on — see
    // `world/Atmosphere.js`. There is no three fog in this scene.
    fog: false
  });
  material.normalScale = new Vector2(1, 1);

  atmosphere?.patch(material);
  // The key and the rim belong to the character. Litter is part of the floor,
  // so it is lit by exactly what the floor is lit by — anything else and a
  // carpet of leaves would be the one thing on the ground wearing a portrait
  // key. See `Environment#excludeFromKeyLights`.
  environment?.excludeFromKeyLights(material);

  patchOnBeforeCompile(material, (shader) => {
    Object.assign(shader.uniforms, look, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uAtlasInset;
         ${VARYINGS_GLSL}
         ${PLACEMENT_GLSL}
         ${vertexGLSL}`
      )
      // The placement has to be resolved before three writes its UV varyings,
      // because which ninth of the sheet this leaf reads is part of the answer.
      .replace(
        '#include <uv_vertex>',
        `LeafPlacement leaf = leafPlace();
         vLeafCut = leaf.cut;
         vLeafNormal = leaf.normal;
         #include <uv_vertex>
         {
           // Every map is on the same UV set with no transform, so each varying
           // is the quad's own [0,1] and folding it into one cell is the same
           // two operations on each. The inset keeps the fetch off the cell's
           // border, where a minified sample would otherwise pull in the leaf
           // next door.
           float leafSpan = (1.0 - 2.0 * uAtlasInset) / ${LEAF_ATLAS}.0;
           vec2  leafBase = (leaf.cell + uAtlasInset) / ${LEAF_ATLAS}.0;
           #ifdef USE_MAP
             vMapUv = leafBase + vMapUv * leafSpan;
           #endif
           #ifdef USE_ALPHAMAP
             vAlphaMapUv = leafBase + vAlphaMapUv * leafSpan;
           #endif
           #ifdef USE_NORMALMAP
             vNormalMapUv = leafBase + vNormalMapUv * leafSpan;
           #endif
           #ifdef USE_ROUGHNESSMAP
             vRoughnessMapUv = leafBase + vRoughnessMapUv * leafSpan;
           #endif
         }`
      )
      // The mesh sits at the origin with an identity matrix and every leaf is
      // placed in world space here, so a world normal can be handed straight to
      // `objectNormal` and three's own `normalMatrix` turns it into the view
      // space its lighting wants.
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = leaf.normal;')
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = leaf.centre
           + (leaf.tangent * position.x + leaf.bitangent * position.y) * leaf.size;
         vLeafWorld = transformed;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         ${VARYINGS_GLSL}
         uniform vec3  uLeafTint;
         uniform float uLeafTintAmount;
         uniform vec3  uLeafBacklight;
         uniform float uLeafBacklightPower;
         uniform vec3  uLightDir;`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           // The sheet is a daylight photograph of a beech in summer and this
           // stage is a blue night. Normalising the tint to unit luminance
           // shifts the hue and leaves the value alone, so the leaves join the
           // palette without going grey — the same grade the floor's soil gets.
           vec3 leafTint = uLeafTint;
           float leafLum = max(1e-4, dot(leafTint, vec3(0.299, 0.587, 0.114)));
           vec3 leafGraded = diffuseColor.rgb * (leafTint / leafLum);
           diffuseColor.rgb = mix(diffuseColor.rgb, leafGraded, uLeafTintAmount);
         }`
      )
      // three's own chunk, with the per-instance dissolve folded into the
      // threshold. Alpha-to-coverage is kept on both paths, so a dissolving leaf
      // erodes at sample rate rather than snapping out a pixel at a time.
      .replace(
        '#include <alphatest_fragment>',
        `{
           // three only declares the alphaTest uniform while its define is on,
           // so the dissolve stands on its own if the material's own cutoff is
           // ever dialled to zero.
           #ifdef USE_ALPHATEST
             float leafCut = max(alphaTest, vLeafCut);
           #else
             float leafCut = vLeafCut;
           #endif
           #ifdef ALPHA_TO_COVERAGE
             diffuseColor.a = smoothstep(leafCut, leafCut + fwidth(diffuseColor.a), diffuseColor.a);
             if (diffuseColor.a == 0.0) discard;
           #else
             if (diffuseColor.a < leafCut) discard;
           #endif
         }`
      )
      .replace(
        '#include <opaque_fragment>',
        `{
           // A leaf is one cell thick and it *glows* when the moon is behind it.
           // This is the single thing that stops a field of cut-outs reading as
           // stickers: light coming through the blade, strongest looking
           // straight into the moon and strongest again when the leaf is turned
           // edge-on to you, carrying the leaf's own colour because that is what
           // the light has just been filtered through.
           vec3 leafView = normalize(cameraPosition - vLeafWorld);
           float leafThrough = pow(max(dot(-leafView, uLightDir), 0.0), uLeafBacklightPower);
           float leafThin = 1.0 - 0.6 * abs(dot(normalize(vLeafNormal), leafView));
           outgoingLight += diffuseColor.rgb * uLeafBacklight * (leafThrough * leafThin);
         }
         #include <opaque_fragment>`
      );
  });

  // **The two populations must not share a program.**
  //
  // three identifies a material's shader by `customProgramCacheKey()`, and
  // `patchOnBeforeCompile` builds that key out of the *source text* of each
  // injected patch. The patch above is one function with one source text, and
  // the thing that makes a litter leaf different from a drifting one —
  // `vertexGLSL` — is captured in its closure, where the key cannot see it. Two
  // materials with the same maps and the same defines would therefore hash
  // identically, three would hand both of them whichever program compiled first,
  // and one population would silently render with the other's placement code and
  // the other's attribute names.
  //
  // Folding the placement source into the key keeps them apart by construction:
  // two populations share a program exactly when they are running the same
  // shader, which is the sharing that was wanted in the first place.
  const chained = material.customProgramCacheKey();
  material.customProgramCacheKey = function () {
    return `${chained}|${vertexGLSL}`;
  };

  return material;
}

/** Re-read the per-material half of `settings.leaves`. Cheap, so per frame. */
export function syncLeafMaterial(material, config) {
  material.roughness = Math.min(Math.max(config.roughness, 0.02), 1);
  material.normalScale.set(config.normalScale, config.normalScale);
  material.alphaTest = Math.min(Math.max(config.alphaTest, 0.02), 0.98);

  // Alpha-to-coverage resolves the cut-out edge against the *multisample* mask,
  // so it does nothing at all on a single-sampled target — and worse than
  // nothing, because it costs the shader a `fwidth` and gives up the `OPAQUE`
  // fast path to write a coverage alpha nobody reads. The composer's targets are
  // where this scene is drawn, so the switch is asked of them rather than
  // trusted: turn `post.samples` up and the leaves get the smoother edge on the
  // next frame, with no other change.
  const coverage = config.alphaToCoverage && (settings.post.samples ?? 0) > 0;
  // The one property here that is a shader define rather than a uniform, so it
  // is the one that has to be guarded against a per-frame recompile.
  if (material.alphaToCoverage !== coverage) {
    material.alphaToCoverage = coverage;
    material.needsUpdate = true;
  }
}
