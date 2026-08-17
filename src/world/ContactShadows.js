import {
  Group,
  Mesh,
  PlaneGeometry,
  MeshBasicMaterial,
  MeshDepthMaterial,
  ShaderMaterial,
  OrthographicCamera,
  WebGLRenderTarget,
  Color
} from 'three';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { terrainGLSL } from '../shaders/lib/terrain.glsl.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/**
 * Subdivisions of the catcher when it has a height field to lie on. A blob a
 * couple of metres across over hills this size needs very little.
 */
const CATCHER_SEGMENTS = 12;

/**
 * Soft contact shadows.
 *
 * Cascaded shadow maps handle the sun, but they cannot resolve the tight,
 * ambient-occlusion-like darkening right under the character's feet. This
 * renders the character's depth from below into a small render target, blurs it
 * twice and projects it onto the ground — the standard "contact shadow" trick,
 * costing three 256px passes per frame.
 */
export class ContactShadows {
  /**
   * @param {import('../core/Renderer.js').Renderer} renderer
   * @param {object} [options]
   * @param {() => number} [options.getStrength] where the opacity is read from,
   *   so a second stage can drive its own catcher from its own settings block.
   * @param {import('./Terrain.js').Terrain} [options.terrain] the height field
   *   to lie on. Without one the catcher stays a flat quad, which is what the
   *   studio set wants.
   */
  constructor(
    renderer,
    {
      size = 5.5,
      resolution = 256,
      height = 3.2,
      blur = 2.4,
      terrain = null,
      getStrength = () => settings.environment.contactShadow
    } = {}
  ) {
    this.renderer = renderer;
    this.size = size;
    this.blurAmount = blur;
    this.terrain = terrain;
    this.getStrength = getStrength;

    this.group = new Group();
    /** Lifted clear of the floor so the catcher never z-fights it. */
    this.lift = 0.015;
    this.group.position.y = this.lift;
    this.uniforms = { uCatcherLift: { value: this.lift } };

    this.renderTarget = new WebGLRenderTarget(resolution, resolution);
    this.renderTarget.texture.generateMipmaps = false;
    this.renderTargetBlur = new WebGLRenderTarget(resolution, resolution);
    this.renderTargetBlur.texture.generateMipmaps = false;

    const segments = terrain ? CATCHER_SEGMENTS : 1;
    const planeGeometry = new PlaneGeometry(size, size, segments, segments).rotateX(Math.PI / 2);

    const catcherMaterial = new MeshBasicMaterial({
      map: this.renderTarget.texture,
      transparent: true,
      opacity: getStrength(),
      depthWrite: false,
      toneMapped: false
    });
    if (terrain) this._patchCatcher(catcherMaterial);

    this.plane = new Mesh(planeGeometry, catcherMaterial);
    // Flip so the projected texture matches the scene orientation.
    this.plane.scale.y = -1;
    this.plane.renderOrder = 1;
    this.plane.layers.set(LAYER.WORLD);
    this.group.add(this.plane);

    this.shadowCamera = new OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, height);
    this.shadowCamera.rotation.x = Math.PI / 2;
    // Only objects explicitly flagged as contact-shadow casters (the character)
    // are captured — otherwise the floor would occlude itself.
    this.shadowCamera.layers.set(LAYER.CONTACT);
    this.group.add(this.shadowCamera);

    // Full-screen quad for the two blur passes. It is rendered on its own (not
    // as part of the scene), but still through `shadowCamera` — so it has to
    // live on the camera's layer and sit inside its 0..height frustum, or the
    // blur silently draws nothing and the catcher ends up an opaque black
    // square. Parenting it to the group keeps it centred on the camera.
    this.blurPlane = new Mesh(planeGeometry);
    this.blurPlane.visible = false;
    this.blurPlane.position.y = height * 0.5;
    this.blurPlane.layers.set(LAYER.CONTACT);
    this.group.add(this.blurPlane);

    this.depthMaterial = new MeshDepthMaterial();
    this.depthMaterial.userData.darkness = { value: 0.8 };
    this.depthMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = this.depthMaterial.userData.darkness;
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform float darkness;\nvoid main() {')
        .replace(
          'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
          'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );'
        );
    };
    this.depthMaterial.depthTest = false;
    this.depthMaterial.depthWrite = false;

