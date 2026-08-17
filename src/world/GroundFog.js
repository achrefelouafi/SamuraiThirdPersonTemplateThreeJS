import {
  BufferAttribute,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector2,
  Vector3
} from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { frame } from '../core/FrameUniforms.js';
import { Atmosphere } from './Atmosphere.js';
import { LAYER } from '../core/Layers.js';

/** Slots allocated once. `groundFog.count` draws a prefix of them. */
const MAX_PUFFS = 512;

const _emitter = new Vector2();

/**
 * The mist that crawls over the ground — an emitter, and the puffs it lets go.
 *
 * This is the *other* fog, and it is a different kind of thing from the haze in
 * `world/Atmosphere.js`. That one is a property of the air: an analytic integral
 * along the view ray, with no shape of its own, and it is what makes the far
 * field recede. This one has shape and it moves — it is born somewhere, it is
 * carried downwind, it thins as it goes, and it hugs whatever the ground under
 * it happens to be doing. You need both, because neither can do the other's job:
 * an integral cannot roll past you, and a puff cannot make a hillside two
 * hundred metres away dissolve.
 *
 * **How little the CPU does.** Every puff is one instance of one quad, and its
 * entire trajectory is closed-form in the vertex shader off three numbers
 * written once at birth (where it was born, when, and how long it lives). So the
 * per-frame CPU work is not "move 300 particles" — it is a loop that compares
 * three hundred floats against the clock and touches only the handful that
 * expired this frame. Nothing else is uploaded, ever.
 *
 * **How it stays on the ground.** The height field is already baked into a
 * texture for the floor to read (`world/TerrainCache.js`), so the vertex shader
 * takes the same fetch: the puff's centre is placed at the ground height under
 * it plus `hover`, which means a puff blowing across a valley goes down into the
 * valley instead of sailing over it. The same lookup at each corner gives the
 * fragment shader the surface height under *it*, and the alpha is ramped up out
 * of the ground over `groundFade` metres — which is what hides the line where
 * the quad crosses the terrain. That line is the one artefact that gives billboard
 * fog away, and it is normally answered with a depth prepass and a soft-particle
 * fade; here the ground is already known analytically, so it costs a texture
 * fetch and a smoothstep instead of a second pass over the whole frame.
 */
