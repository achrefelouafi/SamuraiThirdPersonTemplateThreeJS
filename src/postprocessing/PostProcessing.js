import { Vector2 } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GradeShader } from './GradeShader.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';

/** Resolution the bloom's mip chain is built at, against the frame. */
const BLOOM_SCALE = 0.5;

/**
 * The render pipeline: scene → bloom → tone map → grade.
 *
 * Everything before `OutputPass` is linear HDR; tone mapping and the sRGB
 * conversion happen there, and the grade pass runs after it in display space
 * (see GradeShader).
 */
export class PostProcessing {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.gl = renderer.gl;
    this.scene = scene;
    this.camera = camera;

    const size = this.gl.getSize(new Vector2());
    const pixelRatio = this.gl.getPixelRatio();
    frame.uCameraNear.value = camera.near;
    frame.uCameraFar.value = camera.far;
    frame.uResolution.value.set(
      Math.floor(size.x * pixelRatio),
      Math.floor(size.y * pixelRatio)
    );

    this.composer = new EffectComposer(this.gl);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(size.x, size.y);
    this._applySamples();

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // Half resolution, on purpose. A bloom is a wide, low-frequency halo — at
    // `bloomRadius` 0.72 there is nothing in it a full-res mip chain resolves
    // that a half-res one does not — and UnrealBloom is five separable blurs
    // deep, so halving the side quarters the most expensive pass in the stack
    // for a difference nobody has ever picked out of a still.
    this.bloomPass = new UnrealBloomPass(
      new Vector2(Math.max(2, size.x * BLOOM_SCALE), Math.max(2, size.y * BLOOM_SCALE)),
      settings.post.bloomStrength,
      settings.post.bloomRadius,
      settings.post.bloomThreshold
    );
    this.composer.addPass(this.bloomPass);

    // Tone mapping + sRGB conversion happen here.
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this.gradePass = new ShaderPass(GradeShader);
    this.gradePass.renderToScreen = true;
    this.composer.addPass(this.gradePass);
  }

  /**
   * Push settings values into the passes. Called once per frame.
   *
   * @param {number} elapsed
   * @param {typeof settings.post} [look] the grade block in force — the play
   *   stage's by default, the character screen's while that screen is up. Same
   *   fields either way; nothing here is cached between frames, so swapping the
   *   object swaps the look on the next one.
   */
  sync(elapsed, look = settings.post) {
    const post = look;

    this._applySamples();
    this.bloomPass.strength = post.bloomStrength;
    this.bloomPass.radius = post.bloomRadius;
    this.bloomPass.threshold = post.bloomThreshold;
    this.bloomPass.enabled = post.enabled && post.bloomStrength > 0.001;

    const u = this.gradePass.uniforms;
    u.uTime.value = elapsed;
    u.uAberration.value = post.enabled ? post.chromaticAberration : 0;
    u.uVignette.value = post.enabled ? post.vignette : 0;
    u.uContrast.value = post.enabled ? post.contrast : 1;
    u.uSaturation.value = post.enabled ? post.saturation : 1;
    u.uTemperature.value = post.enabled ? post.temperature : 0;
    u.uLift.value = post.lift;
    u.uGain.value = post.gain;
    u.uGrain.value = post.enabled ? post.grain : 0;
  }

  /**
   * Point the pipeline at a different scene and camera.
   *
   * The character screen is a second scene rather than a second composer: bloom,
   * tone mapping and the grade are the same passes at the same resolution, and
   * rebuilding them per mode would cost a render-target churn on every switch
   * for no difference on screen.
   */
  setView(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
  }

  render() {
    this.composer.render();
    this.gl.setRenderTarget(null);
  }

  /**
   * Multisampling on the composer's own targets.
   *
   * The scene is drawn into a render target, not into the canvas, so the
   * renderer's `antialias` flag never touches it (see `core/Renderer.js`) —
   * this is the only place edge aliasing can be answered. Without it, every
   * rock silhouette and every ridge line against the sky crawls as the camera
   * moves, which reads as a fringe of noise rather than as aliasing.
   *
   * Live, because it is also the most expensive thing in the pipeline: the
   * whole chain writes to these targets, so 4× samples is 4× the write
   * bandwidth on all of it. Drop `post.samples` to 2, or to 0, to buy it back.
   */
  _applySamples() {
    const samples = Math.max(0, Math.round(settings.post.samples ?? 0));
    if (samples === this._samples) return;
    this._samples = samples;
    this.composer.renderTarget1.samples = samples;
    this.composer.renderTarget2.samples = samples;
    // The targets are only reallocated on a size change, so nudge them.
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
  }

  setSize(width, height, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.bloomPass.setSize(
      Math.max(2, width * BLOOM_SCALE),
      Math.max(2, height * BLOOM_SCALE)
    );
    frame.uResolution.value.set(
      Math.floor(width * pixelRatio),
      Math.floor(height * pixelRatio)
    );
  }

  dispose() {
    this.composer.dispose();
  }
}
