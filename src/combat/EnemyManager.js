import { Box3, Group, MathUtils, Vector3 } from 'three';

import { settings } from '../config/settings.js';
import { disposeObject } from '../utils/dispose.js';
import { Enemy } from './Enemy.js';

/** The body, with its idle baked in — one file, cloned per enemy. */
const ENEMY_URL = './models/enemyidle.fbx';

const _v = new Vector3();

/**
 * The population: who is standing, who is on the ground, and who is next.
 *
 * One rig is loaded and every enemy is a `SkeletonUtils` clone of it, so five
 * bodies cost one download, one set of geometry and five skeletons. The manager
 * owns three things and nothing else:
 *
 *  - **The count.** `settings.enemies.count` of them are *standing* at any
 *    moment. A corpse does not hold a slot — the refill timer starts when the
 *    body dies, so the ring around the player is back to full a couple of
 *    seconds later while the old one is still lying there.
 *  - **Where they stand.** Uniformly over the annulus between `minRadius` and
 *    `radius` of wherever the player currently is, rejected against each other
 *    so two never share a patch of ground. Placement is around the *player*
 *    rather than the origin, so walking a hundred metres finds new company
 *    rather than an empty field.
 *  - **Who gets hit.** `findTarget` is the whole of the melee's aim assist, and
 *    it is deliberately the only thing that decides it — the attack asks, this
 *    answers, and tuning "which one did I mean" happens in one place.
 */
export class EnemyManager {
  /**
   * @param {object} world
   * @param {{heightAt: (x: number, z: number) => number}|null} [world.terrain]
   * @param {{onBlood?: Function}|null} [world.effects] handed
   *   to every body it stands up, for the ones that come apart — the manager
   *   only carries it, exactly as it carries the terrain.
   */
  constructor({ terrain = null, effects = null } = {}) {
    this.terrain = terrain;
    this.effects = effects;

    this.group = new Group();
    this.group.name = 'Enemies';

    /** @type {Enemy[]} everything on stage, standing or not. */
    this.enemies = [];
    /** Seconds until each queued body walks on. */
    this._pending = [];

    this.source = null;
    this.clip = null;
    this._scale = 1;
    this._offset = new Vector3();
    this._localHeight = 1;
    this._forwardYaw = 0;

    /** Where the player was last frame — spawning and watching both need it. */
    this._player = new Vector3();
    /** Bodies felled since the page loaded. The editor reads it. */
    this.kills = 0;
  }

  /* ------------------------------------------------------------------ */
  /* loading                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   */
  async load(assets) {
    const fbx = await assets.loadFBX(ENEMY_URL);
    await assets.settled();

    this.clip = fbx.animations?.[0] ?? null;
    if (!this.clip) {
      console.warn(`[EnemyManager] ${ENEMY_URL} carries no animation — the bodies will not idle`);
    }

    // Measured at the export's own scale, so the normalisation below is a pure
    // multiply and `settings.enemies.height` stays a number in metres.
    fbx.scale.setScalar(1);
    fbx.updateMatrixWorld(true);
    const box = new Box3().setFromObject(fbx);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());

    this._localHeight = Math.max(1e-3, size.y);
    this._resolveScale();
    this._base = { cx: center.x, cz: center.z, minY: box.min.y };
    this._offset.set(0, 0, 0);