export class GroundFog {
  /**
   * @param {object} options
   * @param {import('./Terrain.js').Terrain} [options.terrain] the height field,
   *   for the CPU side of the spawn
   * @param {import('./TerrainCache.js').TerrainCache} [options.cache] its baked
   *   texture — bound by identity, so the mist stands on the same ground the
   *   floor is drawing
   * @param {import('./Atmosphere.js').Atmosphere} [options.atmosphere] the air
   *   the puffs are seen through, so a distant one fades like everything else
   */
  constructor({ terrain = null, cache = null, atmosphere = null } = {}) {
    this.terrain = terrain;
    this.cache = cache;

    /* ---- per-instance state, mirrored on the CPU ---- */
    this._origin = new Float32Array(MAX_PUFFS * 3); // spawn x, ground y, z
    this._birth = new Float32Array(MAX_PUFFS);
    this._life = new Float32Array(MAX_PUFFS);
    this._seed = new Float32Array(MAX_PUFFS);
    /** Slots drawn last frame. Raising `count` seeds the ones that appear. */
    this._count = 0;

    for (let i = 0; i < MAX_PUFFS; i++) this._seed[i] = Math.random();

    // The unit quad, written out rather than taken off a `PlaneGeometry`: it is
    // four vertices, and building it here means this geometry owns its own
    // buffers outright instead of sharing attribute objects with a throwaway
    // that would take them with it when it was disposed.
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3
      )
    );
    geometry.setAttribute(
      'uv',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2)
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    this._originAttribute = new InstancedBufferAttribute(this._origin, 3).setUsage(
      DynamicDrawUsage
    );
    this._birthAttribute = new InstancedBufferAttribute(this._birth, 1).setUsage(DynamicDrawUsage);
    this._lifeAttribute = new InstancedBufferAttribute(this._life, 1).setUsage(DynamicDrawUsage);
    geometry.setAttribute('aOrigin', this._originAttribute);
    geometry.setAttribute('aBirth', this._birthAttribute);
    geometry.setAttribute('aLife', this._lifeAttribute);
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(this._seed, 1));
    geometry.instanceCount = 0;
    // The instances are placed in the vertex shader, so the geometry's own
    // bounds describe a 1 m quad at the origin and mean nothing.
    geometry.boundingSphere = null;

    this.geometry = geometry;

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: NormalBlending,
      // A billboard is turned to face the camera in the vertex shader, so which
      // way the source quad was wound is not knowable here.
      side: DoubleSide,
      fog: false,
      uniforms: {
        // Both blocks go in by identity, so the mist is standing on the same
        // baked ground the floor is drawing and is seen through the same air as
        // everything else. Without a cache the shader is handed an inert one and
        // `uHasCache` keeps it from ever sampling it.
        ...(atmosphere ? atmosphere.uniforms : {}),
        ...(cache
          ? cache.uniforms
          : {
              uTerrainCache: { value: null },
              uTerrainCacheOrigin: { value: new Vector2() },
              uTerrainCacheSpacing: { value: 1 },
              uTerrainCacheTexel: { value: 1 }
            }),
        uTime: { value: 0 },
        uLightDir: frame.uLightDir,

        uWind: { value: new Vector3() },
        uRise: { value: 0.05 },
        uHover: { value: 0.4 },
        /** The lateral wander: metres, and how fast it wanders. */
        uSwirl: { value: new Vector2(1.1, 0.12) },

        uSizeStart: { value: 3 },
        uSizeEnd: { value: 8 },
        uSpin: { value: 0.06 },

        uColor: { value: new Color() },
        uLitColor: { value: new Color() },
        uOpacity: { value: 0.3 },
        uSoftness: { value: 0.55 },
        uFade: { value: new Vector2(0.18, 0.4) }, // in, out — fractions of life
        uGroundFade: { value: 1.6 },
        uDetail: { value: 0.5 },
        uDetailScale: { value: 2.4 },
        uMoonlight: { value: 0.5 },
        uMoonPower: { value: 3 },
        /** The clear hole around the lens: gone by x, full again by x + y. */
        uNearFade: { value: new Vector2(7, 9) },
        uHasCache: { value: cache ? 1 : 0 },
        uHasAtmosphere: { value: atmosphere ? 1 : 0 }
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3  uWind;
        uniform float uRise;
        uniform float uHover;
        uniform vec2  uSwirl;
        uniform float uSizeStart;
        uniform float uSizeEnd;
        uniform float uSpin;
        uniform vec2  uFade;
        uniform vec2  uNearFade;
        uniform float uHasCache;

        uniform sampler2D uTerrainCache;
        uniform vec2  uTerrainCacheOrigin;
        uniform float uTerrainCacheSpacing;
        uniform float uTerrainCacheTexel;

        attribute vec3  aOrigin;
        attribute float aBirth;
        attribute float aLife;
        attribute float aSeed;

        varying vec2  vUv;
        varying float vAlpha;
        varying float vSeed;
        varying float vGroundY;
        varying vec3  vWorld;

        /** The baked height field, one fetch. Flat ground when there is none. */
        float groundAt(vec2 xz) {
          if (uHasCache < 0.5) return 0.0;
          vec2 cell = (xz - uTerrainCacheOrigin) / uTerrainCacheSpacing;
          return texture2D(uTerrainCache, (cell + 0.5) * uTerrainCacheTexel).w;
        }

        void main() {
          vUv = uv;
          vSeed = aSeed;

          float age = uTime - aBirth;
          float life = max(aLife, 0.01);
          float t = clamp(age / life, 0.0, 1.0);

          // Where the wind has carried it. Everything below is a function of
          // the age alone — which is what lets the whole system live in a buffer
          // that is written at birth and then left alone.
          vec3 centre = aOrigin + uWind * age;

          // A slow lateral wander so a hundred puffs on the same wind do not
          // read as a hundred puffs on the same wind. Two sines rather than a
          // curl-noise lookup: this runs per vertex, and at this amplitude
          // nobody can tell them apart.
          float phase = aSeed * 43.0;
          float w = uSwirl.y * uTime * (0.6 + aSeed * 0.8);
          centre.x += sin(w + phase) * uSwirl.x * (0.4 + t);
          centre.z += cos(w * 0.83 + phase * 1.7) * uSwirl.x * (0.4 + t);

          // Stand it back up on the ground it has drifted onto, not the ground
          // it was born on — a puff crossing a hollow goes down into it.
          centre.y = groundAt(centre.xz) + uHover + uRise * age;

          float size = mix(uSizeStart, uSizeEnd, t);

          // Camera-facing, with a slow roll about the view axis so no two puffs
          // show the same texture at the same angle.
          float spin = uSpin * uTime * (aSeed * 2.0 - 1.0) + phase;
          float cs = cos(spin), sn = sin(spin);
          vec2 corner = mat2(cs, -sn, sn, cs) * position.xy * size;

          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 upDir = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 world = centre + right * corner.x + upDir * corner.y;

          // The surface under this corner, so the fragment can dissolve the
          // quad into the ground rather than letting the depth test cut it.
          vGroundY = groundAt(world.xz);
          vWorld = world;

          // In, hold, out. Both ends are ramps on the same normalised age, so
          // the life control moves them together.
          vAlpha = smoothstep(0.0, max(uFade.x, 0.001), t) *
                   (1.0 - smoothstep(1.0 - max(uFade.y, 0.001), 1.0, t));

          // And out again near the lens. A puff is metres across, so one that
          // drifts between the camera and the character does not read as mist —
          // it fills the frame, and its birth, death and colour become a wash
          // over the whole shot. Held off the *centre*, not this corner: a
          // billboard faces the camera, so every corner is at much the same
          // depth, and fading on the centre takes the puff out as one piece
          // instead of dragging a soft edge across it. It is still there in the
          // world, still drifting downwind — just not drawn where the only
          // thing it can do is block the view.
          vAlpha *= smoothstep(
            uNearFade.x,
            uNearFade.x + max(uNearFade.y, 0.01),
            distance(centre, cameraPosition)
          );

          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3  uColor;
        uniform vec3  uLitColor;
        uniform vec3  uLightDir;
        uniform float uOpacity;
        uniform float uSoftness;
        uniform float uGroundFade;
        uniform float uDetail;
        uniform float uDetailScale;
        uniform float uMoonlight;
        uniform float uMoonPower;
        uniform float uTime;
        uniform float uHasAtmosphere;

        varying vec2  vUv;
        varying float vAlpha;
        varying float vSeed;
        varying float vGroundY;
        varying vec3  vWorld;

        ${Atmosphere.glsl}

        float fogHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        float fogValue(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(fogHash(i), fogHash(i + vec2(1.0, 0.0)), u.x),
            mix(fogHash(i + vec2(0.0, 1.0)), fogHash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }

        void main() {
          // The puff itself: a disc with a soft shoulder. uSoftness is how much
          // of the radius that shoulder takes, so 1 is a pure gradient and 0 is
          // a hard-edged blob nobody wants.
          vec2 d = vUv - 0.5;
          float r = length(d) * 2.0;
          if (r > 1.0) discard;
          float mask = smoothstep(1.0, 1.0 - clamp(uSoftness, 0.02, 1.0), r);

          // Break the disc up so it does not read as a circle. Two octaves, and
          // only when it is asked for — this is a fill-heavy effect and the
          // difference between two lookups and none is the whole budget.
          if (uDetail > 0.0) {
            vec2 q = vUv * uDetailScale + vSeed * 37.0;
            q += uTime * 0.02 * vec2(1.0, 0.7);
            float n = fogValue(q) * 0.65 + fogValue(q * 2.7 + 5.1) * 0.35;
            mask *= mix(1.0, n * 1.6, clamp(uDetail, 0.0, 1.0));
          }

          // Out of the ground. This is what hides the line where the billboard
          // crosses the terrain: by the time the depth test cuts the quad, the
          // alpha there is already nothing.
          float clearance = smoothstep(0.0, max(uGroundFade, 0.01), vWorld.y - vGroundY);

          float alpha = mask * vAlpha * clearance * uOpacity;
          if (alpha <= 0.002) discard;

          // Lit from the moon, the same way the haze is: looking down the beam
          // the mist glows, across it the same mist is a flat cool grey.
          vec3 view = normalize(vWorld - cameraPosition);
          float toward = clamp(dot(view, uLightDir), 0.0, 1.0);
          vec3 color = mix(uColor, uLitColor, pow(toward, uMoonPower) * uMoonlight);

          // And seen through the same air as everything else, so a puff at the
          // far end of the field does not sit in front of the haze.
          if (uHasAtmosphere > 0.5) color = applyAtmosphere(color, vWorld);

          gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
        }
      `
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'GroundFog';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.layers.set(LAYER.VFX);
    // After the opaque world, before the brighter additive effects.
    this.mesh.renderOrder = 5;
  }

  /** How many puffs are in the air right now. The editor reports it. */
  get count() {
    return this.geometry.instanceCount;
  }

  /**
   * @param {number} elapsed seconds
   * @param {{x: number, z: number}} [anchor] the character, for a following emitter
   */
  update(elapsed, anchor = null) {
    const g = settings.groundFog;

    this.mesh.visible = g.enabled;
    if (!g.enabled) {
      this.geometry.instanceCount = 0;
      // Forget the field. Switching back on then re-seeds every slot at a
      // staggered age rather than resuming a hundred puffs that all expired
      // while the effect was off and would all be reborn on the same frame.
      this._count = 0;
      return;
    }

    const count = Math.min(Math.max(Math.round(g.count), 0), MAX_PUFFS);
    this.geometry.instanceCount = count;

    /* ---- where they are born ---- */
    if (g.follow && anchor) {
      _emitter.set(anchor.x + g.x, anchor.z + g.z);
    } else {
      _emitter.set(g.x, g.z);
    }

    /* ---- the look, all uniforms ---- */
    const u = this.material.uniforms;
    u.uTime.value = elapsed;
    u.uWind.value.set(g.windX, 0, g.windZ);
    u.uRise.value = g.rise;
    u.uHover.value = g.hover;
    u.uSwirl.value.set(g.swirl, g.swirlSpeed);
    u.uSizeStart.value = Math.max(0.1, g.sizeStart);
    u.uSizeEnd.value = Math.max(0.1, g.sizeEnd);
    u.uSpin.value = g.spin;
    u.uColor.value.copy(getColor(g.color));
    u.uLitColor.value.copy(getColor(g.litColor));
    u.uOpacity.value = g.opacity;
    u.uSoftness.value = g.softness;
    u.uFade.value.set(g.fadeIn, g.fadeOut);
    u.uGroundFade.value = g.groundFade;
    u.uDetail.value = g.detail;
    u.uDetailScale.value = Math.max(0.2, g.detailScale);
    u.uMoonlight.value = g.moonlight;
    u.uMoonPower.value = Math.max(0.5, g.moonPower);
    u.uNearFade.value.set(Math.max(0, g.nearFade), Math.max(0.01, g.nearFadeRange));

    /* ---- births ---- */
    // A slot that appears this frame — at boot, or because `count` was turned
    // up — is born into the *middle* of a life it never actually lived, so the
    // new mist joins a field that is already running instead of arriving as one
    // synchronised wall of it. Everything else is born at 0 and fades in.
    let dirty = count > this._count;
    for (let i = this._count; i < count; i++) {
      this._spawn(i, elapsed - Math.random() * Math.max(0.5, g.life), g);
    }
    this._count = count;

    for (let i = 0; i < count; i++) {
      if (elapsed - this._birth[i] < this._life[i]) continue;
      this._spawn(i, elapsed, g);
      dirty = true;
    }

    if (dirty) {
      this._originAttribute.needsUpdate = true;
      this._birthAttribute.needsUpdate = true;
      this._lifeAttribute.needsUpdate = true;
    }
  }

  /**
   * Put one puff back at the emitter.
   *
   * The spawn Y is the ground height *there*, read off the CPU mirror of the
   * height field — the same one the character's feet are placed with, so a puff
   * born on a slope starts on the slope. The vertex shader re-reads the surface
   * as the puff drifts; this is only where it starts.
   *
   * @param {number} i slot
   * @param {number} birth the clock it is born on — in the past, for a stagger
   * @param {typeof settings.groundFog} g
   */
  _spawn(i, birth, g) {
    // Uniform over the disc: the square root is what keeps the mist from
    // bunching at the emitter's centre.
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * Math.max(0, g.radius);
    const x = _emitter.x + Math.cos(angle) * radius;
    const z = _emitter.y + Math.sin(angle) * radius;

    const o = i * 3;
    this._origin[o] = x;
    this._origin[o + 1] = this.terrain ? this.terrain.heightAt(x, z) : 0;
    this._origin[o + 2] = z;

    this._birth[i] = birth;
    this._life[i] = Math.max(0.5, g.life * (1 - g.lifeVariance * Math.random()));
    // The seed is *not* redrawn. It is the slot's identity — its roll, its
    // wander phase, its noise offset — and it is the one attribute that never
    // has to be re-uploaded because of it.
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
