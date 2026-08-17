import { Color } from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { frame } from '../core/FrameUniforms.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/**
 * The air between the camera and everything else.
 *
 * three's `Fog` is one colour applied over a linear ramp, and it cannot draw the
 * two things a forest at a low sun is *made* of. The first is that haze is a
 * volume with a floor: it pools in the hollows and thins as you climb out of
 * them, so a valley two hundred metres away is a wall of white while the ridge
 * behind it is only slightly veiled. The second is that haze is *lit* — looking
 * into the sun you are looking down the beam and the air is bright and warm;
 * turn ninety degrees and the same air is a flat cool grey. Between them they
 * are most of what separates a forest photograph from a green model in a grey
 * box, and neither can be faked with a single fog colour.
 *
 * So this replaces three's fog for the world's own materials rather than adding
 * to it — they are built with `fog: false` and patched with `patch()` below —
 * and the scene carries no `Fog` at all, so nothing can be shaded twice. The
 * character is unhazed either way: it is never more than a few metres from the
 * lens, where every fog model agrees on "none".
 *
 * The height integral is analytic. Density falls exponentially with world Y
 * above `base`, and the optical depth along a segment through that field has a
 * closed form — no marching, one `exp` per fragment more than a linear fog. The
 * sun term is a plain forward lobe rather than Henyey-Greenstein; at these
 * densities the difference is a curve fit nobody can see, and `sunPower` is a
 * dial an artist can actually aim.
 *
 * Every uniform is shared by identity, so one write per frame re-hazes the
 * ground and the sky together — which is the point, since the sky is what the
 * ground has to dissolve *into*.
 */
export class Atmosphere {
  constructor() {
    this.uniforms = {
      uHazeColor: { value: new Color() },
      uHazeSunColor: { value: new Color() },
      // The direction *toward* the sun, straight off the environment's own key
      // light — by identity, so the haze can never be lit from somewhere the
      // shadows are not.
      uHazeSunDir: frame.uLightDir,
      uHazeDensity: { value: 0 },
      uHazeStart: { value: 0 },
      uHazeGround: { value: 0 },
      uHazeBase: { value: 0 },
      uHazeFalloff: { value: 1 },
      uHazeInscatter: { value: 0 },
      uHazeSunPower: { value: 4 },
      uHazeMax: { value: 1 }
    };

    this.update();
  }

  /** The chunk a world material injects. Declares the uniforms above. */
  static get glsl() {
    return atmosphereGLSL;
  }

  /**
   * Put a standard material into the air.
   *
   * Both injection points are chosen to stay out of everyone else's way. The
   * vertex side hangs off `#include <fog_vertex>` — which is always in the
   * source whether or not the material has fog, and which nothing else in this
   * project patches — rather than off `project_vertex`, so a material that wants
   * to displace itself after instancing (the pines' sway) can still own that
   * chunk. The fragment side lands immediately after `opaque_fragment`, where
   * `gl_FragColor` has just been written and is still linear HDR: before tone
   * mapping, before the sRGB transfer, which is the only place a physical
   * quantity like this means anything.
   *
   * @param {THREE.Material} material built with `fog: false`
   */
  patch(material) {
    material.fog = false;
    patchOnBeforeCompile(material, (shader) => {
      Object.assign(shader.uniforms, this.uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${atmosphereVaryingGLSL}`)
        .replace(
          '#include <fog_vertex>',
          `#include <fog_vertex>
           {
             vec4 atmoPos = vec4(transformed, 1.0);
             #ifdef USE_INSTANCING
               atmoPos = instanceMatrix * atmoPos;
             #endif
             vAtmoWorld = (modelMatrix * atmoPos).xyz;
           }`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\n${atmosphereVaryingGLSL}\n${atmosphereGLSL}`
        )
        .replace(
          '#include <opaque_fragment>',
          `#include <opaque_fragment>
           gl_FragColor.rgb = applyAtmosphere(gl_FragColor.rgb, vAtmoWorld);`
        );
    });
    return material;
  }

