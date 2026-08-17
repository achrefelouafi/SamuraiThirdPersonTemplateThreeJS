import { DoubleSide, SRGBColorSpace } from 'three';
import { LAYER } from '../core/Layers.js';

/**
 * Loads equipment models, once each, and dresses them out of the character's
 * own material palette.
 *
 * **Lazy by design.** Every item in the catalog is a ~4.5 MB GLB, and nothing
 * downloads until something asks for it — the boot path is untouched by a
 * catalog of any size. `warm()` fetches the rest in the background once the
 * screen is actually open, so the second click is instant without the first
 * frame ever having waited.
 *
 * **The materials are shared with the body.** Each of these exports embeds the
 * same four 1024² maps the character's palette already carries under
 * `weapon_mat` — they came out of one Blender scene. Left alone that is three
 * more copies of the same textures resident on the GPU, all lit slightly
 * differently from the armour they hang off. So each item's material is resolved
 * against `MaterialLibrary` by name first and the export's own is released; what
 * ends up on screen is literally the same material instance the body wears.
 *
 * @see EquipmentManager for what happens to a loaded model afterwards.
 */
export class EquipmentLibrary {
  /**
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   * @param {import('../loaders/MaterialLibrary.js').MaterialLibrary|null} materialLibrary
   *   the character's palette, if it has one — items fall back to their own
   *   materials when it cannot answer for them.
   */
  constructor(assets, materialLibrary = null) {
    this.assets = assets;
    this.library = materialLibrary;
    /** item id → Promise<Object3D>, so a double click loads one file. */
    this._loading = new Map();
    /** item id → prepared template. Instances are clones of these. */
    this._templates = new Map();
    /** palette material → its double-sided twin, made once and shared. */
    this._twoSided = new Map();
  }

  /** Whether the model behind an item is already resident. */
  isReady(id) {
    return this._templates.has(id);
  }

  /**
   * Fetch and prepare one item's model. Repeat calls share the first request.
   *
   * @param {import('./EquipmentCatalog.js').EquipmentItem} item
   * @returns {Promise<import('three').Object3D>} the template — clone it, don't scene-add it
   */
  load(item) {
    const cached = this._loading.get(item.id);
    if (cached) return cached;

    const request = this.assets
      .loadGLTF(item.url)
      .then(async (gltf) => {
        // The GLB resolves as soon as it is parsed; its images are still
        // decoding, and `_prepare` inspects the textures it is about to release.
        await this.assets.settled();
        const template = this._prepare(gltf.scene, item);
        this._templates.set(item.id, template);
        return template;
      })
      .catch((error) => {
        // A failed request must not poison the cache — the user may well click
        // the card again, and a network blip should be retryable.
        this._loading.delete(item.id);
        throw error;
      });

    this._loading.set(item.id, request);
    return request;
  }

  /**
   * Load everything in the background, one at a time.
   *
   * Sequential rather than parallel on purpose: these are large files and the
   * screen is already interactive, so the point is to be invisible rather than
   * fast. Failures are swallowed — this is a prefetch, and the real `load()`
   * behind a click is where an error belongs.
   *
   * @param {import('./EquipmentCatalog.js').EquipmentItem[]} items
   */
  async warm(items) {
    for (const item of items) {
      try {
        await this.load(item);
      } catch (error) {
        console.warn(`[EquipmentLibrary] prefetch failed for "${item.id}"`, error);
      }
    }
  }

  /**
   * A fresh instance of an already-loaded item.
   *
   * `Object3D#clone` shares geometry and materials with the template, so a
   * second copy of an item costs a few matrices and nothing on the GPU.
   *
   * @returns {import('three').Object3D|null} null if the model is not in yet
   */
  instance(item) {
    const template = this._templates.get(item.id);
    if (!template) return null;
    const clone = template.clone(true);
    clone.name = `Equipment:${item.id}`;
    return clone;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Ready a freshly loaded GLB: shadows, layers, and the palette swap.
   *
   * @param {import('three').Object3D} root
   * @param {import('./EquipmentCatalog.js').EquipmentItem} item
   */
  _prepare(root, item) {
    root.name = `Equipment:${item.id}`;

    /** Materials the palette displaced, and the textures still in use after. */
    const displaced = new Set();
    const kept = new Set();
    const resolved = new Map();

    root.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;

      node.castShadow = true;
      node.receiveShadow = true;
      node.layers.set(LAYER.WORLD);
      node.layers.enable(LAYER.CONTACT); // it belongs in the shadow under the feet

      const source = Array.isArray(node.material) ? node.material : [node.material];
      const applied = source.map((material) => {
        if (!material) return material;
        if (resolved.has(material)) return resolved.get(material);

        const palette = this.library?.resolve(material.name, node.name) ?? null;
        const authored = palette ? this._asDoubleSided(palette) : null;
        if (authored) {
          // The palette was flipped to sit on an FBX body (see
          // `MaterialLibrary#flipTextureV`). This model is glTF and agrees with
          // the texture as authored, so the flip has to be cancelled — on the
          // geometry, since the correction lives on textures the body is
          // sharing and cannot be undone per material.
          if (this.library.flipV) flipGeometryV(node.geometry);
          displaced.add(material);
          resolved.set(material, authored);
          return authored;
        }

        prepareOwnMaterial(material);
        kept.add(material);
        resolved.set(material, material);
        return material;
      });

      node.material = Array.isArray(node.material) ? applied : applied[0];
    });

