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

/** Slots allocated once. `drift.count` draws a prefix of them. */
const MAX_LEAVES = 1024;
const TAU = Math.PI * 2;

/**
 * The leaves in the air.
 *
 * The other half of the same weather as `world/LeafLitter.js`, and deliberately
 * a separate system rather than the litter with a bigger kick: a leaf that has
 * been *carried off* is not doing the same thing as a leaf that has been kicked
 * and is coming back down. It is riding the wind across a hundred metres, it is
 * falling the whole time, and it swings from side to side as it goes — the glide
 * a leaf does because it is a wing, and the single most recognisable thing about
 * a falling leaf. None of that is a kick with different numbers.
 *
 * It shares everything else, though: the same sheet, the same nine variants, the
 * same grade, the same backlight, the same wind block, so the two populations
 * are visibly the same leaves in the same weather.
 *
 * ## Cost
 *
 * Same shape as `world/GroundFog.js`, and for the same reason. Every leaf is one
 * instance, its whole path is a closed form of its age evaluated in the vertex
 * shader, and the four floats that describe it are written once at birth. So the
 * per-frame CPU work is a loop that compares a few hundred floats against the
 * clock and rewrites only the handful that expired — not "advance three hundred
 * particles".
 *
 * ## Landing
 *
 * A drifting leaf reads the same baked height field the litter does and is
 * clamped to it, so it does not sink through the floor: it settles onto the
 * ground, flattens against the slope as it arrives (the tumble is faded out over
 * the last metre of descent) and then skitters along downwind until its life
 * runs out and it erodes away. Leaves blowing along the ground is most of what
 * sells wind, and here it is the *same* leaf that was in the air a moment ago
 * rather than a second effect.
 */
