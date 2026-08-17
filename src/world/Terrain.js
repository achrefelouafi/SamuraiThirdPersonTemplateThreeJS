import { DataTexture, NearestFilter, RGBAFormat, RepeatWrapping, Vector2, Vector3 } from 'three';
import { settings } from '../config/settings.js';
import {
  TERRAIN_HASH_SIZE,
  TERRAIN_MAX_OCTAVES,
  terrainGLSL
} from '../shaders/lib/terrain.glsl.js';

/** A deterministic 32-bit PRNG, so a given seed always builds the same table. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _normal = new Vector3();

/**
 * The height field, and the only thing allowed to answer "how high is the
 * ground here".
 *
 * The GPU side lives in `shaders/lib/terrain.glsl.js` and is injected into the
 * floor and the grass; this class owns the uniforms both of them read (by
 * identity, so they can never drift apart) and mirrors the same arithmetic in
 * JS for everything the CPU has to place on the surface — the character, the
 * camera anchor, the contact shadow, the shadow frustum's focus.
 *
 * **The two sides have to agree exactly**, so the noise is table-driven: the
 * 256×256 byte texture built here is sampled with NEAREST on the GPU and read
 * straight out of its backing array on the CPU, which makes `byte / 255` the
 * one shared primitive. Everything downstream of it is ordinary float maths and
 * lands within a micrometre. Anything that changes the shape of the ground —
 * amplitude, scale, octaves, warp — is a plain uniform, so every control in the
 * editor is live and nothing here is ever rebuilt except the table itself, and
 * that only when the seed changes.
 */
export class Terrain {
  constructor() {
    this._seed = null;
    /** The hash table, as bytes. Rebuilt only when the seed moves. */
    this.texture = new DataTexture(
      new Uint8Array(TERRAIN_HASH_SIZE * TERRAIN_HASH_SIZE * 4),
      TERRAIN_HASH_SIZE,
      TERRAIN_HASH_SIZE,
      RGBAFormat
    );
    this.texture.wrapS = RepeatWrapping;
    this.texture.wrapT = RepeatWrapping;
    // NEAREST, and no mips: the shader does its own interpolation, and it has
    // to be *our* interpolation for the CPU to reproduce it.
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this._data = this.texture.image.data;

    /** Shared with the floor, by identity. */
    this.uniforms = {
      uTerrainHash: { value: this.texture },
      uTerrainAmp: { value: 0 },
      uTerrainScale: { value: 1 },
      uTerrainOctaves: { value: 1 },
      uTerrainLacunarity: { value: 2 },
      uTerrainGain: { value: 0.5 },
      uTerrainWarp: { value: 0 },
      uTerrainRidge: { value: 0 },
      uTerrainOffset: { value: new Vector2() }
    };

    this.update();
  }

  /** The GLSL the floor injects. */
  static get glsl() {
    return terrainGLSL;
  }

  /** Re-read the settings. Everything is a uniform, so this is nearly free. */
  update() {
    const t = settings.terrain;
    const u = this.uniforms;

    if (t.seed !== this._seed) this._buildTable(t.seed);

    u.uTerrainAmp.value = t.enabled ? Math.max(0, t.amplitude) : 0;
    u.uTerrainScale.value = Math.max(1, t.scale);
    u.uTerrainOctaves.value = Math.min(Math.max(1, Math.round(t.octaves)), TERRAIN_MAX_OCTAVES);
    u.uTerrainLacunarity.value = t.lacunarity;
    u.uTerrainGain.value = t.gain;
    u.uTerrainWarp.value = Math.max(0, t.warp);
    u.uTerrainRidge.value = Math.min(Math.max(0, t.ridge), 1);
  }

  /** Whether the ground is anything other than a flat plane right now. */
  get displaced() {
    return this.uniforms.uTerrainAmp.value > 0;
  }

  /**
   * Everything that changes the *shape* of the ground, as one comparable string.
   *
   * `world/TerrainCache.js` bakes this field into a texture and has to know when
   * that bake has gone stale; the seed is in here by way of the lattice offset,
   * which is redrawn with the table.
   */
  get signature() {
    const u = this.uniforms;
    return [
      u.uTerrainAmp.value,
      u.uTerrainScale.value,
      u.uTerrainOctaves.value,
      u.uTerrainLacunarity.value,
      u.uTerrainGain.value,
      u.uTerrainWarp.value,
      u.uTerrainRidge.value,
      u.uTerrainOffset.value.x,
      u.uTerrainOffset.value.y
    ].join(',');
  }

