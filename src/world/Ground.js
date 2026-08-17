import {
  Mesh,
  PlaneGeometry,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Vector2
} from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { TerrainCache } from './TerrainCache.js';
import { LAYER } from '../core/Layers.js';

/**
 * Side length of the floor plane, metres.
 *
 * This is a *window*, not the world: the plane is re-centred on the character
 * every frame, so all that matters is that its edge stays past the point the
 * haze has fully dissolved it — 200 m of clearance in every direction is well
 * past that at any usable density. The texture repeat is derived from this size.
 */
const PLANE_SIZE = 400;

/** Subdivisions per side the floor mesh will accept. */
const MIN_SEGMENTS = 8;
const MAX_SEGMENTS = 768;

/**
 * The tiling sets the floor can wear.
 *
 * `terrain` is ambientCG Ground103 (CC0), the same bare soil the grass sandbox
 * scatters its blades over — it is what the field is planted in. `stone` is the
 * original Rock030 flagstone, kept for the bare stage. Colour is authored sRGB;
 * the rest are linear data.
 */
const TEXTURE_SETS = {
  terrain: {
    map: './textures/terrain/color.jpg',
    normalMap: './textures/terrain/normal.jpg',
    roughnessMap: './textures/terrain/roughness.jpg',
    aoMap: './textures/terrain/ao.jpg'
  },
  stone: {
    map: './textures/stone/color.jpg',
    normalMap: './textures/stone/normal.jpg',
    roughnessMap: './textures/stone/roughness.jpg',
    aoMap: './textures/stone/ao.jpg'
  }
};

const SLOTS = Object.keys(TEXTURE_SETS.terrain);

/**
 * The stage floor.
 *
 * **Displaced.** The plane is a grid, and its vertices are pushed up the shared
 * height field (`world/Terrain.js`) — the same function the CPU stands the
 * character on, so both agree on where the surface is to within a micrometre.
 * Normals come analytically from that field rather than from the mesh, so the
 * shading is smooth at any subdivision and the tiling's own normal map still
 * rides on top of it. Amplitude 0 collapses the whole thing back to a flat plane
 * at y = 0 for free.
 *
 * The field is not evaluated per vertex per frame, though: it is baked into a
 * texture (`world/TerrainCache.js`) that the vertex shader reads with a single
 * fetch. Because the grid snaps to whole vertex spacings — see `setCenter` — the
 * baked lattice *is* the vertex lattice, so this is exact rather than a
 * resampling, and it takes the ground from a hundred-odd noise lookups per
 * vertex down to one.
 *
 * The one subtlety a moving displaced plane brings is *swimming*: the mesh
 * follows the character, so a vertex's world position — and therefore its
 * height — would change under it every frame, and the ground would ripple. The
 * fix is in `setCenter`, which snaps the plane to whole vertex spacings; every
 * vertex then lands on the same world positions it always does, and the surface
 * is perfectly still while the mesh slides under it.
 *
 * **Endless.** The plane follows the character (see `setCenter`), so there is no
 * world edge to walk off. Nothing about the *look*
 * travels with it: the tiling is world-locked through the texture offset, and
 * everything the shader does — the soil noise, the polish — is a function of
 * world position, so the ground under your feet is
 * decided by where you are standing rather than by where the mesh happens to
 * sit. The one thing that does follow is the light pool, which is a camera
 * effect wearing a floor's clothes and belongs on the character.
 *
 * The base is one of the tiling sets above, graded toward the cool stage palette
 * so it reads as a night field rather than a daylit one. On top of the sampled
 * albedo the shader keeps the two things that make the floor sit in this scene:
 * a luminance-preserving tint toward `floorTint`, and a radial light pool that
 * keeps the stage centre readable. When the texture is switched off (or has not
 * loaded yet) the same shader falls back to the original procedural stone, so
 * nothing depends on the download succeeding.
 */