    this.source = fbx;
    this._measureFacing(fbx);
    return this;
  }

  /** Metres per export unit, and the offset that drops the feet onto y = 0. */
  _resolveScale() {
    this._scale = settings.enemies.height / this._localHeight;
  }

  /**
   * Which way the rig faces in its own bind pose.
   *
   * Same heel → toe measurement the player's rig gets: bind poses are not
   * necessarily axis aligned, and a body facing the player is the difference
   * between an enemy and a mannequin with its back turned.
   */
  _measureFacing(root) {
    let foot = null;
    let toe = null;
    root.traverse((node) => {
      if (!node.isBone) return;
      const name = node.name.split(':').pop().replace(/^mixamorig/i, '');
      if (name === 'LeftFoot') foot = node;
      else if (name === 'LeftToeBase') toe = node;
    });
    if (!foot || !toe) return;

    const heel = foot.getWorldPosition(new Vector3());
    const tip = toe.getWorldPosition(_v).sub(heel).setY(0);
    if (tip.lengthSq() > 1e-6) this._forwardYaw = Math.atan2(tip.x, tip.z);
  }

  /* ------------------------------------------------------------------ */
  /* the population                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt
   * @param {import('three').Vector3} player
   */
  update(dt, player) {
    if (player) this._player.copy(player);
    if (!this.source) return;

    if (!settings.enemies.enabled) {
      if (this.enemies.length) this.clear();
      return;
    }

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      enemy.update(dt, this._player);
      if (!enemy.finished) continue;
      enemy.dispose();
      this.enemies.splice(i, 1);
    }

    this._maintain(dt);
  }

  /** Keep `count` of them standing, spawning one `respawnDelay` after a gap opens. */
  _maintain(dt) {
    const config = settings.enemies;
    const standing = this.enemies.reduce((total, enemy) => total + (enemy.alive ? 1 : 0), 0);
    const wanted = Math.max(0, Math.round(config.count));

    // Queue a body for every empty slot. The timer is what keeps a kill from
    // being answered instantly — a replacement blinking in on the frame the
    // last one hit the ground reads as a spawner, not as a world.
    while (standing + this._pending.length < wanted) this._pending.push(config.respawnDelay);

    // Or send one away, if the count was turned down while they were standing.
    while (standing + this._pending.length > wanted) {
      if (this._pending.length) {
        this._pending.pop();
        continue;
      }
      const spare = this._lastAlive();
      if (!spare) break;
      spare.retire();
      break;
    }

    for (let i = this._pending.length - 1; i >= 0; i--) {
      this._pending[i] -= dt;
      if (this._pending[i] > 0) continue;
      this._pending.splice(i, 1);
      this.spawn();
    }
  }

  _lastAlive() {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.enemies[i].alive) return this.enemies[i];
    }
    return null;
  }

  /**
   * Stand one up somewhere in the ring, facing the player.
   *
   * The radius is drawn as `sqrt(random)` across the annulus, which is what
   * spreads them evenly over the *area* — a plain uniform radius crowds them
   * against the inner edge, and five bodies in a huddle is the tell that they
   * were placed by a loop.
   */
  spawn() {
    if (!this.source) return null;
    const config = settings.enemies;

    const inner = Math.max(0.5, Math.min(config.minRadius, config.radius));
    const outer = Math.max(inner + 0.5, config.radius);

    let x = this._player.x;
    let z = this._player.z;
    for (let attempt = 0; attempt < 24; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const t = Math.sqrt(Math.random());
      const distance = inner + (outer - inner) * t;
      x = this._player.x + Math.sin(angle) * distance;
      z = this._player.z + Math.cos(angle) * distance;
      if (this._clear(x, z, config.separation)) break;
    }

    this._resolveScale();
    this._offset.set(
      -this._base.cx * this._scale,
      -this._base.minY * this._scale,
      -this._base.cz * this._scale
    );

    const enemy = new Enemy({
      source: this.source,
      clip: this.clip,
      scale: this._scale,
      offset: this._offset,
      localHeight: this._localHeight,
      forwardYaw: this._forwardYaw,
      terrain: this.terrain,
      effects: this.effects
    });

    // Facing the player, roughly — a ring of bodies all aimed at exactly the
    // same point reads as a firing squad.
    const yaw = Math.atan2(this._player.x - x, this._player.z - z) + (Math.random() - 0.5) * 0.7;
    enemy.place(x, z, yaw);

    this.group.add(enemy.root);
    this.enemies.push(enemy);
    return enemy;
  }

  /** Whether a spot is far enough from everyone already standing on the field. */
  _clear(x, z, separation) {
    const min = separation * separation;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const dx = enemy.position.x - x;
      const dz = enemy.position.z - z;
      if (dx * dx + dz * dz < min) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* combat                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Who the player means, from where they are and which way they are pointing.
   *
   * Inside the cone, then nearest — but "nearest" is weighted by how centred
   * the body is, so a target dead ahead wins over one slightly closer off to
   * the side. That weighting is the difference between an attack that goes
   * where you aimed it and one that grabs whatever is nearest your elbow.
   *
   * @param {import('three').Vector3} origin
   * @param {number} facing radians about +Y, 0 facing +Z
   * @param {{range: number, cone: number}} config cone is the full width, degrees
   * @returns {Enemy|null}
   */
  findTarget(origin, facing, config) {
    const half = Math.cos(MathUtils.degToRad(MathUtils.clamp(config.cone, 0, 360)) * 0.5);
    const fx = Math.sin(facing);
    const fz = Math.cos(facing);

    let best = null;
    let bestScore = Infinity;

    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;

      const dx = enemy.position.x - origin.x;
      const dz = enemy.position.z - origin.z;
      const distance = Math.hypot(dx, dz);
      if (distance > config.range) continue;
      // Standing inside your own feet: no direction to test, and certainly a hit.
      if (distance < 1e-3) return enemy;

      const alignment = (dx * fx + dz * fz) / distance;
      if (alignment < half) continue;

      const score = distance * (2 - alignment);
      if (score >= bestScore) continue;
      bestScore = score;
      best = enemy;
    }

    return best;
  }

  /**
   * Fell one, along `(x, z)`.
   *
   * The force comes from whatever landed the blow rather than from here: a kick
   * shoves a body back and a slash takes it apart, and that difference is
   * three numbers in the striking move's own settings block. So is whether the
   * body is felled or *parted* — `slices` is a field on the move, because it is
   * a fact about the thing that hit, not about the thing that was hit.
   *
   * @param {Enemy} enemy
   * @param {number} x unit direction of the blow
   * @param {number} z
   * @param {{impulse: number, lift: number, spin: number, slices?: boolean}} [force]
   *   defaults to the kick's
   * @returns {boolean} whether this was the blow that put it down
   */
  kill(enemy, x, z, force = settings.kick) {
    if (!enemy?.alive) return false;
    if (!enemy.die(x, z, force, force.slices === true)) return false;
    this.kills++;
    return true;
  }

  /**
   * Keep a point out of every standing body.
   *
   * A shove rather than a collision response: the position is simply moved to
   * the edge of the cylinder it ended up inside. There is no mass here and
   * nothing to conserve — the player is the only thing that moves, and the
   * bodies are furniture until they are hit.
   *
   * @param {import('three').Vector3} position written in place
   * @param {number} radius how close the point may come to a body's centre
   */
  pushOut(position, radius) {
    if (radius <= 0) return;
    const min = radius * radius;

    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const dx = position.x - enemy.position.x;
      const dz = position.z - enemy.position.z;
      const squared = dx * dx + dz * dz;
      if (squared >= min) continue;

      const distance = Math.sqrt(squared);
      if (distance < 1e-4) {
        // Dead centre: no direction to be pushed along, so pick one.
        position.x += radius;
        continue;
      }
      const push = (radius - distance) / distance;
      position.x += dx * push;
      position.z += dz * push;
    }
  }

  /* ------------------------------------------------------------------ */

  /** Clear the field and stand a fresh set up immediately. */
  respawnAll() {
    this.clear();
    const wanted = Math.max(0, Math.round(settings.enemies.count));
    for (let i = 0; i < wanted; i++) this.spawn();
  }

  /** Take everyone off, corpses included. */
  clear() {
    for (const enemy of this.enemies) enemy.dispose();
    this.enemies.length = 0;
    this._pending.length = 0;
  }

  dispose() {
    this.clear();
    this.group.parent?.remove(this.group);
    // Geometry and the imported materials belong to the source, which every
    // clone was sharing — so it goes last, and only here.
    if (this.source) disposeObject(this.source);
    this.source = null;
    this.clip = null;
  }
}
