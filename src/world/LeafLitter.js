import {
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  Vector2,
  Vector3
} from 'three';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import {
  LEAF_ATLAS,
  LEAF_QUAD,
  createLeafMaterial,
  leafCacheUniforms,
  leafGroundGLSL,
  syncLeafMaterial
} from './leafMaterial.js';

/**
 * Cells per side of the field.
 *
 * The field is a `CELLS × CELLS` grid that wraps toroidally around the
 * character — walking east retires the westmost column and re-seeds it in
 * front — so this is not a level size, it is the resolution of the window that
 * follows you. Twenty is chosen against the two things it trades off: a cell is
 * the unit of re-seeding (so more cells means less work per boundary crossing)
 * and it is the unit of the proximity query (so more cells means fewer leaves
 * to test when a foot goes through them).
 */
export const LITTER_CELLS = 20;
const CELLS = LITTER_CELLS;
const SLOTS = CELLS * CELLS;
const TAU = Math.PI * 2;

/**
 * Ceiling on `litter.perCell`, so a slider cannot ask for a million leaves.
 *
 * The instance buffers are allocated at this, once, and a lower density leaves
 * the tail of each cell empty rather than re-allocating — which is what makes
 * both density controls live. The empty slots are drawn at zero size, so they
 * cost four vertex shader invocations that produce a degenerate triangle and
 * never reach a fragment.
 */
const MAX_PER_CELL = 20;
const CAPACITY = SLOTS * MAX_PER_CELL;

/** Positive modulo — the grid wraps, and `%` does not. */
function wrap(value, n) {
  return ((value % n) + n) % n;
}

/**
 * One deterministic draw from three integers.
 *
 * Deterministic is the whole point: a cell's leaves are a function of its
 * *world* index, so walking a hundred metres away and coming back finds the same
 * leaves lying in the same places, and nothing about the scatter has to be
 * stored or streamed.
 */
function hash3(a, b, c) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The leaves on the ground, and what happens when you walk through them.
 *
 * ## One draw call, no per-frame array walk
 *
 * Every leaf is an instance of the same four-vertex quad, and where it is, which
 * way it is turned, which of the nine leaves on the sheet it wears and how far
 * along a kick it is are all resolved in the vertex shader from three
 * attributes written once. So the per-frame CPU cost of five thousand leaves
 * lying in the mud is **zero** — not "small": the loop that would move them does
 * not exist. The only writes are the handful of leaves something has actually
 * disturbed this frame, and the one column of cells that retires when the
 * character crosses a cell boundary.
 *
 * ## How they sit on the ground
 *
 * The floor bakes the height field into a texture (`world/TerrainCache.js`), and
 * a leaf reads it — bilinearly, four taps, see `leafGround` — for both the
 * height under it *and* the surface normal. So a leaf does not sit at a height:
 * it lies flat against the slope, on the same surface the floor is drawing, and
 * a terrain slider moved in the editor re-lays the whole field for free. Nothing
 * is stored per leaf about the ground at all.
 *
 * ## The kick
 *
 * This is the part that has to be exact rather than merely plausible. A leaf's
 * flight is closed-form — linear drag has an exact solution, so the horizontal
 * travel is one `exp()` of its age — and the arc and the swirl are both built to
 * be **zero at the end of the flight**. That is what makes the landing place a
 * closed form too, which is what lets the CPU compute it in one line the next
 * time something kicks the same leaf. So a leaf can be kicked, land, be kicked
 * again from where it landed, and be kicked again from there, with the GPU
 * animating all of it and the CPU touching four floats per kick.
 *
 * The alternative — a real particle system — would need the position of every
 * leaf on the CPU every frame, which is exactly the cost this is built to avoid.
 *
 * Two things kick: the character's feet (`push`), and the wind, which lifts a
 * few leaves a second and skitters them downwind (`_gust`). They are the same
 * mechanism with different numbers.
 */