export class LeafDrift {
  /**
   * @param {object} options
   * @param {object} options.textures the sheet, from `loadLeafTextures`
   * @param {object} options.look the shared look uniforms, by identity
   * @param {import('./Terrain.js').Terrain} [options.terrain] for the spawn height
   * @param {import('./TerrainCache.js').TerrainCache} [options.cache] the baked
   *   field the leaves land on, bound by identity
   * @param {import('./Environment.js').Environment} [options.environment]
   * @param {import('./Atmosphere.js').Atmosphere} [options.atmosphere]
   */
  constructor({
    textures,
    look,
    terrain = null,
    cache = null,
    environment = null,
    atmosphere = null
  }) {
    this.terrain = terrain;

    this.uniforms = {
      ...leafCacheUniforms(cache),
      uTime: { value: 0 },
      uSize: { value: 0.14 },
      uWind: { value: new Vector2(0.6, -1.6) },
      uFall: { value: 0.55 },
      uFlutter: { value: 0.5 },
      uFlutterSpeed: { value: 2.2 },
      uTumble: { value: 1 },
      uYawDrift: { value: 0.4 },
      uHover: { value: 0.02 },
      /** Metres over which the tumble is unwound as it comes down to land. */
      uSettle: { value: 1.2 },
      /** Metres at which it starts to erode, and at which it is gone. */
      uFade: { value: new Vector2(34, 46) },
      /** The hole kept clear around the lens: gone by x, back by x + y. */
      uNear: { value: new Vector2(0.9, 1.4) },
      /** Fractions of the life spent arriving and leaving. */
      uBorn: { value: 0.06 },
      uDying: { value: 0.2 },
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

    this._origin = new Float32Array(MAX_LEAVES * 4); // x, y, z, birth
    this._style = new Float32Array(MAX_LEAVES * 4); // variant, seed, size, life
    /** Slots drawn last frame. Raising `count` seeds only the ones that appear. */
    this._live = 0;

    this.geometry = new InstancedBufferGeometry();
    const w = LEAF_QUAD.width * 0.5;
    const h = LEAF_QUAD.height * 0.5;
    this.geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-w, -h, 0, w, -h, 0, w, h, 0, -w, h, 0]), 3)
    );
    this.geometry.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3)
    );
    this.geometry.setAttribute(
      'uv',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2)
    );
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);

    this._originAttr = new InstancedBufferAttribute(this._origin, 4).setUsage(DynamicDrawUsage);
    this._styleAttr = new InstancedBufferAttribute(this._style, 4).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aOrigin', this._originAttr);
    this.geometry.setAttribute('aStyle', this._styleAttr);
    this.geometry.instanceCount = 0;
    this.geometry.boundingSphere = null;

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'LeafDrift';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.layers.set(LAYER.WORLD);
    // World-space placement in the shader — see `createLeafMaterial`.
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.raycast = () => {};
  }

  /** Leaves in the air right now. The editor reports it. */
  get count() {
    return this.geometry.instanceCount;
  }

  /**
   * @param {number} now the simulation clock the shader is given
   * @param {{x: number, z: number}} anchor the character — the emitter follows
   */
  update(now, anchor) {
    const config = settings.leaves;
    const d = config.drift;
    const on = config.enabled && d.enabled;
    this.mesh.visible = on;
    if (!on) {
      this.geometry.instanceCount = 0;
      // Forget the field. Switching back on re-seeds every slot at a staggered
      // age rather than resuming leaves that all expired while it was off and
      // would all be reborn on the same frame.
      this._live = 0;
      return;
    }

    const count = Math.min(Math.max(Math.round(d.count), 0), MAX_LEAVES);
    this.geometry.instanceCount = count;

    /* ---- the look, all uniforms ---- */
    const u = this.uniforms;
    u.uTime.value = now;
    u.uSize.value = Math.max(0.01, config.size) * Math.max(0.05, d.sizeScale);
    u.uWind.value.set(config.windX, config.windZ);
    u.uFall.value = d.fall;
    u.uFlutter.value = d.flutter;
    u.uFlutterSpeed.value = d.flutterSpeed;
    u.uTumble.value = d.tumble;
    u.uYawDrift.value = d.yawDrift;
    u.uHover.value = d.hover;
    u.uSettle.value = Math.max(0.05, d.settle);
    u.uFade.value.set(Math.max(1, d.fadeStart), Math.max(d.fadeStart + 1, d.fadeEnd));
    u.uNear.value.set(Math.max(0, d.nearFade), Math.max(0.05, d.nearFadeRange));
    u.uBorn.value = d.fadeIn;
    u.uDying.value = d.fadeOut;
    u.uGust.value.set(config.gustSpeed, config.gustScale, config.gustStrength);
    syncLeafMaterial(this.material, config);

    /* ---- births ---- */
    // A slot that appears this frame — at boot, or because `count` was turned
    // up — is born into the middle of a life it never lived, so new leaves join
    // a sky that is already falling instead of arriving as one synchronised
    // wave. Everything else is born at 0 and dissolves in.
    let dirty = count > this._live;
    for (let i = this._live; i < count; i++) {
      this._spawn(i, now - Math.random() * Math.max(0.5, d.life), config, d, anchor);
    }
    this._live = count;

    for (let i = 0; i < count; i++) {
      const o = i * 4;
      if (now - this._origin[o + 3] < this._style[o + 3]) continue;
      this._spawn(i, now, config, d, anchor);
      dirty = true;
    }

    if (dirty) {
      this._originAttr.needsUpdate = true;
      this._styleAttr.needsUpdate = true;
    }
  }

  /**
   * Put one leaf back in the air over the character.
   *
   * Uniform over the disc — the square root is what keeps them from bunching at
   * the centre — and at a height taken off the ground *there*, so a leaf born
   * over a hollow starts above the hollow rather than inside the hill next to it.
   */
  _spawn(i, birth, config, d, anchor) {
    const angle = Math.random() * TAU;
    const radius = Math.sqrt(Math.random()) * Math.max(1, d.radius);
    const x = anchor.x + Math.cos(angle) * radius;
    const z = anchor.z + Math.sin(angle) * radius;
    const ground = this.terrain ? this.terrain.heightAt(x, z) : 0;

    const o = i * 4;
    this._origin[o] = x;
    this._origin[o + 1] =
      ground + d.heightMin + Math.random() * Math.max(0, d.heightMax - d.heightMin);
    this._origin[o + 2] = z;
    this._origin[o + 3] = birth;

    this._style[o] = Math.floor(Math.random() * LEAF_ATLAS * LEAF_ATLAS);
    this._style[o + 1] = Math.random();
    this._style[o + 2] = 1 - config.sizeVariance * Math.random();
    this._style[o + 3] = Math.max(0.5, d.life * (1 - d.lifeVariance * Math.random()));
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
uniform vec2  uWind;
uniform float uFall;
uniform float uFlutter;
uniform float uFlutterSpeed;
uniform float uTumble;
uniform float uYawDrift;
uniform float uHover;
uniform float uSettle;
uniform vec2  uFade;
uniform vec2  uNear;
uniform float uBorn;
uniform float uDying;
uniform vec3  uGust;

attribute vec4 aOrigin; // x, y, z, birth
attribute vec4 aStyle;  // variant, seed, size, life

${leafGroundGLSL}

LeafPlacement leafPlace() {
  LeafPlacement leaf;
  leaf.cell = vec2(mod(aStyle.x, ${LEAF_ATLAS}.0), floor(aStyle.x / ${LEAF_ATLAS}.0));

  float life = max(aStyle.w, 0.1);
  float age = max(uTime - aOrigin.w, 0.0);
  float u = clamp(age / life, 0.0, 1.0);
  float seed = aStyle.y;
  float phase = seed * 61.0;

  // The same gust that quivers the litter, so both populations are moving on
  // one wind rather than on two that happen to point the same way.
  float gust = 1.0 + uGust.z * 0.5
             * sin(uTime * uGust.x + dot(aOrigin.xz, vec2(uGust.y, uGust.y * 0.83)) + phase);

  /* ---- carried, falling, and swinging as it goes ---- */
  vec3 centre = aOrigin.xyz;
  centre.xz += uWind * (age * gust);
  centre.y -= uFall * age * (0.7 + seed * 0.7);

  // The glide. A leaf is a wing: it does not drop, it swings from side to side
  // across its own fall, and this pair of out-of-step sines is the whole reason
  // these read as leaves rather than as confetti.
  float swing = uFlutterSpeed * age * (0.7 + seed * 0.9) + phase;
  centre.x += sin(swing) * uFlutter;
  centre.z += cos(swing * 0.83 + phase) * uFlutter;

  // And it cannot go through the floor. The same baked height field the litter
  // lies on, so a leaf coming down in a hollow lands in the hollow — and once
  // it is down the wind above keeps pushing it, so it skitters along the ground.
  vec4 field = leafGround(centre.xz);
  float floorY = field.w + uHover;
  centre.y = max(centre.y, floorY);
  leaf.centre = centre;

  // 1 well clear of the ground, 0 lying on it.
  float airborne = smoothstep(0.0, uSettle, centre.y - floorY);

  /* ---- which way it is turned ---- */
  // Flat to the world in the air, flat to the *slope* once it is down — so a
  // leaf that has landed on a hillside is lying on the hillside.
  vec3 up = normalize(mix(normalize(field.xyz), vec3(0.0, 1.0, 0.0), airborne));

  float yaw = phase + age * uYawDrift * (seed - 0.5);
  vec3 ref = vec3(cos(yaw), 0.0, sin(yaw));
  vec3 f = ref - up * dot(ref, up);
  float flen = length(f);
  f = flen > 1e-4 ? f / flen : normalize(cross(up, vec3(0.0, 0.0, 1.0)));
  vec3 b = cross(up, f);
  vec3 n = up;

  // Turning over about its long axis — the flip that goes with the swing. Faded
  // out over the last metre of the descent, so the leaf unwinds and comes to
  // rest flat instead of stopping dead on its edge.
  float flip = swing * uTumble * airborne;
  b = leafSpin(b, f, flip);
  n = leafSpin(n, f, flip);

  leaf.tangent = f;
  leaf.bitangent = b;
  leaf.normal = n;
  leaf.size = aStyle.z * uSize;

  /* ---- when it is drawn at all ---- */
  float dist = distance(centre, cameraPosition);
  // Eroded away in the distance, and again right at the lens — a leaf twenty
  // centimetres from the camera is a green wall across the frame, and it is
  // still there in the world, just not drawn where it can only be in the way.
  float far = smoothstep(uFade.x, uFade.y, dist);
  float near = 1.0 - smoothstep(uNear.x, uNear.x + uNear.y, dist);
  // In and out over its own life, so nothing pops.
  float born = 1.0 - smoothstep(0.0, max(uBorn, 0.001), u);
  float dying = smoothstep(1.0 - max(uDying, 0.001), 1.0, u);
  leaf.cut = clamp(max(max(far, near), max(born, dying)), 0.0, 1.0);

  return leaf;
}
`;
