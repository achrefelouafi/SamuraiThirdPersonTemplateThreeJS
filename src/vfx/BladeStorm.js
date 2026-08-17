import {
  Box3,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  PointLight,
  Quaternion,
  Vector3
} from 'three';

import { settings } from '../config/settings.js';
import { frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';
import { Easing } from '../utils/math.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';
import { BladeImpact } from './BladeImpact.js';

/** Which catalog item a blade is forged from. Whatever is in the hand. */
const WEAPON_ID = 'sword';

/** The axis the geometry is baked onto: guard at the origin, tip up +Z. */
const FORWARD = /* @__PURE__ */ new Vector3(0, 0, 1);
const DOWN = /* @__PURE__ */ new Vector3(0, -1, 0);

const _box = /* @__PURE__ */ new Box3();
const _size = /* @__PURE__ */ new Vector3();
const _aim = /* @__PURE__ */ new Vector3();
const _to = /* @__PURE__ */ new Vector3();
const _quat = /* @__PURE__ */ new Quaternion();

/**
 * The blades that hang around a flying body, and what happens where they land.
 *
 * ## What one is
 *
 * The character's own katana — cloned out of whatever is actually equipped on
 * the hand at the moment the first one is forged, so a swapped weapon is a
 * swapped halo — wearing its **own material**, maps and all. It is the same
 * sword the samurai is holding: same steel, same temper line, same wrap on the
 * grip, lit by the same moon. What the summon adds is one thing on top of that
 * — a fresnel rim that finds the edge and the spine — plus the threshold that
 * writes it into the air in the first place (see the shader at the bottom of
 * this file).
 *
 * That is the same thing `vfx/BladeHeat.js` does to the weapon in the hand when
 * it burns, and for the same reason: an object you recognise, with something
 * happening to it, reads as *the sword doing something*. A replacement material
 * reads as a prop that happens to be sword-shaped.
 *
 * ## Its life
 *
 * One blade per body marked from the air (`combat/TargetMarking.js`, aimed by
 * `settings.flight.marking`), and five beats:
 *
 *  - **forge** — it writes itself into the air from guard to tip. Not a fade:
 *    a threshold sweeping up the model with a ragged, noisy front, so the blade
 *    is *drawn* rather than switched on.
 *  - **hold** — it takes station in the halo and charges. The ring turns and
 *    each blade sways on its own phase; the charge itself is read off the light
 *    hanging in the middle of the ring, which brightens as the set comes up.
 *    This beat is the whole ability: the player is stacking a volley in the air
 *    and can see how much of one they have.
 *  - **wind** — on the loose, each blade rocks *backwards* away from its mark
 *    and turns to face it. A quarter of a second, and the launch is nothing
 *    without it.
 *  - **strike** — it accelerates onto the body it was forged for, smearing
 *    along its own length as it goes (`look.stretch`), and goes *through*:
 *    `onStrike` fells whoever it reached and the blade carries on past.
 *  - **plant** — it buries itself in the ground behind the kill, rings like a
 *    struck tuning fork, and burns back down the way it was written.
 *
 * They leave one at a time (`stagger`), which is the difference between six
 * kills and one event.
 *
 * ## What it owns, and what it does not
 *
 * It owns the blades, one light and the hit (`vfx/BladeImpact.js`). It does not
 * decide who is marked — the same marking class every other aimed ability uses
 * does that — and it does not decide what being hit *means*: `onStrike` hands
 * the body out with `settings.flight.blades.force`, in the shape every melee
 * move in the game states its impact in, so `App#_onStrike` takes it without
 * knowing a sword threw it.
 */
export class BladeStorm {
  /**
   * @param {object} [options]
   * @param {{heightAt: (x: number, z: number) => number}|null} [options.terrain]
   * @param {(() => import('../equipment/EquipmentManager.js').EquipmentManager|null)|null} [options.equipment]
   *   where the weapon is read from, asked for rather than held: the loadout is
   *   built long after this is, and the blade should be whatever is on the body
   *   the moment one is forged.
   * @param {((enemy: object, dirX: number, dirZ: number, force: object) => void)|null} [options.onStrike]
   */
  constructor({ terrain = null, equipment = null, onStrike = null } = {}) {
    this.terrain = terrain;
    this.equipment = equipment;
    this.onStrike = onStrike;

    /** Everything it is, in world space. Add it to the scene. */
    this.group = new Group();
    this.group.name = 'BladeStorm';

    this.impact = new BladeImpact();
    this.group.add(this.impact.mesh);

    // One light for the whole ability: it sits in the halo while the blades
    // gather and jumps to the kill on contact. Never casts — a shadow map
    // re-rendered for a light that lives a second costs more than the blades do.
    this.light = new PointLight(0x4fb8ff, 0, 11, 1.9);
    this.light.name = 'BladeStormLight';
    this.light.castShadow = false;
    this.group.add(this.light);

    /** @type {Blade[]} every blade in any state. */
    this.blades = [];

    /**
     * The template every blade is cloned from: one group of baked, re-oriented
     * geometry with no materials of its own. Built on the first mark and kept.
     * @type {Group|null}
     */
    this._template = null;
    /** The blade's length in metres, once the template is measured. */
    this._length = 1;

    /** Held for the markers, which want an iterable of bodies. @type {object[]} */
    this._assigned = [];

    /** Where the halo is centred this frame, and how fast the ring is turning. */
    this._anchor = new Vector3();
    this._haloY = 0;
    this._spin = 0;
    /** Seconds until the next blade in a volley leaves. */
    this._stagger = 0;
    /** What is left of the light's own flash, 0..1, and where it flashed. */
    this._flash = 0;
    this._flashAt = new Vector3();
  }

  /** How many blades are hanging, waiting to be loosed. */
  get held() {
    return this.blades.reduce(
      (count, blade) => count + (blade.state === 'forge' || blade.state === 'hold' ? 1 : 0),
      0
    );
  }

  /** Whether anything at all is out — held, flying or standing in the ground. */
  get active() {
    return this.blades.length > 0;
  }

  /**
   * The bodies a blade is currently promised to.
   *
   * The marker over a head is drawn from this, so a lock the player took stays
   * on the body it was taken on until the blade sent for it arrives — the same
   * contract `ShadowCharacter#assignments` and `Judgement#assignments` keep.
   */
  get assignments() {
    this._assigned.length = 0;
    for (const blade of this.blades) {
      if (blade.target?.alive && blade.state !== 'plant' && blade.state !== 'fade') {
        this._assigned.push(blade.target);
      }
    }
    return this._assigned;
  }

  /* ------------------------------------------------------------------ */
  /* marking                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Forge one for this body.
   *
   * @param {import('../combat/Enemy.js').Enemy} enemy
   * @returns {'forged'|'full'|'duplicate'|'unavailable'} why not, when not — the
   *   caller says it out loud, because this class draws no text.
   */
  mark(enemy) {
    const config = settings.flight.blades;
    if (!enemy?.alive) return 'unavailable';
    if (this.blades.some((blade) => blade.target === enemy && blade.state !== 'plant')) {
      return 'duplicate';
    }
    if (this.held >= Math.max(1, Math.round(config.max))) return 'full';

    const blade = this._build();
    if (!blade) return 'unavailable';

    blade.target = enemy;
    this.blades.push(blade);
    this._reslot();
    return 'forged';
  }

  /**
   * Loose everything that is holding.
   *
   * The volley leaves in the order the marks were taken, one every `stagger`
   * seconds — the first one goes on this frame and the rest are queued by the
   * clock below.
   *
   * @returns {number} how many were sent
   */
  launch() {
    let sent = 0;
    for (const blade of this.blades) {
      if (blade.state !== 'forge' && blade.state !== 'hold') continue;
      blade.queued = sent * Math.max(0, settings.flight.blades.stagger);
      blade.state = 'queued';
      blade.timer = 0;
      sent++;
    }
    return sent;
  }

  /**
   * Send everything away.
   *
   * @param {{immediate?: boolean}} [options] `immediate` drops them on the spot
   *   — for leaving the stage, where a burn would only be paused halfway
   *   through and resumed on the way back.
   */
  dismiss({ immediate = false } = {}) {
    if (immediate) {
      this.clear();
      return;
    }
    for (const blade of this.blades) {
      if (blade.state === 'fade') continue;
      blade.state = 'fade';
      blade.timer = 0;
      blade.target = null;
    }
  }

  /** Every blade off, immediately. */
  clear() {
    for (const blade of this.blades) this._release(blade);
    this.blades.length = 0;
    this.impact.clear();
    this.light.intensity = 0;
    this._flash = 0;
  }

  /* ------------------------------------------------------------------ */
  /* the frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt seconds, on the *simulation's* clock — this is combat,
   *   so it slows with the hit-stop it causes and stops with `P`
   * @param {number} elapsed the shared clock, for the ring's turn and the light
   *   running up the steel
   * @param {import('three').Vector3} position where the caster is standing (or
   *   hovering) this frame — the halo is hung off it and follows it exactly
   * @param {number} height the caster's own height in metres, so the ring sits
   *   at the same point up the body whatever `targetHeight` is set to
   */
  update(dt, elapsed, position, height = 1.8) {
    const config = settings.flight.blades;

    // Before anything can emit into it, so a spark born by this frame's kill is
    // stamped with a clock the shader has already been given.
    this.impact.sync(elapsed, config.impact);

    if (!this.blades.length) {
      this._syncLight(config, dt, 0, 0);
      return;
    }

    this._anchor.copy(position);
    // The ring's height is measured *up the body* rather than in absolute
    // metres, so it sits at the same point on the character whatever
    // `targetHeight` has been set to. Resolved once here because the light in
    // the middle of the halo has to agree with the blades around it.
    this._haloY = position.y + height * config.orbit.height;
    this._spin += dt * config.orbit.spin * Math.PI * 2;

    let charge = 0;
    for (const blade of this.blades) {
      this._advance(blade, config, dt, elapsed);
      if (blade.state === 'hold' || blade.state === 'forge') charge = Math.max(charge, blade.charge);
    }

    for (let i = this.blades.length - 1; i >= 0; i--) {
      if (this.blades[i].state !== 'gone') continue;
      this._release(this.blades[i]);
      this.blades.splice(i, 1);
      this._reslot();
    }

    this._syncLight(config, dt, this.held, charge);
  }

  /** One blade, one frame. */
  _advance(blade, config, dt, elapsed) {
    blade.timer += dt;

    switch (blade.state) {
      case 'forge': {
        const u = Math.min(1, blade.timer / Math.max(0.02, config.formTime));
        blade.build = u;
        // Born close in against the body and pushed out to its station as it
        // is written, so the halo *grows* out of the character rather than
        // appearing around them.
        this._station(blade, config, elapsed, Easing.outBack(u));
        if (u >= 1) this._enter(blade, 'hold');
        break;
      }

      case 'hold': {
        blade.build = 1;
        blade.charge = Math.min(1, blade.timer / Math.max(0.05, config.chargeTime));
        this._station(blade, config, elapsed, 1);
        break;
      }

      case 'queued': {
        // Waiting its turn in the volley. Still in the ring, still charging —
        // the last blade out is the hottest one, which is the right way round.
        blade.charge = Math.min(1, blade.charge + dt / Math.max(0.05, config.chargeTime));
        this._station(blade, config, elapsed, 1);
        if (blade.timer >= blade.queued) {
          this._aimAt(blade);
          this._enter(blade, 'wind');
        }
        break;
      }

      case 'wind': {
        const u = Math.min(1, blade.timer / Math.max(0.02, config.windUp));
        blade.charge = 1;
        // Backwards away from the mark, and turning onto it. The pull-back is
        // an `outQuad` and the turn is the whole beat, so it is aimed before it
        // has finished drawing back — which is what makes the release read as
        // a release rather than as a shove.
        _aim.copy(blade.aim).multiplyScalar(-config.windBack * Easing.outQuad(u) * (1 - u * u * 0.6));
        blade.position.copy(blade.origin).add(_aim);
        blade.pivot.position.copy(blade.position);
        blade.pivot.quaternion.slerpQuaternions(blade.rest, blade.facing, Easing.outCubic(u));
        if (u >= 1) {
          blade.speed = 0;
          this._enter(blade, 'strike');
        }
        break;
      }

      case 'strike': {
        // Re-aimed every frame: a body that has walked two metres since the
        // volley left is still the body this blade was forged for.
        this._retarget(blade);
        blade.speed = Math.min(
          Math.max(0.1, config.speed),
          blade.speed + Math.max(1, config.acceleration) * dt
        );

        _to.copy(blade.hit).sub(blade.position);
        const distance = _to.length();
        const step = blade.speed * dt;

        if (distance > 1e-4) {
          _to.multiplyScalar(1 / distance);
          blade.aim.copy(_to);
          _quat.setFromUnitVectors(FORWARD, _to);
          blade.pivot.quaternion.copy(_quat);
        }

        // Arrived if this frame's step carries it past the chest, or if it is
        // already inside the body's own width — at thirty-eight metres a second
        // one frame is most of a metre, and a blade that has to land on an
        // exact point would tunnel through a body every other volley.
        if (step + config.hitRadius >= distance) {
          blade.position.copy(blade.hit);
          this._land(blade, config);
        } else {
          blade.position.addScaledVector(_to, step);
        }
        blade.pivot.position.copy(blade.position);
        // The smear, scaled by how fast it is actually going.
        blade.stretch = 1 + (config.look.stretch - 1) * (blade.speed / Math.max(1, config.speed));
        break;
      }

      case 'plant': {
        const u = blade.timer / Math.max(0.05, config.plantTime);
        blade.stretch = 1;
        // Ringing, and dying away. A struck blade in the ground is the one beat
        // in this ability that is *still*, which is what makes it read as over.
        const ring =
          Math.sin(blade.timer * config.quiverSpeed) * config.quiver * Math.exp(-blade.timer * 5.5);
        _quat.setFromAxisAngle(blade.quiverAxis, ring);
        blade.pivot.quaternion.copy(blade.rest).multiply(_quat);
        blade.charge = Math.max(0, 1 - u * 1.4);
        if (u >= 1) this._enter(blade, 'fade');
        break;
      }

      case 'fade': {
        const u = Math.min(1, blade.timer / Math.max(0.05, config.fadeTime));
        // Unwritten the way it was written, from the tip back down to the guard.
        blade.build = 1 - u;
        blade.charge = Math.max(0, blade.charge - dt * 2);
        if (u >= 1) blade.state = 'gone';
        break;
      }

      default:
        break;
    }

    this._syncMaterial(blade, config);
  }

  /** Move into a state and start its clock. */
  _enter(blade, state) {
    blade.state = state;
    blade.timer = 0;
  }

  /**
   * Put a blade on its station in the ring.
   *
   * The ring is a circle around the body, tilted out of horizontal by `rise`
   * and turning at `spin`. Each blade hangs tip-down and leans out of the
   * circle by `tilt`, and sways on its own phase (`sway`) so that six of them
   * are six objects rather than one carousel.
   *
   * @param {number} reach 0..1 — how far out from the body this blade has got,
   *   which is what makes the forge push it outward as it is written
   */
  _station(blade, config, elapsed, reach) {
    const orbit = config.orbit;
    const angle = this._spin + blade.slot;
    const sway = Math.sin(elapsed * orbit.swaySpeed + blade.seed * 6.283) * orbit.sway;

    const radius = orbit.radius * (0.18 + 0.82 * reach);
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);

    blade.origin.set(
      this._anchor.x + sin * radius,
      // Tilted out of horizontal, so the ring is a formation seen at an angle
      // rather than a carousel: one side of it rides higher than the other.
      this._haloY + sway + sin * orbit.rise * radius * 0.5,
      this._anchor.z + cos * radius
    );
    blade.position.copy(blade.origin);
    blade.pivot.position.copy(blade.position);

    // Tip down, leaned out of the circle. The lean is what stops the ring from
    // reading as a rack of swords standing on nothing.
    _aim.set(sin * orbit.tilt, -1, cos * orbit.tilt).normalize();
    blade.pivot.quaternion.setFromUnitVectors(FORWARD, _aim);
    blade.rest.copy(blade.pivot.quaternion);
    blade.stretch = 1;
  }

  /**
   * Work out where this blade is going, on the frame it is loosed.
   *
   * Three points come out of it and they are all fixed here rather than chased:
   * where it will meet the body (`hit`), which way it is travelling (`aim`),
   * and where it ends up once it has gone through (`plant`). The last is
   * `overshoot` metres past the body and dropped onto the height field, so a
   * blade always finishes standing in the ground rather than hanging in the air
   * behind a corpse.
   */
  _aimAt(blade) {
    const config = settings.flight.blades;
    this._retarget(blade);

    _to.copy(blade.hit).sub(blade.position);
    if (_to.lengthSq() < 1e-6) _to.copy(DOWN);
    _to.normalize();
    blade.aim.copy(_to);

    // Where it stops: past the body, and on the floor.
    const px = blade.hit.x + _to.x * config.overshoot;
    const pz = blade.hit.z + _to.z * config.overshoot;
    blade.plant.set(px, this.terrain ? this.terrain.heightAt(px, pz) : blade.hit.y, pz);

    _quat.setFromUnitVectors(FORWARD, _to);
    blade.facing.copy(_quat);
  }

  /**
   * Keep the aim honest while the blade is in the air.
   *
   * A mark felled between the loose and the arrival — by another blade in the
   * same volley, most likely — leaves this one with nowhere to be. It is not
   * re-pointed at someone else: the player chose that body, and a sword that
   * swerves onto a bystander is a sword the player did not throw. It carries on
   * to where the body was and buries itself there, which is the honest outcome
   * and still looks like something happened.
   */
  _retarget(blade) {
    const enemy = blade.target;
    if (!enemy?.alive) return;
    blade.hit.set(
      enemy.position.x,
      enemy.position.y + settings.enemies.height * 0.55,
      enemy.position.z
    );
  }

  /**
   * The frame it arrives.
   *
   * Everything that says "that happened" fires from here, together: the body,
   * the flash on the steel, the burst and its sparks, and the light jumping to
   * the point of contact. The blade itself does not stop — it is put on its way
   * to the ground behind the kill, which is what says how fast it was moving.
   */
  _land(blade, config) {
    const target = blade.target;
    if (target?.alive) {
      this.onStrike?.(target, blade.aim.x, blade.aim.z, config.force);
      this.impact.burst(
        blade.hit.x,
        blade.hit.y,
        blade.hit.z,
        blade.aim.x,
        blade.aim.y,
        blade.aim.z,
        config.impact
      );
      this._flash = 1;
      this._flashAt.copy(blade.hit);
    }

    blade.target = null;
    // Standing in the ground where it came to rest, at the angle it arrived at.
    blade.position.copy(blade.plant);
    blade.pivot.position.copy(blade.position);
    blade.rest.copy(blade.pivot.quaternion);
    blade.quiverAxis.set(-blade.aim.z, 0, blade.aim.x).normalize();
    if (!Number.isFinite(blade.quiverAxis.x) || blade.quiverAxis.lengthSq() < 0.5) {
      blade.quiverAxis.set(1, 0, 0);
    }
    this._enter(blade, 'plant');
  }

  /* ------------------------------------------------------------------ */
  /* the look                                                            */
  /* ------------------------------------------------------------------ */

  /** Settings → one blade's uniforms, live, so the halo can be re-dressed. */
  _syncMaterial(blade, config) {
    const look = config.look;
    const u = blade.uniforms;

    // Nothing here touches the material's own colour, roughness or metalness:
    // those are the weapon's, and the whole point is that they arrive intact.
    // The rim is the only thing added on top of them.
    copyColor(u.uFresnelColor.value, look.fresnel.color);
    u.uFresnelPower.value = look.fresnel.power;
    u.uFresnelEmissive.value = look.fresnel.emissive;

    u.uBuild.value = blade.build;
    u.uStretch.value = blade.stretch;
  }

  /**
   * The light, doing its two jobs.
   *
   * It hangs in the halo while the blades gather, so the character is lit by
   * the ring of them rather than standing in the middle of one; and on contact
   * it jumps to whatever was hit and flashes there. Nothing else in the frame
   * says "that happened, *there*" as cheaply as a light that moves.
   */
  _syncLight(config, dt, held, charge) {
    const light = config.light;
    this._flash = Math.max(0, this._flash - dt / Math.max(0.02, light.flashTime));

    if (!light.enabled) {
      this.light.intensity = 0;
      return;
    }

    if (this._flash > 0) {
      this.light.position.copy(this._flashAt);
      copyColor(this.light.color, light.flashColor);
      this.light.intensity = light.flash * this._flash * this._flash;
    } else if (held > 0) {
      this.light.position.set(this._anchor.x, this._haloY, this._anchor.z);
      copyColor(this.light.color, light.color);
      // More blades, more light — and brighter as the set comes up to charge.
      const fill = Math.min(1, held / Math.max(1, config.max));
      this.light.intensity = light.intensity * fill * (0.35 + 0.65 * charge);
    } else {
      this.light.intensity = 0;
    }

    this.light.distance = light.distance;
    this.light.decay = light.decay;
  }

  /* ------------------------------------------------------------------ */
  /* building                                                            */
  /* ------------------------------------------------------------------ */

  /** Space the ring out again after a blade joins it or leaves it. */
  _reslot() {
    const holding = this.blades.filter(
      (blade) => blade.state === 'forge' || blade.state === 'hold' || blade.state === 'queued'
    );
    holding.forEach((blade, index) => {
      blade.slot = (index / Math.max(1, holding.length)) * Math.PI * 2;
    });
  }

  /**
   * One blade: a clone of the template, its own materials, its own pivot.
   *
   * The pivot is what everything here places — the clone under it is already
   * baked into a frame where the guard is at the origin and the tip runs up
   * +Z, so aiming a blade is `setFromUnitVectors` and nothing else.
   *
   * The materials are per *blade* rather than per storm because every uniform
   * on them is a fact about one blade: how much of it has been written, how
   * charged it is, whether it is smearing. A shared material would run six
   * blades off one blade's clock. They still cost one program between them —
   * the patch below is the same source text every time, and that is what
   * `patchOnBeforeCompile` keys the program on.
   *
   * @returns {Blade|null} null if there is no weapon to forge one from
   */
  _build() {
    const template = this._ensureTemplate();
    if (!template) return null;

    const uniforms = this._makeUniforms();
    /** source material → this blade's patched clone of it. */
    const clones = new Map();
    const materials = [];
    const dress = (source) => {
      // A mesh that arrived without a material still needs one of ours, or it
      // renders in three's default white and ignores every uniform below.
      const key = source ?? 'none';
      const existing = clones.get(key);
      if (existing) return existing;
      const clone = this._createMaterial(source ?? null, uniforms);
      clones.set(key, clone);
      materials.push(clone);
      return clone;
    };

    // The clone shares the template's materials by reference, which is exactly
    // what is wanted here: they are the weapon's own, and they are what each
    // blade's patched copy is taken from.
    const model = template.clone(true);
    model.traverse((node) => {
      if (!node.isMesh) return;
      node.material = Array.isArray(node.material)
        ? node.material.map(dress)
        : dress(node.material);
      // Nothing here is worth a shadow map: the blades are small, thin, mostly
      // above head height, and the light that arrives with them is doing the
      // job a cast shadow would.
      node.castShadow = false;
      node.receiveShadow = false;
      node.frustumCulled = false;
      node.layers.set(LAYER.WORLD);
      node.raycast = () => {};
    });

    const pivot = new Group();
    pivot.name = 'Blade';
    pivot.scale.setScalar(Math.max(0.05, settings.flight.blades.scale));
    pivot.add(model);
    this.group.add(pivot);

    return {
      pivot,
      materials,
      uniforms,
      /** @type {import('../combat/Enemy.js').Enemy|null} */
      target: null,
      state: 'forge',
      timer: 0,
      queued: 0,
      slot: 0,
      seed: Math.random(),
      build: 0,
      charge: 0,
      stretch: 1,
      speed: 0,
      position: new Vector3(),
      origin: new Vector3(),
      aim: new Vector3(0, -1, 0),
      hit: new Vector3(),
      plant: new Vector3(),
      quiverAxis: new Vector3(1, 0, 0),
      rest: new Quaternion(),
      facing: new Quaternion()
    };
  }

  /** A blade and everything it owns, off the field and off the GPU. */
  _release(blade) {
    this.group.remove(blade.pivot);
    // The clones only — `Material#dispose` leaves textures alone, and these are
    // the weapon's maps, still on the sword in the character's hand.
    for (const material of blade.materials) material.dispose();
    // The geometry belongs to the template and is shared by every blade.
  }

  /**
   * The shape every blade is cut from, built once off whatever is equipped.
   *
   * Four things happen here and each of them buys something specific:
   *
   *  - **The geometry is cloned.** It is shared with the katana in the
   *    character's hand, and everything below writes to it. Baking a matrix
   *    into the equipped sword's own buffers would fold the weapon in half.
   *  - **The materials are kept, by reference.** Each template mesh carries the
   *    weapon's own material, and every blade takes a patched clone of it
   *    (`_build`). Keeping them per mesh rather than collapsing to one is what
   *    lets a weapon with a separate grip, guard and steel arrive intact.
   *  - **Only the weapon is taken.** Other systems hang their own furniture off
   *    the equipped model — the fire's emitter volume is a half-metre box
   *    parented straight to it (`vfx/EmitterBox.js`) — and `collectMeshes`
   *    below is what keeps a blade being a sword rather than that box.
   *  - **The node transforms are baked in.** The export carries its shape on a
   *    node hierarchy; flattened into the vertices, a blade is one transform
   *    and the shader can read a position along the blade straight off
   *    `position`.
   *  - **It is re-oriented.** The geometry is turned so its longest axis runs
   *    up +Z with the guard at the origin — measured rather than assumed, so a
   *    weapon exported along X works without a line of code changing. Which end
   *    is the tip is read off the model's own origin: that origin is where the
   *    hand holds it, so the far end is the sharp one.
   *
   * @returns {Group|null}
   */
  _ensureTemplate() {
    if (this._template) return this._template;

    const slot = this.equipment?.()?.get(WEAPON_ID) ?? null;
    const source = slot?.model ?? null;
    if (!source) {
      console.warn('[BladeStorm] nothing equipped to forge a blade from');
      return null;
    }

    // Measured in the model's *own* frame rather than the hand's: the placement
    // that orients it in a fist has nothing to do with the shape of it.
    const root = source.clone(true);
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0, 0);
    root.scale.setScalar(slot.placement?.scale ?? 1);
    root.updateMatrixWorld(true);

    /** @type {{geometry: import('three').BufferGeometry, material: any}[]} */
    const parts = [];
    collectMeshes(root, parts);

    if (!parts.length) {
      console.warn('[BladeStorm] the equipped weapon carries no mesh');
      return null;
    }

    this._orient(parts.map((part) => part.geometry));

    const template = new Group();
    template.name = 'BladeTemplate';
    // The materials here are the weapon's, shared and never rendered — the
    // template is only ever cloned. `_build` is what swaps in the patched copy.
    for (const part of parts) template.add(new Mesh(part.geometry, part.material));
    this._template = template;
    return template;
  }

  /**
   * Turn a set of geometries so the blade runs up +Z from a guard at the origin.
   *
   * The rotation is a swap of axes rather than a general matrix — the model is
   * axis-aligned in its own space, so there is nothing to solve.
   */
  _orient(geometries) {
    _box.makeEmpty();
    for (const geometry of geometries) {
      geometry.computeBoundingBox();
      _box.union(geometry.boundingBox);
    }
    _box.getSize(_size);

    // The long way through the model is the blade.
    const axis = _size.x > _size.y && _size.x > _size.z ? 'x' : _size.y > _size.z ? 'y' : 'z';
    // And the tip is the end furthest from the origin the weapon is held by.
    const flip = Math.abs(_box.min[axis]) > Math.abs(_box.max[axis]);

    // A turn about Y by -90° carries +X onto +Z; one about X by +90° carries
    // +Y onto +Z. The flipped cases are the same turns the other way round.
    for (const geometry of geometries) {
      if (axis === 'x') geometry.rotateY(flip ? Math.PI / 2 : -Math.PI / 2);
      else if (axis === 'y') geometry.rotateX(flip ? -Math.PI / 2 : Math.PI / 2);
      else if (flip) geometry.rotateY(Math.PI);
    }

    _box.makeEmpty();
    for (const geometry of geometries) {
      geometry.computeBoundingBox();
      _box.union(geometry.boundingBox);
    }

    // Guard on the origin, blade centred on the axis it runs up.
    const cx = (_box.min.x + _box.max.x) * 0.5;
    const cy = (_box.min.y + _box.max.y) * 0.5;
    const minZ = _box.min.z;
    for (const geometry of geometries) {
      geometry.translate(-cx, -cy, -minZ);
      geometry.computeBoundingSphere();
    }

    this._length = Math.max(0.05, _box.max.z - minZ);
  }

  /** One blade's uniforms. Nothing here is shared with another blade. */
  _makeUniforms() {
    return {
      /** Metres from guard to tip, so the shader can work in 0..1 along it. */
      uLength: { value: this._length },
      /** How much of the blade has been written into the air, 0..1. */
      uBuild: { value: 0 },
      uStretch: { value: 1 },

      uFresnelColor: { value: makeColor('#59c7ff') },
      uFresnelPower: { value: 3.2 },
      uFresnelEmissive: { value: 2.6 },

      // The frame's exposure, by identity — every emissive divides itself by it,
      // for the reason set out on the shadow character's rim.
      uExposure: frame.uExposure
    };
  }

  /**
   * The steel: the weapon's own material, with the summon written onto it.
   *
   * A clone rather than the material itself, because the GLB shares its
   * materials with the *body* (`EquipmentLibrary`) — the katana's steel is
   * literally the same object as the armour's, and patching it in place would
   * put a forge threshold across the character. This is the same clone-and-patch
   * `vfx/BladeHeat.js` does when the weapon burns, and the notes there are the
   * ones to read for why `onBeforeCompile` has to be carried across by hand.
   *
   * Everything the sword already is survives: base colour, normals, the
   * metal-roughness map, its own emissive. The shader below only ever *adds*.
   *
   * @param {import('three').Material|null} source the weapon's material
   * @param {object} uniforms this blade's own, shared by every material on it
   */
  _createMaterial(source, uniforms) {
    // `totalEmissiveRadiance` only exists on the lit materials. A weapon wearing
    // something unlit gets the old near-black steel rather than a patch aimed at
    // a chunk that is not in its shader.
    const material = source?.emissive
      ? source.clone()
      : new MeshStandardMaterial({ color: 0x05060c, roughness: 0.24, metalness: 0.95 });

    if (source?.emissive) {
      // `Material.copy` does not carry own-property `onBeforeCompile`, so any
      // patch already on the weapon (the fire's heat, most likely) would be
      // silently dropped by the clone — along with the cache key that says which
      // program that patch belongs to. See `utils/shaderPatch.js`.
      if (Object.hasOwn(source, 'onBeforeCompile')) {
        material.onBeforeCompile = source.onBeforeCompile;
        if (Object.hasOwn(source, 'customProgramCacheKey')) {
          material.customProgramCacheKey = source.customProgramCacheKey;
        }
      }
    }

    material.name = `${source?.name || 'blade'}:storm`;
    // The blade is cut open by the forge threshold, and the inside of that cut
    // is looked straight into while it is being written.
    material.side = DoubleSide;

    patchOnBeforeCompile(material, (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = BLADE_VERTEX_PATCH(shader.vertexShader);
      shader.fragmentShader = BLADE_FRAGMENT_PATCH(shader.fragmentShader);
    });
    material.needsUpdate = true;

    return material;
  }

  dispose() {
    this.clear();
    this.impact.dispose();
    this.light.dispose();
    if (this._template) {
      this._template.traverse((node) => node.geometry?.dispose());
      this._template = null;
    }
    this.group.parent?.remove(this.group);
  }
}

