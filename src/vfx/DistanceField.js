import {
  ClampToEdgeWrapping,
  Data3DTexture,
  LinearFilter,
  RedFormat,
  UnsignedByteType,
  Vector3
} from 'three';

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _p = new Vector3();

/** Chamfer weights for the 3-3-4 sweep, in voxels. */
const W1 = 1.0;
const W2 = Math.SQRT2;
const W3 = Math.sqrt(3);

/**
 * How far the katana is, in every direction, baked into a 3D texture.
 *
 * This is what lets the volumetric flame have the *shape of the sword* rather
 * than the shape of the box that selected it. A raymarcher needs to answer
 * "how far is the steel from here" thousands of times per pixel, which no mesh
 * can do; so the faces the emitter box kept are burned once into a small
 * unsigned distance field, and the march reads it as a texture.
 *
 * The bake is two steps. First the surface is stamped in: every selected face
 * is walked at about one sample per voxel, and each sample writes its exact
 * distance into the cells immediately around it — which is the only place exact
 * distances matter, because it is where the flame meets the steel. Then a
 * two-pass chamfer sweep propagates those seeds outward, turning a sparse shell
 * into a full field in two linear passes instead of the voxels × triangles the
 * direct answer would cost.
 *
 * Values are stored as `distance / band`, so a byte per voxel is a millimetre
 * of precision over the region the flame actually occupies, and everything past
 * the band clamps to "far away, no fire here".
 */
export class DistanceField {
  constructor() {
    /** @type {Data3DTexture|null} */
    this.texture = null;
    /** Grid corner and extent, in the emitter box's own frame. */
    this.min = new Vector3();
    this.size = new Vector3(1, 1, 1);
    /** Distance the byte range covers, in metres. */
    this.band = 0.2;
    this.ready = false;

    this._dims = [0, 0, 0];
    this._distance = null;
    this._bytes = null;
  }