export class Ground {
  /**
   * @param {import('./Environment.js').Environment} environment
   * @param {object} [options]
   * @param {import('./Terrain.js').Terrain} [options.terrain] the height field
   *   this mesh is displaced by
   * @param {import('./Atmosphere.js').Atmosphere} [options.atmosphere]
   */
  constructor(environment, { terrain = null, atmosphere = null } = {}) {
    this.environment = environment;
    this.terrain = terrain;
    /**
     * The height field, baked to a texture the vertex shader reads with one
     * fetch — see `TerrainCache`. This is what makes a 384² displaced floor
     * cost about as much as an undisplaced one.
     */
    this.cache = terrain ? new TerrainCache(environment.renderer, terrain) : null;

    this.material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: settings.environment.floorRoughness,
      metalness: 0.0,
      dithering: true,
      // The floor is in the haze with everything else — see `Atmosphere`. There
      // is no three fog in this scene to fall back on.
      fog: false
    });
    atmosphere?.patch(this.material);
    // The key and the rim belong to the character; the floor is lit by the
    // ambient, the hemisphere and the probe. See `Environment#excludeFromKeyLights`.
    environment.excludeFromKeyLights(this.material);
    this.material.normalScale = new Vector2(
      settings.environment.floorNormalScale,
      settings.environment.floorNormalScale
    );

    /** name → the four maps of a loaded set. Filled on demand. */
    this.sets = new Map();
    /** Sets whose download failed — asked for once, then left alone. */
    this._failed = new Set();
    /** The set currently attached to the material. */
    this.textures = null;
    this._setName = null;
    this._loading = null;
    this._assets = null;
    this._textured = false;
    /** World XZ the plane is currently centred on — snapped to a vertex spacing. */
    this.center = new Vector2();
    /**
     * World XZ the character is actually at. The plane is snapped and the
     * character is not, so the light pool has to follow this one — a pool
     * anchored to the snapped centre would step around under your feet.
     */
    this.focus = new Vector2();
    /** Subdivisions the current mesh was built with. */
    this.segments = 0;

    this.uniforms = {
      /**
       * Half the vertex spacing: the width of the central difference the normal
       * is taken over. Matching it to the mesh keeps the shading from claiming
       * detail the triangles cannot show, which is what would make the silhouette
       * and the lighting disagree.
       */
      uTerrainNormalEps: { value: 1 },
      uFloorColor: { value: getColor(settings.environment.floorColor).clone() },
      uFloorTint: { value: getColor(settings.environment.floorTint).clone() },
      uTexTint: { value: settings.environment.floorTexTint },
      uSheen: { value: settings.environment.floorSheen },
      uPool: { value: settings.environment.floorPool },
      uFloorCenter: { value: new Vector2() },
      uTime: { value: 0 }
    };

    environment.registerShadowCasterWithPatch(this.material, (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      // Its own uniform objects, by identity, so the floor can never disagree
      // with the height field the character is standing on.
      if (this.cache) Object.assign(shader.uniforms, this.cache.uniforms);

      // The plane is built already lying down (`rotateX` on the geometry), so
      // the model matrix is a pure translation: object space and world space
      // share their axes, and a world-space normal can be handed straight to
      // `objectNormal` without a change of basis.
      //
      // Height and normal both come out of one texture fetch. The floor's grid
      // is snapped to whole vertex spacings and the baked lattice is that same
      // set of world positions read with NEAREST, so this is not an
      // approximation of the field — it is the field, evaluated once instead of
      // five times per vertex per frame. See `TerrainCache`.
      shader.vertexShader = this.terrain
        ? shader.vertexShader
            .replace(
              '#include <common>',
              `#include <common>
               varying vec3 vGroundWorld;
               uniform sampler2D uTerrainCache;
               uniform vec2  uTerrainCacheOrigin;
               uniform float uTerrainCacheSpacing;
               uniform float uTerrainCacheTexel;`
            )
            .replace(
              '#include <beginnormal_vertex>',
              `vec2 gWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;
               vec2 gCell = (gWorldXZ - uTerrainCacheOrigin) / uTerrainCacheSpacing;
               vec4 gField = texture2D(uTerrainCache, (gCell + 0.5) * uTerrainCacheTexel);
               float gHeight = gField.w;
               vec3 objectNormal = gField.xyz;`
            )
            .replace(
              '#include <begin_vertex>',
              `vec3 transformed = vec3(position.x, position.y + gHeight, position.z);
               vGroundWorld = vec3(gWorldXZ.x, transformed.y, gWorldXZ.y);`
            )
        : shader.vertexShader
            .replace('#include <common>', `#include <common>\nvarying vec3 vGroundWorld;`)
            .replace(
              '#include <begin_vertex>',
              `#include <begin_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
            );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vGroundWorld;
           uniform vec3 uFloorColor;
           uniform vec3 uFloorTint;
           uniform float uTexTint;
           uniform float uSheen;
           uniform float uPool;
           uniform vec2 uFloorCenter;
           uniform float uTime;
           ${noiseGLSL}`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             vec3 wp = vGroundWorld;

             #ifdef USE_MAP
               // The soil albedo is already in diffuseColor. Grade it toward the
               // stage's cool floor tint without dragging its brightness down:
               // normalising the tint to unit luminance shifts the hue and leaves
               // the value to the light pool below.
               vec3 tint = uFloorTint;
               float tl = max(1e-4, dot(tint, vec3(0.299, 0.587, 0.114)));
               vec3 graded = diffuseColor.rgb * (tint / tl);
               diffuseColor.rgb = mix(diffuseColor.rgb, graded, clamp(uTexTint, 0.0, 1.0));
             #else
               // No texture: the original procedural dark stone. Broad, smooth
               // variation with a warmer wash drifting through it — anything
               // higher frequency reads as gravel and fights the clean look.
               float macro = fbm3(wp * 0.018);
               float tintMask = smoothstep(-0.5, 0.6, macro);
               vec3 base = mix(uFloorColor, uFloorTint, tintMask * 0.5);
               base *= 1.0 + fbm3(wp * 0.09 + 11.0) * 0.05;
               base *= 1.0 + (snoise01(wp * 0.7) - 0.5) * 0.06;
               diffuseColor.rgb *= base;
             #endif

             // Radial light pool: the ground under the character stays readable
             // and the floor sinks toward the backdrop long before the plane's
             // edge. Measured from the character, not the origin — on an endless
             // floor there is no origin to be lit, and anchoring it there would
             // mean walking out of your own pool of light. Shared by both paths,
             // because it is what welds the floor into the scene.
             float dist = length(wp.xz - uFloorCenter);
             float pool = mix(1.0, smoothstep(40.0, 5.0, dist), clamp(uPool, 0.0, 1.0));
             diffuseColor.rgb *= mix(0.18, 1.0, pool);
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           {
             // Break the sheen up: broad patches of smoother stone catch the key
             // light and the elemental glows, the rest stays matte. Rides on top
             // of the roughness map when one is present.
             float polish = smoothstep(0.3, 0.85, fbm3(vGroundWorld * 0.06 + 3.0) * 0.5 + 0.5);
             roughnessFactor *= mix(1.0, 0.45, polish * clamp(uSheen, 0.0, 1.0));
           }`
        );
    });

    this.segments = this._wantedSegments();
    this.mesh = new Mesh(buildPlane(this.segments), this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'Ground';
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this._syncNormalEps();
    // Bake before anything can draw: the shader binds the cache's texture, and
    // an unbaked one is three's default white — which would stand the whole
    // floor a metre off the ground for the first frame.
    this._ensureCache();

    this.group = this.mesh;
  }

  /** Subdivisions the settings are asking for, clamped to something sane. */
  _wantedSegments() {
    if (!this.terrain) return 1;
    const wanted = Math.round(settings.terrain.segments);
    return Math.min(Math.max(wanted, MIN_SEGMENTS), MAX_SEGMENTS);
  }

  /** Metres between neighbouring floor vertices. */
  get spacing() {
    return PLANE_SIZE / Math.max(1, this.segments);
  }

  _syncNormalEps() {
    this.uniforms.uTerrainNormalEps.value = Math.max(0.05, this.spacing * 0.5);
  }

  /**
   * Keep the baked field under the grid.
   *
   * Almost always a no-op — the bake carries enough slack for the character to
   * walk a good thirty metres before the window runs out, so this costs one
   * comparison per frame and a fullscreen pass every ten seconds or so. The
   * cases that do re-bake are that walk, a terrain slider, and a change of
   * subdivision (which moves the lattice the bake is aligned to).
   */
  _ensureCache() {
    if (!this.cache) return;
    const half = PLANE_SIZE / 2;
    this.cache.ensure(
      this.center.x - half,
      this.center.y - half,
      this.spacing,
      this.segments + 1,
      this.uniforms.uTerrainNormalEps.value
    );
  }

  /**
   * Swap the mesh's grid for a finer or coarser one.
   *
   * The only thing in this class that is not a live uniform, so it is driven off
   * a settings *change* rather than run every frame — and the plane is re-snapped
   * afterwards, because the snap quantum is the vertex spacing that just moved.
   */
  _rebuildGeometry() {
    const segments = this._wantedSegments();
    if (segments === this.segments) return;
    this.segments = segments;
    this.mesh.geometry.dispose();
    this.mesh.geometry = buildPlane(segments);
    this._syncNormalEps();

    const { x, y } = this.focus;
    this.center.set(NaN, NaN); // force the snap below to take
    this.setCenter(x, y);
  }

  /**
   * Load the floor maps and attach them. Called during boot so the maps are in
   * place before the shader is compiled — no first-cast recompile — but the
   * ground renders fine (procedural fallback) if this is skipped or fails.
   *
   * The loader is kept: switching sets in the editor pulls the other one in on
   * demand rather than paying for both at boot.
   *
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   */
  async loadTextures(assets) {
    this._assets = assets;
    await this._useSet(settings.environment.floorTextureSet);
  }

  /** Attach `name`, loading it first if this is the first time it is asked for. */
  async _useSet(name) {
    const key = TEXTURE_SETS[name] ? name : 'terrain';
    if (this._setName === key || this._failed.has(key)) return;

    if (!this.sets.has(key)) {
      // One load at a time, and a set that 404s is not asked for again — this
      // runs off the editor, which can flip the switch every frame.
      if (!this._assets || this._loading) return;
      this._loading = key;
      try {
        this.sets.set(key, await this._load(TEXTURE_SETS[key]));
      } catch (error) {
        this._failed.add(key);
        console.warn(`[Ground] could not load the "${key}" floor set`, error);
        return;
      } finally {
        this._loading = null;
      }
    }

    this.textures = this.sets.get(key);
    this._setName = key;
    this._repeat = 0;
    this._applyTiling();
    // Force a re-attach: the slots hold the previous set's maps.
    this._textured = !settings.environment.floorTexture;
    this._setTextured(settings.environment.floorTexture);
  }

  /** Fetch one set and prepare its four maps for tiled use. */
  async _load(urls) {
    const entries = await Promise.all(
      Object.entries(urls).map(async ([slot, url]) => [slot, await this._assets.loadTexture(url)])
    );

    const maxAniso = this.environment.renderer?.gl.capabilities.getMaxAnisotropy?.() ?? 1;
    const textures = {};
    for (const [slot, texture] of entries) {
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.anisotropy = maxAniso;
      // TextureLoader assumes linear data; only the colour map is authored sRGB.
      if (slot === 'map') texture.colorSpace = SRGBColorSpace;
      textures[slot] = texture;
    }
    return textures;
  }

  /**
   * Point every map at the same tiling, derived from metres-per-tile, and slide
   * it to cancel the plane's own movement so the soil stays nailed to the world
   * instead of sledding along under the character's feet.
   *
   * The offset is the mesh's position expressed in tiles. The V axis is negated
   * because the plane is laid down by a -90° turn about X (baked into the
   * geometry, see `buildPlane`), which maps its local +Y onto world -Z.
   *
   * Only `repeat` and `offset` are touched — they feed the texture's UV matrix,
   * which is rebuilt each render, so there is no image re-upload and this is
   * safe to call per frame.
   */
  _applyTiling() {
    if (!this.textures) return;
    const scale = Math.max(0.1, settings.environment.floorTextureScale);
    const repeat = PLANE_SIZE / scale;
    const changed = repeat !== this._repeat;
    this._repeat = repeat;

    // Wrapped into a single tile. The maps repeat, so this is the same image
    // either way, and it keeps the UVs small however far the character walks
    // instead of letting them drift out of float precision and swim.
    const u = this.center.x / scale;
    const v = -this.center.y / scale;
    const offsetU = u - Math.floor(u);
    const offsetV = v - Math.floor(v);

    for (const texture of Object.values(this.textures)) {
      if (changed) texture.repeat.set(repeat, repeat);
      texture.offset.set(offsetU, offsetV);
    }
  }

  /**
   * Move the floor under the character. Cheap enough to do every frame — only
   * the mesh's matrix changes, whatever the grid's resolution.
   *
   * The plane is **snapped to whole vertex spacings**. That is what makes a
   * displaced floor hold still: every vertex keeps landing on the same world
   * positions, so it keeps reading the same height, and the mesh slides beneath
   * a surface that never moves. Snapping to the exact character position instead
   * would drag every vertex through the height field continuously and the whole
   * landscape would boil.
   *
   * @param {number} x world X to centre on — the character's feet
   * @param {number} z world Z
   */
  setCenter(x, z) {
    this.focus.set(x, z);
    // The pool follows the body, not the mesh — see `focus`.
    this.uniforms.uFloorCenter.value.set(x, z);

    // Nothing to hold still without a height field, and the "spacing" of a
    // two-triangle plane is 400 m — snapping to it would teleport the floor.
    const step = this.terrain ? this.spacing : 0;
    const snappedX = step > 0 ? Math.round(x / step) * step : x;
    const snappedZ = step > 0 ? Math.round(z / step) * step : z;
    if (snappedX === this.center.x && snappedZ === this.center.y) return;

    this.center.set(snappedX, snappedZ);
    this.mesh.position.set(snappedX, 0, snappedZ);
    this.mesh.updateMatrix();
  }

  /** Attach or detach the maps. Flipping this recompiles once (USE_MAP). */
  _setTextured(on) {
    if (!this.textures || on === this._textured) return;
    for (const slot of SLOTS) {
      this.material[slot] = on ? this.textures[slot] : null;
    }
    this.material.needsUpdate = true;
    this._textured = on;
  }

  /**
   * @param {number} elapsed seconds
   * @param {number} [x] world X to keep the floor centred on
   * @param {number} [z] world Z
   */
  update(elapsed, x = this.focus.x, z = this.focus.y) {
    const env = settings.environment;
    // Before the snap and the tiling below, both of which key off the spacing.
    if (this.terrain) this._rebuildGeometry();
    // Before the tiling below, which cancels this move out of the texture UVs.
    this.setCenter(x, z);
    // And after the snap, because the baked window is aligned to the grid the
    // snap just placed.
    this._ensureCache();
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uFloorColor.value.copy(getColor(env.floorColor));
    this.uniforms.uFloorTint.value.copy(getColor(env.floorTint));
    this.uniforms.uTexTint.value = env.floorTexTint;
    this.uniforms.uSheen.value = env.floorSheen;
    this.uniforms.uPool.value = env.floorPool;
    this.material.roughness = env.floorRoughness;
    this.material.normalScale.set(env.floorNormalScale, env.floorNormalScale);

    if (this._setName !== env.floorTextureSet) this._useSet(env.floorTextureSet);
    if (this.textures) {
      this._applyTiling();
      this._setTextured(env.floorTexture);
    }
  }

  dispose() {
    this.cache?.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
    for (const set of this.sets.values()) {
      for (const texture of Object.values(set)) texture.dispose();
    }
    this.sets.clear();
  }
}

/**
 * The floor grid, already lying down.
 *
 * Rotating the *geometry* rather than the mesh is what keeps the model matrix a
 * pure translation, which in turn lets the vertex shader read a world XZ, push
 * the vertex up world +Y and hand back a world-space normal without ever
 * changing basis. `rotateX` leaves the UVs alone, so the tiling maths above is
 * unaffected by it.
 */
function buildPlane(segments) {
  return new PlaneGeometry(PLANE_SIZE, PLANE_SIZE, segments, segments).rotateX(-Math.PI / 2);
}
