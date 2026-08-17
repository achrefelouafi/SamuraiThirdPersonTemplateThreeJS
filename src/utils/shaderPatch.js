/**
 * Compose `onBeforeCompile` callbacks.
 *
 * Several systems want to patch the same built-in material (CSM injects its
 * cascade lookup, we inject procedural colour). Assigning `onBeforeCompile`
 * naively would silently clobber whichever ran first, so all patching goes
 * through here.
 *
 * ## Why the cache key is rewritten too
 *
 * three identifies a material's program with `customProgramCacheKey()`, whose
 * default is `onBeforeCompile.toString()` — the *source text* of the injector,
 * on the reasoning that two materials injecting the same code want the same
 * program. The wrapper installed below has the same source text every time it
 * is built, so without the key below every material patched through here hashes
 * identically: three hands them all whichever program compiled first, and every
 * later material silently renders with another system's shader and another
 * system's uniforms. (That is what put the enemies' orange dissolve rim on the
 * summoned shadows — two skinned standard materials, same defines, one program.)
 *
 * So the key is rebuilt from what actually decides the shader: the source of
 * each injected patch, chained onto whatever key the material already had. Two
 * materials patched with the same function still share a program — which is the
 * sharing that was wanted — and two patched with different ones no longer can.
 *
 * The previous key is read *before* the wrapper is installed, so an
 * already-patched material extends its chain rather than losing it.
 */
export function patchOnBeforeCompile(material, fn) {
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();

  material.onBeforeCompile = function (shader, renderer) {
    if (previous) previous.call(this, shader, renderer);
    fn.call(this, shader, renderer);
  };

  const key = `${previousKey}|${fn.toString()}`;
  material.customProgramCacheKey = function () {
    return key;
  };

  return material;
}

/**
 * Replace a token in a shader string, throwing in dev if the token vanished
 * after a three.js upgrade — silent no-ops here are painful to debug.
 */
export function replaceChunk(source, token, replacement) {
  if (!source.includes(token)) {
    console.warn(`[shaderPatch] token not found: ${token}`);
    return source;
  }
  return source.replace(token, replacement);
}

/** Prepend declarations to a shader stage. */
export function prependChunk(source, code) {
  return `${code}\n${source}`;
}
