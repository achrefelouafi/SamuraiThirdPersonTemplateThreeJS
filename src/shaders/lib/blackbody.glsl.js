/**
 * Thermal radiation, in GLSL.
 *
 * Fire is not a colour, it is a temperature. The red fringe, the orange body,
 * the white core and the incandescent steel under all of it are the *same*
 * function evaluated at different kelvin, and the enormous brightness range
 * between them is the T⁴ of Stefan-Boltzmann rather than an artist's ramp.
 *
 * That is why this lives in one file. The volume, the embers and the blade all
 * radiate through `blackbody()` and `radiance()`, so a spark that has cooled to
 * the temperature of the steel it left is *the same colour as that steel*, with
 * nobody having matched two swatches by eye. Ramps drift apart the moment one of
 * them is tweaked; a shared physical law cannot.
 */
export const blackbodyGLSL = /* glsl */ `
#ifndef BLACKBODY_LIB_INCLUDED
#define BLACKBODY_LIB_INCLUDED

/**
 * Planckian radiator → linear working space, normalised to peak 1.
 *
 * Fit: Tanner Helland's piecewise approximation, valid 1000-40000 K. Cheaper
 * than integrating the CIE curves and, over the 1200-3200 K a flame actually
 * occupies, within a couple of per cent of it.
 */
vec3 blackbody(float kelvin) {
  float t = clamp(kelvin, 1000.0, 12000.0) * 0.01;
  vec3 c;
  if (t <= 66.0) {
    c.r = 1.0;
    c.g = 0.3900816 * log(t) - 0.6318414;
    c.b = t <= 19.0 ? 0.0 : 0.5432068 * log(t - 10.0) - 1.1962540;
  } else {
    c.r = 1.2929362 * pow(t - 60.0, -0.1332047);
    c.g = 1.1298909 * pow(t - 60.0, -0.0755148);
    c.b = 1.0;
  }
  c = clamp(c, 0.0, 1.0);
  return c * c * (0.6 + 0.4 * c); // cheap, accurate-enough sRGB -> linear
}

/**
 * How much power that radiator puts out, relative to the reference kelvin.
 *
 * The exponent is Stefan-Boltzmann's 4 by default; a little under is gentler on
 * a tone mapper. This is what gives fire its internal dynamic range — a
 * white-hot core many times brighter than the red gas a centimetre outside it —
 * and doing it here rather than in a brightness slider is why the core stays
 * white and the fringe stays red at *any* exposure.
 */
float radiance(float kelvin, float reference, float exponent) {
  return pow(max(kelvin, 1.0) / max(reference, 1.0), exponent);
}

/** Radiator colour and power together, the way every caller wants it. */
vec3 thermal(float kelvin, float reference, float exponent) {
  return blackbody(kelvin) * radiance(kelvin, reference, exponent);
}

/** The hand-authored ramp, for when the physics is not the look wanted. */
vec3 gradient4(vec3 c0, vec3 c1, vec3 c2, vec3 c3, float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = mix(c0, c1, smoothstep(0.0, 0.34, t));
  vec3 b = mix(a, c2, smoothstep(0.30, 0.68, t));
  return mix(b, c3, smoothstep(0.64, 1.0, t));
}

#endif
`;
