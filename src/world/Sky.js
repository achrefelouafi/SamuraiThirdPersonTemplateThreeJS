import { BackSide, BoxGeometry, Color, Mesh, ShaderMaterial } from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';

/**
 * The night sky, and the thing every other surface is fading into.
 *
 * It is a backdrop, and it is the *far end of the haze*: `world/Atmosphere.js`
 * pulls every distant surface toward `uHazeColor`, and if the sky behind them is
 * any other colour the ground stops dissolving into the distance and instead
 * ends at a visible line. So the horizon here is not a setting — it is the haze
 * colour, bound by identity from the same uniform block, and only the zenith,
 * the stars and the moon's own glow are authored on top of it.
 *
 * **This class owns where the moon is.** `settings.sky.moon.azimuth/elevation`
 * are resolved here into `frame.uLightDir` — the world's one light direction,
 * which the haze's inscatter lobe and the ground mist's moonlight both read by
 * identity. So the glow in the sky, the bright quarter of the air and the lit
 * side of every puff of mist all move together when the moon is dragged, and
 * cannot disagree. (The character's key is a *different* angle, in
 * `settings.environment` — see `world/Environment.js`.)
 *
 * Drawn as a box locked to the camera with the depth test off, so it is always
 * behind everything and never has to be as large as the far plane. `renderOrder`
 * puts it first: with no depth write it cannot occlude anything drawn after it,
 * and the opaque pass then overdraws almost all of it.
 *
 * **On cost.** Because it is drawn first, this shader runs once for every pixel
 * on screen — so everything in it is priced per frame at full resolution, and
 * everything in it is written accordingly: a gradient, one hash per pixel for
 * the stars, and a disc that is a single dot product. Nothing outside the moon's
 * own few degrees evaluates the moon at all, and a branch over a fullscreen quad
 * is coherent across every warp that is not straddling its edge.
 */
