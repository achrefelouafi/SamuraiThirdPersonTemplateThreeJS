import {
  Scene,
  Vector3,
  Object3D,
  AmbientLight,
  HemisphereLight,
  DirectionalLight,
  EquirectangularReflectionMapping,
  PMREMGenerator
} from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

const _sunDir = new Vector3();
/** Light-space basis and the snapped focus, for the texel grid below. */
const _lightX = new Vector3();
const _lightY = new Vector3();
const _lightZ = new Vector3();
const _snapped = new Vector3();
const UP = new Vector3(0, 1, 0);
const SIDE = new Vector3(0, 0, 1);

/**
 * Scene and lighting.
 *
 * The look is a cinematic stage rather than an outdoor field: a cool key light,
 * a rim from behind, almost no fill. The HDR probe is still loaded, but only as
 * (dim) image-based lighting and as the reflection source for the water / wind
 * shaders — never as the visible sky.
 *
 * The scene carries **no background and no fog of its own.** `world/Sky.js` is
 * drawn over every pixel before anything else, so a background colour was never
 * visible behind it; and `world/Atmosphere.js` owns the air, because it can pool
 * in the hollows and glow looking into the moon, neither of which three's linear
 * fog can do.
 *
 * **The key and the rim light the character, not the world.** three has no
 * per-object light filtering — `WebGLRenderer` gathers lights per *scene* and
 * tests them against the camera's layers, never against the object's — so it is
 * done from the other end: `excludeFromKeyLights` patches a material to drop
 * every directional light, and the key and the rim are the only two directional
 * lights in the scene. The ground takes that patch; the character does not, so
 * the two are lit by different halves of the same rig. See
 * `settings.environment.keyCharacterOnly`, which is live.
 *
 * Note that this also means the key is no longer the *moon*: the moon is a body
 * in the sky with its own angles (`settings.sky.moon`, resolved in
 * `world/Sky.js`), and it is what lights the haze and the mist. The key here is
 * free to be placed for the body alone.
 *
 * Sun shadows use one directional light whose orthographic shadow camera is
 * re-centred on the character every frame and fitted tightly to the play area.
 * At 4096² over a 52 m box that is ~1.3 cm per texel — sharper than a three
 * cascade split would give here, without the cost or the complexity.
 *
 * (An earlier revision used the CSM addon. It replaces three's
 * `lights_fragment_begin` chunk *globally*, which means every material in the
 * scene silently loses all directional lighting unless it is explicitly
 * registered with CSM — a footgun that is not worth it for a play area this
 * small.)
 */
export class Environment {
  /**
   * @param {import('../core/Renderer.js').Renderer} renderer
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(renderer, camera) {
    this.renderer = renderer;
    this.camera = camera;

    this.scene = new Scene();

    /**
     * How much of the directional lights a world material keeps: 0 while the key
     * and the rim are the character's alone, 1 when they light everything.
     *
     * One box, shared by identity with every material `excludeFromKeyLights` has
     * patched, so the switch is one write per frame and never a recompile.
     */
    this.keyMask = { value: 0 };

    this.ambient = new AmbientLight(
      getColor(settings.environment.ambientColor).clone(),
      settings.environment.ambientIntensity
    );
    this.hemi = new HemisphereLight(
      getColor(settings.environment.hemiSkyColor).clone(),
      getColor(settings.environment.hemiGroundColor).clone(),
      settings.environment.hemiIntensity
    );

    this.sun = new DirectionalLight(
      getColor(settings.environment.sunColor).clone(),
      settings.environment.sunIntensity
    );
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = settings.environment.shadowBias;
    this.sun.shadow.normalBias = settings.environment.shadowNormalBias;
    this.sun.shadow.radius = settings.environment.shadowRadius;

    /**
     * Half-width of the shadowed box, live off the settings.
     *
     * A forest wants a bigger one than a bare stage did: the thing casting is a
     * seventeen-metre tree at a sun seven degrees off the horizon, and its
     * shadow is well over a hundred metres long. The box only has to hold the
     * *casters* whose shadows land in frame, not the shadows themselves — but
     * that is still most of the near forest.
     */
    this._shadowExtent = 0;
    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.near = 0.5;
    // Deep, because the light has to be parked far enough up-sun to clear the
    // canopy (see `update`) and the near plane is measured from there.
    shadowCamera.far = 520;
    this._fitShadowCamera(settings.environment.shadowExtent);

    /** The light aims at this; both are moved together to follow the action. */
    this.sunTarget = new Object3D();

