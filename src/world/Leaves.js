import { Group } from 'three';
import { settings } from '../config/settings.js';
import { LeafDrift } from './LeafDrift.js';
import { LeafLitter } from './LeafLitter.js';
import { createLeafLook, loadLeafTextures, syncLeafLook } from './leafMaterial.js';

/**
 * The leaves — the ones on the ground and the ones in the air, as one thing.
 *
 * They are two systems because they are doing two different jobs (see
 * `world/LeafLitter.js` and `world/LeafDrift.js`), but they are *one look*: one
 * sheet of nine leaves loaded once, one grade, one backlight, one wind. So this
 * owns the sheet and the shared uniform block, hands both to the two
 * populations by identity, and gives the app a single object to add, update and
 * throw away.
 *
 * It also owns the one wire between the character and the ground: the body's
 * position and its ground velocity go into `LeafLitter#push`, which is what
 * makes walking through the litter scatter it. That wire lives here rather than
 * in `core/App.js` because it is the leaves' business who disturbs them, and
 * because anything else with a position and a velocity can be pushed through the
 * same call.
 *
 * Nothing here is required for the stage to run. If the sheet fails to download
 * the two meshes are never built, `update` is a no-op, and the rest of the world
 * neither knows nor cares.
 */
export class Leaves {
  /**
   * @param {object} options
   * @param {import('./Terrain.js').Terrain} [options.terrain] the height field
   * @param {import('./TerrainCache.js').TerrainCache} [options.cache] its bake —
   *   bound by identity, so the leaves lie on the ground the floor draws
   * @param {import('./Environment.js').Environment} [options.environment]
   * @param {import('./Atmosphere.js').Atmosphere} [options.atmosphere]
   */
  constructor({ terrain = null, cache = null, environment = null, atmosphere = null } = {}) {
    this._deps = { terrain, cache, environment, atmosphere };

    /** The grade, the backlight and the atlas inset, shared by both meshes. */
    this.look = createLeafLook();

    this.group = new Group();
    this.group.name = 'Leaves';
    /** @type {LeafLitter|null} */
    this.litter = null;
    /** @type {LeafDrift|null} */
    this.drift = null;

    this.textures = null;
  }

  /** Whether the sheet is in and there is anything to draw. */
  get ready() {
    return this.litter !== null;
  }

  /**
   * Fetch the sheet and build both populations.
   *
   * Called during boot so the materials are compiled with everything else — the
   * meshes have to be in the scene before `compileAsync`, or the first leaf on
   * screen is a stutter.
   *
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   * @param {import('../core/Renderer.js').Renderer} renderer for the anisotropy cap
   */
  async load(assets, renderer) {
    try {
      this.textures = await loadLeafTextures(assets, renderer);
    } catch (error) {
      console.warn('[Leaves] could not load the leaf set — the floor stays bare', error);
      return;
    }

    const shared = { textures: this.textures, look: this.look, ...this._deps };
    this.litter = new LeafLitter(shared);
    this.drift = new LeafDrift(shared);
    this.group.add(this.litter.mesh, this.drift.mesh);
  }

  /**
   * @param {number} dt seconds of simulation — 0 while paused, which stops the
   *   wind lifting leaves as well as moving them
   * @param {number} elapsed the simulation clock both shaders are given
   * @param {{x: number, z: number}} position the character
   * @param {{x: number, y: number}} velocity their ground velocity (x, z)
   */
  update(dt, elapsed, position, velocity) {
    if (!this.litter) return;
    syncLeafLook(this.look, settings.leaves);
    // The litter first: it is the one that reads the character's velocity, and
    // the drift's emitter only wants to know where they are standing.
    this.litter.update(dt, elapsed, position, velocity);
    this.drift.update(elapsed, position);
  }

  dispose() {
    this.litter?.dispose();
    this.drift?.dispose();
    for (const texture of Object.values(this.textures ?? {})) texture.dispose();
    this.textures = null;
  }
}
