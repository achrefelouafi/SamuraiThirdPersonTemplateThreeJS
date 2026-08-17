import {
  ClampToEdgeWrapping,
  FloatType,
  HalfFloatType,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget
} from 'three';
import { terrainGLSL } from '../shaders/lib/terrain.glsl.js';

/**
 * Spare texels kept on every side of the floor's own grid.
 *
 * This is the whole economy of the class: the bake only has to be redone when
 * the floor slides past the edge of what was baked, so the slack is how far the
 * character walks between bakes. 32 texels is about 33 m at the default vertex
 * spacing — ten seconds at a run.
 */
const MIN_SLACK = 32;

/** Ceiling on the baked texture, so a silly `terrain.segments` cannot blow VRAM. */
const MAX_SIZE = 2048;

/**
 * The height field, baked.
 *
 * **Why this exists.** The floor is a 384² grid — 148 000 vertices — and every
 * one of them used to evaluate `terrainHeightAt` five times over (once for its
 * own height, four more for the central difference its normal is taken from),
 * each evaluation walking five fbm octaves plus a domain warp. That is well over
 * a million noise lookups per frame, in the *vertex* shader, for a surface that
 * does not change from one frame to the next and does not even move: the floor
 * mesh snaps to whole vertex spacings precisely so that every vertex keeps
 * landing on the same world positions (see `Ground#setCenter`).
 *
 * So the field is evaluated once, into a texture, and the floor reads it back
 * with a single fetch per vertex. The saving is not a constant factor on a small
 * number — it is the difference between the ground being the most expensive
 * thing in the frame and it being free.
 *
 * **Why it is exact.** The bake is a fullscreen quad running the same
 * `terrainGLSL` chunk the floor used to run inline, sampled at exactly the world
 * positions the floor's vertices occupy: the texture's lattice is the floor's
 * lattice, the filter is NEAREST, and each texel is read by exactly one vertex.
 * There is no interpolation anywhere in the path, so the surface that comes out
 * is the surface that went in — the same one the CPU mirror in `Terrain.js`
 * stands the character on.
 *
 * Layout is `vec4(normal.xyz, height)` in a float target, so the normal comes
 * back with the height rather than costing four more samples to rebuild.
 */
