import {
  AmbientLight,
  BackSide,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  RectAreaLight,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SpotLight,
  TorusGeometry,
  Vector3
} from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { LAYER } from '../core/Layers.js';
import { ContactShadows } from './ContactShadows.js';
import { DustMotes } from './DustMotes.js';

/** Where the rig aims: chest height on a 1.78 m body. */
const FOCUS = new Vector3(0, 1.05, 0);

/** Radius of the backdrop shell, metres. Big enough never to be reached. */
const BACKDROP_RADIUS = 40;

const _dir = new Vector3();
const _glow = new Vector3(0, 0, 1);

/**
 * The character screen's set: a scene of its own, lit for one body.
 *
 * The play stage next door is lit for *legibility* — a key, a rim, and fog to
 * sink the floor into the backdrop, all tuned to read at ten metres while the
 * camera swings. None of that survives being walked up to. So this is a second
 * scene with a second lighting rig, built the way a product shot is:
 *
 *  - **Key, twice.** A spot carries the shadow and the falloff; a rect-area
 *    softbox at the same angle does the wrap and the long specular roll down
 *    armour. Neither alone is enough — an area light casts no shadow in three,
 *    and a bare spot leaves metal reading as plastic.
 *  - **Fill from the opposite quarter,** cool and area-shaped, so the shadow
 *    side keeps its form instead of going to black.
 *  - **Two edges, deliberately unmatched.** A cool rim behind one shoulder and
 *    a warm kicker behind the other: the same brightness on both sides reads as
 *    a mistake, a difference in *colour* reads as a room.
 *  - **A hair light** straight down, which is what stops the head merging into
 *    the backdrop on a dark set.
 *  - **A backdrop that answers the camera.** The halo on the shell is placed
 *    from the view vector every frame, so the silhouette is always framed
 *    against the bright part of the wall however far the orbit is dragged.
 *
 * Everything reads `settings.studio` per frame, exactly like the rest of the
 * project: no controller here caches a value, so the editor re-lights the set on
 * the next frame with nothing rebuilt.
 */
export class StudioStage {
  /**
   * @param {import('../core/Renderer.js').Renderer} renderer
   */
  constructor(renderer) {
    // The LTC lookup tables the area lights sample. Idempotent, but it has to
    // have run before the first frame that draws a RectAreaLight.
    RectAreaLightUniformsLib.init();

    this.renderer = renderer;
    this.scene = new Scene();
    this.scene.name = 'StudioStage';

    /** Everything the set owns, so the character can be added and removed alone. */
    this.group = new Group();
    this.group.name = 'StudioSet';
    this.scene.add(this.group);

    this._buildBackdrop();
    this._buildFloor();
    this._buildLights();

    this.contactShadows = new ContactShadows(renderer, {
      size: 2.4,
      resolution: 512,
      height: 2.2,
      blur: 1.6,
      getStrength: () => settings.studio.stage.contactShadow
    });
    this.group.add(this.contactShadows.group);

    // A thin haze catching the key. The volume is the size of the set rather
    // than the size of the field next door, so the motes read as studio air.
    this.dust = new DustMotes({
      count: 700,
      volume: new Vector3(7, 4.5, 7),
      size: 9,
      getAmount: () => settings.studio.stage.dust
    });
    this.dust.setPixelRatio(renderer.gl.getPixelRatio());
    this.group.add(this.dust.points);

    this._focus = FOCUS.clone();
    this._color = new Color();
  }