    releaseMaterials(displaced, kept);

    if (!displaced.size && this.library) {
      console.warn(
        `[EquipmentLibrary] "${item.id}" found no palette material — it keeps its own ` +
          `(the palette offers ${this.library.names.join(', ')}).`
      );
    }

    return root;
  }

  /**
   * The palette material an item should wear, rendered from both sides.
   *
   * Equipment is modelled as open shells — cloth, straps, blade fullers — so
   * back faces have to survive culling. The palette instance itself cannot be
   * flipped: the body wears it too, and doubling its face count everywhere is
   * not what was asked for. So each palette material gets one clone, shared by
   * every item that resolves to it. A clone copies parameters and *references*
   * the same textures, so this costs a uniform block, not a megabyte.
   *
   * @param {import('three').Material} palette
   * @returns {import('three').Material}
   */
  _asDoubleSided(palette) {
    if (palette.side === DoubleSide) return palette;
    let twin = this._twoSided.get(palette);
    if (!twin) {
      twin = palette.clone();
      twin.name = `${palette.name}__doubleSided`;
      twin.side = DoubleSide;
      twin.shadowSide = DoubleSide;
      this._twoSided.set(palette, twin);
    }
    return twin;
  }

  /**
   * Drop every loaded model.
   *
   * Only what this class created is released: geometries, and the materials the
   * palette could not answer for. A shared palette material belongs to the
   * character and is left alone.
   */
  dispose() {
    const twins = new Set(this._twoSided.values());
    for (const template of this._templates.values()) {
      const shared = this.library ? new Set(this.library.materials) : new Set();
      template.traverse((node) => {
        node.geometry?.dispose();
        const list = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of list) {
          // A double-sided twin's textures are the body's: dispose the material
          // and leave the maps to the palette that owns them.
          if (!material || shared.has(material) || twins.has(material)) continue;
          releaseTextures(material);
          material.dispose();
        }
      });
    }
    for (const twin of this._twoSided.values()) twin.dispose();
    this._twoSided.clear();
    this._templates.clear();
    this._loading.clear();
  }
}

/* -------------------------------------------------------------------- */

/**
 * Flip a geometry's V coordinate in place, once.
 *
 * Marked on the geometry rather than tracked outside it because clones share
 * it: flipping twice would be a no-op that looked like a bug on the third item.
 */
function flipGeometryV(geometry) {
  const uv = geometry?.attributes?.uv;
  if (!uv || geometry.userData.__flippedV) return;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  uv.needsUpdate = true;
  geometry.userData.__flippedV = true;
}

/** An item the palette had nothing for keeps its own material — tidied up. */
function prepareOwnMaterial(material) {
  material.side = DoubleSide;
  material.shadowSide = DoubleSide;
  if (material.map) material.map.colorSpace = SRGBColorSpace;
  if (material.emissiveMap) material.emissiveMap.colorSpace = SRGBColorSpace;
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value?.isTexture) value.anisotropy = 4;
  }
}

/** Every texture a material references, released. */
function releaseTextures(material, keep = new Set()) {
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value?.isTexture && !keep.has(value)) value.dispose();
  }
}

/**
 * Release the materials the palette displaced, and their images with them.
 *
 * This is the whole point of the palette swap: without it each item holds four
 * more 1024² maps that are byte-for-byte what the body already has resident.
 */
function releaseMaterials(displaced, kept) {
  const live = new Set();
  for (const material of kept) {
    for (const key of Object.keys(material)) {
      const value = material[key];
      if (value?.isTexture) live.add(value);
    }
  }
  for (const material of displaced) {
    releaseTextures(material, live);
    material.dispose();
  }
}
