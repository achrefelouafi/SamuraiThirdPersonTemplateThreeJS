import { SRGBColorSpace } from 'three';

/**
 * A bag of authored PBR materials, keyed by name.
 *
 * The rigged body is exported as FBX, which carries Phong materials and, at
 * best, a diffuse map — none of the metallic/roughness, normal or emissive
 * detail the model was actually authored with. That authoring survives a glTF
 * export intact, so the look is shipped as a *second* file: an unrigged GLB of
 * the same model whose only job is to be a material palette.
 *
 * Nothing here knows the names in this particular character. The library
 * indexes whatever the GLB contains and `resolve()` matches by name, so
 * swapping in a new body and a new palette is two file paths and no code — as
 * long as the two exports agree on their material names, which they do by
 * construction when both come out of the same scene.
 *
 * @see CharacterController#_prepareMaterials for the application side.
 */
export class MaterialLibrary {
  /**
   * @param {import('./AssetLoader.js').AssetLoader} assets
   * @param {string} url a .glb/.gltf whose materials are the palette
   * @param {{aliases?: Record<string, string>, flipV?: boolean}} [options]
   */
  static async load(assets, url, options) {
    const gltf = await assets.loadGLTF(url);
    return new MaterialLibrary(gltf.scene, options);
  }

  /**
   * @param {import('three').Object3D} source the loaded palette scene
   * @param {{aliases?: Record<string, string>, flipV?: boolean}} [options]
   *   `aliases` maps a name on the *rig* to a name in this library, for the case
   *   where the two exports disagree. Empty is the normal state.
   *   `flipV` reconciles the UV origin with a rig that does not share glTF's —
   *   see `flipTextureV`.
   */
  constructor(source, { aliases = {}, flipV = false } = {}) {
    this.flipV = flipV;
    /** normalised material name → material. */
    this.byName = new Map();
    /** normalised mesh/node name → material, the fallback when names diverge. */
    this.byMesh = new Map();
    /** Every distinct material, in the order the palette declares them. */
    this.materials = [];
    /** Rig-side name → library-side name, normalised. */
    this.aliases = new Map(
      Object.entries(aliases).map(([from, to]) => [normalize(from), normalize(to)])
    );

    this._index(source);
    this._release(source);
  }

  /**
   * Walk the palette and index every material it carries.
   *
   * A material claims its own name first; mesh names are only recorded where
   * they do not collide with one, so an explicit material name always wins.
   */
  _index(source) {
    const meshClaims = [];

    source.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;
      const list = Array.isArray(node.material) ? node.material : [node.material];

      for (const material of list) {
        if (!material) continue;

        if (!this.materials.includes(material)) {
          prepare(material, this.flipV);
          this.materials.push(material);
        }

        for (const key of keysFor(material.name)) {
          if (!this.byName.has(key)) this.byName.set(key, material);
        }
        // A mesh split across materials cannot stand for any one of them.
        if (list.length === 1) meshClaims.push([node.name, material]);
      }
    });

    // A key two different meshes claim identifies neither of them, so it is
    // dropped rather than resolved arbitrarily.
    for (const [name, material] of meshClaims) {
      for (const key of keysFor(name)) {
        if (this.byName.has(key)) continue;
        const held = this.byMesh.get(key);
        if (held === undefined) this.byMesh.set(key, material);
        else if (held !== material) this.byMesh.set(key, null);
      }
    }
  }

  /**
   * Drop the palette's geometry.
   *
   * Only the materials are wanted; the GLB's meshes are an unrigged copy of a
   * body that is already in the scene, and they run to tens of megabytes.
   */
  _release(source) {
    source.traverse((node) => node.geometry?.dispose());
    source.clear();
  }

  /**
   * The authored material for a rig material, or null if the palette has none.
   *
   * Tried in order of how much has to be true for the answer to be right: an
   * alias the project declared, then any material *name* the rig's material or
   * its mesh answers to, then a mesh in the palette wearing exactly one
   * material, and finally — for a single-material palette — the one material
   * there is. Names beat meshes across the board, so a coincidence between a
   * rig mesh and a palette mesh can never displace a real name match.
   *
   * @param {string} materialName name on the rig's imported material
   * @param {string} [meshName] name of the mesh it is applied to
   */
  resolve(materialName, meshName) {
    const alias = this.aliases.get(normalize(materialName));
    if (alias && this.byName.has(alias)) return this.byName.get(alias);

    const keys = [...keysFor(materialName), ...keysFor(meshName)];
    for (const key of keys) if (this.byName.has(key)) return this.byName.get(key);
    for (const key of keys) if (this.byMesh.get(key)) return this.byMesh.get(key);

    return this.materials.length === 1 ? this.materials[0] : null;
  }

  /** Every name the palette answers to, for diagnostics. */
  get names() {
    return this.materials.map((material) => material.name || '(unnamed)');
  }
}