  /** The HDR probe, borrowed from the play stage — spec response, not light. */
  setEnvironment(envMap) {
    this.scene.environment = envMap;
    this.scene.environmentIntensity = settings.studio.lights.envIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* set dressing                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * The cyclorama.
   *
   * One inverted sphere with a vertical gradient and a halo that tracks the
   * camera (`uGlowDir`, written in `update`). Dithered on the way out: a smooth
   * dark gradient across 2000 px is exactly the case 8-bit output bands on, and
   * a quarter-LSB of noise costs nothing and removes it.
   */
  _buildBackdrop() {
    this.backdropUniforms = {
      uTop: { value: new Color() },
      uBottom: { value: new Color() },
      uGlow: { value: new Color() },
      uGlowStrength: { value: 0.75 },
      uGlowSpread: { value: 0.42 },
      uGlowDir: { value: new Vector3(0, 0, 1) }
    };

    const material = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: this.backdropUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uBottom;
        uniform vec3 uGlow;
        uniform float uGlowStrength;
        uniform float uGlowSpread;
        uniform vec3 uGlowDir;
        varying vec3 vDir;

        void main() {
          vec3 dir = normalize(vDir);

          // Ground-to-sky ramp, biased so the horizon sits just under the eye.
          float h = smoothstep(-0.45, 0.85, dir.y);
          vec3 color = mix(uBottom, uTop, h * h);

          // The halo: a lobe around the direction pointing away from the camera,
          // faded out well above and below the subject's head so it reads as a
          // lit wall rather than a sky.
          float facing = max(dot(normalize(vec3(dir.x, 0.0, dir.z)), uGlowDir), 0.0);
          float lobe = pow(facing, mix(9.0, 1.4, clamp(uGlowSpread, 0.0, 1.0)));
          float band = exp(-pow((dir.y - 0.1) / 0.5, 2.0));
          color += uGlow * lobe * band * uGlowStrength;

          // Ordered-ish dither, a quarter of an 8-bit step. Kills the banding a
          // gradient this smooth would otherwise show after the grade.
          float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          color += (n - 0.5) / 1024.0;

          gl_FragColor = vec4(color, 1.0);
        }
      `
    });

    this.backdrop = new Mesh(new SphereGeometry(BACKDROP_RADIUS, 48, 32), material);
    this.backdrop.name = 'Backdrop';
    this.backdrop.layers.set(LAYER.WORLD);
    this.backdrop.frustumCulled = false;
    this.backdrop.renderOrder = -10;
    this.group.add(this.backdrop);
  }

  /**
   * The plinth: a polished disc that dissolves before its own edge.
   *
   * Metal rather than stone, because a mirror floor is what puts a second,
   * upside-down key under the boots and stops the body floating. The alpha fade
   * at the rim is what keeps it from reading as a disc sitting in a void — there
   * is no visible edge to read.
   */
  _buildFloor() {
    const stage = settings.studio.stage;

    this.floorUniforms = {
      uRadius: { value: stage.floorRadius },
      uPool: { value: 1 }
    };

    this.floorMaterial = new MeshStandardMaterial({
      color: getColor(stage.floorColor).clone(),
      roughness: stage.floorRoughness,
      metalness: stage.floorMetalness,
      transparent: true,
      dithering: true
    });

    this.floorMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uRadius = this.floorUniforms.uRadius;
      shader.uniforms.uPool = this.floorUniforms.uPool;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFloorWorld;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvFloorWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vFloorWorld;
           uniform float uRadius;
           uniform float uPool;`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             float r = length(vFloorWorld.xz) / max(0.001, uRadius);
             // Bright under the feet, sinking toward the backdrop outward.
             float pool = mix(0.25, 1.0, smoothstep(1.0, 0.1, r));
             diffuseColor.rgb *= mix(1.0, pool, clamp(uPool, 0.0, 1.0));
             // …and gone entirely before the geometry runs out.
             diffuseColor.a *= smoothstep(1.0, 0.62, r);
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           {
             // Polished at the centre, scuffed toward the rim: a uniformly
             // mirrored floor reads as a render, an uneven one as a set.
             float r = length(vFloorWorld.xz) / max(0.001, uRadius);
             roughnessFactor = clamp(roughnessFactor * mix(0.75, 2.4, smoothstep(0.1, 1.0, r)), 0.02, 1.0);
           }`
        );
    };

    this.floor = new Mesh(new CircleGeometry(1, 96).rotateX(-Math.PI / 2), this.floorMaterial);
    this.floor.name = 'StudioFloor';
    this.floor.receiveShadow = true;
    this.floor.layers.set(LAYER.WORLD);
    this.group.add(this.floor);

    // The rim light strip. Basic, unlit and above the bloom threshold, so it is
    // the one thing on the set that blooms.
    this.ringMaterial = new MeshBasicMaterial({
      color: new Color(),
      transparent: true,
      opacity: 0.9,
      side: DoubleSide,
      toneMapped: false,
      depthWrite: false
    });
    this.ring = new Mesh(new TorusGeometry(1, 0.003, 8, 128).rotateX(Math.PI / 2), this.ringMaterial);
    this.ring.name = 'StudioRing';
    this.ring.position.y = 0.002;
    this.ring.layers.set(LAYER.WORLD);
    this.group.add(this.ring);
  }

  /**
   * The five-point rig. Positions are resolved from azimuth/elevation every
   * frame in `update`, so every angle in the settings block is live.
   */
  _buildLights() {
    const lights = settings.studio.lights;

    /** Everything aims here. */
    this.target = new Object3D();
    this.target.position.copy(FOCUS);
    this.group.add(this.target);

    // ---- key: spot (shadow + falloff) ----
    this.key = new SpotLight(getColor(lights.keyColor).clone(), lights.keyIntensity);
    this.key.angle = lights.keyAngle;
    this.key.penumbra = lights.keyPenumbra;
    this.key.decay = 2;
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.camera.near = 0.4;
    this.key.shadow.camera.far = 24;
    this.key.shadow.bias = lights.shadowBias;
    this.key.shadow.normalBias = lights.shadowNormalBias;
    this.key.shadow.radius = lights.shadowRadius;
    this.key.target = this.target;

    // ---- key: softbox (wrap + specular shape) ----
    this.keySoftbox = new RectAreaLight(
      getColor(lights.keyColor).clone(),
      lights.keySoftbox,
      lights.keySoftboxSize,
      lights.keySoftboxSize
    );

    // ---- fill ----
    this.fill = new RectAreaLight(
      getColor(lights.fillColor).clone(),
      lights.fillIntensity,
      lights.fillSize,
      lights.fillSize
    );

    // ---- edges ----
    this.rim = new SpotLight(getColor(lights.rimColor).clone(), lights.rimIntensity);
    this.rim.angle = 0.7;
    this.rim.penumbra = 1;
    this.rim.decay = 2;
    this.rim.target = this.target;

    this.kicker = new SpotLight(getColor(lights.kickerColor).clone(), lights.kickerIntensity);
    this.kicker.angle = 0.8;
    this.kicker.penumbra = 1;
    this.kicker.decay = 2;
    this.kicker.target = this.target;

    // ---- hair light ----
    this.top = new SpotLight(getColor(lights.topColor).clone(), lights.topIntensity);
    this.top.angle = 0.55;
    this.top.penumbra = 1;
    this.top.decay = 2;
    this.top.target = this.target;

    this.ambient = new AmbientLight(
      getColor(lights.ambientColor).clone(),
      lights.ambientIntensity
    );

    this.group.add(
      this.key,
      this.keySoftbox,
      this.fill,
      this.rim,
      this.kicker,
      this.top,
      this.ambient
    );
  }

  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve the whole set from `settings.studio`.
   *
   * @param {import('three').Camera} camera the studio camera, for the backdrop halo
   * @param {number} elapsed seconds, for the dust
   */
  update(camera, elapsed) {
    const studio = settings.studio;
    const lights = studio.lights;
    const stage = studio.stage;

    this._focus.set(0, studio.camera.targetHeight, 0);
    this.target.position.copy(this._focus);

    /* ---- key ---- */
    place(this.key, lights.keyAzimuth, lights.keyElevation, lights.keyDistance, this._focus);
    this.key.intensity = lights.keyIntensity;
    this.key.color.copy(getColor(lights.keyColor));
    this.key.angle = lights.keyAngle;
    this.key.penumbra = lights.keyPenumbra;
    this.key.shadow.bias = lights.shadowBias;
    this.key.shadow.normalBias = lights.shadowNormalBias;
    this.key.shadow.radius = lights.shadowRadius;

    place(
      this.keySoftbox,
      lights.keyAzimuth,
      lights.keyElevation * 0.8,
      lights.keyDistance * 0.7,
      this._focus
    );
    this.keySoftbox.lookAt(this._focus);
    this.keySoftbox.intensity = lights.keySoftbox;
    this.keySoftbox.color.copy(getColor(lights.keyColor));
    this.keySoftbox.width = lights.keySoftboxSize;
    this.keySoftbox.height = lights.keySoftboxSize;

    /* ---- fill ---- */
    place(this.fill, lights.fillAzimuth, lights.fillElevation, lights.fillDistance, this._focus);
    this.fill.lookAt(this._focus);
    this.fill.intensity = lights.fillIntensity;
    this.fill.color.copy(getColor(lights.fillColor));
    this.fill.width = lights.fillSize;
    this.fill.height = lights.fillSize;

    /* ---- edges ---- */
    place(this.rim, lights.rimAzimuth, lights.rimElevation, lights.rimDistance, this._focus);
    this.rim.intensity = lights.rimIntensity;
    this.rim.color.copy(getColor(lights.rimColor));

    place(
      this.kicker,
      lights.kickerAzimuth,
      lights.kickerElevation,
      lights.kickerDistance,
      this._focus
    );
    this.kicker.intensity = lights.kickerIntensity;
    this.kicker.color.copy(getColor(lights.kickerColor));

    /* ---- hair ---- */
    this.top.position.set(this._focus.x, this._focus.y + 2.6, this._focus.z - 0.9);
    this.top.intensity = lights.topIntensity;
    this.top.color.copy(getColor(lights.topColor));

    this.ambient.intensity = lights.ambientIntensity;
    this.ambient.color.copy(getColor(lights.ambientColor));
    this.scene.environmentIntensity = lights.envIntensity;

    /* ---- backdrop ---- */
    const u = this.backdropUniforms;
    u.uTop.value.copy(getColor(stage.backdropTop));
    u.uBottom.value.copy(getColor(stage.backdropBottom));
    u.uGlow.value.copy(getColor(stage.backdropGlow));
    u.uGlowStrength.value = stage.glowStrength;
    u.uGlowSpread.value = stage.glowSpread;

    // The halo sits opposite the camera, so the silhouette is always read
    // against the bright part of the wall.
    _glow.set(camera.position.x, 0, camera.position.z);
    if (_glow.lengthSq() < 1e-6) _glow.set(0, 0, 1);
    u.uGlowDir.value.copy(_glow.normalize().negate());

    /* ---- floor ---- */
    this.floor.scale.setScalar(stage.floorRadius);
    this.ring.scale.setScalar(stage.floorRadius * 0.995);
    this.floorUniforms.uRadius.value = stage.floorRadius;
    this.floorMaterial.color.copy(getColor(stage.floorColor));
    this.floorMaterial.roughness = stage.floorRoughness;
    this.floorMaterial.metalness = stage.floorMetalness;

    this._color.copy(getColor(stage.ringColor)).multiplyScalar(stage.ringIntensity);
    this.ringMaterial.color.copy(this._color);
    this.ringMaterial.opacity = Math.min(1, stage.ringIntensity);

    this.dust.update(elapsed, null);
  }

  /** The contact-shadow pass. Called once per frame, before the main render. */
  renderContactShadows() {
    this.contactShadows.render(this.scene);
  }

  setPixelRatio(ratio) {
    this.dust.setPixelRatio(ratio);
  }

  dispose() {
    this.contactShadows.dispose();
    this.dust.dispose();
    this.backdrop.geometry.dispose();
    this.backdrop.material.dispose();
    this.floor.geometry.dispose();
    this.floorMaterial.dispose();
    this.ring.geometry.dispose();
    this.ringMaterial.dispose();
    this.key.shadow.dispose();
  }
}

/* -------------------------------------------------------------------- */

/**
 * Put a light on a sphere around the subject.
 *
 * Azimuth is measured from +X toward +Z and elevation from the floor, so the
 * numbers in `settings.studio.lights` read the way a gaffer would say them:
 * "three quarters round, forty degrees up, four metres out".
 */
function place(light, azimuth, elevation, distance, focus) {
  const cosE = Math.cos(elevation);
  _dir.set(Math.cos(azimuth) * cosE, Math.sin(elevation), Math.sin(azimuth) * cosE);
  light.position.copy(focus).addScaledVector(_dir, distance);
}
