import {
  AddEquation,
  Color,
  CustomBlending,
  LinearMipmapLinearFilter,
  Matrix3,
  Mesh,
  OneMinusSrcAlphaFactor,
  RepeatWrapping,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  SrcAlphaFactor,
  Vector3
} from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';

/** The four maps of the surface material, plus the height field it is relieved by. */
const TEXTURES = {
  map: './textures/moon/Moon_002_basecolor.png',
  normalMap: './textures/moon/Moon_002_normal.png',
  roughnessMap: './textures/moon/Moon_002_roughness.png',
  aoMap: './textures/moon/Moon_002_ambientOcclusion.png',
  heightMap: './textures/moon/Moon_002_height.png'
};

/** Reused per frame so placement allocates nothing. */
const _dir = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _WORLD_UP = new Vector3(0, 1, 0);
const _FORWARD = new Vector3(0, 0, 1);

/**
 * The moon, as a body rather than as a dot product.
 *
 * `world/Sky.js` can draw a disc — a smoothstep on `dot(dir, moonDir)` with two
 * octaves of value noise inside it — and for the price (a branch on a fullscreen
 * quad) it is a good disc. But it is a *disc*: it has no terminator, no relief,
 * no silhouette, and the noise standing in for the maria is noise. At the size
 * this scene hangs it at — some six degrees, a dozen times life size, and the
 * subject of the shot — all three of those are visible, and it reads as a lens
 * flare. So this replaces it with a sphere carrying a real lunar surface
 * material, and `Sky` stands its disc down whenever this one is up (`active`).
 *
 * **The maps are a tiling surface material, not a lunar atlas.** They are 1024²
 * squares of ground, so wrapping them on a sphere's own UVs would put a seam
 * down the face and pinch every crater into the poles. They are projected
 * instead — triplanar, in the mesh's *object* space, so the craters are nailed
 * to the body and turn with it, at even scale everywhere including the limb.
 * Three fetches a map, five maps, over a few hundred pixels of screen.
 *
 * **The relief is geometry**, which is the other half of why this exists: the
 * height map displaces the vertices, so the crater rims break the silhouette
 * instead of being shaded onto a circle. The normal map then does the lighting,
 * so the coarse sphere never has to carry the fine detail itself.
 *
 * **On the light.** The moon is not lit from where the scene is lit — the scene
 * is lit *by* the moon. `frame.uLightDir` points from the camera at it, and its
 * own illumination comes from a sun that is somewhere else entirely; that angle
 * is `settings.sky.moon.phase`, measured from full (lit from behind the lens)
 * around toward the limb, which is the only control that decides whether this is
 * a full moon or a crescent.
 *
 * Drawn with the depth test off, just after the sky and before everything
 * opaque, so it is always behind the world and the world always covers it —
 * the same trick, and the same reason, as the sky box itself.
 */
