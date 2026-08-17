import { DoubleSide, Group, Mesh, MeshStandardMaterial, PointLight, Vector3 } from 'three';

import { settings } from '../config/settings.js';
import { frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';
import { Easing } from '../utils/math.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';
import { DustBurst } from './DustBurst.js';
import { ShockRing } from './ShockRing.js';
import { SummonSeal } from './SummonSeal.js';

/** The forearm. One mesh, no colour map, one normal map — see `_build`. */
const FIST_URL = './models/weapons/fist.glb';

/**
 * Where along the model the fist ends and the forearm begins, as a fraction of
 * its height.
 *
 * The arm is stretched to reach whatever height the seal was hung at, and this
 * is what keeps the *fist* out of it: below this line every vertex is rigid, so
 * the knuckles that land on a body are the knuckles that were sculpted. It is a
 * fact about this export rather than a taste control, which is why it is here
 * and not in settings.
 */
const WRIST_AT = 0.42;

/**
 * Judgement: a seal opens over a marked body and a fist comes down through it.
 *
 * ## The shape of it
 *
 * Six beats, all of them in `settings.judgement.beats`, and one state each:
 *
 *  - **open** — the seal writes itself into the air over the mark, one full turn
 *    anticlockwise from the top (`vfx/SummonSeal.js`), irising out as it goes.
 *  - **charge** — held. The circle tightens and brightens and nothing else
 *    happens, which is the beat that makes the blow inevitable rather than
 *    sudden. Take it out and the whole move reads as a projectile.
 *  - **fall** — the fist comes through, accelerating: `t²`, which is what a
 *    dropped thing actually does.
 *  - **impact** — one frame, and everything happens on it. Whoever is under the
 *    knuckles is felled, the world nearly stops, the lens is kicked, the ground
 *    opens (`vfx/ShockRing.js`) and throws up what it is made of
 *    (`vfx/DustBurst.js`).
 *  - **dwell** — the fist sits on the result, cooling. The single cheapest way
 *    to make a blow feel heavy is to leave the thing that landed exactly where
 *    it stopped for half a second.
 *  - **withdraw / close** — pulled back up through the seal, which then folds.
 *
 * ## The trick the whole thing hangs on
 *
 * A fist falling out of a circle is a prop unless the circle is a *hole*. So the
 * fist's material discards every fragment above the seal's plane and burns a
 * line where it crosses, and the forearm is stretched in the vertex shader so it
 * always reaches that plane however high the seal was hung. What is on screen is
 * therefore never a floating arm: it is an arm coming through something, at any
 * height, at any point in the drop, with no keyframes anywhere.
 *
 * ## What it owns, and what it does not
 *
 * It owns the seal, the ring, the dust, one light and the fist. It does **not**
 * decide who is marked (`combat/TargetMarking.js` does, exactly as it does for
 * the shadows) and it does not decide what being hit means — `onStrike` carries
 * the blow out with `settings.judgement.force`, which is the same block shape
 * every melee move states its impact in, so `App#_onStrike` takes it without
 * knowing which move it came from.
 */
export class Judgement {
  /**
   * @param {object} [options]
   * @param {{heightAt: (x: number, z: number) => number}|null} [options.terrain]
   * @param {import('../combat/EnemyManager.js').EnemyManager|null} [options.enemies]
   * @param {((enemy: object, dirX: number, dirZ: number, force: object) => void)|null} [options.onStrike]
   */
  constructor({ terrain = null, enemies = null, onStrike = null } = {}) {
    this.terrain = terrain;
    this.enemies = enemies;
    this.onStrike = onStrike;

    /** Everything it is, in world space. Add it to the scene. */
    this.group = new Group();
    this.group.name = 'Judgement';

    this.seal = new SummonSeal();
    this.shock = new ShockRing({ terrain });
    this.dust = new DustBurst();
    this.group.add(this.seal.mesh, this.shock.mesh, this.dust.mesh);

    // Two jobs, one light: it hangs under the seal while the circle is drawing
    // itself and drops to the ground to flash on contact. Never casts — a
    // shadow map re-rendered for a light that lives for two seconds costs more
    // than everything else here put together.
    this.light = new PointLight(0x8f5bff, 0, 9, 1.9);
    this.light.name = 'JudgementLight';
    this.light.castShadow = false;
    this.group.add(this.light);

    /** @type {Mesh|null} the arm. Null until `load` has been through. */
    this.mesh = null;
    /** @type {MeshStandardMaterial|null} */
    this.material = null;
    /** The export's own height, in its own units — everything local is in these. */
    this._height = 1;

    this.uniforms = this._makeUniforms();

    /** @type {'idle'|'open'|'charge'|'fall'|'dwell'|'withdraw'|'close'} */
    this.state = 'idle';
    /** Seconds in the current state. */
    this.timer = 0;

    /** @type {import('../combat/Enemy.js').Enemy|null} who it was called on. */
    this.target = null;
    /** Held for the markers, which want an iterable of bodies. @type {object[]} */
    this._assigned = [];

    /** Where it lands: the mark's ground, resolved once, on the frame it is cast. */
    this._ground = new Vector3();
    /** The seal's own height, world. */
    this._sealY = 0;
    /** Which way round the seal and the knuckles are, radians about +Y. */
    this._yaw = 0;

    /** The ripple leaving the seal after something came through, 0..1. */
    this._punch = 1;
    /** What is left of the white on the knuckles, 0..1. */
    this._flash = 0;
    /** What is left of the light's own flash, 0..1. */
    this._lightFlash = 0;
  }

  /** Whether a fist is currently on its way, planted, or being pulled back. */
  get active() {
    return this.state !== 'idle';
  }

  /**
   * The body it is coming down on, for as long as it is coming down.
   *
   * The marker over a head is drawn from this, so a lock the player took stays
   * on the body it was taken on until the blow lands — the same contract
   * `ShadowCharacter#assignments` keeps.
   */
  get assignments() {
    return this._assigned;
  }

  /* ------------------------------------------------------------------ */
  /* loading                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Fetch the arm and dress it.
   *
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   */
  async load(assets) {
    try {
      const gltf = await assets.loadGLTF(FIST_URL);
      // The GLB resolves as soon as it is parsed; its normal map is still
      // decoding, and that map is the entire look.
      await assets.settled();
      this._build(gltf.scene);
    } catch (error) {
      console.warn(`[Judgement] ${FIST_URL} did not load — the ability will do nothing`, error);
    }
    return this;
  }

  /**
   * Bake the export into a frame this can actually aim.
   *
   * The GLB carries its transform on a node — a 90° turn, a ×9.56 scale and a
   * lift — and the model's long axis is its own local X. Left that way every
   * placement here would be a matrix puzzle and the vertex shader would be
   * stretching the arm along the wrong axis. So the node's world matrix is
   * pushed into the *geometry* once, at load, and the geometry is then moved so
   * that:
   *
   *  - **the knuckles are at the origin** — the pivot is the striking surface,
   *    which is the only point in the model anything ever wants to position.
   *  - **the arm runs up +Y** — so the drop is a lerp on one number and the
   *    seal's plane is a comparison on another.
   *
   * Everything downstream is then plain arithmetic, and the cost is one walk of
   * 2,416 vertices at load.
   */
  _build(root) {
    root.updateMatrixWorld(true);

    /** @type {Mesh|null} */
    let source = null;
    root.traverse((node) => {
      if (!source && node.isMesh) source = node;
    });
    if (!source) {
      console.warn(`[Judgement] ${FIST_URL} carries no mesh`);
      return;
    }

    const geometry = source.geometry;
    geometry.applyMatrix4(source.matrixWorld);
    geometry.computeBoundingBox();

    const box = geometry.boundingBox;
    geometry.translate(
      -(box.min.x + box.max.x) * 0.5,
      -box.min.y,
      -(box.min.z + box.max.z) * 0.5
    );
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    this._height = Math.max(0.01, geometry.boundingBox.max.y);

    // The one thing the export knows about its own shape. Everything the
    // material does with light is placed by this map — see `_createMaterial`.
    const imported = Array.isArray(source.material) ? source.material[0] : source.material;
    const normalMap = imported?.normalMap ?? null;
    if (!normalMap) {
      console.warn(
        `[Judgement] ${FIST_URL} has no normal map — the fist will be a silhouette and nothing else`
      );
    }
    this.material = this._createMaterial(normalMap);
    // The imported material is dropped, not reused: it carries the export's flat
    // grey base colour and nothing else worth keeping. Its normal map is now
    // ours, so it is not released with it.
    imported?.dispose();

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'JudgementFist';
    // It is born wherever the mark was standing, and it is scaled and stretched
    // from there — none of which the export's own bounds describe.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.WORLD);
    // The depth pass draws with three's own depth material, which knows nothing
    // about the portal cut — so a fist that is still mostly on the other side of
    // the seal would cast its whole arm on the ground. Nothing is lost: the
    // light that arrives with it is doing that job.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.raycast = () => {};
    this.mesh.visible = false;
    this.group.add(this.mesh);

    // The rest of the loaded scene is a node with nothing left under it.
    root.clear();
  }

  /* ------------------------------------------------------------------ */
  /* the cast                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Call it down on a body.
   *
   * @param {import('../combat/Enemy.js').Enemy|null} enemy the mark
   * @returns {boolean} whether the call was taken — false while one is already
   *   on its way, which is what makes a second press mean nothing rather than
   *   restarting the beat that is running.
   */
  cast(enemy) {
    if (!settings.judgement.enabled || !this.mesh) return false;
    if (this.state !== 'idle') return false;
    if (!enemy?.alive) return false;

    const config = settings.judgement;

    this.target = enemy;
    this._assigned.length = 0;
    this._assigned.push(enemy);

    // Where it lands is fixed here, on the frame it is called — the seal is a
    // hole in the world, not a thing that follows anyone about.
    const position = enemy.position;
    this._ground.set(
      position.x,
      this.terrain ? this.terrain.heightAt(position.x, position.z) : position.y,
      position.z
    );
    this._sealY = this._ground.y + Math.max(0.5, config.height);
    this._yaw = Math.random() * Math.PI * 2;

    this.seal.reseed();
    this.seal.place(this._ground.x, this._sealY, this._ground.z, this._yaw);

    this._punch = 1;
    this._flash = 0;
    this._lightFlash = 0;
    this._enter('open');
    return true;
  }

  /**
   * Stop it, wherever it had got to.
   *
   * @param {{immediate?: boolean}} [options] `immediate` drops everything on the
   *   spot — for leaving the stage, where a close would only be paused halfway
   *   through and resumed on the way back.
   */
  dismiss({ immediate = false } = {}) {
    // Unconditional, because "immediate" is for leaving the stage: the dust and
    // the cracks belong to it too, and there is no state in which they should
    // be left to resume on the way back.
    if (immediate) {
      this.clear();
      return;
    }
    if (!this.active) return;
    // Anything before the blow simply folds away; anything after it is already
    // on its way out and is left to finish.
    if (this.state === 'open' || this.state === 'charge' || this.state === 'fall') {
      this._enter('close');
      this.target = null;
      this._assigned.length = 0;
      if (this.mesh) this.mesh.visible = false;
    }
  }

  /** Everything off, immediately. */
  clear() {
    this.state = 'idle';
    this.timer = 0;
    this.target = null;
    this._assigned.length = 0;
    this.seal.clear();
    this.shock.clear();
    this.dust.clear();
    this.light.intensity = 0;
    if (this.mesh) this.mesh.visible = false;
  }

  /* ------------------------------------------------------------------ */
  /* the frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt seconds, on the *simulation's* clock — the whole move is
   *   combat, so it slows with the hit-stop it causes and stops with `P`
   * @param {number} elapsed the shared clock, for the seal's own turning
   */
  update(dt, elapsed) {
    const config = settings.judgement;

    // Both of these outlive the move by a second or so, so they are driven
    // whether or not anything is being cast — and they sit either side of the
    // beat for a reason. The dust has to be synced *before* anything can emit
    // into it, or a grain born by this frame's landing is stamped with a clock
    // the shader has not been given yet; the ground has to be updated *after*,
    // or a wave opened by that same landing is not drawn until the next frame.
    this.dust.sync(elapsed, config.dust);
    this._advance(dt, elapsed, config);
    this.shock.update(dt, config.shock);
  }

  /** The beat itself. Everything with a clock in it is in here. */
  _advance(dt, elapsed, config) {
    if (!this.active) {
      this.seal.update(config.seal, { fade: 0, scale: 0 }, elapsed);
      this.light.intensity = 0;
      return;
    }

    this.timer += dt;

    const beats = config.beats;
    /** 0..1 through the current beat. */
    const t = (seconds) => Math.min(1, this.timer / Math.max(1e-3, seconds));

    let open = 1;
    let scale = 1;
    let charge = 0;
    let knuckles = this._sealY;
    let showFist = false;

    switch (this.state) {
      case 'open': {
        const u = t(beats.open);
        // The circle is *written*: the sweep and the iris run together, so it
        // arrives in the order a hand would have drawn it rather than fading up.
        open = u;
        scale = Easing.outBack(u);
        charge = u * 0.25;
        if (u >= 1) this._enter('charge');
        break;
      }

      case 'charge': {
        const u = t(beats.charge);
        charge = 0.25 + 0.75 * Easing.outQuad(u);
        if (u >= 1) this._enter('fall');
        break;
      }

      case 'fall': {
        const u = t(beats.fall);
        charge = 1;
        showFist = true;
        // t². A dropped thing accelerates, and starting the drop slowly is also
        // what lets the fist *emerge* — for the first frames only a knuckle is
        // through the seal, and the arm follows it out.
        knuckles = this._sealY + (this._impactY() - this._sealY) * (u * u);
        if (u >= 1) {
          knuckles = this._impactY();
          this._land();
        }
        break;
      }

      case 'dwell': {
        const u = t(beats.dwell);
        // Cooling on the spot, but never all the way: the veins are what say
        // the thing is still holding the body down.
        charge = 1 - 0.6 * Easing.outQuad(u);
        showFist = true;
        knuckles = this._impactY();
        if (u >= 1) this._enter('withdraw');
        break;
      }

      case 'withdraw': {
        const u = t(beats.withdraw);
        charge = 0.4 * (1 - u);
        showFist = true;
        // Accelerating away rather than easing off: it hangs for an instant and
        // is then snatched back through, which reads as something else pulling.
        knuckles = this._impactY() + (this._sealY - this._impactY()) * (u * u);
        if (u >= 1) this._enter('close');
        break;
      }

      case 'close': {
        const u = t(beats.close);
        scale = 1 - Easing.inCubic(u);
        charge = 0.2 * (1 - u);
        if (u >= 1) {
          this._enter('idle');
          // Hidden here rather than left to the placement below, which this
          // path does not reach: at a `close` short enough to finish on its
          // first frame the arm would otherwise be left on screen.
          if (this.mesh) this.mesh.visible = false;
          this.seal.update(config.seal, { fade: 0, scale: 0 }, elapsed);
          this.light.intensity = 0;
          return;
        }
        break;
      }

      default:
        break;
    }

    this._punch = Math.min(1, this._punch + dt / 0.34);
    this._flash = Math.max(0, this._flash - dt / Math.max(0.02, config.fist.flashTime));
    this._lightFlash = Math.max(0, this._lightFlash - dt / Math.max(0.02, config.light.flashTime));

    this.seal.update(
      config.seal,
      { open, scale, charge, punch: this._punch < 1 ? this._punch : 0, fade: 1 },
      elapsed
    );
    this._placeFist(config, knuckles, showFist);
    this._syncMaterial(config, charge, elapsed);
    this._syncLight(config, knuckles, showFist);
  }

  /** Where the knuckles come to rest — what is under them is flat by then. */
  _impactY() {
    return this._ground.y + Math.max(0, settings.judgement.fist.crush);
  }

  /** Move into a state, and start its clock. */
  _enter(state) {
    this.state = state;
    this.timer = 0;
  }

  /**
   * The frame it lands.
   *
   * Everything that says "that happened" fires from here, together, because
   * together is the only way any of it reads: the body, the freeze, the lens,
   * the ground and the air. Any one of them alone is a bug.
   */
  _land() {
    const config = settings.judgement;

    this._strike(config);

    this.shock.burst(this._ground.x, this._ground.z, config.shock);
    this.dust.burst(this._ground.x, this._ground.y, this._ground.z, config.dust);

    this._punch = 0;
    this._flash = 1;
    this._lightFlash = 1;
    this.target = null;
    this._assigned.length = 0;

    this._enter('dwell');
  }

  /**
   * Who is under the knuckles.
   *
   * The mark first, if it is still standing — it was chosen, and a blow that
   * misses the body the player picked because something else wandered nearer is
   * the one outcome a marked ability must never have. Then everyone *else*
   * inside the radius, because the thing that landed is wider than a body and a
   * crowd standing under it walking away untouched would be absurd.
   *
   * The blow goes down, so its horizontal direction is very nearly meaningless
   * — `force.impulse` is small on purpose and `force.lift` is negative. What
   * little there is runs outward from the point of impact, so a body at the
   * edge of the radius is thrown clear of it rather than into it.
   */
  _strike(config) {
    const force = config.force;
    const reach = Math.max(0.2, force.reach);
    const strike = (enemy) => {
      const dx = enemy.position.x - this._ground.x;
      const dz = enemy.position.z - this._ground.z;
      const distance = Math.hypot(dx, dz);
      const x = distance > 1e-3 ? dx / distance : Math.sin(this._yaw);
      const z = distance > 1e-3 ? dz / distance : Math.cos(this._yaw);
      this.onStrike?.(enemy, x, z, force);
    };

    const mark = this.target;
    if (mark?.alive) strike(mark);

    if (!this.enemies) return;
    for (const enemy of this.enemies.enemies) {
      if (!enemy.alive || enemy === mark) continue;
      const dx = enemy.position.x - this._ground.x;
      const dz = enemy.position.z - this._ground.z;
      if (dx * dx + dz * dz > reach * reach) continue;
      strike(enemy);
    }
  }

  /* ------------------------------------------------------------------ */
  /* the look                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Put the arm where this frame left it, and tell the shader how much of it is
   * on this side of the seal.
   *
   * Both numbers are the *same* distance, in the model's own units: the height
   * of the seal's plane above the knuckles. It is where the material cuts the
   * arm off (`uCut`) and it is how far the arm has to reach to get there
   * (`uReach`), which is what keeps the wrist inside the hole at any height the
   * seal was hung at.
   */
  _placeFist(config, knuckles, visible) {
    const mesh = this.mesh;
    if (!mesh) return;

    mesh.visible = visible;
    if (!visible) return;

    const scale = Math.max(0.05, config.fist.scale);
    mesh.position.set(this._ground.x, knuckles, this._ground.z);
    mesh.rotation.y = this._yaw;
    mesh.scale.setScalar(scale);

    const span = Math.max(0, (this._sealY - knuckles) / scale);
    this.uniforms.uCut.value = span;
    this.uniforms.uReach.value = span;
    this.uniforms.uModelHeight.value = this._height;
    // The birth line is authored in metres and lives in local units.
    this.uniforms.uBirthWidth.value = Math.max(1e-3, config.fist.birth.width / scale);
  }

  /** Settings → the fist's uniforms, live, so it can be re-dressed mid-fall. */
  _syncMaterial(config, charge, elapsed) {
    const fist = config.fist;
    const u = this.uniforms;

    if (this.material) {
      copyColor(this.material.color, fist.color);
      this.material.roughness = fist.roughness;
      this.material.metalness = fist.metalness;
      this.material.normalScale.set(fist.normalScale, fist.normalScale);
    }

    copyColor(u.uFresnelColor.value, fist.fresnel.color);
    u.uFresnelPower.value = fist.fresnel.power;
    u.uFresnelEmissive.value = fist.fresnel.emissive;

    const veins = fist.veins;
    copyColor(u.uVeinColor.value, veins.color);
    copyColor(u.uVeinHot.value, veins.hotColor);
    u.uVeinEmissive.value = veins.emissive;
    u.uVeinGain.value = veins.gain;
    u.uVeinSharpness.value = veins.sharpness;
    u.uVeinScale.value = veins.scale;
    u.uVeinSpeed.value = veins.speed;
    u.uCavity.value = veins.cavity;

    copyColor(u.uBirthColor.value, fist.birth.color);
    u.uBirthEmissive.value = fist.birth.emissive;

    u.uCharge.value = charge;
    // Squared, so the flash is over almost before it has been seen. A linear
    // decay on something this bright reads as the arm cooling rather than as an
    // impact — the eye wants the spike gone by the frame after the one it
    // landed on.
    u.uFlash.value = this._flash * this._flash * fist.flash;
    u.uTime.value = elapsed;
  }

  /**
   * The light, doing its two jobs.
   *
   * Under the seal while the circle is up, so the ground below it is already
   * violet before anything comes through; on the ground the instant the fist
   * lands, flashing. A light that *moves* to where the blow landed is the
   * cheapest thing in the frame that says the blow landed there.
   */
  _syncLight(config, knuckles, planted) {
    const light = config.light;
    if (!light.enabled) {
      this.light.intensity = 0;
      return;
    }

    const flash = this._lightFlash;
    if (flash > 0) {
      this.light.position.set(this._ground.x, this._ground.y + 0.6, this._ground.z);
      copyColor(this.light.color, light.flashColor);
      this.light.intensity = light.flash * flash * flash;
    } else {
      // Riding the knuckles once they are through, so the fall is lit by the
      // thing that is falling.
      const y = planted ? knuckles + 0.5 : this._sealY - 0.4;
      this.light.position.set(this._ground.x, y, this._ground.z);
      copyColor(this.light.color, light.color);
      this.light.intensity = light.intensity * this.uniforms.uCharge.value;
    }

    this.light.distance = light.distance;
    this.light.decay = light.decay;
  }

  /** The fist's own uniforms. Nothing here is shared with anything else. */
  _makeUniforms() {
    return {
      /** Local units of arm above the knuckles that are on the far side. */
      uCut: { value: 0 },
      /** How far the forearm has to stretch to still be in the hole. */
      uReach: { value: 0 },
      uModelHeight: { value: 1 },
      uStretchFrom: { value: WRIST_AT },

      uFresnelColor: { value: makeColor('#9a63ff') },
      uFresnelPower: { value: 2.1 },
      uFresnelEmissive: { value: 2.4 },

      uVeinColor: { value: makeColor('#8a52ff') },
      uVeinHot: { value: makeColor('#fff0cf') },
      uVeinEmissive: { value: 2.2 },
      uVeinGain: { value: 5.5 },
      uVeinSharpness: { value: 1.6 },
      uVeinScale: { value: 5.5 },
      uVeinSpeed: { value: 0.7 },
      uCavity: { value: 0.65 },

      uBirthColor: { value: makeColor('#e9dcff') },
      uBirthEmissive: { value: 4.5 },
      uBirthWidth: { value: 0.1 },

      uCharge: { value: 0 },
      uFlash: { value: 0 },
      uTime: { value: 0 },
      // The frame's exposure, by identity — every emissive here divides itself
      // by it, for the reason set out on the shadow character's rim.
      uExposure: frame.uExposure
    };
  }

  /**
   * One black, rimmed, veined, cuttable surface.
   *
   * The export ships a flat grey base colour, a roughness number and one normal
   * map, and that is the whole of what is known about it. So nothing here tries
   * to light an albedo that does not exist: the base is near-black and every
   * bright thing on screen is emitted, placed by the relief the normal map
   * describes. See the fragment patch at the bottom of this file.
   */
  _createMaterial(normalMap) {
    const material = new MeshStandardMaterial({
      name: 'JudgementFist',
      color: 0x07070d,
      roughness: 0.44,
      metalness: 0.3,
      normalMap,
      // The export declares itself double sided, and it has to be: the arm is
      // cut open at the seal and the inside of that cut is looked straight up
      // into from the ground.
      side: DoubleSide
    });

    patchOnBeforeCompile(material, (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = FIST_VERTEX_PATCH(shader.vertexShader);
      shader.fragmentShader = FIST_FRAGMENT_PATCH(shader.fragmentShader);
    });
    material.needsUpdate = true;

    return material;
  }

  dispose() {
    this.clear();
    this.seal.dispose();
    this.shock.dispose();
    this.dust.dispose();
    this.light.dispose();
    this.mesh?.geometry.dispose();
    this.material?.normalMap?.dispose();
    this.material?.dispose();
    this.group.parent?.remove(this.group);
  }
}

/* -------------------------------------------------------------------- */

/**
 * The stretch, and the normal that has to follow it.
 *
 * The seal can be hung at any height and the arm is a fixed length, so the two
 * do not meet by construction — the arm is made to reach instead. `uReach` is
 * how many of the model's own units of arm are wanted between the knuckles and
 * the plane; anything past its natural height is added at the top and tapered
 * in from the wrist (`uStretchFrom`), so the *fist* is never touched. What the
 * eye sees is a forearm disappearing into a hole; what is actually happening is
 * the last half of it being drawn out like taffy, in the region that is inside
 * the hole and cannot be looked at.
 *
 * The normal is corrected on the way, in `beginnormal_vertex`, because that is
 * the last place `objectNormal` can still be written: a surface stretched along
 * y has its y gradient divided by the local stretch factor, so the normal's y
 * component is divided by the same thing. Skip it and the stretched section
 * lights as though it were still the shape it was exported at — which is
 * visible as a band of wrong shading right where the arm meets the seal, the
 * one place on the model the eye is guaranteed to be looking.
 */
const FIST_VERTEX_PATCH = (source) => {
  const head = /* glsl */ `
uniform float uReach;
uniform float uModelHeight;
uniform float uStretchFrom;
varying vec3 vFistLocal;

/** How far up the stretch has come at height y, and how fast it is growing. */
vec2 fistStretch(float y) {
  float h = max(uModelHeight, 1e-4);
  float a = uStretchFrom * h;
  float span = max(h - a, 1e-4);
  float t = clamp((y - a) / span, 0.0, 1.0);
  return vec2(t * t * (3.0 - 2.0 * t), 6.0 * t * (1.0 - t) / span);
}
`;

  const normals = /* glsl */ `
#include <beginnormal_vertex>
{
  float extra = max(0.0, uReach - max(uModelHeight, 1e-4));
  objectNormal.y /= max(1.0 + fistStretch(position.y).y * extra, 1e-3);
}
`;

  const vertices = /* glsl */ `
#include <begin_vertex>
{
  float extra = max(0.0, uReach - max(uModelHeight, 1e-4));
  transformed.y += fistStretch(transformed.y).x * extra;
}
vFistLocal = transformed;
`;

  let patched = replaceChunk(`${head}\n${source}`, '#include <beginnormal_vertex>', normals);
  return replaceChunk(patched, '#include <begin_vertex>', vertices);
};

/**
 * Everything you actually see.
 *
 * The model has no colour map. That is not a limitation to work around here, it
 * is the brief: there is nothing to light, so nothing is lit — the base is
 * near-black and every bright thing below is *emitted*, in four terms.
 *
 * ## 1. The relief, which places the other three
 *
 * The one thing the export knows about its own surface is its normal map. After
 * `normal_fragment_maps` the shader is holding both the mapped normal and the
 * surface it was applied to (`nonPerturbedNormal`), and the angle between them
 * is how hard the map is bending the light at this fragment — near zero across
 * the flats of the forearm, and large down every knuckle crease, seam and fold.
 * That number is the whole placement system: it darkens the surface where a
 * crevice would hold shadow (`uCavity`, which is cavity occlusion by another
 * name) and it lights the same crevices from inside (`uVein*`). The sculpt
 * therefore draws itself, out of the only map there is.
 *
 * It is the same idea as the katana's hot steel (`vfx/BladeHeat.js`), where the
 * albedo's luminance runs the temperature so the wrap's raised diamonds come out
 * as glowing lattice. There the map said *what colour*; here it says *what
 * shape*, and the shape is all that was shipped.
 *
 * ## 2. The rim
 *
 * A fresnel, taken on the **mapped** normal rather than the geometric one — so
 * the silhouette does not merely outline the arm, it breaks up along every
 * ridge the sculpt has, and the grazing light crawls as the fist turns. On a
 * geometric normal this is a clean neon outline; on this one it is a wet edge.
 * It is also what keeps a near-black object from reading as a hole punched in a
 * night sky, which is the same job it does on the summoned shadows.
 *
 * ## 3. The cut, and the line on it
 *
 * Every fragment above the seal's plane is discarded and a band of light is
 * burned just under it. This is the effect: without it there is a floating
 * forearm, and with it there is something reaching through.
 *
 * ## 4. The moment
 *
 * `uCharge` runs the veins from violet to white as the blow gathers and
 * `uFlash` puts the whole surface briefly over the top of that on contact,
 * weighted toward the silhouette so the fist blows out at its edges first.
 *
 * Every emissive is divided by the frame's exposure for the reason set out on
 * the shadow character's rim: ACES desaturates as it clips, so a colour picked
 * at one exposure arrives at a different hue at another.
 */
const FIST_FRAGMENT_PATCH = (source) => {
  const head = /* glsl */ `
${noiseGLSL}

uniform float uCut;
uniform vec3 uFresnelColor;
uniform float uFresnelPower;
uniform float uFresnelEmissive;
uniform vec3 uVeinColor;
uniform vec3 uVeinHot;
uniform float uVeinEmissive;
uniform float uVeinGain;
uniform float uVeinSharpness;
uniform float uVeinScale;
uniform float uVeinSpeed;
uniform float uCavity;
uniform vec3 uBirthColor;
uniform float uBirthEmissive;
uniform float uBirthWidth;
uniform float uCharge;
uniform float uFlash;
uniform float uTime;
uniform float uExposure;
varying vec3 vFistLocal;
`;

  const body = /* glsl */ `
#include <emissivemap_fragment>

{
  // The other side of the seal. Nothing here is drawn, and nothing here is
  // shaded — the discard is the first thing in the block for that reason.
  if (vFistLocal.y > uCut) discard;

  float exposure = max(uExposure, 0.01);
  vec3 nrm = normalize(normal);

  // How hard the map is bending the surface here: flat across the forearm,
  // wide open down every crease the sculpt has.
  float relief = 1.0 - clamp(dot(nrm, normalize(nonPerturbedNormal)), 0.0, 1.0);
  relief = pow(clamp(relief * max(uVeinGain, 0.01), 0.0, 1.0), max(uVeinSharpness, 0.05));

  // Crevices hold shadow. Taking it out of the base colour is what stops the
  // glow below from looking painted on top of a smooth object.
  diffuseColor.rgb *= 1.0 - clamp(uCavity, 0.0, 1.0) * relief;

  // And they hold light, unevenly, with the unevenness crawling up the arm —
  // a static field reads as a texture, and this has to read as something moving
  // inside the thing.
  float flow = snoise01(vFistLocal * uVeinScale - vec3(0.0, uTime * uVeinSpeed, 0.0));
  float vein = relief * mix(0.45, 1.55, flow);
  vec3 veinColor = mix(uVeinColor, uVeinHot, clamp(uCharge, 0.0, 1.0));
  totalEmissiveRadiance += veinColor * vein * uVeinEmissive * (0.3 + 0.7 * uCharge) / exposure;

  // The silhouette, drawn on the mapped normal so it breaks up along the sculpt.
  float facing = clamp(1.0 - abs(dot(nrm, normalize(vViewPosition))), 0.0, 1.0);
  totalEmissiveRadiance +=
    uFresnelColor * pow(facing, max(uFresnelPower, 0.05)) * (uFresnelEmissive / exposure);

  // The line where the arm passes through the plane.
  float birth = 1.0 - smoothstep(0.0, max(uBirthWidth, 1e-4), uCut - vFistLocal.y);
  totalEmissiveRadiance += uBirthColor * birth * (uBirthEmissive / exposure);

  // Contact. Almost entirely on the silhouette: an even flash over the whole
  // surface turns the arm to milk, and what actually reads as a blow is the
  // edges flaring while the form underneath stays readable.
  if (uFlash > 0.001) {
    totalEmissiveRadiance += uVeinHot * uFlash * (0.12 + 0.88 * facing) / exposure;
  }
}
`;

  return replaceChunk(`${head}\n${source}`, '#include <emissivemap_fragment>', body);
};
