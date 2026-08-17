import {
  AxesHelper,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  SkeletonHelper,
  SphereGeometry,
  Vector2,
  Vector3
} from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

import { settings } from '../config/settings.js';
import { AssetLoader } from '../loaders/AssetLoader.js';
import { StudioStage } from '../world/StudioStage.js';
import { StudioCamera } from './StudioCamera.js';
import { EquipmentLibrary } from '../equipment/EquipmentLibrary.js';
import { EquipmentManager } from '../equipment/EquipmentManager.js';
import { ITEMS } from '../equipment/EquipmentCatalog.js';
import { CharacterScreenUI } from '../ui/CharacterScreenUI.js';
import { LAYER } from '../core/Layers.js';

const _worldPosition = new Vector3();
const _worldScale = new Vector3();
const _pointer = new Vector2();

/**
 * Yaw the body is parked at on entry.
 *
 * Set against the camera's opening azimuth (`StudioCamera#reset`) rather than
 * chosen on its own: the two are ~35° apart, which is the three-quarter the
 * armour reads best at. Straight on flattens the shoulder line, and profile
 * hides half of what is being equipped.
 */
const ENTRY_FACING = 1.25;

/**
 * The character screen: a second stage, for looking at the body and dressing it.
 *
 * It is a *mode*, not a scene graph trick. Entering moves the character out of
 * the play scene and into the studio's, swaps the camera, the lighting and the
 * grade, and hands the pointer to an inspection orbit; leaving puts all of it
 * back, including where the character was standing. Nothing is duplicated — the
 * same skeleton, the same mixer and the same equipment mounts are on screen in
 * both places, which is what makes gear tuned here already correct out there.
 *
 * What it owns:
 *
 *  - `stage` — the lit set (see `world/StudioStage.js`)
 *  - `camera` — a free orbit that pans and dollies (see `StudioCamera.js`)
 *  - `equipment` — what is worn and where (see `equipment/EquipmentManager.js`)
 *  - a gizmo, a bone marker and a skeleton overlay: the three things that turn
 *    "type an offset and squint" into direct manipulation
 *  - the panel, which is plain DOM (see `ui/CharacterScreenUI.js`)
 */