/* -------------------------------------------------------------------- */

/**
 * The weapon's own meshes, and nothing else that happens to be parented to it.
 *
 * An equipped model is not only the model: other systems attach their working
 * parts to it precisely *because* its local axes are the blade's axes. The fire
 * hangs its emitter volume there — an oriented box half a metre bigger than the
 * sword in every direction, plus the hull the flame is raymarched inside
 * (`vfx/WeaponFire.js`). Traversed naively, that box is by far the biggest thing
 * in the hierarchy, so it dominates the bounding box `_orient` measures and it
 * becomes the shape every blade is cut from: the halo hangs six giant crates
 * around the character and throws them at people.
 *
 * Two rules, and the subtree is pruned rather than the node skipped:
 *
 *  - anything flagged `isFireVolume` is the fire's, not the sword's;
 *  - anything hidden is hidden for a reason. The hull is invisible until the
 *    blade is lit, and rebuilding it as a fresh mesh here would lose that and
 *    turn it visible — which is exactly the bug this pair of checks is for.
 */
function collectMeshes(node, out, isRoot = true) {
  // The root itself is exempt from the visibility rule: a weapon can legitimately
  // be hidden as a whole — sheathed, or off on the character screen — and a blade
  // forged in that frame should still be a sword rather than nothing at all.
  if (node.userData?.isFireVolume === true || (!isRoot && node.visible === false)) return;
  if (node.isMesh && node.geometry) {
    const geometry = node.geometry.clone();
    geometry.applyMatrix4(node.matrixWorld);
    out.push({ geometry, material: node.material ?? null });
  }
  for (const child of node.children) collectMeshes(child, out, false);
}