  /**
   * Bake the selected faces.
   *
   * @param {import('./SurfaceSampler.js').SurfaceSampler} sampler
   * @param {import('three').Matrix4} toBox model space → the box's frame, metric
   * @param {Vector3} half the box's half extents in that frame
   * @param {number} band how far out the field is worth knowing, metres
   * @param {number} [maxVoxels] the whole budget for the grid. The band has to
   *   cover the plume as well as the sheath, so the grid it is spread over is
   *   large; this is what keeps the voxel near a centimetre, which is the scale
   *   the flame's grip on the steel is read at.
   * @returns {boolean} whether there was anything to bake
   */
  build(sampler, toBox, half, band, maxVoxels = 400000) {
    if (!sampler || sampler.pickedCount === 0) {
      this.ready = false;
      return false;
    }

    this.band = Math.max(band, 0.01);

    // The grid has to hold the box plus everything the flame can reach off it.
    const margin = this.band;
    const extentX = (half.x + margin) * 2;
    const extentY = (half.y + margin) * 2;
    const extentZ = (half.z + margin) * 2;

    // One voxel size for all three axes — the chamfer weights below assume it.
    const volume = extentX * extentY * extentZ;
    let voxel = Math.cbrt(volume / maxVoxels);
    voxel = Math.max(voxel, Math.max(extentX, extentY, extentZ) / 192, 0.0025);

    const nx = clampDim(Math.ceil(extentX / voxel));
    const ny = clampDim(Math.ceil(extentY / voxel));
    const nz = clampDim(Math.ceil(extentZ / voxel));
    const count = nx * ny * nz;

    this._dims = [nx, ny, nz];
    this.size.set(nx * voxel, ny * voxel, nz * voxel);
    this.min.set(-this.size.x * 0.5, -this.size.y * 0.5, -this.size.z * 0.5);

    if (!this._distance || this._distance.length < count) {
      this._distance = new Float32Array(count);
      this._bytes = new Uint8Array(count);
    }
    const distance = this._distance;
    const far = this.band * 4;
    distance.fill(far, 0, count);

    /* ---- stamp the surface in ---- */
    // Each face is walked at roughly one sample per voxel, so the seeds land in
    // a closed shell whatever size the triangles happen to be — a coarse face
    // gets a grid across it, and one already finer than a voxel costs its three
    // corners and nothing more. Tying the density to the *voxel* rather than to
    // a fixed count per triangle is what keeps this from being either full of
    // holes on a coarse mesh or hopelessly redundant on a fine one.
    for (let t = 0; t < sampler.pickedCount; t++) {
      sampler.readSelected(t, _a, _b, _c);
      _a.applyMatrix4(toBox);
      _b.applyMatrix4(toBox);
      _c.applyMatrix4(toBox);

      const longest = Math.sqrt(
        Math.max(
          _a.distanceToSquared(_b),
          _b.distanceToSquared(_c),
          _c.distanceToSquared(_a)
        )
      );
      const steps = Math.min(16, Math.max(1, Math.ceil(longest / voxel)));

      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps - i; j++) {
          const u = i / steps;
          const v = j / steps;
          _p.set(
            _a.x + (_b.x - _a.x) * u + (_c.x - _a.x) * v,
            _a.y + (_b.y - _a.y) * u + (_c.y - _a.y) * v,
            _a.z + (_b.z - _a.z) * u + (_c.z - _a.z) * v
          );
          this._stamp(_p, voxel, distance);
        }
      }
    }

    /* ---- sweep it outward ---- */
    this._sweep(distance, voxel);

    /* ---- encode ---- */
    const bytes = this._bytes;
    const scale = 255 / this.band;
    for (let i = 0; i < count; i++) {
      const v = distance[i] * scale;
      bytes[i] = v >= 255 ? 255 : v | 0;
    }

    this._upload(bytes, nx, ny, nz);
    this.ready = true;
    return true;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Write the exact distance to one surface point into the voxels around it.
   *
   * One voxel of reach, which is all the sweep needs to take over from: the
   * samples are spaced a voxel apart, so every cell touching the surface gets a
   * true distance and everything beyond is the sweep's job. Reaching two voxels
   * out instead would be five times the work for a shell the sweep reproduces.
   */
  _stamp(point, voxel, distance) {
    const [nx, ny, nz] = this._dims;
    const gx = (point.x - this.min.x) / voxel;
    const gy = (point.y - this.min.y) / voxel;
    const gz = (point.z - this.min.z) / voxel;

    const x0 = Math.max(0, Math.floor(gx) - 1);
    const x1 = Math.min(nx - 1, Math.floor(gx) + 1);
    const y0 = Math.max(0, Math.floor(gy) - 1);
    const y1 = Math.min(ny - 1, Math.floor(gy) + 1);
    const z0 = Math.max(0, Math.floor(gz) - 1);
    const z1 = Math.min(nz - 1, Math.floor(gz) + 1);

    for (let z = z0; z <= z1; z++) {
      const dz = (z + 0.5 - gz) * voxel;
      const dz2 = dz * dz;
      for (let y = y0; y <= y1; y++) {
        const dy = (y + 0.5 - gy) * voxel;
        const row = (z * ny + y) * nx;
        const dyz = dz2 + dy * dy;
        for (let x = x0; x <= x1; x++) {
          const dx = (x + 0.5 - gx) * voxel;
          const d = Math.sqrt(dyz + dx * dx);
          const i = row + x;
          if (d < distance[i]) distance[i] = d;
        }
      }
    }
  }

  /**
   * Two chamfer passes — forward over the causal half of the neighbourhood,
   * then backward over the other half.
   *
   * The error against a true Euclidean transform is a couple of per cent, which
   * for a field whose only job is to say how thick the flame is here is not a
   * difference anyone can see. The neighbour offsets are resolved into flat
   * indices up front: this is the one genuinely hot loop in the effect, and it
   * runs over a quarter of a million voxels every time the box is dragged.
   */
  _sweep(distance, voxel) {
    const [nx, ny, nz] = this._dims;
    const strideY = nx;
    const strideZ = nx * ny;

    // The 13 causal neighbours, as parallel typed arrays. This loop runs ten
    // million times per bake, so the offsets are resolved to flat indices here
    // and the inner loop touches nothing but numbers.
    const dxs = new Int8Array(13);
    const dys = new Int8Array(13);
    const dzs = new Int8Array(13);
    const offsets = new Int32Array(13);
    const weights = new Float32Array(13);

    let n = 0;
    for (let dz = -1; dz <= 0; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dz === 0 && (dy > 0 || (dy === 0 && dx >= 0))) continue;
          const steps = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          dxs[n] = dx;
          dys[n] = dy;
          dzs[n] = dz;
          offsets[n] = dx + dy * strideY + dz * strideZ;
          weights[n] = (steps === 1 ? W1 : steps === 2 ? W2 : W3) * voxel;
          n++;
        }
      }
    }

    sweep(distance, dxs, dys, dzs, offsets, weights, nx, ny, nz, 1);
    // The backward pass is the same neighbourhood mirrored.
    for (let i = 0; i < 13; i++) {
      dxs[i] = -dxs[i];
      dys[i] = -dys[i];
      dzs[i] = -dzs[i];
      offsets[i] = -offsets[i];
    }
    sweep(distance, dxs, dys, dzs, offsets, weights, nx, ny, nz, -1);
  }

  /** (Re)build the GPU texture. Reused in place whenever the grid fits. */
  _upload(bytes, nx, ny, nz) {
    const size = nx * ny * nz;
    const image = this.texture?.image;
    if (image && image.width === nx && image.height === ny && image.depth === nz) {
      image.data.set(bytes.subarray(0, size));
      this.texture.needsUpdate = true;
      return;
    }

    this.texture?.dispose();
    this.texture = new Data3DTexture(bytes.slice(0, size), nx, ny, nz);
    this.texture.format = RedFormat;
    this.texture.type = UnsignedByteType;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.wrapS = ClampToEdgeWrapping;
    this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.wrapR = ClampToEdgeWrapping;
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture?.dispose();
    this.texture = null;
    this._distance = null;
    this._bytes = null;
    this.ready = false;
  }
}

function clampDim(n) {
  return Math.min(192, Math.max(4, n));
}

/**
 * One chamfer pass in scan order (`step` 1 forward, -1 backward).
 *
 * The bounds check is per neighbour rather than per voxel because the grid's
 * faces are the only place it can fail, and hoisting it would mean either three
 * nested branch sets or a padded grid — both more expensive than the compare.
 */
function sweep(distance, dxs, dys, dzs, offsets, weights, nx, ny, nz, step) {
  const strideY = nx;
  const strideZ = nx * ny;
  const z0 = step > 0 ? 0 : nz - 1;
  const y0 = step > 0 ? 0 : ny - 1;
  const x0 = step > 0 ? 0 : nx - 1;

  for (let z = z0; z >= 0 && z < nz; z += step) {
    for (let y = y0; y >= 0 && y < ny; y += step) {
      for (let x = x0; x >= 0 && x < nx; x += step) {
        const i = x + y * strideY + z * strideZ;
        let d = distance[i];
        for (let n = 0; n < 13; n++) {
          const xx = x + dxs[n];
          if (xx < 0 || xx >= nx) continue;
          const yy = y + dys[n];
          if (yy < 0 || yy >= ny) continue;
          const zz = z + dzs[n];
          if (zz < 0 || zz >= nz) continue;
          const candidate = distance[i + offsets[n]] + weights[n];
          if (candidate < d) d = candidate;
        }
        distance[i] = d;
      }
    }
  }
}
