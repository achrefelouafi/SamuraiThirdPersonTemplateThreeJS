import GUI from 'lil-gui';
import { settings } from '../config/settings.js';
import { LITTER_CELLS } from '../world/LeafLitter.js';
import { PresetManager } from './PresetManager.js';

/**
 * Real-time stage editor.
 *
 * Every control binds straight to a field in `config/settings.js`. Because the
 * lights, the floor shader, the dust, the camera rig and the post stack all
 * *read* those fields each frame, no controller needs an onChange handler:
 * moving a slider re-lights the scene on the next frame, with no rebuild and no
 * shader recompilation.
 *
 * That holds while the clock is paused (`P`) — which is the point, since the
 * pose worth lighting is usually a frozen one. The two exceptions are noted
 * where they occur: the floor's stone maps flip a shader define, and the
 * character's scale is resolved once at load.
 */
export class Editor {
  /**
   * @param {object} hooks { onToast, getWeaponFire, onRespawnEnemies, onCastJudgement }
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.presets = new PresetManager();

    this.gui = new GUI({ title: 'Stage Editor', width: 330 });
    this.gui.domElement.style.setProperty('--title-height', '30px');

    this._presetState = { name: 'My preset', selected: this.presets.names[0] ?? '' };
    this._hidden = false;

    this._buildPresets();
    this._buildEnvironment();
    this._buildAir();
    this._buildTerrain();
    this._buildLeaves();
    this._buildFire();
    this._buildShadowCharacter();
    this._buildJudgement();
    this._buildFlight();
    this._buildPost();
    this._buildCamera();
    this._buildCharacter();
    this._buildLocomotion();
    this._buildCombat();
    this._buildStudio();

    // Everything starts collapsed, top-level folders included: the panel opens
    // as a list of sections and the user picks one.
    this.gui.foldersRecursive().forEach((folder) => folder.close());
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  static range(folder, object, key, min, max, step, label) {
    return folder.add(object, key, min, max, step).name(label ?? key);
  }

  /** Re-read every control from settings — after a preset load or a reset. */
  refresh() {
    this.gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
  }

  toggle() {
    this._hidden = !this._hidden;
    this.gui.show(!this._hidden);
  }

  /* ------------------------------------------------------------------ */
  /* folders                                                             */
  /* ------------------------------------------------------------------ */