export class Moon {
  constructor() {
    this.uniforms = {
      uMap: { value: null },
      uNormalMap: { value: null },
      uRoughnessMap: { value: null },
      uAOMap: { value: null },
      uHeightMap: { value: null },

      /**
       * The body's own rotation, object → world.
       *
       * `modelMatrix` is declared in the vertex stage only, and the shading here
       * is done in object space (that is where the maps live) and has to end up
       * in the world. One mat3, refreshed with the placement below.
       */
      uObjectToWorld: { value: new Matrix3() },

      /** Where the sun that lights it is, in world space. */
      uLight: { value: new Vector3(0, 0, 1) },
      /** Tint over the albedo, and the HDR scale that makes it bloom. */
      uTint: { value: new Color(1, 1, 1) },
      uBrightness: { value: 1 },
      /** Master on the coverage — the body's own, separate from the limb fade. */
      uOpacity: { value: 1 },

      /** Tiles per radius, and how hard the triplanar seams are. */
      uTexScale: { value: 1.6 },
      uBlendSharp: { value: 4 },

      /** Displacement as a fraction of the radius, and normal-map weight. */
      uDisplace: { value: 0.05 },
      uRelief: { value: 0.9 },
      uAO: { value: 0.7 },
      uSheen: { value: 0.06 },

      /** Softness of the terminator, and how flat the lit face reads. */
      uTerminator: { value: 0.12 },
      uFlatten: { value: 0.55 },
      /** Fill on the night side, and how far the rim dissolves into the glare. */
      uEarthshine: { value: 0.045 },
      uEdge: { value: 0.1 }
    };

    this.material = new ShaderMaterial({
      // Blended, but *not* `transparent` — and the difference is the whole
      // reason the sorting works. A transparent material is drawn in the pass
      // after the opaque one, which with the depth test off would paint the moon
      // over the trees in front of it. Asking for the blend explicitly instead
      // keeps this in the opaque list, where `renderOrder` can put it directly
      // behind the world, and still lets the limb fade out rather than end.
      transparent: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: SrcAlphaFactor,
      blendDst: OneMinusSrcAlphaFactor,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        uniform sampler2D uHeightMap;
        uniform float uTexScale;
        uniform float uBlendSharp;
        uniform float uDisplace;

        varying vec3 vObjPos;
        varying vec3 vObjNormal;
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;

        /**
         * The height map's own mean, measured off the file.
         *
         * The field is 0..0.69 and averages 0.37, so displacing about 0.5 would
         * shrink the whole body and put four fifths of the range on the inside.
         * Centred here instead, craters cut in and rims stand out about the
         * radius the glare in the sky is sized for.
         */
        const float HEIGHT_MEAN = 0.37;

        /**
         * How much of each of the three projections a point gets, from how far
         * its normal leans down each axis. Raised to a power so the three planes
         * meet in a narrow band instead of a wide smear.
         */
        vec3 triBlend(vec3 n) {
          vec3 b = pow(abs(n), vec3(uBlendSharp));
          return b / max(b.x + b.y + b.z, 1e-4);
        }

        void main() {
          // The geometry is a unit sphere, so its position *is* its normal.
          vec3 n = normalize(position);
          vec3 blend = triBlend(n);

          vec3 p = position * uTexScale;
          float h =
            texture2D(uHeightMap, p.yz).r * blend.x +
            texture2D(uHeightMap, p.xz).r * blend.y +
            texture2D(uHeightMap, p.xy).r * blend.z;

          vec3 displaced = position * (1.0 + (h - HEIGHT_MEAN) * uDisplace);

          // The *undisplaced* point is what the maps are read at, so pushing the
          // surface around cannot slide the texture over it.
          vObjPos = position;
          vObjNormal = n;

          vec4 world = modelMatrix * vec4(displaced, 1.0);
          vWorldPos = world.xyz;
          // Uniform scale throughout, so the rotation alone carries the normal.
          vWorldNormal = normalize(mat3(modelMatrix) * n);
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform sampler2D uNormalMap;
        uniform sampler2D uRoughnessMap;
        uniform sampler2D uAOMap;

        uniform mat3  uObjectToWorld;
        uniform vec3  uLight;
        uniform vec3  uTint;
        uniform float uBrightness;
        uniform float uOpacity;
        uniform float uTexScale;
        uniform float uBlendSharp;
        uniform float uRelief;
        uniform float uAO;
        uniform float uSheen;
        uniform float uTerminator;
        uniform float uFlatten;
        uniform float uEarthshine;
        uniform float uEdge;

        varying vec3 vObjPos;
        varying vec3 vObjNormal;
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;

        /**
         * The albedo map's own mean, in linear light, measured off the file.
         *
         * uBrightness is sky.disc times the body's own multiplier; sky.disc is
         * shared with the glare, and was tuned against a disc that was very
         * nearly white. Lunar regolith is dark grey rock at
         * about a third of that, so without normalising here the same number
         * would mean two different things depending on which moon was drawn, and
         * turning the body on would darken it by a factor of three.
         */
        const float ALBEDO_MEAN = 0.36;

        vec3 triBlend(vec3 n) {
          vec3 b = pow(abs(n), vec3(uBlendSharp));
          return b / max(b.x + b.y + b.z, 1e-4);
        }

        vec3 triplanar(sampler2D tex, vec3 p, vec3 blend) {
          return texture2D(tex, p.yz).rgb * blend.x +
                 texture2D(tex, p.xz).rgb * blend.y +
                 texture2D(tex, p.xy).rgb * blend.z;
        }

        /**
         * The normal map, blended across the same three planes.
         *
         * Not an average of three vectors — that flattens the detail wherever
         * two planes overlap. This is the whiteout blend: each projection's
         * tangent-space normal is folded onto the surface normal *before* they
         * are mixed, so the bumps survive the seam at full strength.
         */
        vec3 triplanarNormal(vec3 p, vec3 n, vec3 blend) {
          vec3 nx = texture2D(uNormalMap, p.yz).xyz * 2.0 - 1.0;
          vec3 ny = texture2D(uNormalMap, p.xz).xyz * 2.0 - 1.0;
          vec3 nz = texture2D(uNormalMap, p.xy).xyz * 2.0 - 1.0;

          nx = vec3(nx.xy + n.zy, abs(nx.z) * n.x);
          ny = vec3(ny.xy + n.xz, abs(ny.z) * n.y);
          nz = vec3(nz.xy + n.xy, abs(nz.z) * n.z);

          return normalize(nx.zyx * blend.x + ny.xzy * blend.y + nz.xyz * blend.z);
        }

        void main() {
          vec3 gn = normalize(vObjNormal);
          vec3 blend = triBlend(gn);
          vec3 p = vObjPos * uTexScale;

          vec3 albedo = triplanar(uMap, p, blend) / ALBEDO_MEAN;
          float rough = triplanar(uRoughnessMap, p, blend).r;
          float ao = triplanar(uAOMap, p, blend).r;

          // Object space throughout, then turned into the world in one step —
          // the maps are fixed to the body, so this is the only place the two
          // frames have to meet.
          vec3 nObj = normalize(mix(gn, triplanarNormal(p, gn, blend), uRelief));
          vec3 N = normalize(uObjectToWorld * nObj);
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 L = normalize(uLight);

          float ndl = dot(N, L);
          // A real moon has almost no limb darkening — the regolith throws light
          // straight back at whoever lit it, so the disc is nearly as bright at
          // the edge as at the centre. A plain lambert gets this wrong in the
          // most recognisable way possible, so the cosine is flattened and the
          // terminator is put back by hand as a narrow band.
          float lit = smoothstep(-uTerminator, uTerminator, ndl);
          float diffuse = pow(max(ndl, 0.0), uFlatten) * lit;

          // The AO map is the crater floors and the rim shadows; it belongs to
          // the surface, not to the lighting, so it darkens both sides.
          float occlusion = mix(1.0, ao, uAO);

          vec3 face = albedo * uTint * diffuse;
          // Earthshine: the night side is not black, it is lit by the planet
          // behind the lens. Tiny, and entirely what stops the dark limb from
          // reading as a bite out of the disc.
          face += albedo * uTint * uEarthshine * (1.0 - lit);

          // A wide, weak sheen off the smoother patches. The surface is dust and
          // nothing on it is glossy, so this only exists to keep the roughness
          // map's variation from being invisible.
          vec3 H = normalize(L + V);
          float gloss = 1.0 - rough;
          face += uTint * uSheen * gloss * pow(max(dot(N, H), 0.0), mix(4.0, 48.0, gloss)) * lit;

          face *= occlusion * uBrightness;

          // The limb is read through the same glare as everything around it, so
          // it is faded rather than cut — a hard rim on a body this bright reads
          // as a decal pasted over the sky.
          float ndv = dot(normalize(vWorldNormal), V);
          float alpha = smoothstep(0.0, max(uEdge, 1e-3), ndv) * uOpacity;

          gl_FragColor = vec4(face, alpha);
        }
      `
    });

    // 96×64 is about a degree of arc per quad at the size this is drawn — fine
    // enough that the displaced silhouette is a ragged edge rather than a
    // polygon, and 6k vertices is nothing.
    this.mesh = new Mesh(new SphereGeometry(1, 96, 64), this.material);
    this.mesh.name = 'Moon';
    this.mesh.frustumCulled = false;
    // Just after the sky (-1000) and before every opaque surface, with no depth
    // written: it cannot occlude the world, and the world overdraws it.
    this.mesh.renderOrder = -999;
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;

    /** Set once the five maps are in; nothing draws before that. */
    this.ready = false;
    this._textures = null;

    // Parked on the camera here rather than in the frame loop, for the same
    // reason the sky is: the shadow and contact passes draw through cameras that
    // never tell the app where they are.
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      const far = Math.max(camera.far ?? 400, 10);
      // Well inside the far plane, and far enough out that the parallax across
      // an orbit of the rig is under a pixel.
      const distance = far * 0.35;
      this.mesh.position.copy(camera.position).addScaledVector(_dir, distance);
      // Angular size is shared with the sky's glare: `discSize` is 1 - cos of
      // the half angle, so this is the radius that subtends exactly that.
      const half = Math.acos(1 - Math.min(Math.max(settings.sky.discSize, 1e-5), 0.5));
      const radius = distance * Math.tan(half);
      this.mesh.scale.setScalar(radius);
      this.mesh.updateMatrixWorld(true);

      // The rotation alone, with the uniform scale divided back out — the
      // fragment stage needs it and cannot see `modelMatrix`.
      this.uniforms.uObjectToWorld.value
        .setFromMatrix4(this.mesh.matrixWorld)
        .multiplyScalar(1 / Math.max(radius, 1e-6));
    };
  }

  /** Whether this is the moon on screen — i.e. whether `Sky` should stand down. */
  get active() {
    return this.ready && settings.sky.moon.geometry === true;
  }

  /**
   * Fetch the surface material.
   *
   * Called once from `App#load`, before the shader warm-up, so the first frame
   * has a body in it rather than a pop a moment later.
   *
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   */
  async load(assets) {
    if (this.ready) return;
    try {
      const entries = await Promise.all(
        Object.entries(TEXTURES).map(async ([slot, url]) => [slot, await assets.loadTexture(url)])
      );

      this._textures = {};
      for (const [slot, texture] of entries) {
        // Triplanar reads run off the object position, which leaves every plane
        // long before it reaches 0..1 — so all three maps have to tile.
        texture.wrapS = RepeatWrapping;
        texture.wrapT = RepeatWrapping;
        texture.minFilter = LinearMipmapLinearFilter;
        texture.generateMipmaps = true;
        // TextureLoader assumes linear data; only the albedo is authored sRGB.
        if (slot === 'map') texture.colorSpace = SRGBColorSpace;
        this._textures[slot] = texture;
      }

      this.uniforms.uMap.value = this._textures.map;
      this.uniforms.uNormalMap.value = this._textures.normalMap;
      this.uniforms.uRoughnessMap.value = this._textures.roughnessMap;
      this.uniforms.uAOMap.value = this._textures.aoMap;
      this.uniforms.uHeightMap.value = this._textures.heightMap;
      this.material.needsUpdate = true;
      this.ready = true;
      // Shown here rather than waiting for the first `update`, because the warm-up
      // in `App#load` only walks what is *visible* — left hidden, this shader
      // would be the one thing compiling during the first frame instead of before
      // it, which is the stutter that pass exists to prevent.
      this.mesh.visible = this.active;
    } catch (error) {
      console.warn('[Moon] could not load the surface maps — falling back to the sky disc', error);
      this.ready = false;
    }
  }

  /**
   * Re-read the settings, and re-aim.
   *
   * Runs *after* `Sky#update`, which is what writes `frame.uLightDir` — the
   * direction the body has to sit in. Reading it rather than resolving the
   * angles again is what keeps the disc inside the glare that was drawn for it.
   */
  update() {
    const m = settings.sky.moon;
    // Zero on either of the body's own two masters is off, not a black sphere
    // drawn over the stars.
    this.mesh.visible =
      settings.sky.enabled && this.active && settings.sky.disc > 0 && m.opacity > 0 && m.brightness > 0;
    if (!this.mesh.visible) return;

    _dir.copy(frame.uLightDir.value).normalize();

    // Face the camera's side of the body toward the camera, then turn it on that
    // axis — `spin` and `tilt` are only a seed for which stretch of ground is
    // pointed at the lens, since the material is the same everywhere.
    this.mesh.quaternion.setFromUnitVectors(_FORWARD, _dir);
    this.mesh.rotateY(m.tilt);
    this.mesh.rotateZ(m.spin);

    // Where its sun is. `phase` is measured from full — 0 puts the light behind
    // the lens and the whole face is lit; π/2 is a half moon lit from the side
    // the angle swings toward; π is new. `phaseTilt` lifts that sun above the
    // line of sight so the terminator leans instead of running dead vertical.
    _right.crossVectors(_WORLD_UP, _dir);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_dir, _right).normalize();

    const cp = Math.cos(m.phase);
    const sp = Math.sin(m.phase);
    const ct = Math.cos(m.phaseTilt);
    const st = Math.sin(m.phaseTilt);
    this.uniforms.uLight.value
      .copy(_dir)
      .multiplyScalar(-cp * ct)
      .addScaledVector(_right, sp * ct)
      .addScaledVector(_up, st)
      .normalize();

    const u = this.uniforms;
    u.uTint.value.copy(getColor(m.color));
    u.uBrightness.value = settings.sky.disc * Math.max(0, m.brightness ?? 1);
    u.uOpacity.value = Math.min(Math.max(m.opacity ?? 1, 0), 1);
    u.uTexScale.value = Math.max(0.05, m.textureScale);
    u.uBlendSharp.value = Math.max(1, m.blendSharpness);
    u.uDisplace.value = m.displacement;
    u.uRelief.value = m.relief;
    u.uAO.value = m.ao;
    u.uSheen.value = m.sheen;
    u.uTerminator.value = Math.max(0.001, m.terminator);
    u.uFlatten.value = Math.max(0.05, m.flatten);
    u.uEarthshine.value = m.earthshine;
    u.uEdge.value = m.edge;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    if (this._textures) {
      for (const texture of Object.values(this._textures)) texture.dispose();
      this._textures = null;
    }
  }
}
