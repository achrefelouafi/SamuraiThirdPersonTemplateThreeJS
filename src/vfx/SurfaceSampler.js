import { Matrix4, Vector3 } from 'three';

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _ab = new Vector3();
const _ac = new Vector3();
const _n = new Vector3();
const _centroid = new Vector3();
const _matrix = new Matrix4();

/** Floats per triangle in the pool: v0, edge1, edge2, normal, area. */
const STRIDE = 13;

/**
 * A model's surface, as points that can be picked at random.
 *
 * This is what turns "the faces inside that box" into an emitter: the whole
 * model is flattened once into a triangle pool in the *model's own frame*, and
 * `select()` then keeps the triangles a volume test accepts. `sample()` picks
 * one of those with probability proportional to its area and returns a uniform
 * point on it, so the flames come off the blade evenly rather than pooling
 * wherever the mesh happens to be dense.
 *
 * ## Why the triangles are subdivided
 *
 * A katana blade is a handful of very long quads. Testing whether such a
 * triangle is "in the box" has no useful answer — half of it is, and picking a
 * point on it lands anywhere along the whole blade regardless of how small the
 * box was drawn. So every triangle is split until its longest edge is under
 * `maxEdge`, at which point the centroid test *is* the containment test to
 * within a couple of millimetres, and shrinking the box genuinely shrinks the
 * fire. The split is a build-time cost paid once per model.
 */
export class SurfaceSampler {
  /**
   * @param {import('three').Object3D} root the model; triangles come back in its frame
   * @param {object} [options]
   * @param {number} [options.maxEdge] metres — triangles are split below this
   * @param {number} [options.budget] hard cap on the triangle pool
   * @param {(node: import('three').Object3D) => boolean} [options.filter]
   *   which meshes count; the default takes every visible one
   */
  constructor(root, { maxEdge = 0.018, budget = 40000, filter = null } = {}) {
    /** Flat pool, `STRIDE` floats per triangle. */
    this.data = new Float32Array(0);
    this.count = 0;

    /** Indices into the pool that `select()` kept, and their running area. */
    this.picked = new Int32Array(0);
    this.cumulative = new Float32Array(0);
    this.pickedCount = 0;
    this.area = 0;

    /** Model-space bounds of every triangle in the pool. */
    this.min = new Vector3(Infinity, Infinity, Infinity);
    this.max = new Vector3(-Infinity, -Infinity, -Infinity);

    if (root) this._build(root, maxEdge, budget, filter);
  }

  get isEmpty() {
    return this.count === 0;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Keep the triangles whose centre a test accepts.
   *
   * Cheap enough to run on every frame of a gizmo drag — it is one predicate
   * call and one add per triangle, over a pool that is thousands rather than
   * millions of entries.
   *
   * @param {(point: Vector3) => boolean} contains
   * @returns {number} how many triangles are now emitting
   */
  select(contains) {
    if (this.picked.length < this.count) {
      this.picked = new Int32Array(this.count);
      this.cumulative = new Float32Array(this.count);
    }

    let kept = 0;
    let total = 0;
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      // v0 + (e1 + e2) / 3
      _centroid.set(
        this.data[o] + (this.data[o + 3] + this.data[o + 6]) / 3,
        this.data[o + 1] + (this.data[o + 4] + this.data[o + 7]) / 3,
        this.data[o + 2] + (this.data[o + 5] + this.data[o + 8]) / 3
      );
      if (!contains(_centroid)) continue;
      total += this.data[o + 12];
      this.picked[kept] = i;
      this.cumulative[kept] = total;
      kept++;
    }

    this.pickedCount = kept;
    this.area = total;
    return kept;
  }

  /**
   * A uniform random point on the selected surface.
   *
   * @param {Vector3} position written with the point, in model space
   * @param {Vector3} normal written with that triangle's face normal
   * @returns {boolean} false when nothing is selected
   */
  sample(position, normal) {
    if (this.pickedCount === 0 || this.area <= 0) return false;

    const target = Math.random() * this.area;
    const index = this._search(target);
    const o = this.picked[index] * STRIDE;

    // Uniform barycentric on the triangle: the sqrt is what keeps the corner
    // from being three times more likely than the middle.
    let u = Math.random();
    let v = Math.random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }

    position.set(
      this.data[o] + this.data[o + 3] * u + this.data[o + 6] * v,
      this.data[o + 1] + this.data[o + 4] * u + this.data[o + 7] * v,
      this.data[o + 2] + this.data[o + 5] * u + this.data[o + 8] * v
    );
    normal.set(this.data[o + 9], this.data[o + 10], this.data[o + 11]);
    return true;
  }

  /**
   * The corners of one selected triangle, by position in the selection.
   *
   * How the distance field reads the surface back out — see `DistanceField`.
   *
   * @param {number} slot 0..`pickedCount`
   */
  readSelected(slot, a, b, c) {
    const o = this.picked[slot] * STRIDE;
    a.set(this.data[o], this.data[o + 1], this.data[o + 2]);
    b.set(
      a.x + this.data[o + 3],
      a.y + this.data[o + 4],
      a.z + this.data[o + 5]
    );
    c.set(
      a.x + this.data[o + 6],
      a.y + this.data[o + 7],
      a.z + this.data[o + 8]
    );
  }

  /** First entry whose running area passes `target`. */
  _search(target) {
    let lo = 0;
    let hi = this.pickedCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /* ------------------------------------------------------------------ */

  _build(root, maxEdge, budget, filter) {
    root.updateWorldMatrix(true, true);
    const toModel = new Matrix4().copy(root.matrixWorld).invert();

    /** @type {number[]} */
    const out = [];
    const limit = maxEdge * maxEdge;

    root.traverse((node) => {
      if (!node.isMesh || node.visible === false) return;
      if (filter && !filter(node)) return;

      const geometry = node.geometry;
      const position = geometry?.attributes?.position;
      if (!position) return;

      _matrix.multiplyMatrices(toModel, node.matrixWorld);
      const index = geometry.index;
      const faces = index ? index.count / 3 : position.count / 3;

      for (let f = 0; f < faces; f++) {
        if (out.length / STRIDE >= budget) return;

        const i0 = index ? index.getX(f * 3) : f * 3;
        const i1 = index ? index.getX(f * 3 + 1) : f * 3 + 1;
        const i2 = index ? index.getX(f * 3 + 2) : f * 3 + 2;

        _a.fromBufferAttribute(position, i0).applyMatrix4(_matrix);
        _b.fromBufferAttribute(position, i1).applyMatrix4(_matrix);
        _c.fromBufferAttribute(position, i2).applyMatrix4(_matrix);

        subdivide(out, _a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z, limit, budget);
      }
    });

    this.count = out.length / STRIDE;
    this.data = new Float32Array(out);

    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      const x = this.data[o];
      const y = this.data[o + 1];
      const z = this.data[o + 2];
      // The three corners are v0, v0 + e1 and v0 + e2.
      this._grow(x, y, z);
      this._grow(x + this.data[o + 3], y + this.data[o + 4], z + this.data[o + 5]);
      this._grow(x + this.data[o + 6], y + this.data[o + 7], z + this.data[o + 8]);
    }
  }

  _grow(x, y, z) {
    if (x < this.min.x) this.min.x = x;
    if (y < this.min.y) this.min.y = y;
    if (z < this.min.z) this.min.z = z;
    if (x > this.max.x) this.max.x = x;
    if (y > this.max.y) this.max.y = y;
    if (z > this.max.z) this.max.z = z;
  }
}

/* -------------------------------------------------------------------- */

/**
 * Split a triangle until every piece is under `limit` (squared edge length).
 *
 * **Longest-edge bisection**, not the four-way midpoint split, and the
 * difference is not academic. Midpoint splitting preserves a triangle's shape,
 * so a sliver stays a sliver: the two triangles making up the flat of a
 * 30 mm × 900 mm blade have to be split six times before their *long* edge is
 * under 20 mm, and that is 4⁶ = 4096 pieces each — the pool is exhausted by one
 * face of one sword, and every mesh after it comes through unsplit. Cutting the
 * longest edge alone adds one triangle per split and stops after about 45 of
 * them, which is the number the surface area actually calls for.
 *
 * Iterative rather than recursive so a pathological mesh cannot blow the stack,
 * and it stops the moment the pool is full — a model too dense to subdivide is
 * still emitted, just at the resolution the budget bought.
 */
function subdivide(out, ax, ay, az, bx, by, bz, cx, cy, cz, limit, budget) {
  const stack = [ax, ay, az, bx, by, bz, cx, cy, cz];

  while (stack.length) {
    const z2 = stack.pop();
    const y2 = stack.pop();
    const x2 = stack.pop();
    const z1 = stack.pop();
    const y1 = stack.pop();
    const x1 = stack.pop();
    const z0 = stack.pop();
    const y0 = stack.pop();
    const x0 = stack.pop();

    const e01 = dist2(x0, y0, z0, x1, y1, z1);
    const e12 = dist2(x1, y1, z1, x2, y2, z2);
    const e20 = dist2(x2, y2, z2, x0, y0, z0);
    const longest = Math.max(e01, e12, e20);

    // One bisection costs one more slot; stop while there is still room to emit
    // everything already waiting.
    const room = budget - out.length / STRIDE - stack.length / 9;
    if (longest > limit && room > 1) {
      // Relabel so the longest edge is always (0, 1), then cut it.
      let px = x0, py = y0, pz = z0;
      let qx = x1, qy = y1, qz = z1;
      let rx = x2, ry = y2, rz = z2;
      if (longest === e12) {
        px = x1; py = y1; pz = z1;
        qx = x2; qy = y2; qz = z2;
        rx = x0; ry = y0; rz = z0;
      } else if (longest === e20) {
        px = x2; py = y2; pz = z2;
        qx = x0; qy = y0; qz = z0;
        rx = x1; ry = y1; rz = z1;
      }

      const mx = (px + qx) * 0.5;
      const my = (py + qy) * 0.5;
      const mz = (pz + qz) * 0.5;

      stack.push(
        px, py, pz, mx, my, mz, rx, ry, rz,
        mx, my, mz, qx, qy, qz, rx, ry, rz
      );
      continue;
    }

    if (out.length / STRIDE >= budget) return;

    _ab.set(x1 - x0, y1 - y0, z1 - z0);
    _ac.set(x2 - x0, y2 - y0, z2 - z0);
    _n.crossVectors(_ab, _ac);
    const area = _n.length() * 0.5;
    if (area <= 1e-12) continue;
    _n.divideScalar(area * 2);

    out.push(
      x0, y0, z0,
      _ab.x, _ab.y, _ab.z,
      _ac.x, _ac.y, _ac.z,
      _n.x, _n.y, _n.z,
      area
    );
  }
}

function dist2(x0, y0, z0, x1, y1, z1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  return dx * dx + dy * dy + dz * dz;
}