/**
 * The smear.
 *
 * A blade crossing thirty metres in under a second moves further between two
 * frames than it is long, and the eye reads that as a stutter rather than as
 * speed. So the model is stretched along its own length while it travels, from
 * the tip *backwards* — the point stays exactly where the simulation put it and
 * the rest of the sword trails out behind it. It is the cheapest motion blur
 * there is, and on a shape this thin it is indistinguishable from an expensive
 * one.
 *
 * `vAlong` is taken from the *unstretched* position on purpose: it is where a
 * fragment sits along the real blade, and the forge threshold and the energy
 * bands are both facts about the blade rather than about the smear.
 */
const BLADE_VERTEX_PATCH = (source) => {
  const head = /* glsl */ `
uniform float uLength;
uniform float uStretch;
varying float vAlong;
varying vec3 vBladeLocal;
`;

  const vertices = /* glsl */ `
#include <begin_vertex>
vAlong = clamp(position.z / max(uLength, 1e-4), 0.0, 1.0);
vBladeLocal = position;
{
  float tip = uLength;
  transformed.z = tip - (tip - transformed.z) * max(uStretch, 1.0);
}
`;

  return replaceChunk(`${head}\n${source}`, '#include <begin_vertex>', vertices);
};

/**
 * Everything the summon adds to a blade — which is now two things, on purpose.
 *
 * The material underneath is the weapon's own and arrives fully dressed: base
 * colour, normals, metal-roughness, its own emissive. Nothing here replaces any
 * of it or even dials it — the katana in the halo is the katana in the hand,
 * lit by the same moon, and the only thing added is a rim.
 *
 * ## 1. The forge, which is also the death
 *
 * One threshold, `uBuild`, sweeping from guard to tip. Every fragment past the
 * front is discarded and the front itself is eaten into by a noise field so it
 * tears rather than wipes. Run it up and the blade writes itself into the air;
 * run it back down and the same blade is unwritten from the tip. One number
 * does both, which is why there is no separate dissolve anywhere in this file.
 * It is a threshold and nothing else — no line of light rides it, because that
 * is a summoning effect and this blade is meant to read as steel.
 *
 * ## 2. The rim
 *
 * A fresnel on the shaded normal, one colour, constant. It is the only thing
 * that gives a near-black object a silhouette against a night sky, and it is
 * the same device the summoned shadows are drawn with. Everything else the
 * halo used to wear — bands running up the steel, a charge tint, a contact
 * flare — is gone: the light in the middle of the ring and the burst at the
 * point of contact already say those things, and saying them twice is what
 * made the blades read as props rather than as swords.
 *
 * The emissive is divided by the frame's exposure: ACES desaturates as it
 * clips, so a colour picked at one exposure arrives at a different hue at
 * another.
 */
