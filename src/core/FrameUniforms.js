import { Vector2, Vector3 } from 'three';

/**
 * Uniform objects shared by *every* custom material, by identity.
 *
 * Because three.js stores uniforms as `{ value }` boxes, handing the same box to
 * many materials means one write per frame updates all of them. That keeps the
 * per-frame CPU work for a scene full of custom materials down to a handful of
 * assignments instead of a traversal.
 */
export const frame = {
  uTime: { value: 0 },
  uDelta: { value: 0 },
  uResolution: { value: new Vector2(1, 1) },
  uCameraNear: { value: 0.1 },
  uCameraFar: { value: 400 },
  /**
   * The tone mapper's exposure for this frame, mirrored from the renderer.
   *
   * The play stage and the character screen grade at very different exposures
   * (0.98 against 0.49), and ACES desaturates as it clips — so an emissive that
   * is dialled in on one stage comes out a different *hue* on the other. A
   * shader that divides its emissive by this feeds the tone mapper the same
   * value in both places, and the colour picked in the editor is the colour on
   * screen wherever the body is standing.
   */
  uExposure: { value: 1 },
  /** Equirectangular HDR used for cheap reflections in custom shaders. */
  uEnvMap: { value: null },
  /**
   * World-space direction *toward* the sun, mirrored from the environment.
   * Custom shaders that fake a normal need the same key direction the lit
   * meshes are using, or the fake reads as a sticker.
   */
  uLightDir: { value: new Vector3(0.45, 0.78, 0.44).normalize() }
};

/** Convenience: the uniform block a custom material usually wants. */
export function sharedUniforms(extra = {}) {
  return {
    uTime: frame.uTime,
    uResolution: frame.uResolution,
    uCameraNear: frame.uCameraNear,
    uCameraFar: frame.uCameraFar,
    uLightDir: frame.uLightDir,
    ...extra
  };
}