  _buildPresets() {
    const folder = this.gui.addFolder('Presets');
    const state = this._presetState;

    let selector = folder
      .add(state, 'selected', this.presets.names.length ? this.presets.names : [''])
      .name('preset');

    // lil-gui rebuilds the controller when the option list changes, so the
    // reference has to be replaced rather than mutated.
    const refreshOptions = () => {
      const names = this.presets.names;
      selector = selector.options(names.length ? names : ['']).name('preset');
      selector.setValue(names.includes(state.selected) ? state.selected : (names[0] ?? ''));
    };

    folder.add(state, 'name').name('name');

    folder
      .add(
        {
          save: () => {
            this.presets.save(state.name);
            state.selected = state.name;
            refreshOptions();
            this.hooks.onToast?.(`Saved preset "${state.name}"`);
          }
        },
        'save'
      )
      .name('Save preset');

    folder
      .add(
        {
          load: () => {
            if (this.presets.load(state.selected)) {
              this.refresh();
              this.hooks.onToast?.(`Loaded "${state.selected}"`);
            }
          }
        },
        'load'
      )
      .name('Load preset');

    folder
      .add(
        {
          duplicate: () => {
            const copy = this.presets.duplicate(state.selected);
            if (copy) {
              state.selected = copy;
              refreshOptions();
              this.hooks.onToast?.(`Duplicated to "${copy}"`);
            }
          }
        },
        'duplicate'
      )
      .name('Duplicate');

    folder
      .add(
        {
          remove: () => {
            if (this.presets.remove(state.selected)) {
              refreshOptions();
              this.hooks.onToast?.('Preset deleted');
            }
          }
        },
        'remove'
      )
      .name('Delete');

    folder
      .add({ exportOne: () => this.presets.exportJSON() }, 'exportOne')
      .name('Export current (JSON)');
    folder.add({ exportAll: () => this.presets.exportAll() }, 'exportAll').name('Export all presets');

    folder
      .add(
        {
          import: async () => {
            const result = await this.presets.importFromFile();
            refreshOptions();
            this.refresh();
            this.hooks.onToast?.(
              result.applied
                ? 'Settings imported'
                : result.imported.length
                  ? `Imported ${result.imported.length} preset(s)`
                  : 'Nothing imported'
            );
          }
        },
        'import'
      )
      .name('Import JSON…');

    folder
      .add(
        {
          reset: () => {
            this.presets.reset();
            this.refresh();
            this.hooks.onToast?.('Reset to defaults');
          }
        },
        'reset'
      )
      .name('Reset to defaults');

    this.presetFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  _buildEnvironment() {
    const folder = this.gui.addFolder('Environment');
    const e = settings.environment;
    const R = Editor.range;

    // The key and the rim are the character's own lights. three cannot exclude
    // an object from a light, so the world's surfaces are patched to drop every
    // directional light instead — see `Environment#excludeFromKeyLights`. Off,
    // and the pair go back to lighting the whole landscape.
    folder.add(e, 'keyCharacterOnly').name('key & rim: character only');
    R(folder, e, 'sunIntensity', 0, 8, 0.01, 'key intensity');
    folder.addColor(e, 'sunColor').name('key colour');
    R(folder, e, 'sunAzimuth', 0, Math.PI * 2, 0.01, 'key azimuth');
    R(folder, e, 'sunElevation', 0.05, 1.5, 0.01, 'key elevation');
    R(folder, e, 'ambientIntensity', 0, 3, 0.01, 'ambient');
    folder.addColor(e, 'ambientColor').name('ambient colour');
    R(folder, e, 'hemiIntensity', 0, 3, 0.01, 'hemisphere');
    R(folder, e, 'envIntensity', 0, 3, 0.01, 'env (IBL)');
    R(folder, e, 'shadowRadius', 0, 8, 0.05, 'shadow softness');
    R(folder, e, 'shadowBias', -0.01, 0.001, 0.0001, 'shadow bias');
    // The pair the character screen has always had and this one did not. Bias
    // works in depth and has to be re-dialled whenever `shadow box` moves; the
    // normal bias is in metres of world and does not. Speckle on a lit surface
    // wants this one raised, a shadow detaching from its feet wants it lowered.
    R(folder, e, 'shadowNormalBias', 0, 0.15, 0.001, 'shadow normal bias');
    R(folder, e, 'contactShadow', 0, 1.5, 0.01, 'contact shadow');
    // Half-width of the sun's shadow box. Bigger reaches further out for
    // casters and costs sharpness — the map is a fixed 4096², so this is
    // metres per texel in disguise. The distance below only has to be far
    // enough up-sun to clear the canopy; at a low elevation that is a long way.
    R(folder, e, 'shadowExtent', 12, 120, 1, 'shadow box (m)');
    R(folder, e, 'shadowDistance', 40, 400, 5, 'sun distance (m)');

    const rim = folder.addFolder('Rim light');
    R(rim, e, 'rimIntensity', 0, 4, 0.01, 'rim intensity');
    rim.addColor(e, 'rimColor').name('rim colour');
    R(rim, e, 'rimAzimuth', 0, Math.PI * 2, 0.01, 'rim azimuth');
    R(rim, e, 'rimElevation', 0.05, 1.5, 0.01, 'rim elevation');
    rim.addColor(e, 'hemiSkyColor').name('hemi sky');
    rim.addColor(e, 'hemiGroundColor').name('hemi bounce');

    // `tiled surface` flips USE_MAP, so it costs one shader recompile — fine for
    // an editor toggle, and free while it stays put. Switching sets downloads
    // the other one the first time it is picked.
    const floor = folder.addFolder('Stage floor');
    floor.add(e, 'floorTexture').name('tiled surface');
    floor.add(e, 'floorTextureSet', ['terrain', 'stone']).name('surface');
    R(floor, e, 'floorTextureScale', 0.5, 24, 0.1, 'tile size (m)');
    R(floor, e, 'floorNormalScale', 0, 3, 0.01, 'relief strength');
    R(floor, e, 'floorTexTint', 0, 1, 0.01, 'tint toward floor');
    floor.addColor(e, 'floorColor').name('floor colour');
    floor.addColor(e, 'floorTint').name('floor tint');
    R(floor, e, 'floorRoughness', 0.05, 1, 0.01, 'roughness');
    R(floor, e, 'floorSheen', 0, 1, 0.01, 'sheen');
    R(floor, e, 'floorPool', 0, 1, 0.01, 'light pool');
  }

  /* ------------------------------------------------------------------ */

  /**
   * Haze, sky and ground mist — one look, in one folder.
   *
   * They are together because they cannot be tuned apart. The sky's horizon *is*
   * the haze colour (bound by identity, which is why there is no control for it
   * under Sky); the mist is lit from the same moon direction the haze glows
   * along, and the moon's own angles live under Sky; and the ground fog's job is
   * to sit in front of a distance the haze has already dissolved. Move one and
   * the others are suddenly wrong.
   */
  _buildAir() {
    const folder = this.gui.addFolder('Air, sky & fog');
    const R = Editor.range;

    const h = settings.haze;
    const haze = folder.addFolder('Distance haze');
    haze.add(h, 'enabled').name('haze enabled');
    haze.addColor(h, 'color').name('haze colour');
    haze.addColor(h, 'sunColor').name('into-moon colour');
    // 1/m, so the number itself means very little; the readout under it is what
    // you actually aim.
    R(haze, h, 'density', 0, 0.03, 0.0002, 'distance haze (1/m)');
    R(haze, h, 'start', 0, 40, 0.5, 'clear air (m)');
    haze
      .add(
        {
          get halfAt() {
            const d = settings.haze.density;
            return d > 1e-5 ? Math.round(Math.LN2 / d + settings.haze.start) : 9999;
          }
        },
        'halfAt'
      )
      .name('half hidden at (m)')
      .listen()
      .disable();
    // The layer that pools in the hollows. `mist floor` is the world height it
    // sits on and `mist depth` is how fast it thins going up — between them
    // they decide whether it is a ground effect or a wall.
    R(haze, h, 'ground', 0, 0.12, 0.001, 'ground mist (1/m)');
    R(haze, h, 'base', -12, 12, 0.1, 'mist floor (m)');
    R(haze, h, 'falloff', 0.5, 40, 0.1, 'mist depth (m)');
    // How far the air goes toward the moon's colour looking down the beam. The
    // highest-value control in this folder: at 0 the haze is a flat wash from
    // every angle, which is the one thing real air never is.
    R(haze, h, 'inscatter', 0, 1, 0.01, 'moon inscatter');
    R(haze, h, 'sunPower', 1, 24, 0.1, 'inscatter tightness');
    R(haze, h, 'max', 0, 1, 0.01, 'haze ceiling');

    const s = settings.sky;
    const sky = folder.addFolder('Sky');
    sky.add(s, 'enabled').name('sky enabled');
    sky.addColor(s, 'zenith').name('zenith');
    R(sky, s, 'gradient', 0.1, 3, 0.01, 'gradient');
    R(sky, s, 'sunGlow', 0, 12, 0.05, 'moon glare');
    R(sky, s, 'sunGlowPower', 1, 60, 0.5, 'glare tightness');
    R(sky, s, 'broadGlow', 0, 3, 0.01, 'broad wash');
    R(sky, s, 'exposure', 0, 3, 0.01, 'sky exposure');

    // The moon. `disc size` is 1 - cos of the half-angle, so the numbers look
    // small — 0.006 is about six degrees across, which is a dozen times life
    // size and exactly what the reference is.
    const moon = sky.addFolder('Moon');
    // Where it hangs — and the world's one light direction with it: the sky's
    // glare, the haze's inscatter lobe and the mist's lit side all resolve from
    // this pair (`Sky#_placeMoon` writes `frame.uLightDir`). The character's key
    // is a *different* angle, over in Environment.
    //
    // Elevation is capped low on purpose. The rig cannot aim much above 30°
    // (`camera.maxPolar`), so a moon parked higher than this is off the top of
    // the frame and only its glare is ever on screen — which is exactly why it
    // used to be invisible at the old 0.72.
    R(moon, s.moon, 'azimuth', 0, Math.PI * 2, 0.01, 'rotation (azimuth)');
    R(moon, s.moon, 'elevation', -0.05, 0.6, 0.005, 'elevation');
    R(moon, s, 'disc', 0, 40, 0.1, 'brightness');
    R(moon, s, 'discSize', 0.0005, 0.05, 0.0005, 'size');
    moon.addColor(s.moon, 'color').name('colour');

    // The body — a displaced sphere wearing a real lunar surface material
    // (`world/Moon.js`). Off, and the sky goes back to drawing the disc itself,
    // which is the only thing the two `maria` sliders at the bottom still feed.
    const body = moon.addFolder('Surface');
    body.add(s.moon, 'geometry').name('textured body');
    // The body's own two masters. `brightness` above is `sky.disc`, which is
    // also the glare's and what the haze's lobe is sized against — these two
    // are the ones to reach for when the sphere itself is too hot or too solid,
    // because they move it and nothing else. Both at 1 is untouched.
    R(body, s.moon, 'brightness', 0, 3, 0.01, 'body brightness');
    R(body, s.moon, 'opacity', 0, 1, 0.01, 'body opacity');
    // The one control here that changes the picture rather than the finish:
    // where the moon's *own* sun is, from full through half to new.
    R(body, s.moon, 'phase', 0, Math.PI, 0.01, 'phase (full → new)');
    R(body, s.moon, 'phaseTilt', -1.2, 1.2, 0.01, 'phase tilt');
    R(body, s.moon, 'terminator', 0.005, 0.5, 0.005, 'terminator softness');
    R(body, s.moon, 'flatten', 0.1, 2, 0.01, 'limb flatness');
    R(body, s.moon, 'earthshine', 0, 0.4, 0.005, 'earthshine');
    R(body, s.moon, 'edge', 0.001, 0.4, 0.001, 'limb fade');
    R(body, s.moon, 'displacement', 0, 0.25, 0.005, 'relief (geometry)');
    R(body, s.moon, 'relief', 0, 1, 0.01, 'relief (normals)');
    R(body, s.moon, 'ao', 0, 1, 0.01, 'crater shadow (AO)');
    R(body, s.moon, 'sheen', 0, 0.5, 0.005, 'sheen');
    R(body, s.moon, 'textureScale', 0.2, 6, 0.05, 'crater scale');
    R(body, s.moon, 'blendSharpness', 1, 16, 0.5, 'projection blend');
    R(body, s.moon, 'tilt', -Math.PI, Math.PI, 0.01, 'face tilt');
    R(body, s.moon, 'spin', -Math.PI, Math.PI, 0.01, 'face spin');

    // Fallback disc only: with the body up, `Sky` is not drawing a disc at all.
    R(moon, s.moon, 'detail', 0, 1, 0.01, 'maria (disc only)');
    R(moon, s.moon, 'detailScale', 1, 24, 0.1, 'maria size (disc only)');

    // One hash per lattice cell, so the whole sky of them is about the price of
    // a single texture lookup. `density` is cells per unit direction: up packs
    // more in and shrinks each one.
    const stars = sky.addFolder('Stars');
    const st = s.stars;
    stars.add(st, 'enabled').name('stars enabled');
    R(stars, st, 'density', 40, 600, 5, 'density');
    R(stars, st, 'brightness', 0, 6, 0.05, 'brightness');
    R(stars, st, 'twinkle', 0, 1, 0.01, 'twinkle');
    R(stars, st, 'horizon', 0, 0.6, 0.01, 'gone below (sin elev)');

    this._buildGroundFog(folder);
  }

  /**
   * The mist that rolls over the ground — see `world/GroundFog.js`.
   *
   * A sub-folder of the air rather than a folder of its own, because it is the
   * near half of the same effect: the haze above dissolves the distance, and
   * this puts something between you and it that has a shape and moves.
   *
   * Everything here is live. `count` is the only control that touches a buffer,
   * and even that only reveals or hides slots that were allocated at boot — the
   * mist never rebuilds.
   */
  _buildGroundFog(parent) {
    const folder = parent.addFolder('Ground fog (emitter)');
    const f = settings.groundFog;
    const R = Editor.range;

    folder.add(f, 'enabled').name('enabled');
    // Density is `count` against `life`: a slot respawns the instant it dies, so
    // the emitter is releasing count/life puffs a second. `count` is also the
    // fill-rate dial — it is the first thing to turn down if the frame is tight.
    R(folder, f, 'count', 0, 512, 1, 'puffs (cost)');
    R(folder, f, 'life', 1, 60, 0.5, 'life (s)');
    R(folder, f, 'lifeVariance', 0, 0.95, 0.01, 'life spread');
    R(folder, f, 'opacity', 0, 1, 0.01, 'opacity');

    // Where it comes from. `follow` parks the emitter on the character, which is
    // what keeps mist around the camera on an endless floor; off, x/z are a
    // fixed world position and the bank stays in the hollow you put it in.
    const emitter = folder.addFolder('Emitter');
    emitter.add(f, 'follow').name('follow character');
    R(emitter, f, 'x', -200, 200, 0.5, 'x / offset X (m)');
    R(emitter, f, 'z', -200, 200, 0.5, 'z / offset Z (m)');
    R(emitter, f, 'radius', 0, 120, 0.5, 'spawn radius (m)');
    // The hole kept clear around the lens. Nothing else in this panel can fix a
    // puff sitting between you and the character: raise this until the closest
    // mist is behind the camera's own distance to them.
    R(emitter, f, 'nearFade', 0, 40, 0.25, 'clear of camera (m)');
    R(emitter, f, 'nearFadeRange', 0.5, 40, 0.25, 'clear ramp (m)');

    const drift = folder.addFolder('Drift');
    R(drift, f, 'windX', -8, 8, 0.05, 'wind X (m/s)');
    R(drift, f, 'windZ', -8, 8, 0.05, 'wind Z (m/s)');
    R(drift, f, 'rise', -1, 2, 0.01, 'rise (m/s)');
    R(drift, f, 'hover', -1, 8, 0.05, 'hover above ground (m)');
    R(drift, f, 'swirl', 0, 8, 0.05, 'wander (m)');
    R(drift, f, 'swirlSpeed', 0, 1.5, 0.01, 'wander speed');
    R(drift, f, 'spin', 0, 1, 0.005, 'roll (rad/s)');

    const look = folder.addFolder('Look');
    R(look, f, 'sizeStart', 0.2, 40, 0.1, 'size at birth (m)');
    R(look, f, 'sizeEnd', 0.2, 60, 0.1, 'size at death (m)');
    look.addColor(f, 'color').name('mist colour');
    look.addColor(f, 'litColor').name('into-moon colour');
    R(look, f, 'moonlight', 0, 1.5, 0.01, 'moonlight');
    R(look, f, 'moonPower', 0.5, 12, 0.1, 'moonlight tightness');
    R(look, f, 'softness', 0.02, 1, 0.01, 'edge softness');
    R(look, f, 'fadeIn', 0.01, 0.9, 0.01, 'fade in (of life)');
    R(look, f, 'fadeOut', 0.01, 0.9, 0.01, 'fade out (of life)');
    // What hides the line where a billboard crosses the terrain. Too small and
    // the cut shows; too large and the mist floats off the ground.
    R(look, f, 'groundFade', 0.05, 8, 0.05, 'dissolve into ground (m)');
    R(look, f, 'detail', 0, 1, 0.01, 'noise breakup');
    R(look, f, 'detailScale', 0.5, 12, 0.1, 'breakup size');
  }

  /* ------------------------------------------------------------------ */

  /**
   * The shape of the ground — see `world/Terrain.js`.
   *
   * Every control here is a shader uniform read by the floor *and* the CPU that
   * stands the character up, so the landscape can be redialled while walking
   * over it and the body keeps its feet on whatever comes out. The two that are
   * not free are called out below.
   */
  _buildTerrain() {
    const folder = this.gui.addFolder('Terrain');
    const t = settings.terrain;
    const R = Editor.range;

    folder.add(t, 'enabled').name('terrain enabled');
    R(folder, t, 'amplitude', 0, 20, 0.05, 'height (m)');
    R(folder, t, 'scale', 8, 200, 1, 'hill size (m)');
    // The one real cost dial: the floor evaluates this field five times per
    // vertex (the height and its normal), so an octave here is paid for by
    // every vertex of the grid.
    R(folder, t, 'octaves', 1, 6, 1, 'detail (cost)');
    R(folder, t, 'warp', 0, 2, 0.01, 'warp (valleys)');
    R(folder, t, 'ridge', 0, 1, 0.01, 'ridges');

    const shape = folder.addFolder('Fine shape');
    R(shape, t, 'lacunarity', 1.5, 3, 0.01, 'octave step');
    R(shape, t, 'gain', 0.2, 0.7, 0.01, 'octave falloff');
    R(shape, t, 'seed', 0, 60, 0.1, 'seed').listen();
    shape
      .add(
        {
          randomize: () => {
            t.seed = Math.random() * 60;
          }
        },
        'randomize'
      )
      .name('Randomise landscape');
    // The only control in this folder that rebuilds anything: it swaps the
    // floor's grid, which is a one-frame hitch and 400 m / segments of vertex
    // spacing. Below about 128 the hills go visibly faceted in silhouette.
    shape
      .add(t, 'segments', [64, 128, 192, 256, 384, 512, 768])
      .name('floor mesh detail')
      .onChange((value) => {
        this.hooks.onToast?.(`Floor grid: ${(400 / value).toFixed(2)} m between vertices`);
      });
  }

  /**
   * The litter on the floor and the leaves in the air — see `world/Leaves.js`.
   *
   * One folder, because they are one look: the sheet, the grade, the backlight
   * and the wind at the top are shared by both populations by identity, and only
   * the two sub-folders differ. Everything here is live — the one control that
   * recompiles is the coverage switch, and it is called out where it sits.
   *
   * The control worth reaching for first is `backlight`. Leaves are one cell
   * thick and they glow when the moon is behind them; at 0 they are opaque chips
   * and the whole field reads as stickers on the ground.
   */
  _buildLeaves() {
    const folder = this.gui.addFolder('Leaves');
    const g = settings.leaves;
    const R = Editor.range;

    folder.add(g, 'enabled').name('leaves enabled');
    R(folder, g, 'size', 0.02, 0.6, 0.005, 'leaf length (m)');
    R(folder, g, 'sizeVariance', 0, 0.9, 0.01, 'size spread');

    // The sheet is a daylight photograph of a green beech and this stage is a
    // blue night. Without this the leaves are the one summer-coloured thing in
    // the frame.
    const look = folder.addFolder('Grade & backlight');
    look.addColor(g, 'tint').name('tint toward');
    R(look, g, 'tintAmount', 0, 1, 0.01, 'tint amount');
    look.addColor(g, 'backlightColor').name('through-leaf colour');
    R(look, g, 'backlight', 0, 3, 0.01, 'backlight');
    R(look, g, 'backlightPower', 1, 24, 0.5, 'backlight tightness');
    R(look, g, 'roughness', 0.02, 1, 0.01, 'roughness');
    R(look, g, 'normalScale', 0, 3, 0.05, 'relief (normals)');

    // The cut-out. Lower is a fatter leaf and a rougher edge; the coverage
    // switch is what keeps that edge from crawling, and it is the only control
    // in this folder that recompiles. It does nothing until there is MSAA to
    // resolve against — raise `samples` under Post processing first.
    const cut = look.addFolder('Cut-out');
    R(cut, g, 'alphaTest', 0.05, 0.95, 0.01, 'alpha cutoff');
    cut
      .add(g, 'alphaToCoverage')
      .name('smooth edge (needs MSAA)')
      .onChange((value) => {
        if (value && (settings.post.samples ?? 0) === 0) {
          this.hooks.onToast?.('Smooth leaf edges need post → samples above 0');
        }
      });
    R(cut, g, 'atlasInset', 0, 0.15, 0.005, 'sheet inset');

    // One wind for both populations: it quivers the litter where it lies and
    // carries the leaves in the air, so a gust crosses the whole field at once.
    const wind = folder.addFolder('Wind');
    R(wind, g, 'windX', -8, 8, 0.05, 'wind X (m/s)');
    R(wind, g, 'windZ', -8, 8, 0.05, 'wind Z (m/s)');
    R(wind, g, 'gustSpeed', 0, 3, 0.01, 'gust speed');
    R(wind, g, 'gustScale', 0.005, 0.4, 0.005, 'gust size (rad/m)');
    R(wind, g, 'gustStrength', 0, 3, 0.01, 'gust strength');

    /* ---- the ground ---- */
    const l = g.litter;
    const litter = folder.addFolder('Litter (on the ground)');
    litter.add(l, 'enabled').name('litter enabled');
    // The two cost dials. Live like everything else — they only decide where
    // the leaves are laid out, so moving one re-lays the grid rather than
    // rebuilding a buffer. `perCell` × 400 is the leaf count.
    R(litter, l, 'perCell', 1, 20, 1, 'per cell (cost)');
    R(litter, l, 'field', 20, 120, 1, 'window (m)');
    litter
      .add(
        {
          get leaves() {
            return Math.round(settings.leaves.litter.perCell) * LITTER_CELLS * LITTER_CELLS;
          }
        },
        'leaves'
      )
      .name('leaves drawn')
      .listen()
      .disable();
    R(litter, l, 'hover', 0, 0.2, 0.002, 'float above floor (m)');
    R(litter, l, 'rustle', 0, 1, 0.01, 'wind quiver (rad)');
    // Keep `gone by` inside half the window, or the edge of the field itself
    // comes into view.
    R(litter, l, 'fadeStart', 2, 80, 0.5, 'erodes from (m)');
    R(litter, l, 'fadeEnd', 3, 100, 0.5, 'gone by (m)');

    // What a foot does to them. `push speed` is the dead band that stops the
    // leaves under a standing character boiling; `forward blend` is what turns
    // the throw from an explosion underneath you into a sweep.
    const push = litter.addFolder('Underfoot');
    R(push, l, 'pushRadius', 0.1, 3, 0.05, 'sweep radius (m)');
    R(push, l, 'pushLead', -1, 2, 0.05, 'sweep ahead of body (m)');
    R(push, l, 'pushForce', 0, 3, 0.01, 'force');
    R(push, l, 'pushLift', 0, 2, 0.01, 'lift');
    R(push, l, 'pushForward', 0, 1, 0.01, 'forward blend');
    R(push, l, 'pushSpeed', 0, 3, 0.05, 'moves at least (m/s)');
    R(push, l, 'pushBudget', 1, 200, 1, 'leaves per frame (cap)');

    // And what the wind does: a few a second come unstuck and skitter downwind.
    const skitter = litter.addFolder('Blown along');
    R(skitter, l, 'gustRate', 0, 60, 0.5, 'lifted per second');
    R(skitter, l, 'gustForce', 0, 3, 0.01, 'force');
    R(skitter, l, 'gustLift', 0, 2, 0.01, 'lift');
    R(skitter, l, 'gustSpread', 0, 3.2, 0.05, 'fan (rad)');

    // The flight itself. The swirl and the spin both die out exactly as the leaf
    // lands, which is what makes the landing place computable — and that is what
    // lets a leaf be kicked again from where it came down.
    const flight = litter.addFolder('Flight');
    R(flight, l, 'flight', 0.1, 5, 0.05, 'flight (s)');
    R(flight, l, 'drag', 0.1, 8, 0.05, 'drag');
    R(flight, l, 'swirl', 0, 1.5, 0.01, 'swirl (m)');
    R(flight, l, 'swirlSpeed', 0, 20, 0.1, 'swirl speed');
    R(flight, l, 'spin', 0, 60, 0.5, 'tumble (rad/s)');

    /* ---- the air ---- */
    const d = g.drift;
    const drift = folder.addFolder('Drift (in the air)');
    drift.add(d, 'enabled').name('drift enabled');
    R(drift, d, 'count', 0, 1024, 1, 'leaves (cost)');
    R(drift, d, 'radius', 2, 90, 0.5, 'spawn radius (m)');
    R(drift, d, 'life', 2, 60, 0.5, 'life (s)');
    R(drift, d, 'lifeVariance', 0, 0.9, 0.01, 'life spread');
    R(drift, d, 'heightMin', 0, 20, 0.1, 'born from (m)');
    R(drift, d, 'heightMax', 0, 40, 0.1, 'born to (m)');
    R(drift, d, 'sizeScale', 0.1, 4, 0.05, 'size against litter');

    // The glide. A leaf is a wing: it does not drop, it swings across its own
    // fall, and this pair is most of why these read as leaves.
    const fall = drift.addFolder('Fall & flutter');
    R(fall, d, 'fall', 0, 4, 0.01, 'sink (m/s)');
    R(fall, d, 'flutter', 0, 3, 0.01, 'swing (m)');
    R(fall, d, 'flutterSpeed', 0, 8, 0.05, 'swing speed');
    R(fall, d, 'tumble', 0, 4, 0.01, 'turn over');
    R(fall, d, 'yawDrift', 0, 3, 0.01, 'yaw drift (rad/s)');
    // What makes one land instead of stopping dead on its edge.
    R(fall, d, 'settle', 0.05, 5, 0.05, 'flatten over (m)');
    R(fall, d, 'hover', 0, 0.3, 0.005, 'rests above floor (m)');

    const seen = drift.addFolder('Fade');
    R(seen, d, 'fadeIn', 0.005, 0.5, 0.005, 'in (of life)');
    R(seen, d, 'fadeOut', 0.005, 0.6, 0.005, 'out (of life)');
    R(seen, d, 'fadeStart', 2, 90, 0.5, 'erodes from (m)');
    R(seen, d, 'fadeEnd', 3, 120, 0.5, 'gone by (m)');
    // Nothing else can fix a leaf sitting on the lens.
    R(seen, d, 'nearFade', 0, 6, 0.05, 'clear of camera (m)');
    R(seen, d, 'nearFadeRange', 0.05, 6, 0.05, 'clear ramp (m)');
  }

  /**
   * The burning katana — see `vfx/WeaponFire.js`.
   *
   * The box block is the aim and everything under it is the look. Those box
   * numbers are shared with the gizmo in the character screen, so they are
   * `listen()`ed: dragging the volume against the body moves these sliders, and
   * typing here moves the volume. `Refit` throws both away and puts the box back
   * around the whole weapon.
   */
  _buildFire() {
    const folder = this.gui.addFolder('Katana fire');
    const f = settings.fire;
    const R = Editor.range;
    const weapon = () => this.hooks.getWeaponFire?.() ?? null;

    folder.add(f, 'enabled').name('enabled');
    R(folder, f, 'intensity', 0, 3, 0.01, 'intensity');

    // What is alight. `faces` is the count the box is currently keeping — the
    // fastest way to tell a box that missed the blade from one that is simply
    // pointed somewhere dark.
    const box = folder.addFolder('Emitter box');
    const b = f.box;
    box.add(b, 'show').name('show wireframe').listen();
    box.add(b, 'autoFit').name('auto-fit on equip');
    box
      .add(
        {
          refit: () => {
            const fire = weapon();
            this.hooks.onToast?.(
              fire?.refit() ? 'Fire box refitted to the weapon' : 'No weapon equipped'
            );
          }
        },
        'refit'
      )
      .name('Refit to weapon');

    const readout = {
      get faces() {
        const fire = weapon();
        return fire ? `${fire.faceCount} faces alight` : 'no weapon';
      }
    };
    box.add(readout, 'faces').name('emitting').disable().listen();

    R(box, b, 'x', -1, 1, 0.001, 'offset X (m)').listen();
    R(box, b, 'y', -1, 1, 0.001, 'offset Y (m)').listen();
    R(box, b, 'z', -1, 1, 0.001, 'offset Z (m)').listen();
    R(box, b, 'rotX', -180, 180, 0.5, 'rotate X (°)').listen();
    R(box, b, 'rotY', -180, 180, 0.5, 'rotate Y (°)').listen();
    R(box, b, 'rotZ', -180, 180, 0.5, 'rotate Z (°)').listen();
    R(box, b, 'scaleX', 0.02, 4, 0.01, 'scale X').listen();
    R(box, b, 'scaleY', 0.02, 4, 0.01, 'scale Y').listen();
    R(box, b, 'scaleZ', 0.02, 4, 0.01, 'scale Z').listen();
    R(box, b, 'sizeX', 0.005, 2, 0.001, 'size X (m)').listen();
    R(box, b, 'sizeY', 0.005, 2, 0.001, 'size Y (m)').listen();
    R(box, b, 'sizeZ', 0.005, 2, 0.001, 'size Z (m)').listen();

    // The flame body: a raymarched black-body volume wrapped around a distance
    // field of the selected faces. `thickness` is the first dial to reach for —
    // it is how much burning gas there is off the steel, in metres.
    const volume = folder.addFolder('Flame body');
    const v = f.volume;
    volume.add(v, 'enabled').name('enabled');
    R(volume, v, 'thickness', 0.002, 0.3, 0.001, 'thickness (m)');
    R(volume, v, 'plume', 1, 6, 0.01, 'plume stretch');
    R(volume, v, 'length', 0.05, 2, 0.01, 'plume length (m)');
    R(volume, v, 'spread', 0, 4, 0.01, 'widens with age');
    R(volume, v, 'rise', 0.1, 8, 0.01, 'buoyant flow (m/s)');
    R(volume, v, 'inherit', 0, 1.5, 0.01, 'blade velocity bend');
    R(volume, v, 'glow', 0, 20, 0.01, 'emission');
    R(volume, v, 'density', 0, 6, 0.01, 'density');
    R(volume, v, 'opacity', 0, 1, 0.01, 'opacity');
    R(volume, v, 'steps', 8, 64, 1, 'march steps');

    const shape = volume.addFolder('Turbulence');
    R(shape, v, 'softness', 0.05, 1, 0.01, 'edge softness');
    R(shape, v, 'shred', 0, 3, 0.01, 'fringe shred');
    R(shape, v, 'bulge', 0, 1, 0.01, 'silhouette lobes');
    R(shape, v, 'bulgeScale', 1, 30, 0.1, 'lobes per metre');
    R(shape, v, 'detachment', 0, 2, 0.01, 'tip detachment');
    R(shape, v, 'buoyancy', 0, 6, 0.01, 'field climb');
    R(shape, v, 'noiseFrequency', 2, 40, 0.1, 'detail size');
    R(shape, v, 'noiseStrength', 0, 3, 0.01, 'noise strength');
    R(shape, v, 'warp', 0, 1, 0.01, 'domain warp');
    R(shape, v, 'tongue', 0.5, 6, 0.01, 'tongue stretch');
    R(shape, v, 'lick', 0, 6, 0.01, 'fringe lick');
    R(shape, v, 'wisps', 0, 2, 0.01, 'wisps');
    R(shape, v, 'flicker', 0, 1.5, 0.01, 'flicker');
    R(shape, v, 'octaves', 1, 5, 1, 'octaves');

    // The physics half. `palette` is the escape hatch: 0 is a pure radiator,
    // 1 hands the colour back to the four stops under Palette.
    const heat = volume.addFolder('Temperature');
    R(heat, v, 'tempCore', 1200, 6000, 10, 'core (K)');
    R(heat, v, 'tempEdge', 1000, 3000, 10, 'edge (K)');
    R(heat, v, 'emissionCurve', 1, 6, 0.05, 'radiance exponent');
    R(heat, v, 'heatFocus', 0.1, 3, 0.01, 'heat focus');
    R(heat, v, 'heatFalloff', 0.1, 4, 0.01, 'heat falloff');
    R(heat, v, 'heatFollow', 0, 1, 0.01, 'noise in temperature');
    R(heat, v, 'tailHeat', 0, 1, 0.01, 'tip temperature');
    R(heat, v, 'palette', 0, 1, 0.01, 'palette over physics');
    R(heat, v, 'scatter', 0, 4, 0.01, 'in-scatter');
    R(heat, v, 'scatterFalloff', 0.5, 8, 0.01, 'scatter falloff');
    R(heat, v, 'soot', 0, 4, 0.01, 'soot absorption');
    R(heat, v, 'coreClarity', 0, 1, 0.01, 'core clarity');

    // Only in force as `palette` above is turned up — at 0 the colour is the
    // black-body physics and these four stops do nothing.
    const palette = volume.addFolder('Palette');
    palette.addColor(v, 'colorCore').name('core');
    palette.addColor(v, 'colorMid').name('mid');
    palette.addColor(v, 'colorEdge').name('edge');
    palette.addColor(v, 'colorSmoke').name('smoke');

    // The steel's own glow — see `vfx/BladeHeat.js`. `edge boost` is the dial
    // that draws the white filament down the cutting edge, and `char` is what
    // stops the key light's specular sitting on top of it.
    const steel = folder.addFolder('Hot steel');
    const s = f.steel;
    steel.add(s, 'enabled').name('enabled');
    R(steel, s, 'amount', 0, 3, 0.01, 'glow');
    R(steel, s, 'tempCore', 1000, 4000, 10, 'hottest (K)');
    R(steel, s, 'tempEdge', 900, 3000, 10, 'coolest (K)');
    R(steel, s, 'curve', 1, 6, 0.05, 'radiance exponent');
    R(steel, s, 'edge', 0, 5, 0.01, 'edge boost');
    R(steel, s, 'edgeSharpness', 0.5, 8, 0.05, 'edge tightness');
    R(steel, s, 'detail', 0, 1, 0.01, 'uneven heat');
    R(steel, s, 'scale', 1, 40, 0.1, 'heat detail size');
    R(steel, s, 'speed', 0, 4, 0.01, 'heat crawl');
    R(steel, s, 'relief', 0, 1, 0.01, 'texture relief');
    R(steel, s, 'falloff', 0.01, 1, 0.01, 'box edge fade');
    R(steel, s, 'char', 0, 1, 0.01, 'char the metal');

    // Sparks born on the selected triangles — see `vfx/EmberSystem.js`. `rate`
    // and `life` together decide how many are alive; `streak` is the motion
    // blur that keeps them from reading as dots.
    const embers = folder.addFolder('Embers');
    const em = f.embers;
    embers.add(em, 'enabled').name('enabled');

    const live = {
      get count() {
        const fire = weapon();
        return fire ? `${fire.emberCount} in flight` : 'no weapon';
      }
    };
    embers.add(live, 'count').name('sparks').disable().listen();

    R(embers, em, 'rate', 0, 1500, 1, 'births / s');
    R(embers, em, 'swing', 0, 2, 0.01, 'more when swung');
    R(embers, em, 'life', 0.1, 6, 0.01, 'life (s)');
    R(embers, em, 'lifeVariance', 0, 0.95, 0.01, 'life spread');
    R(embers, em, 'emission', 0, 20, 0.01, 'brightness');
    R(embers, em, 'size', 0.001, 0.05, 0.0005, 'radius (m)');
    R(embers, em, 'sizeVariance', 0, 0.95, 0.01, 'size spread');
    R(embers, em, 'shrink', 0, 2, 0.01, 'size at death');
    R(embers, em, 'core', 0, 12, 0.05, 'core tightness');
    R(embers, em, 'twinkle', 0, 1, 0.01, 'twinkle');

    const launch = embers.addFolder('Launch');
    R(launch, em, 'standoff', 0, 0.05, 0.0005, 'stand off (m)');
    R(launch, em, 'eject', 0, 3, 0.01, 'off the face (m/s)');
    R(launch, em, 'rise', 0, 4, 0.01, 'along the flow (m/s)');
    R(launch, em, 'spread', 0, 2, 0.01, 'scatter (m/s)');
    R(launch, em, 'inherit', 0, 1.5, 0.01, 'blade velocity kept');

    const flight = embers.addFolder('Flight');
    R(flight, em, 'buoyancy', 0, 8, 0.01, 'buoyancy (m/s²)');
    R(flight, em, 'drag', 0.05, 6, 0.01, 'air drag (1/s)');
    R(flight, em, 'turbulence', 0, 2, 0.01, 'wander (m)');
    R(flight, em, 'turbulenceScale', 0.2, 12, 0.05, 'wander detail');
    R(flight, em, 'turbulenceSpeed', 0, 4, 0.01, 'wander speed');
    R(flight, em, 'stretch', 0, 6, 0.01, 'streak / (m/s)');
    R(flight, em, 'maxStretch', 1, 24, 0.1, 'streak cap');

    const cooling = embers.addFolder('Cooling');
    R(cooling, em, 'tempBirth', 1200, 4000, 10, 'birth (K)');
    R(cooling, em, 'tempDeath', 800, 2500, 10, 'death (K)');
    R(cooling, em, 'curve', 1, 6, 0.05, 'radiance exponent');
    R(cooling, em, 'cool', 0.1, 4, 0.01, 'cools early ← → late');

    const light = folder.addFolder('Firelight');
    const li = f.light;
    light.add(li, 'enabled').name('enabled');
    R(light, li, 'intensity', 0, 60, 0.1, 'intensity (cd)');
    R(light, li, 'distance', 0.5, 15, 0.1, 'reach (m)');
    R(light, li, 'decay', 0, 3, 0.01, 'decay');
    light.addColor(li, 'color').name('colour');
    R(light, li, 'flicker', 0, 1, 0.01, 'flicker');
  }

  /**
   * The two summoned shadows — see `vfx/ShadowCharacter.js`.
   *
   * `V` arms the mark and the last lock writes the same `active` flag this
   * checkbox does, so the two agree either way round (hence the `listen()`).
   * Ticking it here is the one summon that skips the marking entirely: with
   * nothing assigned each shadow takes the nearest body it can have, which is
   * what the pair did before there was anything to mark. Everything else is
   * sampled by the shadow material every frame, so they can be re-dressed while
   * they are standing beside the body.
   */
  _buildShadowCharacter() {
    const folder = this.gui.addFolder('Shadow character');
    const s = settings.shadowCharacter;
    const R = Editor.range;

    folder.add(s, 'active').name('summoned (unmarked)').listen();
    R(folder, s, 'offset', 0, 4, 0.01, 'to each side (m)');
    R(folder, s, 'back', -2, 3, 0.01, 'behind (m)');
    R(folder, s, 'scale', 0.3, 2, 0.01, 'size ×');
    R(folder, s, 'emerge', 0, 2, 0.01, 'step out (s)');
    R(folder, s, 'crouch', 0, 6, 0.05, 'crouch hold (s)');

    // Choosing who they go for — `V`, the aim, and the diamond over the head.
    // `aim` is the one to reach for: it is how far off the middle of the frame
    // a body may be and still be the one meant, as a fraction of the screen's
    // height, so it is the difference between a look and a pixel hunt.
    const mark = folder.addFolder('The mark');
    const m = s.marking;
    R(mark, m, 'count', 1, 2, 1, 'bodies to mark');
    R(mark, m, 'range', 4, 80, 0.5, 'markable within (m)');
    R(mark, m, 'aim', 0.02, 0.6, 0.005, 'aim tolerance (screens)');
    R(mark, m, 'timeout', 0, 60, 0.5, 'arm expires after (s)');

    const marker = mark.addFolder('The diamond');
    const ml = m.look;
    marker.addColor(ml, 'color').name('under the aim');
    marker.addColor(ml, 'lockColor').name('locked');
    R(marker, ml, 'size', 0.1, 2, 0.01, 'size (m)');
    R(marker, ml, 'lift', 0, 2, 0.01, 'above the head (m)');
    R(marker, ml, 'width', 0.01, 0.5, 0.005, 'outline width');
    R(marker, ml, 'softness', 0.005, 0.3, 0.005, 'feather');
    R(marker, ml, 'intensity', 0, 6, 0.05, 'brightness');
    R(marker, ml, 'pulse', 0, 1, 0.01, 'breath depth');
    R(marker, ml, 'pulseSpeed', 0, 20, 0.1, 'breath speed');
    R(marker, ml, 'pop', 0, 2, 0.01, 'lock snap');
    R(marker, ml, 'fadeIn', 0.01, 1, 0.01, 'fade in (s)');
    R(marker, ml, 'fadeOut', 0.01, 1, 0.01, 'fade out (s)');

    // The errand: from the crouch to the blow landing. Where the run stops is
    // the striking move's own `standoff` under Combat, the ground its warp
    // covers, and the slack here.
    const hunt = folder.addFolder('The hunt');
    const h = s.hunt;
    R(hunt, h, 'speed', 0.5, 12, 0.05, 'run speed (m/s)');
    // The pose only — the approach is aimed at the target, so no value here can
    // cost the pair a kill.
    R(hunt, h, 'turnRate', 0.000001, 0.05, 0.000001, 'turn follow');
    R(hunt, h, 'slack', 0, 1, 0.01, 'standoff slack (m)');
    R(hunt, h, 'timeout', 1, 30, 0.5, 'give up after (s)');

    // What it finishes with — one of the player's own attacks, thrown on that
    // move's numbers under Combat. `lead` is the hand-over from run to move:
    // at 1 the body keeps the speed it arrived at, which is the join to watch.
    const strike = folder.addFolder('The strike');
    const st = s.strike;
    strike
      .add(st, 'move', { 'slide cut': 'crouchSlash', 'slash hit': 'slashHit', kick: 'kick' })
      .name('finisher');
    R(strike, st, 'lead', 0.2, 2, 0.01, 'brakes ← → lunges');

    // The vanish — the same noise burn the enemies die by, in violet.
    const dissolve = folder.addFolder('Vanish');
    const d = s.dissolve;
    R(dissolve, d, 'time', 0.1, 4, 0.01, 'burn (s)');
    R(dissolve, d, 'detail', 1, 60, 0.5, 'noise detail');
    R(dissolve, d, 'rise', 0, 1, 0.01, 'rise vs noise');
    dissolve.addColor(d, 'edgeColor').name('edge colour');
    R(dissolve, d, 'edgeEmissive', 0, 12, 0.01, 'edge emissive');
    R(dissolve, d, 'edgeWidth', 0.005, 0.4, 0.005, 'edge width');

    // The dark. Not quite black on purpose — see the note in settings.js.
    const dark = folder.addFolder('Darkness');
    dark.addColor(s, 'color').name('body colour');
    R(dark, s, 'roughness', 0, 1, 0.01, 'roughness');
    R(dark, s, 'metalness', 0, 1, 0.01, 'metalness');

    // The rim that draws the silhouette. `power` tightens the band toward the
    // outline; `emissive` is how hard it burns.
    const fresnel = folder.addFolder('Fresnel rim');
    const fr = s.fresnel;
    fresnel.addColor(fr, 'color').name('rim colour');
    R(fresnel, fr, 'power', 0.2, 8, 0.05, 'rim tightness');
    R(fresnel, fr, 'emissive', 0, 10, 0.01, 'rim emissive');
  }

  /**
   * The fist — `Q`, and everything that arrives with it.
   *
   * The button at the top is the one to use while tuning: it calls the whole
   * thing down on the nearest body without going through the mark, so a number
   * can be moved and seen again two seconds later. Everything below is sampled
   * every frame, so a slider moved while the fist is falling lands on the fist
   * that is falling.
   *
   * The three numbers worth reaching for first are `height` (the length of the
   * drop, and therefore its weight), `fall` (a quarter second is a punch, half
   * is a boulder) and `fist → size` — see the note in settings.js.
   */
  _buildJudgement() {
    const folder = this.gui.addFolder('Judgement (the fist)');
    const j = settings.judgement;
    const R = Editor.range;

    folder
      .add({ cast: () => this.hooks.onCastJudgement?.() }, 'cast')
      .name('Call it down (nearest)');
    folder.add(j, 'enabled').name('enabled');
    R(folder, j, 'height', 1.2, 12, 0.05, 'seal height (m)');

    // The choreography. `fall` is the only one that is about force rather than
    // pacing, and `charge` is the beat the move would be nothing without.
    const beats = folder.addFolder('Beats (s)');
    const b = j.beats;
    R(beats, b, 'open', 0.05, 2, 0.01, 'seal draws itself');
    R(beats, b, 'charge', 0, 3, 0.01, 'held, gathering');
    R(beats, b, 'fall', 0.05, 1.5, 0.01, 'the drop');
    R(beats, b, 'dwell', 0, 3, 0.01, 'planted');
    R(beats, b, 'withdraw', 0.05, 2, 0.01, 'pulled back');
    R(beats, b, 'close', 0.05, 2, 0.01, 'seal folds away');

    // Who it can be called down on. `aim` is the same control the shadows have:
    // how far off the middle of the frame a body may be and still be the one
    // meant, as a fraction of the screen's height.
    const mark = folder.addFolder('The mark');
    const m = j.marking;
    R(mark, m, 'range', 4, 80, 0.5, 'markable within (m)');
    R(mark, m, 'aim', 0.02, 0.6, 0.005, 'aim tolerance (screens)');
    R(mark, m, 'timeout', 0, 60, 0.5, 'arm expires after (s)');

    // The circle. Every mark on it is arithmetic in one fragment shader, so the
    // counts below are free — turn `runes` up and there are simply more of them.
    const seal = folder.addFolder('The seal');
    const s = j.seal;
    R(seal, s, 'radius', 0.4, 5, 0.05, 'radius (m)');
    seal.addColor(s, 'color').name('line colour');
    seal.addColor(s, 'coreColor').name('core colour');
    R(seal, s, 'intensity', 0, 8, 0.05, 'brightness');
    R(seal, s, 'spin', -2, 2, 0.01, 'turns a second');
    R(seal, s, 'ticks', 4, 120, 1, 'ticks');
    R(seal, s, 'runes', 3, 40, 1, 'runes');
    R(seal, s, 'spokes', 2, 24, 1, 'spokes');
    R(seal, s, 'width', 0.002, 0.06, 0.001, 'stroke weight');
    R(seal, s, 'softness', 0.001, 0.06, 0.001, 'feather');
    R(seal, s, 'haze', 0, 2, 0.01, 'inner glow');
    R(seal, s, 'detail', 0, 1, 0.01, 'mottling');
    R(seal, s, 'pulse', 0, 1, 0.01, 'breath depth');
    R(seal, s, 'pulseSpeed', 0, 20, 0.1, 'breath speed');

    // The arm. There is no colour map on this model at all — the whole look is
    // the rim and the relief below, placed by its normal map.
    const fist = folder.addFolder('The fist');
    const f = j.fist;
    R(fist, f, 'scale', 0.4, 4, 0.01, 'size ×');
    R(fist, f, 'crush', 0, 1.5, 0.01, 'stops above ground (m)');
    fist.addColor(f, 'color').name('body colour');
    R(fist, f, 'roughness', 0, 1, 0.01, 'roughness');
    R(fist, f, 'metalness', 0, 1, 0.01, 'metalness');
    R(fist, f, 'normalScale', 0, 3, 0.01, 'relief depth');
    R(fist, f, 'flash', 0, 10, 0.05, 'contact flash');
    R(fist, f, 'flashTime', 0.02, 1, 0.01, 'flash fades (s)');

    const rim = fist.addFolder('Fresnel rim');
    const fr = f.fresnel;
    rim.addColor(fr, 'color').name('rim colour');
    R(rim, fr, 'power', 0.2, 8, 0.05, 'rim tightness');
    R(rim, fr, 'emissive', 0, 10, 0.01, 'rim emissive');

    // The light inside the sculpt. `gain` is the control: relief is a small
    // number and has to be opened right up before it reads at all.
    const veins = fist.addFolder('Veins (in the relief)');
    const v = f.veins;
    veins.addColor(v, 'color').name('cold colour');
    veins.addColor(v, 'hotColor').name('hot colour');
    R(veins, v, 'emissive', 0, 10, 0.01, 'emissive');
    R(veins, v, 'gain', 0.5, 20, 0.1, 'relief gain');
    R(veins, v, 'sharpness', 0.2, 6, 0.05, 'relief sharpness');
    R(veins, v, 'scale', 0.5, 30, 0.1, 'field scale');
    R(veins, v, 'speed', 0, 5, 0.01, 'field speed');
    R(veins, v, 'cavity', 0, 1, 0.01, 'cavity shading');

    const birth = fist.addFolder('Through the seal');
    const bl = f.birth;
    birth.addColor(bl, 'color').name('line colour');
    R(birth, bl, 'emissive', 0, 12, 0.05, 'line emissive');
    R(birth, bl, 'width', 0.01, 1, 0.005, 'line width (m)');

    // What it does to a body. `lift` is negative here and positive on every
    // other move in the game — see the note in settings.js.
    const force = folder.addFolder('The blow');
    const fo = j.force;
    R(force, fo, 'reach', 0.2, 6, 0.05, 'crushes within (m)');
    R(force, fo, 'impulse', 0, 20, 0.1, 'outward (m/s)');
    R(force, fo, 'lift', -30, 10, 0.1, 'down ← → up (m/s)');
    R(force, fo, 'spin', 0, 4, 0.05, 'upper body takes');
    R(force, fo, 'hitStop', 0, 0.5, 0.005, 'freeze (s)');
    R(force, fo, 'hitStopScale', 0.01, 1, 0.005, 'freeze depth');
    R(force, fo, 'shake', 0, 1.5, 0.01, 'camera shake (m)');

    // The ground. The cracks only open behind the wave, which is what stops the
    // pair reading as one decal fading in.
    const shock = folder.addFolder('The ground');
    const sh = j.shock;
    R(shock, sh, 'radius', 0.5, 12, 0.1, 'wave reaches (m)');
    R(shock, sh, 'life', 0.1, 3, 0.01, 'wave lasts (s)');
    shock.addColor(sh, 'color').name('wave colour');
    shock.addColor(sh, 'crackColor').name('crack colour');
    R(shock, sh, 'intensity', 0, 8, 0.05, 'brightness');
    R(shock, sh, 'width', 0.01, 0.4, 0.005, 'wave width');
    R(shock, sh, 'softness', 0.01, 0.5, 0.005, 'feather');
    R(shock, sh, 'cracks', 0, 32, 1, 'cracks');
    R(shock, sh, 'crackLength', 0.1, 1, 0.01, 'crack reach');
    R(shock, sh, 'crackWidth', 0.002, 0.1, 0.001, 'crack width');
    R(shock, sh, 'crackGlow', 0, 5, 0.05, 'crack glow');
    R(shock, sh, 'lift', 0, 0.3, 0.005, 'off the floor (m)');

    // Dust and soil — the only thing in the ability that is lit rather than
    // emitted, which is exactly why it sells the impact.
    const dust = folder.addFolder('Dust & soil');
    const d = j.dust;
    dust.add(d, 'enabled').name('enabled');
    R(dust, d, 'puffs', 0, 120, 1, 'dust puffs');
    R(dust, d, 'clods', 0, 160, 1, 'soil clods');
    R(dust, d, 'speed', 0.5, 20, 0.1, 'launch (m/s)');
    R(dust, d, 'spread', 0, 1.5, 0.01, 'scatter');
    R(dust, d, 'rise', 0, 2, 0.01, 'up vs out');
    R(dust, d, 'ring', 0, 3, 0.05, 'born at radius (m)');
    R(dust, d, 'dustLife', 0.1, 6, 0.05, 'dust lasts (s)');
    R(dust, d, 'soilLife', 0.1, 4, 0.05, 'soil lasts (s)');
    R(dust, d, 'dustSize', 0.02, 2, 0.01, 'dust size (m)');
    R(dust, d, 'dustGrow', 1, 10, 0.05, 'dust swells ×');
    R(dust, d, 'soilSize', 0.005, 0.5, 0.005, 'soil size (m)');
    R(dust, d, 'dustDrag', 0.05, 8, 0.05, 'dust drag /s');
    R(dust, d, 'soilDrag', 0.05, 4, 0.01, 'soil drag /s');
    R(dust, d, 'gravity', -40, 0, 0.5, 'gravity (m/s²)');
    R(dust, d, 'lift', 0, 6, 0.05, 'dust buoyancy');
    dust.addColor(d, 'color').name('lit dust');
    dust.addColor(d, 'shadeColor').name('shaded dust');
    dust.addColor(d, 'soilColor').name('soil');
    R(dust, d, 'opacity', 0, 1.5, 0.01, 'opacity');

    const light = folder.addFolder('Its light');
    const l = j.light;
    light.add(l, 'enabled').name('enabled');
    light.addColor(l, 'color').name('seal colour');
    light.addColor(l, 'flashColor').name('contact colour');
    R(light, l, 'intensity', 0, 60, 0.5, 'while it gathers');
    R(light, l, 'flash', 0, 400, 1, 'on contact');
    R(light, l, 'flashTime', 0.05, 2, 0.01, 'flash fades (s)');
    R(light, l, 'distance', 1, 40, 0.5, 'reach (m)');
    R(light, l, 'decay', 0.5, 3, 0.05, 'decay');
  }

  /**
   * Flight, and the blades it hangs in the air — see `vfx/BladeStorm.js`.
   *
   * Three numbers before any of the others: `height` (how far off the floor the
   * body cruises, which is also how far the aim is looking down), `speed` (this
   * has to be *fast* or the whole mode reads as walking at altitude) and
   * `blades → volley → stagger`, which is the difference between six kills and
   * one event.
   */
  _buildFlight() {
    const folder = this.gui.addFolder('Flight (X) & the blades');
    const f = settings.flight;
    const R = Editor.range;

    folder.add(f, 'enabled').name('enabled');
    R(folder, f, 'height', 1, 20, 0.1, 'cruise height (m)');
    R(folder, f, 'speed', 1, 30, 0.1, 'cruise (m/s)');
    R(folder, f, 'boost', 1, 40, 0.1, 'boost — shift (m/s)');

    const air = folder.addFolder('In the air');
    R(air, f, 'takeoff', 0.1, 3, 0.01, 'climb takes (s)');
    R(air, f, 'land', 0.1, 3, 0.01, 'descent takes (s)');
    R(air, f, 'acceleration', 1, 40, 0.5, 'accelerates (m/s²)');
    R(air, f, 'deceleration', 1, 40, 0.5, 'decelerates (m/s²)');
    // Lower is snappier: it is the fraction of the heading gap left after a
    // second, and the bank below is drawn off how fast that gap closes.
    R(air, f, 'turnRate', 0.0001, 0.2, 0.0001, 'turn (gap left after 1s)');
    R(air, f, 'bank', 0, 1.5, 0.01, 'roll into turns (rad)');
    R(air, f, 'pitch', 0, 1, 0.01, 'nose down at speed (rad)');
    R(air, f, 'leanRate', 0.5, 20, 0.1, 'lean arrives (1/s)');
    R(air, f, 'bob', 0, 1, 0.005, 'hover breath (m)');
    R(air, f, 'bobSpeed', 0, 4, 0.01, 'breath speed (Hz)');
    R(air, f, 'blendIn', 0.02, 1.5, 0.01, 'pose fades in (s)');
    R(air, f, 'blendOut', 0.02, 1.5, 0.01, 'pose fades out (s)');

    // The touchdown. `lead` is the only one that has to be judged against the
    // clip rather than by taste: it is how far *before* the feet arrive the
    // landing starts, so its impact frame is the frame they land on.
    const down = folder.addFolder('The touchdown');
    const r = f.recover;
    down.add(r, 'enabled').name('landing clip');
    R(down, r, 'lead', 0, 1, 0.01, 'starts early by (s)');
    R(down, r, 'blendIn', 0.02, 1, 0.01, 'fades in (s)');
    R(down, r, 'blendOut', 0.02, 1.5, 0.01, 'hands to idle over (s)');
    R(down, r, 'exitAt', 0.1, 1, 0.01, 'released at (phase)');

    // The aim. One body at a time, and it re-arms itself on every click.
    const mark = folder.addFolder('The mark');
    const m = f.marking;
    R(mark, m, 'range', 4, 100, 0.5, 'markable within (m)');
    R(mark, m, 'aim', 0.02, 0.6, 0.005, 'aim tolerance (screens)');

    const blades = folder.addFolder('The blades');
    const b = f.blades;
    R(blades, b, 'max', 1, 16, 1, 'how many can hang');
    R(blades, b, 'scale', 0.3, 3, 0.01, 'size ×');
    R(blades, b, 'formTime', 0.05, 2, 0.01, 'forges over (s)');
    R(blades, b, 'chargeTime', 0.05, 4, 0.01, 'comes to charge (s)');

    // The ring itself. `spin` and `sway` are what stop six swords from reading
    // as one rigid carousel.
    const orbit = blades.addFolder('The halo');
    const o = b.orbit;
    R(orbit, o, 'radius', 0.4, 6, 0.05, 'radius (m)');
    R(orbit, o, 'height', 0.2, 2.5, 0.01, 'up the body ×');
    R(orbit, o, 'rise', 0, 2, 0.01, 'ring tilt');
    R(orbit, o, 'spin', -2, 2, 0.01, 'turns a second');
    R(orbit, o, 'tilt', 0, 1.5, 0.01, 'blades lean out');
    R(orbit, o, 'sway', 0, 1, 0.005, 'sway (m)');
    R(orbit, o, 'swaySpeed', 0, 6, 0.05, 'sway speed');

    // The volley. `stagger` first — see the note above.
    const volley = blades.addFolder('The volley');
    R(volley, b, 'stagger', 0, 0.6, 0.005, 'gap between them (s)');
    R(volley, b, 'windUp', 0.02, 1, 0.01, 'pull-back (s)');
    R(volley, b, 'windBack', 0, 3, 0.05, 'pulls back (m)');
    R(volley, b, 'speed', 5, 90, 0.5, 'travels at (m/s)');
    R(volley, b, 'acceleration', 10, 400, 5, 'accelerates (m/s²)');
    R(volley, b, 'hitRadius', 0.1, 2, 0.01, 'arrives within (m)');
    R(volley, b, 'overshoot', 0, 8, 0.05, 'buries itself past (m)');
    R(volley, b, 'plantTime', 0.1, 6, 0.05, 'stands in the ground (s)');
    R(volley, b, 'fadeTime', 0.1, 3, 0.01, 'burns away over (s)');
    R(volley, b, 'quiver', 0, 0.4, 0.005, 'rings (rad)');
    R(volley, b, 'quiverSpeed', 1, 60, 0.5, 'ring speed');

    // The steel. The blade wears the weapon's own textured material and nothing
    // here replaces or dials it — the rim is the whole of what is added.
    const look = blades.addFolder('The steel');
    const lk = b.look;
    R(look, lk, 'stretch', 1, 8, 0.05, 'smear while flying ×');

    const rim = look.addFolder('Fresnel rim');
    const fr = lk.fresnel;
    rim.addColor(fr, 'color').name('rim colour');
    R(rim, fr, 'power', 0.2, 8, 0.05, 'rim tightness');
    R(rim, fr, 'emissive', 0, 10, 0.01, 'rim emissive');

    // What a blade does to a body. `slices` is the one that matters: it is a
    // sword, and it should take them apart.
    const force = blades.addFolder('The blow');
    const fo = b.force;
    R(force, fo, 'impulse', 0, 30, 0.1, 'along the blade (m/s)');
    R(force, fo, 'lift', -20, 20, 0.1, 'up (m/s)');
    R(force, fo, 'spin', 0, 4, 0.05, 'upper body takes');
    R(force, fo, 'hitStop', 0, 0.4, 0.005, 'freeze (s)');
    R(force, fo, 'hitStopScale', 0.01, 1, 0.005, 'freeze depth');
    R(force, fo, 'shake', 0, 1.5, 0.01, 'camera shake (m)');
    force.add(fo, 'slices').name('cuts them in half');

    // The hit: one burst and a shower of sparks out of one buffer.
    const hit = blades.addFolder('The hit');
    const im = b.impact;
    hit.add(im, 'enabled').name('enabled');
    hit.addColor(im, 'color').name('flash colour');
    hit.addColor(im, 'ringColor').name('ring colour');
    R(hit, im, 'size', 0.2, 6, 0.05, 'size (m)');
    R(hit, im, 'life', 0.05, 2, 0.01, 'lasts (s)');
    R(hit, im, 'intensity', 0, 10, 0.05, 'brightness');
    R(hit, im, 'spikes', 0, 16, 1, 'star spikes');
    R(hit, im, 'spikeLength', 0.2, 4, 0.05, 'spike reach');

    const sparks = hit.addFolder('Sparks');
    R(sparks, im, 'sparks', 0, 160, 1, 'how many');
    sparks.addColor(im, 'sparkColor').name('colour');
    R(sparks, im, 'sparkSpeed', 0.5, 40, 0.1, 'launch (m/s)');
    R(sparks, im, 'sparkSpread', 0, 1.3, 0.01, 'cone');
    R(sparks, im, 'sparkLife', 0.05, 3, 0.01, 'lasts (s)');
    R(sparks, im, 'sparkSize', 0.005, 0.4, 0.005, 'size (m)');
    R(sparks, im, 'sparkStretch', 0, 0.3, 0.001, 'smear per m/s');
    R(sparks, im, 'sparkDrag', 0.05, 8, 0.05, 'drag /s');
    R(sparks, im, 'sparkGravity', -40, 0, 0.5, 'gravity (m/s²)');

    const light = blades.addFolder('Its light');
    const li = b.light;
    light.add(li, 'enabled').name('enabled');
    light.addColor(li, 'color').name('halo colour');
    light.addColor(li, 'flashColor').name('contact colour');
    R(light, li, 'intensity', 0, 60, 0.5, 'while they gather');
    R(light, li, 'flash', 0, 300, 1, 'on contact');
    R(light, li, 'flashTime', 0.05, 2, 0.01, 'flash fades (s)');
    R(light, li, 'distance', 1, 40, 0.5, 'reach (m)');
    R(light, li, 'decay', 0.5, 3, 0.05, 'decay');
  }

  _buildPost() {
    const folder = this.gui.addFolder('Post processing');
    const p = settings.post;
    const R = Editor.range;

    folder.add(p, 'enabled').name('enabled');
    // The only anti-aliasing in the project — the scene never touches the canvas
    // directly, so the renderer's own flag has nothing to act on. It is also the
    // heaviest thing in the stack, hence a dial rather than a constant.
    folder.add(p, 'samples', [0, 2, 4, 8]).name('anti-aliasing');
    R(folder, p, 'exposure', 0.1, 3, 0.01, 'exposure');
    R(folder, p, 'bloomStrength', 0, 3, 0.01, 'bloom intensity');
    R(folder, p, 'bloomRadius', 0, 1.5, 0.01, 'bloom radius');
    R(folder, p, 'bloomThreshold', 0, 2, 0.01, 'bloom threshold');
    R(folder, p, 'contrast', 0.5, 2, 0.01, 'contrast');
    R(folder, p, 'saturation', 0, 2.5, 0.01, 'saturation');
    R(folder, p, 'temperature', -0.5, 0.5, 0.01, 'temperature');
    R(folder, p, 'lift', -0.2, 0.2, 0.005, 'lift');
    R(folder, p, 'gain', 0.5, 2, 0.01, 'gain');
    R(folder, p, 'vignette', 0, 1.5, 0.01, 'vignette');
    R(folder, p, 'chromaticAberration', 0, 3, 0.01, 'chromatic aberration');
    R(folder, p, 'grain', 0, 0.2, 0.001, 'film grain');
  }

  _buildCamera() {
    const folder = this.gui.addFolder('Camera');
    const c = settings.camera;
    const R = Editor.range;

    // The wheel writes `distance` straight into settings, so the slider listens.
    R(folder, c, 'distance', 1, 40, 0.1, 'distance').listen();
    R(folder, c, 'minDistance', 1, 20, 0.1, 'min distance');
    R(folder, c, 'maxDistance', 4, 40, 0.1, 'max distance');
    R(folder, c, 'zoomSpeed', 0.1, 3, 0.01, 'zoom speed');
    R(folder, c, 'fov', 20, 90, 0.5, 'field of view');
    R(folder, c, 'targetHeight', 0, 4, 0.01, 'target height');
    R(folder, c, 'minPolar', 0.05, 1.5, 0.01, 'min pitch');
    // Past π/2 the camera drops below its target and the view tilts up, which is
    // the only way anything in the sky gets into frame. Nothing collides the
    // lens against the floor, so a long zoom at the top of this range will go
    // through the ground — which is why the default stops just past level.
    R(folder, c, 'maxPolar', 0.2, 2.2, 0.01, 'max pitch');
    R(folder, c, 'damping', 0.001, 0.5, 0.001, 'follow damping');
  }

  _buildCharacter() {
    const folder = this.gui.addFolder('Character');
    const c = settings.character;
    const R = Editor.range;

    // The mixer's own rate.
    R(folder, settings.global, 'animationSpeed', 0.1, 3, 0.01, 'playback rate');
    R(folder, settings.global, 'timeScale', 0.02, 2, 0.01, 'time scale');

    // The turntable advances `facing` itself, so that slider listens.
    R(folder, c, 'spin', -0.5, 0.5, 0.005, 'turntable (rev/s)');
    R(folder, c, 'facing', -Math.PI, Math.PI * 3, 0.01, 'facing').listen();

    // The skin's response to the stage's lights. The body wears the glTF
    // palette's authored maps, so these two only reach it once the override is
    // on — off, they still drive any material the palette had no match for.
    const material = folder.addFolder('Skin');
    material.add(c, 'overrideSurface').name('override authored PBR');
    R(material, c, 'roughness', 0, 1, 0.01, 'roughness');
    R(material, c, 'metalness', 0, 1, 0.01, 'metalness');

    // The rig is re-normalised against `targetHeight` every frame, so this
    // rescales the body live — and anything attached to a bone with it.
    const rig = folder.addFolder('Rig');
    R(rig, c, 'targetHeight', 1, 3, 0.01, 'height (m)');
    R(rig, c, 'turnRate', 0.000001, 0.02, 0.000001, 'turn follow');
  }

  _buildLocomotion() {
    const folder = this.gui.addFolder('Locomotion');
    const l = settings.locomotion;
    const R = Editor.range;

    folder.add(l, 'enabled').name('controls enabled');

    // How fast the body travels. The stride rate divides these by the clip
    // speeds below, so raising one speeds the legs up to match.
    R(folder, l, 'walkSpeed', 0.2, 4, 0.01, 'walk (m/s)');
    R(folder, l, 'runSpeed', 1, 12, 0.01, 'run (m/s)');
    R(folder, l, 'acceleration', 1, 60, 0.1, 'acceleration');
    R(folder, l, 'deceleration', 1, 60, 0.1, 'deceleration');
    R(folder, l, 'blendRate', 0.000001, 0.05, 0.000001, 'blend follow');

    const gait = folder.addFolder('Gait');
    R(gait, l, 'idleThreshold', 0, 0.5, 0.001, 'idle below (m/s)');
    // The speeds the clips themselves cover at rate 1 — the divisor. Tune these
    // once against the animation; move `walkSpeed`/`runSpeed` for design.
    R(gait, l, 'clipWalkSpeed', 0.2, 4, 0.01, 'walk clip (m/s)');
    R(gait, l, 'clipRunSpeed', 1, 12, 0.01, 'run clip (m/s)');
    // Trim on top of that division, per gait — for the part of the mismatch the
    // clip speeds do not account for. Blended between the two by the same curve
    // the weights use, and bounded by the stride clamp below.
    R(gait, l, 'walkAnimSpeed', 0.25, 3, 0.01, 'walk anim ×');
    R(gait, l, 'runAnimSpeed', 0.25, 3, 0.01, 'run anim ×');
    R(gait, l, 'strideMin', 0.2, 1, 0.01, 'stride min');
    R(gait, l, 'strideMax', 1, 5, 0.01, 'stride max');

    // Space, from a run. `distance` renormalises the clip's own travel, so it is
    // the reach of the jump in metres — 0 hands it back to the animation.
    const jump = folder.addFolder('Long jump');
    const j = settings.jump;
    jump.add(j, 'enabled').name('long jump enabled');
    R(jump, j, 'distance', 0, 20, 0.1, 'distance (m)');
    R(jump, j, 'minRunFraction', 0, 1, 0.01, 'launch above run ×');
    R(jump, j, 'landAt', 0.4, 1, 0.01, 'control returns at');
    R(jump, j, 'blendIn', 0.01, 0.6, 0.01, 'blend in (s)');
    R(jump, j, 'blendOut', 0.01, 0.8, 0.01, 'blend out (s)');

    // Space at anything less. It covers no ground of its own, so what there is
    // to tune is how it sits over the gait: `gaitBleed` is how much of the walk
    // or run keeps playing under it, which is what keeps the legs carrying the
    // body instead of planting while the controller travels.
    const hop = folder.addFolder('Hop');
    const h = settings.hop;
    hop.add(h, 'enabled').name('hop enabled');
    R(hop, h, 'gaitBleed', 0, 1, 0.01, 'gait under hop');
    R(hop, h, 'landAt', 0.4, 1, 0.01, 'feet down at');
    R(hop, h, 'blendIn', 0.01, 0.6, 0.01, 'blend in (s)');
    R(hop, h, 'blendOut', 0.01, 0.8, 0.01, 'blend out (s)');
  }

  /**
   * The kick and the bodies it lands on.
   *
   * Two halves that meet in one place. The **kick** half is the animation
   * contract: `hitAt`, `recoverAt` and `approach` are normalised times in the
   * clip, and they are the three numbers to reach for after watching the move
   * once — the foot connects here, control comes back there, and the warp has
   * that long to put the body where the animator assumed it was standing.
   *
   * The **enemies** half is the sandbox around it. Everything is live except
   * the height and the ring, which are read when a body is spawned — hit
   * "Respawn all" after moving those.
   */
  _buildCombat() {
    const folder = this.gui.addFolder('Combat');
    const R = Editor.range;

    // One folder per move, built from the same three groups — the two attacks
    // are the same machine (`animation/Attack.js`) with different numbers, so
    // there is nothing to say about one of them that is not a field on both.
    this._buildAttack(folder, settings.kick, 'Kick (E)');
    this._buildAttack(folder, settings.slashHit, 'Slash hit (R)');
    this._buildAttack(folder, settings.crouchSlash, 'Slide cut (T)');
    this._buildTargetRing(folder);
    this._buildSlice(folder);

    const e = settings.enemies;
    const enemies = folder.addFolder('Enemies');
    enemies.add(e, 'enabled').name('enemies enabled');
    R(enemies, e, 'count', 0, 20, 1, 'standing at once');
    R(enemies, e, 'radius', 2, 40, 0.5, 'spawn radius (m)');
    R(enemies, e, 'minRadius', 1, 20, 0.5, 'no closer than (m)');
    R(enemies, e, 'separation', 0.5, 6, 0.1, 'apart from each other (m)');
    R(enemies, e, 'height', 1, 3, 0.01, 'height (m)');
    R(enemies, e, 'corpseTime', 0, 30, 0.5, 'corpse stays (s)');
    R(enemies, e, 'dissolveTime', 0.1, 6, 0.1, 'burns away over (s)');
    R(enemies, e, 'respawnDelay', 0, 15, 0.1, 'respawn after (s)');
    enemies.add(e, 'watch').name('watch the player');
    R(enemies, e, 'watchRadius', 2, 40, 0.5, 'watch within (m)');
    R(enemies, e, 'turnRate', 0.000001, 0.2, 0.000001, 'turn follow');
    enemies.add(e, 'collide').name('block the player');
    R(enemies, e, 'bodyRadius', 0.1, 1.5, 0.01, 'body radius (m)');
    enemies
      .add({ respawn: () => this.hooks.onRespawnEnemies?.() }, 'respawn')
      .name('Respawn all');

    // Authored rather than imported — the export carries no textures at all.
    const look = enemies.addFolder('Look');
    const el = e.look;
    look.addColor(el, 'color').name('body colour');
    R(look, el, 'roughness', 0, 1, 0.01, 'roughness');
    R(look, el, 'metalness', 0, 1, 0.01, 'metalness');
    look.addColor(el, 'rimColor').name('rim colour');
    R(look, el, 'rimPower', 0.2, 8, 0.05, 'rim tightness');
    R(look, el, 'rimEmissive', 0, 8, 0.01, 'rim emissive');
    look.addColor(el, 'edgeColor').name('burn colour');
    R(look, el, 'edgeEmissive', 0, 20, 0.1, 'burn emissive');
    R(look, el, 'edgeWidth', 0.01, 0.5, 0.01, 'burn width');
    R(look, el, 'dissolveDetail', 1, 40, 0.5, 'burn detail');
    R(look, el, 'dissolveRise', 0, 1, 0.01, 'burn rises');

    // The ragdoll. `brace` is the one worth understanding: bone lengths alone
    // give a rope, and these extra constraints across the pelvis and chest are
    // what give the body a shape it is trying to keep as it falls.
    const doll = enemies.addFolder('Ragdoll');
    const r = e.ragdoll;
    R(doll, r, 'gravity', -60, -1, 0.5, 'gravity (m/s²)');
    R(doll, r, 'damping', 0, 0.9, 0.01, 'air drag /s');
    R(doll, r, 'iterations', 1, 20, 1, 'solver passes');
    R(doll, r, 'substeps', 1, 6, 1, 'substeps');
    R(doll, r, 'brace', 0, 1, 0.01, 'torso stiffness');
    R(doll, r, 'radius', 0.01, 0.4, 0.005, 'joint radius (m)');
    R(doll, r, 'friction', 0, 1, 0.01, 'ground friction');
    R(doll, r, 'bounce', 0, 0.8, 0.01, 'bounce');
    R(doll, r, 'sleep', 0, 0.5, 0.005, 'sleeps below');
  }

  /**
   * One melee move's three groups: who it goes to, when it lands, what it does.
   *
   * The numbers to reach for after watching a move once are the normalised
   * times — the blow connects *here*, control comes back *there*, and the warp
   * has that long to put the body where the animator assumed it was standing.
   * Everything else follows from those three.
   *
   * @param {import('lil-gui').GUI} parent
   * @param {object} config a `settings.kick`-shaped block
   * @param {string} title what the folder is called, hotkey included
   */
  _buildAttack(parent, config, title) {
    const folder = parent.addFolder(title);
    const R = Editor.range;

    folder.add(config, 'enabled').name('enabled');

    // Who the blow goes to. `range` and `cone` decide what can be locked at
    // all; `standoff` is the distance the strike is thrown from, and it is the
    // one that decides whether the foot lands on the chest or through it.
    const aim = folder.addFolder('Target & warp');
    R(aim, config, 'range', 0.5, 12, 0.05, 'lock range (m)');
    R(aim, config, 'cone', 20, 360, 1, 'lock cone (°)');
    R(aim, config, 'standoff', 0.4, 2.5, 0.01, 'strike from (m)');
    R(aim, config, 'maxWarp', 0, 12, 0.05, 'max step in (m)');
    R(aim, config, 'warpAt', 0.05, 0.9, 0.01, 'approach ends at');
    R(aim, config, 'turnAt', 0.05, 1, 0.01, 'turn done by');
    // Only the slide cut goes through the body rather than up to it, so these
    // two are on the block that asked for them rather than on every move.
    if ('passThrough' in config) {
      R(aim, config, 'passThrough', 0, 5, 0.05, 'ends past by (m)');
      R(aim, config, 'passAt', 0.1, 1, 0.01, 'pass ends at');
    }

    // The clip's own timeline. Every time here is normalised, so `timeScale`
    // rides over all of them: it changes how long the move takes without moving
    // where in it the blow lands.
    const timing = folder.addFolder('Timing');
    R(timing, config, 'hitAt', 0.05, 0.95, 0.01, 'blow connects at');
    R(timing, config, 'reach', 0.5, 4, 0.05, 'connects within (m)');
    R(timing, config, 'recoverAt', 0.3, 1, 0.01, 'control returns at');
    if ('timeScale' in config) R(timing, config, 'timeScale', 0.25, 3, 0.01, 'played at ×');
    R(timing, config, 'blendIn', 0.01, 0.6, 0.01, 'blend in (s)');
    R(timing, config, 'blendOut', 0.01, 0.8, 0.01, 'blend out (s)');

    // What the blow does. `spin` is the one with the least obvious name and the
    // most obvious effect: it is how much harder the shoulders are thrown than
    // the feet, which is the whole difference between sliding and folding.
    const impact = folder.addFolder('Impact');
    R(impact, config, 'impulse', 0, 25, 0.1, 'force (m/s)');
    R(impact, config, 'lift', 0, 15, 0.1, 'lift (m/s)');
    R(impact, config, 'spin', 0, 4, 0.05, 'upper body ×');
    R(impact, config, 'hitStop', 0, 0.3, 0.005, 'hit stop (s)');
    R(impact, config, 'hitStopScale', 0, 1, 0.01, 'hit stop time ×');
    R(impact, config, 'shake', 0, 1, 0.01, 'camera shake (m)');
    // A fact about the move, not about the body it lands on — which is why it
    // is a field here and not in the enemies' block.
    if ('slices' in config) impact.add(config, 'slices').name('cuts in half');
  }

  /**
   * The circle under a body in reach — see `vfx/TargetRings.js`.
   *
   * There is nothing here about *who* wears one: that is the two moves' own
   * lock range and cone above, and this only draws the answer. `falloff` is the
   * one to reach for — it is the exponent on the radius, so low is a glow that
   * fills the circle and high is a hard rim with nothing inside it.
   */
  _buildTargetRing(parent) {
    const folder = parent.addFolder('Target ring');
    const R = Editor.range;
    const t = settings.targetRing;

    folder.add(t, 'enabled').name('enabled');
    folder.addColor(t, 'color').name('colour');
    R(folder, t, 'radius', 0.2, 3, 0.01, 'radius (m)');
    R(folder, t, 'falloff', 0.2, 12, 0.1, 'edge falloff');
    R(folder, t, 'softness', 0.01, 0.6, 0.01, 'outer feather');
    R(folder, t, 'intensity', 0, 6, 0.05, 'brightness');
    R(folder, t, 'pulse', 0, 1, 0.01, 'breath depth');
    R(folder, t, 'pulseSpeed', 0, 12, 0.1, 'breath speed');
    R(folder, t, 'lift', 0, 0.2, 0.005, 'off the floor (m)');
    R(folder, t, 'fadeIn', 0.01, 1, 0.01, 'fade in (s)');
    R(folder, t, 'fadeOut', 0.01, 1, 0.01, 'fade out (s)');

    // The caps ride the ring's own fades, so there is nothing here but where
    // they sit and how big they are.
    const keys = folder.addFolder('Hotkeys over the head');
    keys.add(t.hotkeys, 'enabled').name('enabled');
    R(keys, t.hotkeys, 'lift', 0, 2, 0.01, 'above the head (m)');
    R(keys, t.hotkeys, 'scale', 0.5, 2.5, 0.05, 'size ×');
  }

  /**
   * The cut, the meat and the blood — see `combat/Enemy.js`.
   *
   * Everything here is live *except* the plane itself: `height` and `tilt` are
   * read once, at the moment of the blow, because a plane that moved afterwards
   * would slide up a corpse already lying in two pieces. Cut something new to
   * see those two move. Colours, the meat and the blood are all per-frame.
   *
   * The two multiplier groups are the ones worth playing with: `upper` is what
   * the top half takes of the move's own impulse, lift and spin, and `lower` is
   * what is left for a pair of legs. Give the lower half much of anything and
   * the body stops reading as cut and starts reading as two bodies that were
   * standing very close together.
   */
  _buildSlice(parent) {
    const folder = parent.addFolder('Slice & blood');
    const R = Editor.range;
    const s = settings.slice;

    folder.add(s, 'enabled').name('slicing enabled');

    const plane = folder.addFolder('The cut (read at the blow)');
    R(plane, s, 'height', 0.1, 0.9, 0.01, 'cuts at (× height)');
    R(plane, s, 'tilt', 0, 60, 1, 'tilt off level (°)');
    R(plane, s, 'separation', 0, 0.6, 0.01, 'halves part by (m)');
    R(plane, s, 'split', 0, 8, 0.05, 'driven apart at (m/s)');

    const halves = folder.addFolder('What each half takes');
    R(halves, s.upper, 'impulse', 0, 3, 0.05, 'top: force ×');
    R(halves, s.upper, 'lift', 0, 3, 0.05, 'top: lift ×');
    R(halves, s.upper, 'spin', 0, 3, 0.05, 'top: spin ×');
    R(halves, s.lower, 'impulse', 0, 2, 0.01, 'legs: force ×');
    R(halves, s.lower, 'lift', 0, 2, 0.01, 'legs: lift ×');
    R(halves, s.lower, 'spin', 0, 2, 0.01, 'legs: spin ×');

    // Turn this off and the torso falls through the legs, which is the clearest
    // way to see what it is doing.
    const hit = folder.addFolder('Halves against each other');
    const c = s.collide;
    hit.add(c, 'enabled').name('halves collide');
    R(hit, c, 'radius', 0, 0.3, 0.005, 'joint size (m)');
    R(hit, c, 'bounce', 0, 1, 0.01, 'bounce');
    R(hit, c, 'friction', 0, 1, 0.01, 'grip');
    R(hit, c, 'maxPush', 0.005, 0.3, 0.005, 'push cap /frame (m)');

    // The hollow the cut opens is the material's own back faces, painted as
    // meat — there is no cap geometry anywhere in this.
    const meat = folder.addFolder('The wound');
    meat.addColor(s, 'interiorColor').name('inside colour');
    R(meat, s, 'interiorEmissive', 0, 3, 0.01, 'inside glow');
    meat.addColor(s, 'edgeColor').name('cut line colour');
    R(meat, s, 'edgeEmissive', 0, 20, 0.1, 'cut line glow');
    R(meat, s, 'edgeWidth', 0.001, 0.08, 0.001, 'cut line width');

    const blood = folder.addFolder('Blood');
    const b = s.blood;
    blood.add(b, 'enabled').name('blood enabled');
    blood.addColor(b, 'color').name('blood colour');
    R(blood, b, 'brightness', 0, 4, 0.05, 'brightness');
    R(blood, b, 'burst', 0, 600, 5, 'droplets on the cut');
    R(blood, b, 'speed', 0, 15, 0.1, 'thrown at (m/s)');
    R(blood, b, 'spread', 0, 2, 0.01, 'spray spread');
    R(blood, b, 'drip', 0, 300, 1, 'stump drip (/s)');
    R(blood, b, 'dripSpeed', 0, 6, 0.05, 'drip speed (m/s)');
    R(blood, b, 'bleedTime', 0, 8, 0.1, 'bleeds for (s)');
    R(blood, b, 'size', 0.002, 0.15, 0.002, 'droplet size (m)');
    R(blood, b, 'sizeVariance', 0, 1, 0.01, 'size variance');
    R(blood, b, 'life', 0.1, 5, 0.05, 'droplet life (s)');
    R(blood, b, 'lifeVariance', 0, 0.95, 0.01, 'life variance');
    R(blood, b, 'gravity', -60, 0, 0.5, 'gravity (m/s²)');
    R(blood, b, 'drag', 0.02, 4, 0.01, 'air drag /s');
    R(blood, b, 'stretch', 0, 0.4, 0.005, 'motion streak');
    R(blood, b, 'maxStretch', 1, 20, 0.5, 'streak ceiling');
    R(blood, b, 'fade', 0.02, 1, 0.01, 'fades over (× life)');
  }

  /**
   * The character screen's set.
   *
   * Same contract as everything above — `StudioStage` re-resolves the whole rig
   * from these fields every frame, so a slider moved with the screen open
   * re-lights it on the next one. The screen has to be up (`Tab`) to see any of
   * it; the play stage next door reads none of these.
   */
  _buildStudio() {
    const folder = this.gui.addFolder('Character screen');
    const s = settings.studio;
    const R = Editor.range;

    R(folder, s, 'turntable', -0.3, 0.3, 0.005, 'turntable (rev/s)').listen();

    const camera = folder.addFolder('Camera');
    R(camera, s.camera, 'fov', 15, 80, 0.5, 'field of view');
    R(camera, s.camera, 'targetHeight', 0, 2.2, 0.01, 'look at (m)');
    R(camera, s.camera, 'minDistance', 0.2, 3, 0.05, 'min distance');
    R(camera, s.camera, 'maxDistance', 1, 20, 0.1, 'max distance');
    R(camera, s.camera, 'autoOrbit', -0.2, 0.2, 0.005, 'camera drift (rev/s)');

    // Key and fill are each a spot plus a softbox at the same angle; moving the
    // angle moves both, which is what keeps them reading as one source.
    const key = folder.addFolder('Key');
    const l = s.lights;
    R(key, l, 'keyIntensity', 0, 400, 1, 'spot (cd)');
    key.addColor(l, 'keyColor').name('colour');
    R(key, l, 'keyAzimuth', 0, Math.PI * 2, 0.01, 'azimuth');
    R(key, l, 'keyElevation', 0.05, 1.5, 0.01, 'elevation');
    R(key, l, 'keyDistance', 1, 10, 0.05, 'distance (m)');
    R(key, l, 'keyAngle', 0.1, 1.4, 0.01, 'cone');
    R(key, l, 'keyPenumbra', 0, 1, 0.01, 'penumbra');
    R(key, l, 'keySoftbox', 0, 20, 0.1, 'softbox (nits)');
    R(key, l, 'keySoftboxSize', 0.2, 8, 0.1, 'softbox size (m)');

    const fill = folder.addFolder('Fill');
    R(fill, l, 'fillIntensity', 0, 12, 0.05, 'intensity (nits)');
    fill.addColor(l, 'fillColor').name('colour');
    R(fill, l, 'fillAzimuth', 0, Math.PI * 2, 0.01, 'azimuth');
    R(fill, l, 'fillElevation', 0.05, 1.5, 0.01, 'elevation');
    R(fill, l, 'fillDistance', 1, 10, 0.05, 'distance (m)');
    R(fill, l, 'fillSize', 0.2, 8, 0.1, 'panel size (m)');

    const edges = folder.addFolder('Rim, kicker & hair');
    R(edges, l, 'rimIntensity', 0, 600, 1, 'rim (cd)');
    edges.addColor(l, 'rimColor').name('rim colour');
    R(edges, l, 'rimAzimuth', 0, Math.PI * 2, 0.01, 'rim azimuth');
    R(edges, l, 'rimElevation', 0.05, 1.5, 0.01, 'rim elevation');
    R(edges, l, 'rimDistance', 1, 10, 0.05, 'rim distance (m)');
    R(edges, l, 'kickerIntensity', 0, 400, 1, 'kicker (cd)');
    edges.addColor(l, 'kickerColor').name('kicker colour');
    R(edges, l, 'kickerAzimuth', 0, Math.PI * 2, 0.01, 'kicker azimuth');
    R(edges, l, 'kickerElevation', 0.05, 1.5, 0.01, 'kicker elevation');
    R(edges, l, 'kickerDistance', 1, 10, 0.05, 'kicker distance (m)');
    R(edges, l, 'topIntensity', 0, 300, 1, 'hair light (cd)');
    edges.addColor(l, 'topColor').name('hair colour');

    const ambient = folder.addFolder('Ambient & shadow');
    R(ambient, l, 'ambientIntensity', 0, 1, 0.005, 'ambient');
    ambient.addColor(l, 'ambientColor').name('ambient colour');
    R(ambient, l, 'envIntensity', 0, 3, 0.01, 'env (IBL)');
    R(ambient, l, 'shadowRadius', 0, 12, 0.1, 'shadow softness');
    R(ambient, l, 'shadowBias', -0.01, 0.001, 0.0001, 'shadow bias');
    R(ambient, l, 'shadowNormalBias', 0, 0.1, 0.001, 'normal bias');

    const stage = folder.addFolder('Set');
    const st = s.stage;
    stage.addColor(st, 'backdropTop').name('backdrop top');
    stage.addColor(st, 'backdropBottom').name('backdrop bottom');
    stage.addColor(st, 'backdropGlow').name('halo colour');
    R(stage, st, 'glowStrength', 0, 3, 0.01, 'halo strength');
    R(stage, st, 'glowSpread', 0, 1, 0.01, 'halo spread');
    stage.addColor(st, 'floorColor').name('floor colour');
    R(stage, st, 'floorRoughness', 0.02, 1, 0.01, 'floor roughness');
    R(stage, st, 'floorMetalness', 0, 1, 0.01, 'floor metalness');
    R(stage, st, 'floorRadius', 1, 8, 0.05, 'plinth radius (m)');
    stage.addColor(st, 'ringColor').name('ring colour');
    R(stage, st, 'ringIntensity', 0, 6, 0.01, 'ring intensity');
    R(stage, st, 'contactShadow', 0, 2, 0.01, 'contact shadow');
    R(stage, st, 'dust', 0, 3, 0.01, 'studio haze');

    const post = folder.addFolder('Grade');
    const p = s.post;
    post.add(p, 'enabled').name('enabled');
    R(post, p, 'exposure', 0.1, 3, 0.01, 'exposure');
    R(post, p, 'bloomStrength', 0, 3, 0.01, 'bloom intensity');
    R(post, p, 'bloomRadius', 0, 1.5, 0.01, 'bloom radius');
    R(post, p, 'bloomThreshold', 0, 2, 0.01, 'bloom threshold');
    R(post, p, 'contrast', 0.5, 2, 0.01, 'contrast');
    R(post, p, 'saturation', 0, 2.5, 0.01, 'saturation');
    R(post, p, 'temperature', -0.5, 0.5, 0.01, 'temperature');
    R(post, p, 'vignette', 0, 1.5, 0.01, 'vignette');
    R(post, p, 'chromaticAberration', 0, 3, 0.01, 'chromatic aberration');
    R(post, p, 'grain', 0, 0.2, 0.001, 'film grain');
  }

  dispose() {
    this.gui.destroy();
  }
}
