/**
 * The world's height field — the one definition of "where is the ground".
 *
 * Two things have to agree on it or the illusion falls apart: the floor mesh
 * (which is displaced by it) and the *CPU*, which has to answer the same
 * question for the character's feet. The first reads this chunk; the second
 * reads `world/Terrain.js`, which mirrors the arithmetic below line for line.
 *
 * Which is why this is value noise off a **lookup table** rather than the
 * project's usual `snoise`. A procedural hash (`fract(sin(...) * 43758.5)`) does
 * not evaluate identically on a GPU and in JS — the results agree to a few
 * decimals, which is centimetres of terrain, which is a character sinking into
 * a hill. A 256×256 byte table sampled with NEAREST returns exactly `byte/255`
 * on both sides, and everything after it is plain float arithmetic that agrees
 * to well under a millimetre.
 *
 * The table is small enough to live in texture cache, and the four corners of a
 * cell are packed into one texel so a lookup is one fetch rather than four —
 * both of which mattered a great deal when the floor ran this per vertex per
 * frame. It no longer does: the field is baked once into a texture and read back
 * with a single fetch (`world/TerrainCache.js`), so what is left here runs on the
 * bake and on the contact-shadow catcher's dozen vertices. `uTerrainOctaves` is
 * still a live uniform rather than a `#define`, so the shape can be redialled
 * without a recompile.
 */

/** Side of the hash table, and the modulus every lattice coordinate wraps on. */
export const TERRAIN_HASH_SIZE = 256;

/**
 * Octaves the loop is compiled for. `uTerrainOctaves` breaks out early, so this
 * is a ceiling, not a cost — but GLSL ES 1.00 needs the bound to be constant.
 */
export const TERRAIN_MAX_OCTAVES = 6;

export const terrainGLSL = /* glsl */ `
#ifndef TERRAIN_FIELD_INCLUDED
#define TERRAIN_FIELD_INCLUDED

uniform sampler2D uTerrainHash;
uniform float uTerrainAmp;         // metres from the mean to a peak
uniform float uTerrainScale;       // metres per lattice unit of the base octave
uniform float uTerrainOctaves;
uniform float uTerrainLacunarity;
uniform float uTerrainGain;
uniform float uTerrainWarp;        // domain warp, in lattice units
uniform float uTerrainRidge;       // 0 = rolling, 1 = ridged
uniform vec2  uTerrainOffset;      // the seed, as a shift of the lattice

/**
 * The four lattice corners of one cell, in a single fetch.
 *
 * The table is *packed*: the texel for cell (x, y) carries its own byte in R and
 * its three forward neighbours — (x+1, y), (x, y+1), (x+1, y+1) — in G, B and A
 * (see Terrain#_buildTable). The obvious version of this function fetched one
 * channel and was called four times per octave; this fetches all four at once
 * and returns bit-identical values, because they are the same bytes. It is a
 * straight 4x cut in the hottest memory traffic in the frame.
 *
 * NEAREST on an 8-bit texture, so every component is exactly byte/255 — which is
 * what lets the CPU mirror in world/Terrain.js reproduce this to the micrometre.
 */
vec4 terrainCorners(vec2 cell) {
  vec2 uv = (mod(cell, ${TERRAIN_HASH_SIZE}.0) + 0.5) * ${1 / TERRAIN_HASH_SIZE};
  return texture2D(uTerrainHash, uv);
}

/** Smoothstep-interpolated value noise, 0..1. */
float terrainValue(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec4 h = terrainCorners(i);
  return mix(mix(h.r, h.g, u.x), mix(h.b, h.a, u.x), u.y);
}

/** Ground height at a world XZ, metres. */
float terrainHeightAt(vec2 worldXZ) {
  if (uTerrainAmp <= 0.0) return 0.0;

  vec2 p = worldXZ / uTerrainScale + uTerrainOffset;

  // Pushing the lattice around with a slower copy of itself is what turns
  // fbm's soapy blobs into something with valleys and shoulders.
  if (uTerrainWarp > 0.0) {
    vec2 q = p * 0.5;
    p += vec2(terrainValue(q + vec2(19.3, 7.1)) - 0.5,
              terrainValue(q + vec2(-3.7, 23.9)) - 0.5) * uTerrainWarp;
  }

  float sum = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  for (int i = 0; i < ${TERRAIN_MAX_OCTAVES}; i++) {
    if (float(i) >= uTerrainOctaves) break;
    float n = terrainValue(p);
    n = mix(n, 1.0 - abs(n * 2.0 - 1.0), uTerrainRidge);
    sum += amp * n;
    norm += amp;
    // The offset stops the octaves from lining up their lattices at the origin.
    p = p * uTerrainLacunarity + vec2(31.7, 17.3);
    amp *= uTerrainGain;
  }

  return (sum / max(norm, 1e-5) - 0.5) * 2.0 * uTerrainAmp;
}

/**
 * Surface normal by central difference. Four more height evaluations, which is
 * why only the floor mesh uses it — the grass cannot afford them per blade.
 */
vec3 terrainNormalAt(vec2 worldXZ, float eps) {
  float hL = terrainHeightAt(worldXZ - vec2(eps, 0.0));
  float hR = terrainHeightAt(worldXZ + vec2(eps, 0.0));
  float hD = terrainHeightAt(worldXZ - vec2(0.0, eps));
  float hU = terrainHeightAt(worldXZ + vec2(0.0, eps));
  return normalize(vec3(hL - hR, 2.0 * eps, hD - hU));
}

#endif
`;