  /**
   * Fill the hash table, and derive the lattice shift from the same seed.
   *
   * Reshuffling the table is what makes a new seed a genuinely different
   * landscape rather than the same hills slid sideways; the shift on top of it
   * keeps seed 0 off the lattice origin, where every octave would line up.
   */
  _buildTable(seed) {
    this._seed = seed;
    const random = mulberry32(Math.floor(seed * 7919) + 1);
    const data = this._data;
    // Every byte, in the order the unpacked table drew them — the lattice shift
    // below is the next two draws off the same stream, so changing what is
    // consumed here would reshape every landscape a seed has ever produced.
    for (let i = 0; i < data.length; i++) data[i] = (random() * 256) | 0;

    // Pack each cell's three forward neighbours alongside it, so the shader's
    // bilinear lookup is one fetch instead of four (`terrainCorners`). R keeps
    // the cell's own value, which is the channel the CPU mirror below reads and
    // the one thing both sides have to agree on — the other three are copies of
    // bytes that are already in the table, so nothing about the landscape moves.
    const N = TERRAIN_HASH_SIZE;
    const cells = new Uint8Array(N * N);
    for (let i = 0; i < cells.length; i++) cells[i] = data[i * 4];
    for (let y = 0; y < N; y++) {
      const row = y * N;
      const rowNext = ((y + 1) % N) * N;
      for (let x = 0; x < N; x++) {
        const xNext = (x + 1) % N;
        const o = (row + x) * 4;
        data[o + 1] = cells[row + xNext];
        data[o + 2] = cells[rowNext + x];
        data[o + 3] = cells[rowNext + xNext];
      }
    }
    this.texture.needsUpdate = true;

    this.uniforms.uTerrainOffset.value.set(random() * 128, random() * 128);
  }

  /* ------------------------------------------------------------------ */
  /* the CPU mirror — keep in step with terrain.glsl.js                  */
  /* ------------------------------------------------------------------ */

  /** One table cell, wrapped. The GLSL reads exactly this byte. */
  _hash(ix, iy) {
    const x = ((ix % TERRAIN_HASH_SIZE) + TERRAIN_HASH_SIZE) % TERRAIN_HASH_SIZE;
    const y = ((iy % TERRAIN_HASH_SIZE) + TERRAIN_HASH_SIZE) % TERRAIN_HASH_SIZE;
    return this._data[(y * TERRAIN_HASH_SIZE + x) * 4] / 255;
  }

  /** `terrainValue()` from the chunk. */
  _value(px, py) {
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const fx = px - ix;
    const fy = py - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = this._hash(ix, iy);
    const b = this._hash(ix + 1, iy);
    const c = this._hash(ix, iy + 1);
    const d = this._hash(ix + 1, iy + 1);
    const top = a + (b - a) * ux;
    const bottom = c + (d - c) * ux;
    return top + (bottom - top) * uy;
  }

  /**
   * `terrainHeightAt()` from the chunk — the ground height at a world XZ.
   *
   * @param {number} x world X
   * @param {number} z world Z
   * @returns {number} metres
   */
  heightAt(x, z) {
    const u = this.uniforms;
    const amp = u.uTerrainAmp.value;
    if (amp <= 0) return 0;

    const scale = u.uTerrainScale.value;
    const offset = u.uTerrainOffset.value;
    let px = x / scale + offset.x;
    let py = z / scale + offset.y;

    const warp = u.uTerrainWarp.value;
    if (warp > 0) {
      const qx = px * 0.5;
      const qy = py * 0.5;
      const wx = this._value(qx + 19.3, qy + 7.1) - 0.5;
      const wy = this._value(qx - 3.7, qy + 23.9) - 0.5;
      px += wx * warp;
      py += wy * warp;
    }

    const octaves = u.uTerrainOctaves.value;
    const lacunarity = u.uTerrainLacunarity.value;
    const gain = u.uTerrainGain.value;
    const ridge = u.uTerrainRidge.value;

    let sum = 0;
    let a = 1;
    let norm = 0;
    for (let i = 0; i < TERRAIN_MAX_OCTAVES; i++) {
      if (i >= octaves) break;
      const n0 = this._value(px, py);
      const n = n0 + (1 - Math.abs(n0 * 2 - 1) - n0) * ridge; // mix(n, ridged, ridge)
      sum += a * n;
      norm += a;
      px = px * lacunarity + 31.7;
      py = py * lacunarity + 17.3;
      a *= gain;
    }

    return (sum / Math.max(norm, 1e-5) - 0.5) * 2 * amp;
  }

  /**
   * Surface normal at a world XZ. Same central difference the floor's vertex
   * shader takes, so anything the CPU stands up here is square to the mesh.
   *
   * @param {number} x world X
   * @param {number} z world Z
   * @param {number} [eps] the half-width of the difference, metres
   * @returns {Vector3} unit, pointing up
   */
  normalAt(x, z, eps = 0.5) {
    if (!this.displaced) return _normal.set(0, 1, 0);
    const hL = this.heightAt(x - eps, z);
    const hR = this.heightAt(x + eps, z);
    const hD = this.heightAt(x, z - eps);
    const hU = this.heightAt(x, z + eps);
    return _normal.set(hL - hR, 2 * eps, hD - hU).normalize();
  }

  dispose() {
    this.texture.dispose();
  }
}