export class CharacterScreen {
  /**
   * @param {object} context
   * @param {import('../core/Renderer.js').Renderer} context.renderer
   * @param {HTMLCanvasElement} context.canvas
   * @param {import('../animation/CharacterController.js').CharacterController} context.character
   * @param {import('three').Scene} context.worldScene where the character lives otherwise
   * @param {import('three').Texture|null} context.envMap the HDR probe, for spec response
   * @param {(message: string) => void} [context.onToast]
   * @param {() => void} [context.onExit]
   */
  constructor({ renderer, canvas, character, worldScene, envMap, onToast, onExit }) {
    this.renderer = renderer;
    this.canvas = canvas;
    this.character = character;
    this.worldScene = worldScene;
    this.onToast = onToast ?? (() => {});
    this.onExit = onExit ?? (() => {});

    this.active = false;
    this.elapsed = 0;

    this.stage = new StudioStage(renderer);
    this.stage.setEnvironment(envMap);
    this.camera = new StudioCamera(canvas);

    /**
     * Equipment loads through a loader of its own.
     *
     * The boot loader is done and disposed by the time this screen exists, and
     * its progress stream belongs to the loading veil. Keeping a second one here
     * means an item downloaded three minutes in cannot disturb either.
     */
    this.assets = new AssetLoader();
    this.library = new EquipmentLibrary(this.assets, character.materialLibrary);
    this.equipment = new EquipmentManager(character, this.library, {
      onChange: (event) => this._onEquipmentChange(event)
    });

    this.selected = null;
    this.preview = 'idle';
    /**
     * What the gizmo is holding: the selected piece, or the fire's emitter box.
     *
     * The box is a child of the weapon, so the *same* gizmo in the same local
     * space does both jobs — pointing it at the box is a one-line change of
     * target rather than a second manipulator.
     * @type {'item'|'fire'}
     */
    this.gizmoTarget = 'item';
    /** @type {import('../vfx/WeaponFire.js').WeaponFire|null} */
    this.weaponFire = null;
    /** The joint marker is on by default: it is the answer to "where is that bone". */
    this.markerVisible = true;
    this._warmed = false;
    /** Placement the world stage should get back when the screen closes. */
    this._restore = null;

    this._buildGizmo();
    this._buildOverlays();

    this.ui = new CharacterScreenUI({
      items: ITEMS,
      equipment: this.equipment,
      state: () => ({
        selected: this.selected,
        gizmoMode: this.gizmoMode,
        preview: this.preview,
        fireBox: this.fireBoxEditing
      }),
      hooks: this._uiHooks()
    });
    this.ui.setBones(this._boneOptions());

    this._bindPicking();
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  _buildGizmo() {
    // Off to begin with: the handles sit over the piece being judged, and the
    // screen is opened to *look* at the body at least as often as to drag it.
    // Move/Rotate are one click away in the bar.
    this.gizmoMode = 'none';
    this.transform = new TransformControls(this.camera.camera, this.canvas);
    this.transform.size = 0.7;
    this.transform.space = 'local';
    this.transform.enabled = false;

    // Dragging the gizmo must not also orbit the camera underneath it.
    this.transform.addEventListener('dragging-changed', (event) => {
      this.camera.setEnabled(!event.value);
      // While the box is under the pointer, settings follow the object rather
      // than the other way round — see `WeaponFire#boxLocked`.
      if (this.weaponFire && this.gizmoTarget === 'fire') {
        this.weaponFire.boxLocked = event.value;
      }
    });

    // The gizmo writes the object directly, so the panel's numbers are read
    // back off it rather than predicted.
    this.transform.addEventListener('objectChange', () => {
      if (this.gizmoTarget === 'fire') this.weaponFire?.readBackBox();
      else if (this.selected) this.equipment.readBack(this.selected);
    });

    this.gizmoHelper = this.transform.getHelper();
    this.gizmoHelper.layers.set(LAYER.WORLD);
    this.gizmoHelper.traverse((node) => node.layers.set(LAYER.WORLD));
    this.stage.scene.add(this.gizmoHelper);
  }

  /** The bone marker and the skeleton overlay — both off until asked for. */
  _buildOverlays() {
    this.marker = new AxesHelper(0.12);
    this.marker.material.depthTest = false;
    this.marker.material.transparent = true;
    this.marker.material.opacity = 0.9;
    this.marker.renderOrder = 999;
    this.marker.visible = false;
    this.marker.layers.set(LAYER.WORLD);

    this.markerDot = new Mesh(
      new SphereGeometry(0.012, 12, 8),
      new MeshBasicMaterial({ color: 0x7fd4ff, depthTest: false, toneMapped: false })
    );
    this.markerDot.renderOrder = 999;
    this.markerDot.layers.set(LAYER.WORLD);
    this.marker.add(this.markerDot);
    this.stage.scene.add(this.marker);

    this.skeleton = null; // built on first use — it needs the loaded rig
  }

  _ensureSkeleton() {
    if (this.skeleton || !this.character.model) return;
    this.skeleton = new SkeletonHelper(this.character.model);
    this.skeleton.material.depthTest = false;
    this.skeleton.material.transparent = true;
    this.skeleton.material.opacity = 0.55;
    this.skeleton.renderOrder = 998;
    this.skeleton.visible = false;
    this.skeleton.layers.set(LAYER.WORLD);
    this.stage.scene.add(this.skeleton);
  }

  /**
   * The joints the panel offers.
   *
   * Every bone the rig actually carries, under its short name, minus the finger
   * chains — fifty joints nobody attaches a scabbard to would bury the four that
   * matter. `EquipmentCatalog.ATTACH_POINTS` supplies the order they appear in.
   */
  _boneOptions() {
    const names = new Set();
    for (const name of this.character.bones.keys()) {
      // The rig indexes every joint twice, raw and namespace-stripped. Stripping
      // again here is idempotent and works either way round, which matters for a
      // rig whose exporter wrote no namespace at all.
      const short = name.split(':').pop().replace(/^mixamorig/i, '');
      if (!short) continue;
      if (/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(short)) continue;
      names.add(short);
    }
    return [...names].sort();
  }

  /** Pick an attached item by clicking it. A drag is an orbit, not a click. */
  _bindPicking() {
    this.raycaster = new Raycaster();
    // Only the equipment layer matters; the body and the set are not selectable.
    let downAt = null;

    this._onPointerDown = (event) => {
      downAt = { x: event.clientX, y: event.clientY };
    };

    this._onPointerUp = (event) => {
      if (!this.active || !downAt) return;
      const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
      downAt = null;
      if (moved > 4 || this.transform.dragging) return;

      const rect = this.canvas.getBoundingClientRect();
      _pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
      this.raycaster.setFromCamera(_pointer, this.camera.camera);

      for (const [id, slot] of this.equipment.slots) {
        if (this.raycaster.intersectObject(slot.model, true).length) {
          this.select(id);
          return;
        }
      }
    };

    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
  }

  /* ------------------------------------------------------------------ */
  /* mode                                                                */
  /* ------------------------------------------------------------------ */

  get postLook() {
    return settings.studio.post;
  }

  toggle() {
    if (this.active) this.exit();
    else this.enter();
  }

  /**
   * Take the character out of the world and onto the set.
   *
   * The world's placement is remembered rather than reset, so closing the
   * screen puts the body back exactly where the player left it — including its
   * heading, which is a setting the studio's turntable is about to write to.
   */
  enter() {
    if (this.active) return;
    this.active = true;

    this._restore = {
      position: this.character.position.clone(),
      facing: settings.character.facing,
      spin: settings.character.spin
    };

    // The world turntable and the studio's would otherwise both drive `facing`.
    settings.character.spin = 0;
    this.character.jump?.cancel();
    this.character.hop?.cancel();
    for (const move of this.character.attacks ?? []) move.cancel();
    // Whatever the body was doing out there, it arrives doing what the Motion
    // buttons say — which on the first entry is a plain idle, and on a second
    // one is whatever was left selected, frozen included.
    this.setPreview(this.preview);
    this.character.resetPlacement();
    this.character.position.set(0, 0, 0);
    settings.character.facing = ENTRY_FACING;

    this.stage.scene.add(this.character.root);
    this._ensureSkeleton();

    this.camera.reset();
    this.camera.setEnabled(true);
    this.transform.camera = this.camera.camera;
    this._syncGizmo();

    this.ui.show();
    this.ui.refresh();

    // Only now, with the screen up and interactive, is it worth pulling the
    // rest of the catalog down.
    if (!this._warmed) {
      this._warmed = true;
      this.library.warm(ITEMS).then(() => this.ui.refresh());
    }
  }

  /** Put the body, the camera and the controls back. */
  exit() {
    if (!this.active) return;
    this.active = false;

    // The box wireframe is an editing aid, not part of the effect — it does not
    // follow the character out onto the stage.
    if (this.fireBoxEditing) this.setFireBoxEditing(false);

    this.transform.detach();
    this.transform.enabled = false;
    this.camera.setEnabled(false);
    this.ui.hide();

    this.worldScene.add(this.character.root);

    if (this._restore) {
      this.character.position.copy(this._restore.position);
      settings.character.facing = this._restore.facing;
      settings.character.spin = this._restore.spin;
      this.character.setFacing(this._restore.facing);
      this._restore = null;
    }

    this.onExit();
  }

  /* ------------------------------------------------------------------ */
  /* frame                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt simulation seconds (0 while paused)
   * @param {number} raw real seconds — the camera and the set keep moving
   */
  update(dt, raw) {
    this.elapsed += raw;

    // The body's own turntable, advanced through `facing` like every other
    // heading in the project so nothing else has to know it is spinning.
    if (settings.studio.turntable !== 0 && dt > 0) {
      settings.character.facing += settings.studio.turntable * Math.PI * 2 * dt;
    }

    // `stopped` holds the pose by handing the body no time — the mixer still
    // runs, so the frozen frame is applied and the rig keeps its skinning, but
    // nothing in it advances. Everything else here is still given `raw`: the
    // turntable above, the camera and the set all keep moving around a body
    // that does not.
    this.character.update(this.preview === 'stopped' ? 0 : dt);
    this.equipment.update();

    this.camera.update(raw);
    this.stage.update(this.camera.camera, this.elapsed);

    this._updateMarker();

    this.stage.contactShadows.setPosition(0, 0);
    this.stage.renderContactShadows();
  }

  /** Park the marker on the selected slot's joint, at world scale. */
  _updateMarker() {
    const slot = this.selected ? this.equipment.get(this.selected) : null;
    const bone = slot?.bone;
    if (!bone || !this.markerVisible) {
      this.marker.visible = false;
      return;
    }

    bone.matrixWorld.decompose(_worldPosition, this.marker.quaternion, _worldScale);
    this.marker.position.copy(_worldPosition);
    this.marker.scale.setScalar(1);
    this.marker.visible = true;
  }

  resize(width, height, pixelRatio) {
    this.camera.resize(width, height);
    this.stage.setPixelRatio(pixelRatio);
  }

  /* ------------------------------------------------------------------ */
  /* selection & framing                                                 */
  /* ------------------------------------------------------------------ */

  select(id) {
    this.selected = this.equipment.isEquipped(id) ? id : null;
    this._syncGizmo();
    this.ui.refresh();
  }

  setGizmoMode(mode) {
    this.gizmoMode = mode;
    this._syncGizmo();
    this.ui.refresh();
  }

  /** Hand the effect over once the app has built it. */
  setWeaponFire(fire) {
    this.weaponFire = fire;
    this.ui.refresh();
  }

  /**
   * Point the gizmo at the fire's emitter box, and draw it.
   *
   * The wireframe follows the target rather than being its own toggle: a box
   * being dragged that cannot be seen is the one state nobody wants, and the
   * editor's own `show` checkbox is still there for looking at it from the play
   * stage.
   */
  setFireBoxEditing(on) {
    this.gizmoTarget = on ? 'fire' : 'item';
    settings.fire.box.show = on;
    // Scale only ever meant anything for the box; drop back to move on the way out.
    if (!on && this.gizmoMode === 'scale') this.gizmoMode = 'translate';
    this._syncGizmo();
    this.ui.refresh();
  }

  get fireBoxEditing() {
    return this.gizmoTarget === 'fire';
  }

  _syncGizmo() {
    const fire = this.gizmoTarget === 'fire' ? this.weaponFire : null;
    const slot = this.selected ? this.equipment.get(this.selected) : null;
    // The box only exists once the effect has bound itself to an equipped
    // weapon; until then there is nothing under the gizmo to hold.
    const target = fire ? (fire.gizmoTarget.parent ? fire.gizmoTarget : null) : slot?.model;

    // `TransformControls` listens on the shared canvas, so an attached gizmo is
    // live whether or not its helper is being drawn. Off the screen that means a
    // drag meant for the world camera would grab the selected piece and throw it
    // somewhere — hence nothing is ever attached while the screen is closed.
    // `enter()` calls back through here, so the selection survives the round trip.
    if (!this.active || !target || this.gizmoMode === 'none') {
      this.transform.detach();
      this.transform.enabled = false;
      return;
    }
    this.transform.mode = this.gizmoMode;
    this.transform.enabled = true;
    this.transform.attach(target);
  }

  /** @param {'full'|'bust'|'head'|'item'} preset */
  frame(preset) {
    const height = this.character.height || 1.78;

    if (preset === 'item') {
      const slot = this.selected ? this.equipment.get(this.selected) : null;
      if (!slot) {
        this.onToast('Select a piece first');
        return;
      }
      slot.model.getWorldPosition(_worldPosition);
      this.camera.flyTo(_worldPosition, 0.6);
      return;
    }

    const frames = {
      full: [height * 0.52, height * 1.55],
      bust: [height * 0.82, height * 0.62],
      head: [height * 0.93, height * 0.3]
    };
    const [y, distance] = frames[preset] ?? frames.full;
    this.camera.flyTo(_worldPosition.set(0, y, 0), distance);
  }

  /**
   * Stopped / idle / walk / run, so gear can be judged still *or* moving.
   *
   * `stopped` is not a fourth clip — it is the idle, snapped to its first frame
   * and then denied any time at all (see `update`). A breathing idle is the
   * right thing to judge a scabbard's swing against and the wrong thing to
   * judge its *seat* against: the shoulder it is resting on is moving a
   * centimetre either way, so half a millimetre of penetration comes and goes
   * while the eye is on it. Frozen, what is on screen is what will be there.
   */
  setPreview(name) {
    const locomotion = this.character.locomotion;
    if (!locomotion) return;
    const speeds = {
      stopped: 0,
      idle: 0,
      walk: settings.locomotion.walkSpeed,
      run: settings.locomotion.runSpeed
    };
    this.preview = name;
    locomotion.setSpeed(speeds[name] ?? 0);
    if (name === 'stopped') locomotion.rest();
    this.ui.refresh();
  }

  /* ------------------------------------------------------------------ */

  _onEquipmentChange(event) {
    if (event.type === 'equipped') {
      this.selected = event.id;
      this._syncGizmo();
    }
    if (event.type === 'unequipped' && this.selected === event.id) {
      this.selected = null;
      this._syncGizmo();
    }
    // A bone change re-parents the mount, so the gizmo has to follow it — but
    // never mid-drag: this event is also what the gizmo's own writes raise, and
    // re-attaching under the pointer would drop the drag it came from.
    if (event.type === 'placed' && this.selected === event.id && !this.transform.dragging) {
      this._syncGizmo();
    }
    this.ui.refresh();
  }

  /** Everything the panel can ask for. */
  _uiHooks() {
    return {
      onToggleItem: async (id) => {
        const equipping = !this.equipment.isEquipped(id);
        await this.equipment.toggle(id);
        if (!equipping || !this.equipment.isEquipped(id)) return;
        this.select(id);
        // Equipment wears the body's materials but not its skinning, so the
        // first attach needs a program the body's copy cannot stand in for.
        // Compiling it here costs a promise; not compiling it costs a hitch on
        // the frame the piece appears.
        await this.renderer.gl.compileAsync(this.stage.scene, this.camera.camera);
      },
      onSelect: (id) => this.select(id),
      onBone: (id, bone) => this.equipment.setBone(id, bone),
      onPlacement: (id, patch) => this.equipment.setPlacement(id, patch),
      onMirror: (id, axis, on) => this.equipment.setMirror(id, axis, on),
      onResetPlacement: (id) => this.equipment.resetPlacement(id),
      onFrame: (preset) => this.frame(preset),
      onGizmo: (mode) => this.setGizmoMode(mode),
      onPreview: (name) => this.setPreview(name),
      onSkeleton: (on) => {
        this._ensureSkeleton();
        if (this.skeleton) this.skeleton.visible = on;
      },
      onMarker: (on) => {
        this.markerVisible = on;
      },
      onFire: (on) => {
        settings.fire.enabled = on;
      },
      onFireBox: (on) => {
        this.setFireBoxEditing(on);
        if (on) {
          this.onToast(
            'Fire box — Move, Rotate and Scale drag the volume the flames come off'
          );
        }
      },
      onRefitFireBox: () => {
        this.onToast(
          this.weaponFire?.refit()
            ? 'Fire box refitted to the weapon'
            : 'Nothing equipped to fit the box to'
        );
      },
      onTurntable: (value) => {
        settings.studio.turntable = value;
      },
      onSave: () => {
        this.onToast(
          this.equipment.save() ? 'Loadout saved' : 'Could not save — storage is unavailable'
        );
      },
      onLoad: async () => {
        const found = await this.equipment.restore();
        this.onToast(found ? 'Loadout restored' : 'No saved loadout');
      },
      onClear: () => {
        this.equipment.clear();
        this.onToast('Everything off — locked gear stays on');
      },
      onExport: () => this._download(),
      onCopy: async () => {
        const text = this.equipment.snippet();
        try {
          await navigator.clipboard.writeText(text);
          this.onToast('Placements copied — paste over the catalog defaults');
        } catch {
          console.log(text);
          this.onToast('Clipboard blocked — the snippet is in the console');
        }
      },
      onExit: () => this.exit()
    };
  }

  /** The loadout as a file, for keeping outside the browser. */
  _download() {
    const blob = new Blob([JSON.stringify(this.equipment.serialize(), null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'loadout.json';
    link.click();
    URL.revokeObjectURL(url);
    this.onToast('loadout.json exported');
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.transform.detach();
    this.transform.dispose();
    this.equipment.dispose();
    this.library.dispose();
    this.assets.dispose();
    this.ui.dispose();
    this.camera.dispose();
    this.stage.dispose();
    this.marker.geometry?.dispose();
    this.marker.material?.dispose();
    this.markerDot.geometry.dispose();
    this.markerDot.material.dispose();
    this.skeleton?.dispose();
  }
}
