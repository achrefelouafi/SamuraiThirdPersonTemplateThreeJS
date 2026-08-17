import { LoadingManager, TextureLoader } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { extractEmbeddedMedia } from './fbxEmbeddedMedia.js';

/**
 * A 1×1 opaque white PNG.
 *
 * Authoring tools bake absolute local texture paths into FBX files (this model
 * points at `C:/Users/.../textures/...`). Those requests can never resolve from
 * a web server, so they are redirected here: the material keeps a neutral map
 * instead of a permanently pending texture, and the console stays clean.
 */
export const PLACEHOLDER_TEXTURE_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

/** Matches a drive-letter or UNC path that leaked into an asset reference. */
const ABSOLUTE_LOCAL_PATH = /(^|\/)[A-Za-z]:[\\/]|^\\\\/;

/** Last path segment of a URL, lowercased and stripped of any query. */
function basename(url) {
  return String(url).split(/[?#]/)[0].split(/[\\/]/).pop().toLowerCase();
}

/**
 * Central asset loading with a single progress stream.
 *
 * Every loader shares one LoadingManager so the boot screen can report real
 * aggregate progress instead of guessing — and one URL modifier, which is where
 * the two ways an FBX can lie about its textures are answered: a path baked in
 * from the authoring machine falls back to a neutral placeholder, and a request
 * for an image that is actually embedded in the model is served from memory
 * (see `fbxEmbeddedMedia.js`).
 */
export class AssetLoader {
  constructor() {
    this.manager = new LoadingManager();

    /** basename → object URL, for images lifted out of an FBX. */
    this.embedded = new Map();

    this.manager.setURLModifier((url) => {
      const embedded = this.embedded.get(basename(url));
      if (embedded) return embedded;
      return ABSOLUTE_LOCAL_PATH.test(url) ? PLACEHOLDER_TEXTURE_URL : url;
    });

    this.fbx = new FBXLoader(this.manager);
    this.gltf = new GLTFLoader(this.manager);
    this.hdr = new HDRLoader(this.manager);
    this.texture = new TextureLoader(this.manager);

    this._onProgress = null;
    this._loaded = 0;
    this._total = 0;
    this._settleWaiters = [];

    this.manager.onStart = (url, loaded, total) => {
      this._loaded = loaded;
      this._total = total;
    };
    this.manager.onProgress = (url, loaded, total) => {
      this._loaded = loaded;
      this._total = total;
      this._onProgress?.(total ? loaded / total : 0, url);
    };
    this.manager.onLoad = () => {
      this._loaded = this._total;
      this._settleWaiters.splice(0).forEach((resolve) => resolve());
    };
    this.manager.onError = (url) => console.error(`[AssetLoader] failed: ${url}`);
  }

  onProgress(callback) {
    this._onProgress = callback;
  }

  /**
   * Resolves once every queued request has settled.
   *
   * Loaders resolve as soon as the *model* is parsed; its textures are still in
   * flight at that point, so anything that inspects `texture.image` has to wait
   * for this first or it will read a half-initialised texture.
   */
  settled() {
    if (this._total === 0 || this._loaded >= this._total) return Promise.resolve();
    return new Promise((resolve) => this._settleWaiters.push(resolve));
  }

  /**
   * Load an FBX, serving any textures it embeds from memory.
   *
   * The file is fetched here rather than handed to `FBXLoader.load` so the same
   * bytes can be mined for embedded images *before* the loader asks for them —
   * registering them afterwards would be too late, and fetching twice would
   * cost a second download of a model that runs to tens of megabytes.
   *
   * @returns {Promise<THREE.Group>}
   */
  async loadFBX(url) {
    const resolved = encodeURI(url);
    this.manager.itemStart(resolved);

    try {
      const response = await fetch(resolved);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${url}`);

      const buffer = await response.arrayBuffer();
      for (const [name, objectURL] of extractEmbeddedMedia(buffer)) {
        this.embedded.set(name, objectURL);
      }

      // FBXLoader resolves texture paths against this, exactly as `load` would.
      return this.fbx.parse(buffer, resolved.slice(0, resolved.lastIndexOf('/') + 1));
    } catch (error) {
      this.manager.itemError(resolved);
      throw error;
    } finally {
      this.manager.itemEnd(resolved);
    }
  }

  /**
   * Load a glTF/GLB.
   *
   * Unlike the FBX path this needs no help: a GLB carries its images inline as
   * buffer views, so there are no external paths to redirect and nothing to
   * lift out of the bytes first.
   *
   * @returns {Promise<{scene: THREE.Group, animations: THREE.AnimationClip[]}>}
   */
  loadGLTF(url) {
    return new Promise((resolve, reject) => {
      this.gltf.load(encodeURI(url), resolve, undefined, reject);
    });
  }

  /** @returns {Promise<THREE.Texture>} */
  loadTexture(url) {
    return new Promise((resolve, reject) => {
      this.texture.load(encodeURI(url), resolve, undefined, reject);
    });
  }

  /** @returns {Promise<THREE.DataTexture>} */
  loadHDR(url) {
    return new Promise((resolve, reject) => {
      this.hdr.load(encodeURI(url), resolve, undefined, reject);
    });
  }

  /**
   * Release the object URLs held for embedded images.
   *
   * Safe once every queued request has settled: the textures have decoded by
   * then and no longer need the blob behind them. Call it and the model's
   * texture bytes stop being held twice.
   */
  dispose() {
    for (const url of new Set(this.embedded.values())) URL.revokeObjectURL(url);
    this.embedded.clear();
  }
}