    this.horizontalBlur = new ShaderMaterial(HorizontalBlurShader);
    this.verticalBlur = new ShaderMaterial(VerticalBlurShader);
    this.horizontalBlur.depthTest = false;
    this.verticalBlur.depthTest = false;

    this._clearColor = new Color();
  }

  /**
   * Lay the catcher on the height field instead of leaving it a flat quad.
   *
   * A blob two metres across on a 20° slope would otherwise sink half a metre
   * into the hill on the uphill side and hang in the air on the downhill one —
   * and since it depth-tests against the ground, the uphill half would simply be
   * cut off. Displacing it is the only version that reads as a shadow.
   *
   * The awkward part is the mesh's own `scale.y = -1` (see below), which negates
   * anything written into object-space Y. Dividing by the model matrix's Y scale
   * cancels it, and leaves this correct for an unflipped catcher too.
   */
  _patchCatcher(material) {
    patchOnBeforeCompile(material, (shader) => {
      Object.assign(shader.uniforms, this.terrain.uniforms, {
        uCatcherLift: this.uniforms.uCatcherLift
      });
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>\nuniform float uCatcherLift;\n${terrainGLSL}`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           {
             vec4 catcherWorld = modelMatrix * vec4(position, 1.0);
             float target = terrainHeightAt(catcherWorld.xz) + uCatcherLift;
             transformed.y += (target - catcherWorld.y) / modelMatrix[1][1];
           }`
        );
    });
    material.customProgramCacheKey = () => 'contact-catcher-terrain';
  }

  /**
   * Keep the shadow catcher under the character.
   *
   * @param {number} x world X
   * @param {number} z world Z
   * @param {number} [y] the ground height there. Only the group's placement —
   *   the catcher's *shape* comes from the height field itself when it has one.
   */
  setPosition(x, z, y = 0) {
    this.group.position.set(x, y + this.lift, z);
  }

  render(scene) {
    const gl = this.renderer.gl;
    const strength = this.getStrength();
    this.plane.material.opacity = strength;
    if (strength <= 0.001) return;

    const previousBackground = scene.background;
    const previousOverride = scene.overrideMaterial;
    const previousAutoClear = gl.autoClear;
    gl.getClearColor(this._clearColor);
    const previousAlpha = gl.getClearAlpha();

    scene.background = null;
    scene.overrideMaterial = this.depthMaterial;
    this.plane.visible = false;
    gl.autoClear = true;

    gl.setRenderTarget(this.renderTarget);
    // Clear to *transparent* black: the catcher plane samples this texture
    // directly, so an opaque clear would paint a black square on the ground.
    // The blur passes below inherit the same clear for the same reason.
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(scene, this.shadowCamera);

    scene.overrideMaterial = previousOverride;
    this._blur(this.blurAmount);
    this._blur(this.blurAmount * 0.35);
    gl.setClearColor(this._clearColor, previousAlpha);

    gl.setRenderTarget(null);
    gl.autoClear = previousAutoClear;
    scene.background = previousBackground;
    this.plane.visible = true;
  }

  _blur(amount) {
    const gl = this.renderer.gl;

    this.blurPlane.visible = true;

    this.blurPlane.material = this.horizontalBlur;
    this.horizontalBlur.uniforms.tDiffuse.value = this.renderTarget.texture;
    this.horizontalBlur.uniforms.h.value = (amount * 1) / 256;
    gl.setRenderTarget(this.renderTargetBlur);
    gl.render(this.blurPlane, this.shadowCamera);

    this.blurPlane.material = this.verticalBlur;
    this.verticalBlur.uniforms.tDiffuse.value = this.renderTargetBlur.texture;
    this.verticalBlur.uniforms.v.value = (amount * 1) / 256;
    gl.setRenderTarget(this.renderTarget);
    gl.render(this.blurPlane, this.shadowCamera);

    this.blurPlane.visible = false;
  }

  dispose() {
    this.renderTarget.dispose();
    this.renderTargetBlur.dispose();
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.depthMaterial.dispose();
    this.horizontalBlur.dispose();
    this.verticalBlur.dispose();
  }
}