export class Sky {
  /**
   * @param {import('./Atmosphere.js').Atmosphere} atmosphere the haze the
   *   horizon has to match, bound by identity
   */
  constructor(atmosphere) {
    this.material = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        ...atmosphere.uniforms,
        uZenith: { value: new Color() },
        uGradient: { value: 1 },
        uSunGlow: { value: 0 },
        uSunGlowPower: { value: 8 },
        uBroadGlow: { value: 0 },
        uDisc: { value: 0 },
        uDiscSize: { value: 0.01 },
        uSkyExposure: { value: 1 },
        uTime: { value: 0 },

        /** The moon's face: how much mottling, and how big its patches are. */
        uMoonColor: { value: new Color() },
        uMoonDetail: { value: 0 },
        uMoonDetailScale: { value: 6 },

        /** Stars: density, brightness, twinkle depth, and where they start. */
        uStarDensity: { value: 0 },
        uStarBrightness: { value: 0 },
        uStarTwinkle: { value: 0 },
        uStarHorizon: { value: 0.1 }
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          // The box is parked on the camera, so a corner's world offset is the
          // direction the pixels inside it are looking.
          vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3  uHazeColor;
        uniform vec3  uHazeSunColor;
        uniform vec3  uHazeSunDir;
        uniform vec3  uZenith;
        uniform float uGradient;
        uniform float uSunGlow;
        uniform float uSunGlowPower;
        uniform float uBroadGlow;
        uniform float uDisc;
        uniform float uDiscSize;
        uniform float uSkyExposure;
        uniform float uTime;

        uniform vec3  uMoonColor;
        uniform float uMoonDetail;
        uniform float uMoonDetailScale;

        uniform float uStarDensity;
        uniform float uStarBrightness;
        uniform float uStarTwinkle;
        uniform float uStarHorizon;

        varying vec3 vDir;

        /** The whole noise budget for this shader: two multiply-adds and a fract. */
        float skyHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        /** Bilinear value noise. A quarter of the cost of a simplex lookup. */
        float skyValue(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          float a = skyHash(i);
          float b = skyHash(i + vec2(1.0, 0.0));
          float c = skyHash(i + vec2(0.0, 1.0));
          float d = skyHash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }

        /**
         * A field of stars, from one hash per cell.
         *
         * The direction is scaled into a lattice and each cell holds at most one
         * star, placed inside its own cell by the same hash that decides whether
         * it is there at all. That is one hash and one length per pixel for a
         * whole sky of them.
         */
        vec3 starField(vec3 dir) {
          vec3 p = dir * uStarDensity;
          vec3 cell = floor(p);
          vec3 f = fract(p) - 0.5;

          float h = skyHash(cell.xy + cell.z * 37.7);
          // Most cells are empty; the survivors are the bright end of the hash,
          // which is what gives a sky of a few sharp stars instead of a haze of
          // grey ones.
          float present = step(0.965, h);
          if (present < 0.5) return vec3(0.0);

          // Kept to the middle four-tenths of the cell. A star drawn from one
          // cell only is clipped by its own walls, so the placement and the
          // radius below are chosen to just meet at the boundary and no further.
          vec3 jitter = (vec3(fract(h * 613.7), fract(h * 917.3), fract(h * 271.1)) - 0.5) * 0.4;
          float d = length(f - jitter);
          float core = smoothstep(0.3, 0.0, d);

          // Slow, per-star scintillation. The phase is the cell's own hash, so
          // no two stars breathe together.
          float twinkle = 1.0 - uStarTwinkle * (0.5 + 0.5 * sin(uTime * 1.7 + h * 96.0));
          // Cool white to faintly warm, by the same hash.
          vec3 tint = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.94, 0.86), fract(h * 53.1));
          return tint * (core * core) * uStarBrightness * twinkle;
        }

        void main() {
          vec3 dir = normalize(vDir);
          float up = clamp(dir.y, 0.0, 1.0);

          // Horizon is the haze, by construction. Everything the ground fades
          // into is therefore the colour it is standing in front of.
          vec3 sky = mix(uHazeColor, uZenith, pow(up, uGradient));
          // Below the horizon there is no sky to see — only more of the same
          // air, which is what the floor's own far edge has already become.
          float above = smoothstep(-0.12, 0.03, dir.y);
          sky = mix(uHazeColor, sky, above);

          float sun = clamp(dot(dir, uHazeSunDir), 0.0, 1.0);

          // Stars go in under everything: they are behind the glow, behind the
          // clouds, and they fade out through the thick air near the horizon.
          if (uStarBrightness > 0.0) {
            float clarity = smoothstep(uStarHorizon, uStarHorizon + 0.25, dir.y);
            // And out of the moon's own quarter, where nothing this faint would
            // survive the glare.
            clarity *= 1.0 - 0.85 * pow(sun, 3.0);
            sky += starField(dir) * clarity;
          }

          // Two lobes: the tight one is the glare around the disc, the broad one
          // is the whole quarter of the sky the moon washes out.
          sky += uHazeSunColor * (pow(sun, uSunGlowPower) * uSunGlow + pow(sun, 2.0) * uBroadGlow);

          // The disc itself. Soft-edged — it is being read through the same haze
          // as everything else, and a hard rim would read as a decal.
          float disc = smoothstep(1.0 - uDiscSize, 1.0 - uDiscSize * 0.2, sun);
          if (disc > 0.0) {
            vec3 face = uMoonColor;
            if (uMoonDetail > 0.0) {
              // The maria. The disc is a couple of degrees across, so the noise
              // is evaluated over the *direction* rather than over a projection
              // of it — the patches are fixed to the moon and turn with it, and
              // at this angular size the distortion of a flat lookup is under a
              // pixel. Two octaves is all a body this small can show.
              vec2 uv = dir.xy * uMoonDetailScale + dir.z * 0.5;
              float mottle = skyValue(uv * 40.0) * 0.6 + skyValue(uv * 97.0) * 0.4;
              face *= mix(1.0, 0.45 + 0.75 * mottle, clamp(uMoonDetail, 0.0, 1.0));
            }
            sky += face * uDisc * disc;
          }

          gl_FragColor = vec4(sky * uSkyExposure, 1.0);
        }
      `
    });

    this.mesh = new Mesh(new BoxGeometry(1, 1, 1), this.material);
    this.mesh.name = 'Sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    this._lastTime = 0;

    /**
     * Whether to draw the disc.
     *
     * Cleared by `App` for as long as `world/Moon.js` has a body up: the two
     * would otherwise be stacked on the same few degrees of sky, the shader one
     * unshaded and always full, showing through the terminator of the other.
     * The glare and the broad wash are *not* affected — they belong to the sky
     * whichever moon is in it.
     */
    this.discEnabled = true;

    // Sized and parked here rather than in the frame loop, so the sky follows
    // whichever camera is drawing it — including the shadow and contact passes,
    // which never ask the app where they are.
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      this.mesh.position.copy(camera.position);
      // Comfortably inside the far plane at any corner: the diagonal of a cube
      // of side s is s·√3, so half the far distance leaves ~15% of headroom.
      this.mesh.scale.setScalar(Math.max(camera.far ?? 400, 10) * 0.5);
      this.mesh.updateMatrixWorld(true);
    };
  }

  /**
   * Re-read the settings. Everything is a uniform, so this is nearly free.
   *
   * @param {number} [elapsed] seconds, for the twinkle
   */
  update(elapsed = this._lastTime) {
    const s = settings.sky;
    const u = this.material.uniforms;

    // Where the moon is, first and unconditionally — this is the world's one
    // light direction, and the haze and the ground mist read it whether or not
    // there is a sky drawn behind them.
    this._placeMoon(s.moon);

    this.mesh.visible = s.enabled;
    if (!s.enabled) return;

    this._lastTime = elapsed;

    u.uTime.value = elapsed;
    u.uZenith.value.copy(getColor(s.zenith));
    u.uGradient.value = Math.max(0.05, s.gradient);
    u.uSunGlow.value = s.sunGlow;
    u.uSunGlowPower.value = Math.max(1, s.sunGlowPower);
    u.uBroadGlow.value = s.broadGlow;
    u.uDisc.value = this.discEnabled ? s.disc : 0;
    u.uDiscSize.value = Math.max(0.0005, s.discSize);
    u.uSkyExposure.value = s.exposure;

    const m = s.moon;
    u.uMoonColor.value.copy(getColor(m.color));
    u.uMoonDetail.value = m.detail;
    u.uMoonDetailScale.value = Math.max(0.5, m.detailScale);

    const st = s.stars;
    u.uStarDensity.value = Math.max(1, st.density);
    u.uStarBrightness.value = st.enabled ? Math.max(0, st.brightness) : 0;
    u.uStarTwinkle.value = Math.min(Math.max(st.twinkle, 0), 1);
    u.uStarHorizon.value = st.horizon;
  }

  /**
   * Resolve the moon's azimuth and elevation into the world's light direction.
   *
   * Written into `frame.uLightDir` — the *shared* box, so the haze (which binds
   * it as `uHazeSunDir`) and the ground mist see the move on the same frame with
   * no copying. This shader's own `uHazeSunDir` is that same box by identity,
   * which is why the disc, the glare and the lit air can never drift apart.
   *
   * Same convention as every other angle in the project: azimuth from world +X
   * toward +Z, elevation from the horizon.
   *
   * @param {{ azimuth: number, elevation: number }} moon
   */
  _placeMoon(moon) {
    const cosE = Math.cos(moon.elevation);
    frame.uLightDir.value
      .set(Math.cos(moon.azimuth) * cosE, Math.sin(moon.elevation), Math.sin(moon.azimuth) * cosE)
      .normalize();
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