  /** Re-read the settings. Everything is a uniform, so this is nearly free. */
  update() {
    const h = settings.haze;
    const u = this.uniforms;
    const on = h.enabled;

    u.uHazeColor.value.copy(getColor(h.color));
    u.uHazeSunColor.value.copy(getColor(h.sunColor));
    u.uHazeDensity.value = on ? Math.max(0, h.density) : 0;
    u.uHazeStart.value = Math.max(0, h.start);
    u.uHazeGround.value = on ? Math.max(0, h.ground) : 0;
    u.uHazeBase.value = h.base;
    u.uHazeFalloff.value = Math.max(0.1, h.falloff);
    u.uHazeInscatter.value = h.inscatter;
    u.uHazeSunPower.value = Math.max(0.1, h.sunPower);
    u.uHazeMax.value = Math.min(Math.max(h.max, 0), 1);
  }
}

/**
 * The one thing both stages need: where this fragment is in the world.
 *
 * Kept apart from the chunk below because the vertex shader wants only the
 * declaration and would otherwise be compiling a function it never calls.
 */
const atmosphereVaryingGLSL = /* glsl */ `
#ifndef ATMOSPHERE_VARYING_INCLUDED
#define ATMOSPHERE_VARYING_INCLUDED
varying vec3 vAtmoWorld;
#endif
`;

const atmosphereGLSL = /* glsl */ `
#ifndef ATMOSPHERE_INCLUDED
#define ATMOSPHERE_INCLUDED

uniform vec3  uHazeColor;
uniform vec3  uHazeSunColor;
uniform vec3  uHazeSunDir;    // world direction *toward* the sun
uniform float uHazeDensity;   // 1/m of the layer that is everywhere
uniform float uHazeStart;     // metres of clear air in front of the lens
uniform float uHazeGround;    // extra 1/m at the floor of the mist
uniform float uHazeBase;      // world Y that mist sits on
uniform float uHazeFalloff;   // metres it takes to thin by 1/e
uniform float uHazeInscatter; // how far the haze goes toward the sun's colour
uniform float uHazeSunPower;  // how tight that lobe is
uniform float uHazeMax;       // ceiling, so the far field never goes fully flat

/**
 * The colour of the air along a view ray, and how much of it there is.
 *
 * @param color    what the surface radiates
 * @param worldPos where that surface is
 */
vec3 applyAtmosphere(vec3 color, vec3 worldPos) {
  vec3 toEye = cameraPosition - worldPos;
  float dist = length(toEye);
  float travel = max(dist - uHazeStart, 0.0);
  if (travel <= 0.0) return color;

  // The layer that is everywhere: plain Beer-Lambert in distance.
  float optical = uHazeDensity * travel;

  // The mist on the floor. Density is exp(-(y - base) / falloff), and the
  // integral of that along a straight segment has a closed form — which is the
  // whole reason the profile is an exponential and not something prettier.
  // Clamped because the exponentials below are evaluated on both ends of the
  // ray and a camera under the base height would otherwise overflow one.
  if (uHazeGround > 0.0) {
    float a = clamp((cameraPosition.y - uHazeBase) / uHazeFalloff, -4.0, 24.0);
    float b = clamp((worldPos.y - uHazeBase) / uHazeFalloff, -4.0, 24.0);
    float da = a - b;
    // As the two ends converge the quotient goes 0/0; the midpoint value is its
    // limit, and switching over well before the cancellation bites keeps the
    // horizon from stitching itself with a seam of noise.
    float layer = abs(da) > 1e-3 ? (exp(-b) - exp(-a)) / da : exp(-0.5 * (a + b));
    optical += uHazeGround * travel * clamp(layer, 0.0, 8.0);
  }

  float amount = clamp(1.0 - exp(-optical), 0.0, 1.0) * uHazeMax;
  if (amount <= 0.0) return color;

  // Looking down the beam, the air is bright and the sun's own colour; across
  // it, the same air is flat and cool. One dot product, and it is most of the
  // difference between haze and a grey wash.
  vec3 view = -toEye / max(dist, 1e-4);
  float sun = clamp(dot(view, uHazeSunDir), 0.0, 1.0);
  vec3 haze = mix(uHazeColor, uHazeSunColor, pow(sun, uHazeSunPower) * uHazeInscatter);

  return mix(color, haze, amount);
}

#endif
`;