export class TerrainCache {
  /**
   * @param {import('../core/Renderer.js').Renderer} renderer
   * @param {import('./Terrain.js').Terrain} terrain the field to bake
   */
  constructor(renderer, terrain) {
    this.renderer = renderer;
    this.terrain = terrain;

    /** Side of the current texture, texels. */
    this.size = 0;
    /** Metres between neighbouring texels — the floor's vertex spacing. */
    this.spacing = 0;
    /** World XZ of texel (0, 0). */
    this.origin = new Vector2(NaN, NaN);
    this._eps = 0;
    this._signature = null;
    this.target = null;
    /** Bakes performed. The editor reports it; a rising count is a bug. */
    this.bakes = 0;

    // A half-float height at this amplitude lands within a couple of
    // millimetres, which nobody can see — but the character's feet are placed
    // off the CPU mirror rather than off this texture, and a full float costs
    // one texture either way, so take the exact one where it is offered.
    this._type = renderer.gl.extensions.has('EXT_color_buffer_float')
      ? FloatType
      : HalfFloatType;

    /** What the floor binds. Shared by identity; the texture is swapped in. */
    this.uniforms = {
      uTerrainCache: { value: null },
      uTerrainCacheOrigin: { value: new Vector2() },
      uTerrainCacheSpacing: { value: 1 },
      /** 1 / size — the vertex shader multiplies rather than divides. */
      uTerrainCacheTexel: { value: 1 }
    };

    this._bakeUniforms = {
      uBakeOrigin: { value: new Vector2() },
      uBakeSpacing: { value: 1 },
      uBakeSize: { value: 1 },
      uBakeEps: { value: 0.5 }
    };

    // The terrain's uniform objects go in by identity, so a slider moved in the
    // editor is already in this material — all `ensure` has to notice is that
    // the field it baked is no longer the field the settings describe.
    this.material = new ShaderMaterial({
      uniforms: Object.assign({}, terrain.uniforms, this._bakeUniforms),
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec2  uBakeOrigin;
        uniform float uBakeSpacing;
        uniform float uBakeSize;
        uniform float uBakeEps;
        varying vec2 vUv;
        ${terrainGLSL}

        void main() {
          // The fragment centre of texel i is (i + 0.5) / size, so this recovers
          // the integer i exactly — which is what keeps the baked lattice and
          // the floor's vertex lattice the same set of world positions.
          vec2 cell = floor(vUv * uBakeSize);
          vec2 worldXZ = uBakeOrigin + cell * uBakeSpacing;
          gl_FragColor = vec4(
            terrainNormalAt(worldXZ, uBakeEps),
            terrainHeightAt(worldXZ)
          );
        }
      `
    });

    this.scene = new Scene();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /**
   * Make sure the baked window covers the floor's grid, re-baking if it does not.
   *
   * @param {number} firstX world X of the grid's first vertex
   * @param {number} firstZ world Z of the grid's first vertex
   * @param {number} spacing metres between vertices
   * @param {number} vertices vertices per side (segments + 1)
   * @param {number} eps half-width of the central difference the normal is taken
   *   over — the floor's `uTerrainNormalEps`, so the baked normals are the ones
   *   it would have computed itself
   * @returns {boolean} whether a bake ran
   */
  ensure(firstX, firstZ, spacing, vertices, eps) {
    const size = cacheSize(vertices);
    const signature = this.terrain.signature;

    if (
      this.target &&
      this.size === size &&
      this.spacing === spacing &&
      this._eps === eps &&
      this._signature === signature &&
      this._covers(firstX, firstZ, vertices)
    ) {
      return false;
    }

    // Centre the new window on the grid, so the slack is spent evenly and the
    // character walks the same distance whichever way they set off.
    const slack = Math.max(0, Math.floor((size - vertices) / 2));
    this._resize(size);
    this.spacing = spacing;
    this._eps = eps;
    this._signature = signature;
    this.origin.set(firstX - slack * spacing, firstZ - slack * spacing);
    this._bake();
    return true;
  }

  /** Whether `vertices` texels from (firstX, firstZ) are inside the window. */
  _covers(firstX, firstZ, vertices) {
    // A texel of tolerance: the grid's corner is arrived at through a float
    // model matrix, and being a micrometre outside is not a reason to re-bake.
    const slop = this.spacing * 0.5;
    const span = (vertices - 1) * this.spacing;
    const reach = (this.size - 1) * this.spacing;
    return (
      firstX >= this.origin.x - slop &&
      firstZ >= this.origin.y - slop &&
      firstX + span <= this.origin.x + reach + slop &&
      firstZ + span <= this.origin.y + reach + slop
    );
  }

  _resize(size) {
    if (this.target && this.size === size) return;
    this.target?.dispose();
    this.size = size;
    this.target = new WebGLRenderTarget(size, size, {
      type: this._type,
      format: RGBAFormat,
      // NEAREST and no mips, for the same reason the hash table has none: the
      // floor reads one texel per vertex and any filtering at all would put a
      // surface under the character that is not the one the CPU agreed to.
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false
    });
    this.target.texture.generateMipmaps = false;
    this.uniforms.uTerrainCache.value = this.target.texture;
    this.uniforms.uTerrainCacheTexel.value = 1 / size;
  }

  /** One fullscreen pass. Rare enough that its cost never reaches the frame. */
  _bake() {
    const gl = this.renderer.gl;
    const b = this._bakeUniforms;
    b.uBakeOrigin.value.copy(this.origin);
    b.uBakeSpacing.value = this.spacing;
    b.uBakeSize.value = this.size;
    b.uBakeEps.value = this._eps;

    const previousTarget = gl.getRenderTarget();
    const previousAutoClear = gl.autoClear;
    gl.autoClear = true;
    gl.setRenderTarget(this.target);
    gl.render(this.scene, this.camera);
    gl.setRenderTarget(previousTarget);
    gl.autoClear = previousAutoClear;

    this.uniforms.uTerrainCacheOrigin.value.copy(this.origin);
    this.uniforms.uTerrainCacheSpacing.value = this.spacing;
    this.bakes += 1;
  }

  dispose() {
    this.target?.dispose();
    this.target = null;
    this.quad.geometry.dispose();
    this.material.dispose();
  }
}

/** Smallest power of two that holds the grid and its slack. */
function cacheSize(vertices) {
  const wanted = vertices + MIN_SLACK * 2;
  let size = 256;
  while (size < wanted && size < MAX_SIZE) size *= 2;
  return Math.min(size, MAX_SIZE);
}