/* -------------------------------------------------------------------- */

/** Blender's `.001` duplicate suffix, and the ` (1)` other tools append. */
const VARIANT_SUFFIX = /(\.\d{3}|\s*\(\d+\))$/;

/** A trailing or leading "mat"/"material", which only one side usually carries. */
const MATERIAL_WORD = /^(?:material|mat)|(?:material|mat)$/g;

/** Case, punctuation and duplicate suffixes are noise when matching names. */
function normalize(name) {
  return String(name ?? '')
    .replace(VARIANT_SUFFIX, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The keys a name is looked up under, strictest first.
 *
 * The second is the name with its "mat" decoration removed, which is what lets
 * a rig material called `armor_mat` find a palette material called `armor` (or
 * a mesh called `Armor`) without anyone writing an alias for it.
 */
function keysFor(name) {
  const exact = normalize(name);
  if (!exact) return [];
  const bare = exact.replace(MATERIAL_WORD, '');
  return bare && bare !== exact ? [exact, bare] : [exact];
}

/**
 * Ready an imported material for the geometry it is about to be applied to.
 *
 * glTF already lands with the right colour spaces and PBR slots, so this is
 * only what is a property of the *pairing* rather than the export: the UV
 * origin the palette assumes versus the one the rig was written with, and the
 * anisotropy the character wants because it is the one thing the camera gets
 * close to.
 */
function prepare(material, flipV) {
  if (material.map) material.map.colorSpace = SRGBColorSpace;
  if (material.emissiveMap) material.emissiveMap.colorSpace = SRGBColorSpace;

  for (const key of Object.keys(material)) {
    const value = material[key];
    if (!value || !value.isTexture) continue;
    value.anisotropy = 4;
    if (flipV) flipTextureV(value);
  }
}

/**
 * Sample a texture as if its V axis ran the other way.
 *
 * glTF puts UV (0,0) at the *top* left and GLTFLoader compensates by uploading
 * the image unflipped (`flipY = false`). FBX — and Blender's FBX exporter, which
 * is where the rig comes from — keeps the OpenGL convention, origin at the
 * *bottom* left. So the rig's V is `1 - V` relative to the palette's, and every
 * palette texture lands on it upside down.
 *
 * The obvious answer, setting `flipY = true` back on the texture, silently does
 * nothing here: GLTFLoader decodes through ImageBitmapLoader wherever the
 * browser allows it, and `WebGLTextures` skips the `UNPACK_FLIP_Y_WEBGL` call
 * for an ImageBitmap source. Flipping through the texture matrix instead is
 * honoured by the shader whatever the image turned out to be — three keeps a
 * transform per texture slot, so this reaches the normal and emissive maps and
 * not just the base colour.
 *
 * Only V: exporters disagree about the vertical origin, never the horizontal.
 */
function flipTextureV(texture) {
  texture.repeat.y = -1;
  texture.offset.y = 1;
}