    /**
     * Cool separation light coming from behind the stage. No shadows: it exists
     * purely to draw a bright edge around the character and the effects so they
     * do not merge into the night behind them. Like the key, it is the
     * character's alone — see `excludeFromKeyLights`.
     */
    this.rim = new DirectionalLight(
      getColor(settings.environment.rimColor).clone(),
      settings.environment.rimIntensity
    );
    this.rimTarget = new Object3D();
    this.rim.target = this.rimTarget;

    this.scene.add(this.ambient, this.hemi, this.sun, this.sunTarget, this.rim, this.rimTarget);
    this.sun.target = this.sunTarget;

    this.focus = new Vector3();
    this._envMap = null;
    this._pmrem = null;
    this._rimDir = new Vector3();
  }

  /**
   * Load the HDR probe. It lights the scene (IBL) but is deliberately *not*
   * used as the background — the stage keeps its flat dark backdrop.
   */
  async loadEnvironment(hdrTexture) {
    this._pmrem = new PMREMGenerator(this.renderer.gl);
    this._pmrem.compileEquirectangularShader();

    hdrTexture.mapping = EquirectangularReflectionMapping;
    const target = this._pmrem.fromEquirectangular(hdrTexture);

    this._envMap = target.texture;
    this.scene.environment = this._envMap;
    this.scene.environmentIntensity = settings.environment.envIntensity;

    // Kept as an equirect source for the cheap fake reflections inside the
    // custom water / wind shaders (they cannot use the PMREM cube directly).
    this.equirect = hdrTexture;

    this._pmrem.dispose();
    this._pmrem = null;
  }

  /** The PMREM probe, for a second scene that wants the same spec response. */
  get envMap() {
    return this._envMap;
  }

  /**
   * Opt a material into the scene's shadow setup.
   *
   * Nothing is required any more — standard materials receive the sun by
   * default — but the hook is kept so callers do not need to care whether the
   * shadow implementation changes again.
   */
  registerShadowCaster(material) {
    return material;
  }

  /** Register a material and inject custom shader code into it. */
  registerShadowCasterWithPatch(material, patch) {
    patchOnBeforeCompile(material, patch);
    return material;
  }

  /**
   * Take a material out of the key and the rim.
   *
   * three offers no way to say "this light, not that object": lights are
   * gathered once per scene and every lit material in it gets all of them (the
   * only filter is `light.layers` against the *camera*, which is all-or-nothing
   * for the frame). So the exclusion is done inside the shader, and as cheaply
   * as the preprocessor allows.
   *
   * The trick is the last line of the injection. `lights_pars_begin` defines
   * `getDirectionalLightInfo`, and `lights_fragment_begin` — which comes later,
   * inside `main` — is the only thing that calls it, once per directional light.
   * Defining a macro of that name *after* the real function is declared leaves
   * the wrapper's own call to it unexpanded (the macro is not in scope yet on
   * that line) and redirects every later call to the wrapper. One multiply per
   * directional light per fragment, no chunk is reimplemented, and nothing here
   * has to know how three loops over its lights.
   *
   * @param {THREE.Material} material a lit material — standard, physical, phong
   */
  excludeFromKeyLights(material) {
    patchOnBeforeCompile(material, (shader) => {
      shader.uniforms.uKeyMask = this.keyMask;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_pars_begin>',
        `#include <lights_pars_begin>
         #if NUM_DIR_LIGHTS > 0
           uniform float uKeyMask;
           void getMaskedDirectionalLightInfo(const in DirectionalLight dirLight, out IncidentLight light) {
             getDirectionalLightInfo(dirLight, light);
             light.color *= uKeyMask;
           }
           #define getDirectionalLightInfo getMaskedDirectionalLightInfo
         #endif`
      );
    });
    return material;
  }

  /**
   * Keep the shadow volume centred on the action.
   *
   * @param {number} x world X
   * @param {number} z world Z
   * @param {number} [y] the ground height there — on a displaced floor the
   *   frustum has to follow the body up the hill, or a deep valley walks out of
   *   the bottom of it and loses its shadows
   */
  setFocus(x, z, y = 0) {
    this.focus.set(x, y, z);
  }

  /** Resize the sun's orthographic shadow box. Cheap, but not free — so guarded. */
  _fitShadowCamera(extent) {
    const half = Math.max(4, extent);
    if (half === this._shadowExtent) return;
    this._shadowExtent = half;
    const camera = this.sun.shadow.camera;
    camera.left = -half;
    camera.right = half;
    camera.top = half;
    camera.bottom = -half;
    camera.updateProjectionMatrix();
  }

  /**
   * Move the shadow frustum onto the focus point, snapped to whole shadow-map
   * texels.
   *
   * This is the single fix for shadow *crawl* — the fizzing, sparkling noise
   * that runs along every shadow edge while the character walks. The cause is
   * that the frustum follows the body continuously: every frame the same world
   * geometry is rasterised into the depth map at a slightly different sub-texel
   * offset, so each edge texel flips in and out of shadow independently, and the
   * result is a band of pixels boiling at 60 Hz. It is the same problem the
   * floor mesh has (a vertex dragged through the height field), and it has the
   * same answer: quantise the movement to the grid it is sampled on.
   *
   * The frustum is orthographic and axis-aligned in light space, so "one texel"
   * is `2 · extent / mapSize` metres along each of the light's own lateral axes.
   * Rounding the focus to that grid means the depth map re-renders with the
   * scene landing on exactly the same texels it did last frame, and the edges
   * hold still. Depth along the light is left alone — nothing samples it at a
   * fixed resolution.
   *
   * @param {THREE.Vector3} out the snapped focus
   */
  _snapFocusToTexels(out) {
    const texel = (this._shadowExtent * 2) / Math.max(1, this.sun.shadow.mapSize.x);

    // The basis three's `lookAt` will build for the light, so the grid below is
    // the grid the shadow camera actually rasterises on.
    _lightZ.copy(_sunDir).negate().normalize();
    // Straight up- or down-sun the usual up vector is degenerate; any axis off
    // it will do, and the sun never sits there at a playable elevation anyway.
    const reference = Math.abs(_lightZ.y) > 0.999 ? SIDE : UP;
    _lightX.crossVectors(reference, _lightZ).normalize();
    _lightY.crossVectors(_lightZ, _lightX);

    const x = Math.round(this.focus.dot(_lightX) / texel) * texel;
    const y = Math.round(this.focus.dot(_lightY) / texel) * texel;
    const z = this.focus.dot(_lightZ);

    return out
      .copy(_lightX)
      .multiplyScalar(x)
      .addScaledVector(_lightY, y)
      .addScaledVector(_lightZ, z);
  }

  /** Direction a light travels (from the light toward the scene). */
  _computeLightDirection(out, azimuth, elevation) {
    const cosE = Math.cos(elevation);
    out.set(-Math.cos(azimuth) * cosE, -Math.sin(elevation), -Math.sin(azimuth) * cosE);
    return out.normalize();
  }

  update() {
    const env = settings.environment;

    this._computeLightDirection(_sunDir, env.sunAzimuth, env.sunElevation);
    this._fitShadowCamera(env.shadowExtent);

    // Park the light up-sun from the focus point so the shadow frustum always
    // contains the play area. Far further back than a stage needed: at a low
    // elevation the light's own height above the ground is only
    // `distance · sin(elevation)`, and a light standing lower than the canopy
    // has its near plane cutting the tops off the trees it is meant to be
    // casting from.
    // Snapped, so the depth map stops re-rasterising at a new sub-texel offset
    // every frame and the shadow edges stop fizzing.
    this._snapFocusToTexels(_snapped);
    this.sunTarget.position.copy(_snapped);
    this.sun.position.copy(_snapped).addScaledVector(_sunDir, -Math.max(40, env.shadowDistance));

    // Whether the world's own surfaces see the key and the rim at all. The
    // custom shaders that fake their own normals are *not* driven from here:
    // they read `frame.uLightDir`, which is the moon, and the moon is
    // `world/Sky.js`'s to place.
    this.keyMask.value = env.keyCharacterOnly ? 0 : 1;

    this.sun.intensity = env.sunIntensity;
    this.sun.color.copy(getColor(env.sunColor));
    this.sun.shadow.radius = env.shadowRadius;
    this.sun.shadow.bias = env.shadowBias;
    // The other half of the acne fix, and the one the character screen has
    // always had a control for: `bias` offsets in depth and so has to be dialled
    // against the slope, while this one walks the sample along the surface
    // normal and is scale-free. Between them they are what stops a lit surface
    // from speckling itself.
    this.sun.shadow.normalBias = env.shadowNormalBias;

    this._computeLightDirection(this._rimDir, env.rimAzimuth, env.rimElevation);
    this.rimTarget.position.copy(this.focus);
    this.rim.position.copy(this.focus).addScaledVector(this._rimDir, -40);
    this.rim.intensity = env.rimIntensity;
    this.rim.color.copy(getColor(env.rimColor));

    this.ambient.intensity = env.ambientIntensity;
    this.ambient.color.copy(getColor(env.ambientColor));
    this.hemi.intensity = env.hemiIntensity;
    this.hemi.color.copy(getColor(env.hemiSkyColor));
    this.hemi.groundColor.copy(getColor(env.hemiGroundColor));

    this.scene.environmentIntensity = env.envIntensity;
  }

  dispose() {
    this._envMap?.dispose();
    this.equirect?.dispose();
    this.sun.shadow.dispose();
  }
}