const BLADE_FRAGMENT_PATCH = (source) => {
  const head = /* glsl */ `
${noiseGLSL}

uniform float uBuild;
uniform vec3 uFresnelColor;
uniform float uFresnelPower;
uniform float uFresnelEmissive;
uniform float uExposure;
varying float vAlong;
varying vec3 vBladeLocal;
`;

  const body = /* glsl */ `
#include <emissivemap_fragment>

{
  // How far up the blade has been written. The noise is what turns a wipe into
  // a forge: the front tears along the steel instead of crossing it flat. Both
  // numbers are fixed here rather than exposed — the threshold is the blade's
  // life, not part of how it looks.
  float grain = snoise01(vBladeLocal * 9.0);
  float front = uBuild * 1.45 - 0.45 * grain;
  // Past the front there is no blade yet. Nothing beyond here is shaded, which
  // is why the discard is the first thing in the block.
  if (front - vAlong < 0.0) discard;

  float exposure = max(uExposure, 0.01);
  vec3 nrm = normalize(normal);
  float facing = clamp(1.0 - abs(dot(nrm, normalize(vViewPosition))), 0.0, 1.0);

  totalEmissiveRadiance +=
    uFresnelColor * pow(facing, max(uFresnelPower, 0.05)) * (uFresnelEmissive / exposure);
}
`;

  return replaceChunk(`${head}\n${source}`, '#include <emissivemap_fragment>', body);
};