export class LeafLitter {
  /**
   * @param {object} options
   * @param {object} options.textures the sheet, from `loadLeafTextures`
   * @param {object} options.look the shared look uniforms, by identity
   * @param {import('./TerrainCache.js').TerrainCache} [options.cache] the baked
   *   height field — bound by identity, so the litter lies on the same ground
   *   the floor is drawing
   * @param {import('./Environment.js').Environment} [options.environment]
   * @param {import('./Atmosphere.js').Atmosphere} [options.atmosphere]
   */
  constructor({ textures, look, cache = null, environment = null, atmosphere = null }) {
    this.uniforms = {
      ...leafCacheUniforms(cache),
      uTime: { value: 0 },
      uSize: { value: 0.14 },
      uHover: { value: 0.012 },
      uFlight: { value: 1.1 },
      uDrag: { value: 2.6 },
      uSwirl: { value: 0.18 },
      uSwirlSpeed: { value: 4 },
      uSpin: { value: 16 },
      /** Metres at which the field starts to erode, and at which it is gone. */
      uFade: { value: new Vector2(22, 31) },
      uRustle: { value: 0.18 },
      /** Gust speed, spatial scale, strength. */
      uGust: { value: new Vector3(0.6, 0.05, 1) }
    };

    this.material = createLeafMaterial({
      textures,
      look,
      uniforms: this.uniforms,
      vertexGLSL: VERTEX,
      environment,
      atmosphere
    });

    /* ---- the grid ---- */
    /** World cell index each slot column / row currently stands for. */
    this._worldI = new Int32Array(CELLS).fill(0x7fffffff);
    this._worldJ = new Int32Array(CELLS).fill(0x7fffffff);
    this._dirtyCol = new Uint8Array(CELLS);
    this._dirtyRow = new Uint8Array(CELLS);

    /**
     * How many of each cell's `MAX_PER_CELL` slots are actually leaves, and how
     * wide a cell is. Both are live: the buffers are allocated once at the
     * ceiling and a lower density simply leaves the tail of every cell at zero
     * size, which the rasteriser drops before it costs a fragment. Re-allocating
     * instead would be a hitch on every step of the slider *and* would strand
     * the old GPU buffers, which three only frees when the geometry itself goes.
     */
    this._perCell = 0;
    this._cellSize = 0;

    /** Instance range written this frame, so only that span goes up the bus. */
    this._lo = Infinity;
    this._hi = -1;
    this._styleDirty = false;

    /** Flight length and the drag integral over it — both read from uniforms. */
    this._flight = 1.1;
    this._impulse = 0;
    /** Fractional leaves the wind still owes, so a low rate is not lost to floor(). */
    this._gustDebt = 0;

    this.geometry = new InstancedBufferGeometry();
    const w = LEAF_QUAD.width * 0.5;
    const h = LEAF_QUAD.height * 0.5;
    this.geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-w, -h, 0, w, -h, 0, w, h, 0, -w, h, 0]), 3)
    );
    // Declared by three's own prefix whether or not we use it, and a missing
    // attribute is a driver warning on some stacks. The shading normal comes
    // from the placement, not from here.
    this.geometry.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3)
    );
    this.geometry.setAttribute(
      'uv',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2)
    );
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);

    // Allocated once, at the ceiling, and never again — see `_perCell`. The
    // arrays are laid out cell by cell, which is what makes a kick near the
    // character a short contiguous span rather than a scattering across the
    // whole buffer, and therefore what makes a partial upload worth doing.
    this._rest = new Float32Array(CAPACITY * 4);
    this._kick = new Float32Array(CAPACITY * 4);
    this._style = new Float32Array(CAPACITY * 2);
    this._restAttr = new InstancedBufferAttribute(this._rest, 4).setUsage(DynamicDrawUsage);
    this._kickAttr = new InstancedBufferAttribute(this._kick, 4).setUsage(DynamicDrawUsage);
    this._styleAttr = new InstancedBufferAttribute(this._style, 2).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aRest', this._restAttr);
    this.geometry.setAttribute('aKick', this._kickAttr);
    this.geometry.setAttribute('aStyle', this._styleAttr);
    this.geometry.instanceCount = CAPACITY;
    // Every leaf is placed in world space by the shader, so the geometry's own
    // bounds describe a quad at the origin and mean nothing.
    this.geometry.boundingSphere = null;

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'LeafLitter';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    // Nothing worth casting: a leaf lying flat on the floor throws its shadow
    // onto the floor it is already touching, and five thousand of them would be
    // paid for in shadow-map fill for a result nobody can see.
    this.mesh.castShadow = false;
    this.mesh.layers.set(LAYER.WORLD);
    // The shader works in world space and the placement hands `objectNormal` a
    // world normal, both of which are only true while this matrix is identity.
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.raycast = () => {};
  }

  /** Leaves actually standing on the ground — the rest of the slots are empty. */
  get count() {
    return SLOTS * this._perCell;
  }

  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt seconds of simulation
   * @param {number} now the simulation clock the shader is given
   * @param {{x: number, z: number}} anchor the character
   * @param {{x: number, y: number}} velocity their ground velocity (x, z)
   */
  update(dt, now, anchor, velocity) {
    const config = settings.leaves;
    const l = config.litter;
    const on = config.enabled && l.enabled;
    this.mesh.visible = on;
    if (!on) return;

    /* ---- the look, all uniforms ---- */
    const u = this.uniforms;
    u.uTime.value = now;
    u.uSize.value = Math.max(0.01, config.size);
    u.uHover.value = l.hover;
    u.uFlight.value = Math.max(0.05, l.flight);
    u.uDrag.value = Math.max(0.05, l.drag);
    u.uSwirl.value = l.swirl;
    u.uSwirlSpeed.value = l.swirlSpeed;
    u.uSpin.value = l.spin;
    u.uFade.value.set(Math.max(1, l.fadeStart), Math.max(l.fadeStart + 1, l.fadeEnd));
    u.uRustle.value = l.rustle;
    u.uGust.value.set(config.gustSpeed, config.gustScale, config.gustStrength);
    syncLeafMaterial(this.material, config);

    this._flight = u.uFlight.value;
    const k = u.uDrag.value;
    this._impulse = (1 - Math.exp(-k * this._flight)) / k;

    /* ---- the field ---- */
    // Density and window size are live like everything else: they only decide
    // where the leaves are laid out, so a change re-seeds the grid rather than
    // rebuilding anything. Re-seeding four hundred cells is a few thousand
    // writes — perceptible on a slider drag and nowhere else.
    const perCell = Math.min(Math.max(Math.round(l.perCell), 1), MAX_PER_CELL);
    const cellSize = Math.max(0.5, l.field) / CELLS;
    if (perCell !== this._perCell || cellSize !== this._cellSize) {
      this._perCell = perCell;
      this._cellSize = cellSize;
      // Every column and row now looks stale, so the follow below re-lays the
      // whole grid onto the new lattice.
      this._worldI.fill(0x7fffffff);
      this._worldJ.fill(0x7fffffff);
    }

    this._follow(anchor.x, anchor.z);
    this.push(anchor.x, anchor.z, velocity.x, velocity.y, now);
    this._gust(dt, now, l, config);
    this._flush();
  }

  /**
   * Kick every settled leaf inside `reach` of a foot going somewhere.
   *
   * Public because a leaf does not care what pushed it: the character is wired
   * up in `world/Leaves.js`, and anything else with a position and a velocity
   * can be handed to the same call.
   *
   * @param {number} x world X of the thing moving
   * @param {number} z world Z
   * @param {number} vx its ground velocity
   * @param {number} vz
   * @param {number} now the simulation clock
   */
  push(x, z, vx, vz, now) {
    // Nothing has been laid out yet — `update` has not run. Guarded because
    // this is the one public entry point that can be reached from outside the
    // frame order, and a zero cell size would divide the query into infinities.
    if (this._cellSize <= 0) return;
    const l = settings.leaves.litter;
    const speed = Math.hypot(vx, vz);
    // Standing still disturbs nothing — without this the leaves under a
    // stationary character would be re-kicked every frame and boil in place.
    if (speed < l.pushSpeed) return;

    const dirX = vx / speed;
    const dirZ = vz / speed;
    // A little ahead of the body: what goes through the leaves is the leading
    // foot, and the root the character is positioned by is half a metre behind it.
    const cx = x + dirX * l.pushLead;
    const cz = z + dirZ * l.pushLead;

    const reach = Math.max(0.05, l.pushRadius);
    const reachSq = reach * reach;
    const cellSize = this._cellSize;
    const perCell = this._perCell;
    const flight = this._flight;
    const impulse = this._impulse;
    const forward = Math.min(Math.max(l.pushForward, 0), 1);
    let budget = l.pushBudget;

    const i0 = Math.floor((cx - reach) / cellSize);
    const i1 = Math.floor((cx + reach) / cellSize);
    const j0 = Math.floor((cz - reach) / cellSize);
    const j1 = Math.floor((cz + reach) / cellSize);

    for (let wj = j0; wj <= j1; wj++) {
      const j = wrap(wj, CELLS);
      // A cell the window does not currently hold — only possible if the reach
      // is dialled up past the field's own radius.
      if (this._worldJ[j] !== wj) continue;

      for (let wi = i0; wi <= i1; wi++) {
        const i = wrap(wi, CELLS);
        if (this._worldI[i] !== wi) continue;

        const base = (j * CELLS + i) * MAX_PER_CELL;
        // Only the first `perCell` of each block hold a leaf; the tail is empty.
        for (let n = 0; n < perCell; n++) {
          if (budget <= 0) return;
          const index = base + n;
          const o = index * 4;

          // Still in the air from the last kick. Left alone rather than
          // re-launched: the closed-form landing the CPU relies on is only
          // exact at the end of a flight (see the class comment).
          if (now - this._kick[o + 3] < flight) continue;

          const px = this._rest[o] + this._kick[o] * impulse;
          const pz = this._rest[o + 1] + this._kick[o + 1] * impulse;
          const dx = px - cx;
          const dz = pz - cz;
          const distSq = dx * dx + dz * dz;
          if (distSq > reachSq) continue;

          const dist = Math.sqrt(distSq);
          // Away from the foot, blended toward where the foot is going. Purely
          // radial reads as an explosion under the character; purely forward
          // reads as a conveyor belt. The blend is what makes it a sweep.
          let ax;
          let az;
          if (dist > 1e-3) {
            ax = (dx / dist) * (1 - forward) + dirX * forward;
            az = (dz / dist) * (1 - forward) + dirZ * forward;
          } else {
            ax = dirX;
            az = dirZ;
          }
          const alen = Math.hypot(ax, az) || 1;

          // Harder the faster you are going and the closer the leaf is, with a
          // wide random spread so a step does not throw a tidy fan.
          const power =
            l.pushForce * speed * (0.35 + 0.65 * (1 - dist / reach)) * (0.5 + Math.random());

          this._settle(index);
          this._kick[o] = (ax / alen) * power;
          this._kick[o + 1] = (az / alen) * power;
          this._kick[o + 2] = l.pushLift * power * (0.25 + Math.random() * 0.95);
          this._kick[o + 3] = now;
          this._touch(index);
          budget--;
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */

  /**
   * Slide the window onto the character, re-seeding only what changed.
   *
   * The slot a world cell lands in is `worldIndex mod CELLS` on each axis, which
   * makes the mapping **separable**: a step east retires exactly one column and
   * a step north exactly one row, whatever else is going on. So the usual cost
   * of this is a forty-iteration comparison loop that finds nothing, and the
   * cost when the character does cross a boundary is one column — twenty cells,
   * a few hundred leaves — rather than the whole field.
   */
  _follow(x, z) {
    const half = CELLS >> 1;
    const cellSize = this._cellSize;
    const baseI = Math.floor(x / cellSize) - half;
    const baseJ = Math.floor(z / cellSize) - half;

    const dirtyCol = this._dirtyCol;
    const dirtyRow = this._dirtyRow;
    let moved = false;

    for (let i = 0; i < CELLS; i++) {
      // The one world index congruent to `i` that lies inside the window.
      const w = baseI + wrap(i - baseI, CELLS);
      const stale = w !== this._worldI[i];
      dirtyCol[i] = stale ? 1 : 0;
      if (stale) {
        this._worldI[i] = w;
        moved = true;
      }
    }
    for (let j = 0; j < CELLS; j++) {
      const w = baseJ + wrap(j - baseJ, CELLS);
      const stale = w !== this._worldJ[j];
      dirtyRow[j] = stale ? 1 : 0;
      if (stale) {
        this._worldJ[j] = w;
        moved = true;
      }
    }
    if (!moved) return;

    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        if (dirtyCol[i] || dirtyRow[j]) this._seedCell(i, j);
      }
    }
    this._styleDirty = true;
  }

  /** Lay a cell's leaves out from the hash of its world index. */
  _seedCell(i, j) {
    const wi = this._worldI[i];
    const wj = this._worldJ[j];
    const cellSize = this._cellSize;
    const perCell = this._perCell;
    const spread = settings.leaves.sizeVariance;
    const base = (j * CELLS + i) * MAX_PER_CELL;

    for (let n = 0; n < MAX_PER_CELL; n++) {
      const index = base + n;
      const o = index * 4;
      const s = n * 8;

      // Past the density asked for: an empty slot. Marked with a zero size,
      // which collapses its quad to a point the rasteriser drops before it can
      // cost a fragment, and left otherwise untouched — turning the density back
      // up re-lays the whole grid anyway (see `update`), so there is nothing to
      // be gained by keeping a position in it.
      if (n >= perCell) {
        this._rest[o + 3] = 0;
        this._kick[o + 3] = -1000;
        continue;
      }

      this._rest[o] = (wi + hash3(wi, wj, s)) * cellSize;
      this._rest[o + 1] = (wj + hash3(wi, wj, s + 1)) * cellSize;
      this._rest[o + 2] = hash3(wi, wj, s + 2) * TAU;
      this._rest[o + 3] = 1 - spread * hash3(wi, wj, s + 3);

      // Settled long ago and going nowhere: a zero velocity means the flight
      // above contributes nothing however old it gets.
      this._kick[o] = 0;
      this._kick[o + 1] = 0;
      this._kick[o + 2] = 0;
      this._kick[o + 3] = -100 - hash3(wi, wj, s + 4) * 90;

      this._style[index * 2] = Math.floor(hash3(wi, wj, s + 5) * LEAF_ATLAS * LEAF_ATLAS);
      this._style[index * 2 + 1] = hash3(wi, wj, s + 6);
    }

    this._touchRange(base, base + MAX_PER_CELL - 1);
  }

  /**
   * Lift a few leaves a second and skitter them downwind.
   *
   * The other half of "the wind moves them": `uRustle` quivers every leaf where
   * it lies, which is what the *field* does in a breeze, and this is what one
   * leaf in it does — comes unstuck, tumbles a few metres and settles again.
   * Between them they are the difference between a carpet that shivers and a
   * floor that has weather on it, and this half costs a handful of writes a
   * second because it is the same kick the character's feet use.
   */
  _gust(dt, now, l, config) {
    if (dt <= 0 || l.gustRate <= 0) return;
    const windX = config.windX;
    const windZ = config.windZ;
    const speed = Math.hypot(windX, windZ);
    if (speed < 1e-3) return;

    this._gustDebt += l.gustRate * dt;
    let count = Math.floor(this._gustDebt);
    if (count <= 0) return;
    this._gustDebt -= count;
    // A long hitch cannot be allowed to spend its whole backlog at once.
    count = Math.min(count, 32);

    const dirX = windX / speed;
    const dirZ = windZ / speed;
    const flight = this._flight;

    for (let n = 0; n < count; n++) {
      // A slot anywhere in the field, which is the whole point: the wind is not
      // a thing happening around the character.
      const slot = (Math.random() * SLOTS) | 0;
      const index = slot * MAX_PER_CELL + ((Math.random() * this._perCell) | 0);
      const o = index * 4;
      // An empty slot, or one still in the air from the last gust.
      if (this._rest[o + 3] <= 0) continue;
      if (now - this._kick[o + 3] < flight) continue;

      // Downwind, fanned either side — a gust is turbulent, and a field of
      // leaves all leaving on exactly the same bearing reads as a conveyor.
      const fan = (Math.random() - 0.5) * l.gustSpread;
      const cos = Math.cos(fan);
      const sin = Math.sin(fan);
      const power = l.gustForce * speed * (0.3 + Math.random() * 1.2);

      this._settle(index);
      this._kick[o] = (dirX * cos - dirZ * sin) * power;
      this._kick[o + 1] = (dirX * sin + dirZ * cos) * power;
      this._kick[o + 2] = l.gustLift * power * (0.2 + Math.random());
      this._kick[o + 3] = now;
      this._touch(index);
    }
  }

  /**
   * Fold a finished flight into the resting place.
   *
   * The one line the whole design turns on. Because the arc and the swirl are
   * both zero at the end of a flight, a landed leaf is at exactly
   * `rest + velocity · impulse(flight)` — so where it *is* can be recovered on
   * the CPU without ever having tracked it, and it becomes the origin the next
   * kick is measured from. Only ever called on a leaf that has landed.
   */
  _settle(index) {
    const o = index * 4;
    this._rest[o] += this._kick[o] * this._impulse;
    this._rest[o + 1] += this._kick[o + 1] * this._impulse;
  }

  _touch(index) {
    if (index < this._lo) this._lo = index;
    if (index > this._hi) this._hi = index;
  }

  _touchRange(lo, hi) {
    if (lo < this._lo) this._lo = lo;
    if (hi > this._hi) this._hi = hi;
  }

  /** Send up only the span that was written. */
  _flush() {
    if (this._hi < this._lo) return;
    const count = this._hi - this._lo + 1;

    this._restAttr.addUpdateRange(this._lo * 4, count * 4);
    this._restAttr.needsUpdate = true;
    this._kickAttr.addUpdateRange(this._lo * 4, count * 4);
    this._kickAttr.needsUpdate = true;
    // The variant and the seed are a slot's identity — they move only when a
    // cell is re-seeded, which is the one case worth a whole-buffer upload.
    if (this._styleDirty) {
      this._styleAttr.needsUpdate = true;
      this._styleDirty = false;
    }

    this._lo = Infinity;
    this._hi = -1;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* -------------------------------------------------------------------- */

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uHover;
uniform float uFlight;
uniform float uDrag;
uniform float uSwirl;
uniform float uSwirlSpeed;
uniform float uSpin;
uniform vec2  uFade;
uniform float uRustle;
uniform vec3  uGust;

attribute vec4 aRest;   // resting x, resting z, yaw, size
attribute vec4 aKick;   // launch vx, launch vz, peak height, birth
attribute vec2 aStyle;  // which of the nine, and the slot's own seed

${leafGroundGLSL}

LeafPlacement leafPlace() {
  LeafPlacement leaf;
  leaf.cell = vec2(mod(aStyle.x, ${LEAF_ATLAS}.0), floor(aStyle.x / ${LEAF_ATLAS}.0));

  float flight = max(uFlight, 0.05);
  float t = min(max(uTime - aKick.w, 0.0), flight);
  float u = t / flight;
  float settle = 1.0 - u;
  float phase = aStyle.y * 43.0 + aKick.w * 0.7;

  /* ---- where the kick took it ---- */
  // Linear drag has an exact solution, so the whole flight is one exp() of the
  // age: nothing is integrated, nothing is stored per frame, and the path is
  // identical at any frame rate.
  float k = max(uDrag, 0.05);
  vec2 travel = aKick.xy * ((1.0 - exp(-k * t)) / k);

  // A sideways swirl on the way down, gone by the time it lands. That is not
  // decoration — the landing place has to be reproducible on the CPU, so
  // everything that moves the leaf has to have died out at u = 1.
  vec2 perp = vec2(-aKick.y, aKick.x);
  float plen = length(perp);
  perp = plen > 1e-4 ? perp / plen : vec2(1.0, 0.0);
  travel += perp * (sin(uSwirlSpeed * t * (2.0 + aStyle.y * 3.0) + phase)
                    * uSwirl * settle * settle);

  vec2 xz = aRest.xy + travel;
  vec4 field = leafGround(xz);

  // Up, and down again. Zero at both ends by construction, so the leaf lands on
  // the ground rather than at a fixed height above where it set off from — and
  // front-loaded, because a kicked leaf leaves fast and comes down slowly.
  float arc = aKick.z * sin(3.14159265 * pow(u, 0.65));
  leaf.centre = vec3(xz.x, field.w + uHover + arc, xz.y);

  /* ---- which way it is turned ---- */
  // Flat against the slope under it, facing its own yaw. The normal is the
  // interpolated one out of the baked field, so a leaf on a hillside is lying
  // on the hillside rather than standing at an angle to it.
  vec3 n = normalize(field.xyz);
  vec3 ref = vec3(cos(aRest.z), 0.0, sin(aRest.z));
  vec3 f = ref - n * dot(ref, n);
  float flen = length(f);
  f = flen > 1e-4 ? f / flen : normalize(cross(n, vec3(0.0, 0.0, 1.0)));
  vec3 b = cross(n, f);

  // The wind worrying at it where it lies. Two incommensurate waves over world
  // position, so a gust crosses the field as a wave rather than every leaf in
  // it twitching on the same beat. Each rotation keeps the frame orthonormal,
  // which is why they are applied one axis at a time.
  float g1 = sin(uTime * uGust.x + dot(xz, vec2(uGust.y, uGust.y * 0.83)) + phase);
  float g2 = sin(uTime * uGust.x * 0.77 - dot(xz, vec2(uGust.y * 1.31, uGust.y)) + phase * 1.7);
  float quiver = uRustle * uGust.z * (0.35 + 0.65 * aStyle.y);

  float shiver = g2 * quiver * 0.5;
  f = leafSpin(f, n, shiver);
  b = leafSpin(b, n, shiver);
  float hinge = g1 * quiver;
  f = leafSpin(f, b, hinge);
  n = leafSpin(n, b, hinge);

  // And a real tumble while it is off the ground, unwinding to nothing as it
  // settles — which is what leaves it lying flat at the end of a kick instead
  // of standing on its edge.
  float spin = uSpin * t * settle;
  vec3 axis = normalize(vec3(sin(phase * 1.7), 0.62, cos(phase)));
  f = leafSpin(f, axis, spin);
  b = leafSpin(b, axis, spin);
  n = leafSpin(n, axis, spin);

  leaf.tangent = f;
  leaf.bitangent = b;
  leaf.normal = n;
  leaf.size = aRest.w * uSize;

  // The far half of the field erodes away rather than being drawn a pixel at a
  // time: a density that reads as litter underfoot is a shimmering grey haze at
  // thirty metres, and the dissolve costs nothing where a second LOD would not.
  leaf.cut = smoothstep(uFade.x, uFade.y, distance(leaf.centre, cameraPosition));
  return leaf;
}
`;
