import { Group, MathUtils, Matrix4, Vector3 } from 'three';
import {
  defaultItems,
  defaultPlacement,
  findItem,
  ITEMS,
  normaliseMirror
} from './EquipmentCatalog.js';

const STORAGE_KEY = 'character-equipment.loadout.v1';
/** Change kinds that alter what would be written — anything else is UI noise. */
const PERSISTED_EVENTS = new Set(['equipped', 'unequipped', 'placed']);
const SAVE_DELAY_MS = 400;
const _scale = new Vector3();
const _reflect = new Matrix4();
const _mirror = new Matrix4();
const _local = new Matrix4();
const _bodyInverse = new Matrix4();

/**
 * What the character is currently wearing, and where each piece sits.
 *
 * One equipped item is one *slot*: a mount parented to a skeleton joint, the
 * model under it, and the placement (bone, offset, rotation, scale) that put it
 * there. Because the mount hangs off the bone rather than off the root, gear
 * rides the animation for free — there is no per-frame work here beyond keeping
 * one scale honest.
 *
 * ## The mount, and why it exists
 *
 * The rig is a Mixamo FBX: authored in centimetres, scaled by `fbxScale` and
 * then again to land on `settings.character.targetHeight`. A joint's world scale
 * is therefore something like 0.01, and an object parented straight to it would
 * arrive a hundred times too small with offsets to match — "move it 2 cm along
 * the palm" would be a value of 2, and every number would silently change
 * meaning the moment anyone touched the character's height.
 *
 * The mount cancels exactly that: its scale is the inverse of the joint's world
 * scale, so **everything inside it is in metres**, whatever the rig was exported
 * at. That is what makes the offsets in `EquipmentCatalog` real measurements and
 * what keeps them valid when `targetHeight` moves.
 *
 * ## Mirroring
 *
 * A slot can be *folded* through the body's centre on any of the three axes —
 * a scabbard tuned on the left hip becomes the right-hip one, handed and all,
 * without a second entry in the catalog. There is only ever one of each piece:
 * the mirror is a reflection wrapped around the mount (`_reflectMount`), not a
 * copy beside it, so the placement, the gizmo and the joint it rides all go on
 * meaning exactly what they did.
 */
export class EquipmentManager {
  /**
   * @param {import('../animation/CharacterController.js').CharacterController} character
   * @param {import('./EquipmentLibrary.js').EquipmentLibrary} library
   * @param {{onChange?: (event: {type: string, id: string}) => void}} [hooks]
   */
  constructor(character, library, hooks = {}) {
    this.character = character;
    this.library = library;
    this.hooks = hooks;

    /** item id → slot. Insertion ordered, which is the order the screen lists. */
    this.slots = new Map();
    /** item ids whose model is in flight, for the card's spinner. */
    this.pending = new Set();
    /**
     * Ids taken off again while their model was still downloading.
     *
     * A set rather than a single id, and cleared by the *next* equip of the same
     * id rather than only by the load it cancelled: a card clicked three times
     * during one download would otherwise leave a cancellation standing that
     * ate the request the user actually meant.
     */
    this._cancelled = new Set();

    this._modelScale = 0;
    /**
     * Whether every change writes itself to storage.
     *
     * On, because the screen is where gear is *placed* and the world is where it
     * is judged: a placement dialled in on the set has to be the one the body
     * walks out with, this run and the next. The Save button stays — it is now
     * only a way to say "now" — and `restore()` is what reads this back.
     */
    this.autosave = true;
    this._saveTimer = 0;
  }

  /* ------------------------------------------------------------------ */
  /* equipping                                                           */
  /* ------------------------------------------------------------------ */

  isEquipped(id) {
    return this.slots.has(id);
  }

  isPending(id) {
    return this.pending.has(id);
  }

  get(id) {
    return this.slots.get(id) ?? null;
  }

  /**
   * Put an item on the body, loading its model the first time.
   *
   * @param {string} id catalog item id
   * @param {import('./EquipmentCatalog.js').EquipmentPlacement} [placement]
   *   where to put it; the catalog's own defaults when omitted
   * @returns {Promise<object|null>} the slot, or null if the item never loaded
   */
  async equip(id, placement) {
    const item = findItem(id);
    if (!item) {
      console.warn(`[EquipmentManager] no catalog item "${id}"`);
      return null;
    }
    if (this.slots.has(id)) return this.slots.get(id);

    // This request supersedes any cancellation still standing for this item.
    this._cancelled.delete(id);
    this.pending.add(id);
    this._emit('pending', id);

    let model = this.library.instance(item);
    if (!model) {
      try {
        await this.library.load(item);
      } catch (error) {
        this.pending.delete(id);
        this._emit('failed', id);
        console.error(`[EquipmentManager] "${id}" failed to load`, error);
        return null;
      }
      model = this.library.instance(item);
    }

    this.pending.delete(id);
    // Unequipped again while the file was in flight.
    if (!model || this._cancelled.has(id)) {
      this._cancelled.delete(id);
      this._emit('changed', id);
      return null;
    }

    const mount = new Group();
    mount.name = `Mount:${id}`;
    mount.add(model);

    const slot = {
      item,
      model,
      mount,
      bone: null,
      placement: placement ? clonePlacement(placement) : defaultPlacement(item)
    };

    this.slots.set(id, slot);
    this._attach(slot);
    this._emit('equipped', id);
    return slot;
  }

  /** Take an item off and release its instance. */
  unequip(id) {
    if (this.pending.has(id)) {
      // The load is already out; remember to drop the result when it lands.
      this._cancelled.add(id);
      this.pending.delete(id);
      this._emit('changed', id);
      return;
    }

    const slot = this.slots.get(id);
    if (!slot) return;

    slot.mount.parent?.remove(slot.mount);
    // Geometry and materials belong to the library's template; only the clone's
    // scene nodes go, and those are plain objects the GC can have.
    this.slots.delete(id);
    this._emit('unequipped', id);
  }

  /** Whether the catalog marks this piece as one the screen cannot take off. */
  isLocked(id) {
    return findItem(id)?.locked === true;
  }

  /** Equip if it is off, unequip if it is on — locked pieces only ever go on. */
  toggle(id) {
    if (this.slots.has(id) || this.pending.has(id)) {
      if (this.isLocked(id)) return Promise.resolve(this.slots.get(id) ?? null);
      this.unequip(id);
      return Promise.resolve(null);
    }
    return this.equip(id);
  }

  /* ------------------------------------------------------------------ */
  /* placement                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Move an equipped item to a different joint, keeping its offsets.
   * @returns {boolean} false if this rig has no such joint
   */
  setBone(id, boneName) {
    const slot = this.slots.get(id);
    if (!slot) return false;
    if (!this.character.getBone(boneName)) {
      console.warn(`[EquipmentManager] no bone named "${boneName}" on this rig`);
      return false;
    }
    slot.placement.bone = boneName;
    this._attach(slot);
    this._emit('placed', id);
    return true;
  }

  /**
   * Patch an item's offset, rotation or scale.
   *
   * @param {string} id
   * @param {{position?: number[], rotation?: number[], scale?: number}} patch
   *   position in metres, rotation in degrees
   */
  setPlacement(id, patch) {
    const slot = this.slots.get(id);
    if (!slot) return;
    const placement = slot.placement;

    if (patch.position) placement.position = [...patch.position];
    if (patch.rotation) placement.rotation = [...patch.rotation];
    if (typeof patch.scale === 'number') placement.scale = patch.scale;

    this._applyPlacement(slot);
    this._emit('placed', id);
  }

  /**
   * Read the mount's live transform back into the placement.
   *
   * This is the gizmo's return path: `TransformControls` writes the object
   * directly, so the numbers the panel shows are recovered from it rather than
   * predicted. Scale is left alone — the gizmo never touches it here.
   */
  readBack(id) {
    const slot = this.slots.get(id);
    if (!slot) return;
    const node = slot.model;

    slot.placement.position = [node.position.x, node.position.y, node.position.z];
    slot.placement.rotation = [
      MathUtils.radToDeg(node.rotation.x),
      MathUtils.radToDeg(node.rotation.y),
      MathUtils.radToDeg(node.rotation.z)
    ];
    this._emit('placed', id);
  }

  /** Put an item back where the catalog says it goes. */
  resetPlacement(id) {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.placement = defaultPlacement(slot.item);
    this._attach(slot);
    this._emit('placed', id);
  }

  /* ------------------------------------------------------------------ */
  /* mirroring                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Fold an item through the body's centre on one axis, or unfold it.
   *
   * The piece moves; nothing is duplicated. Several axes at once compose into
   * the single reflection they describe, which is still one piece.
   *
   * @param {string} id
   * @param {0|1|2} axis 0 = X (left/right), 1 = Y (up/down), 2 = Z (front/back)
   * @param {boolean} on
   */
  setMirror(id, axis, on) {
    const slot = this.slots.get(id);
    if (!slot || axis < 0 || axis > 2) return;
    const mirror = (slot.placement.mirror ??= [false, false, false]);
    if (mirror[axis] === on) return;
    mirror[axis] = on;
    this._syncMirrors(slot);
    this._emit('placed', id);
  }

  /** Which axes this item is currently reflected on. */
  getMirror(id) {
    return normaliseMirror(this.slots.get(id)?.placement.mirror);
  }

  /** Whether any axis of this slot is currently reflected. */
  _isMirrored(slot) {
    return normaliseMirror(slot.placement.mirror).some(Boolean);
  }

  /**
   * Hand the mount over to the mirror, or give it back.
   *
   * The two states are which of them owns `mount.matrix`. Unmirrored it is the
   * scale cancel and nothing else, composed by three from `mount.scale` as
   * usual; mirrored, `_updateMirrors` writes the matrix outright every frame and
   * three is told to keep its hands off — a reflection has a negative
   * determinant, which is exactly what a position/quaternion/scale triple cannot
   * hold.
   */
  _syncMirrors(slot) {
    const mirrored = this._isMirrored(slot);
    slot.mount.matrixAutoUpdate = !mirrored;
    if (mirrored) {
      this._reflectMount(slot);
    } else {
      // Back to the plain scale cancel, applied at once rather than next frame.
      slot.mount.updateMatrix();
      slot.mount.matrixWorldNeedsUpdate = true;
    }
  }

  /**
   * Reflect every mirrored slot through the body's centre.
   *
   * Cheap enough to be unconditional — a handful of matrix products per mirrored
   * piece — and it has to run every frame, because the reflection is expressed
   * against a joint that is moving.
   */
  _updateMirrors() {
    for (const slot of this.slots.values()) {
      if (!slot.mount.matrixAutoUpdate) this._reflectMount(slot);
    }
  }

  /**
   * Fold one slot's mount across the body, in place.
   *
   * There is no second copy anywhere in here: the piece the mirror produces *is*
   * the piece, moved. The mount still hangs off its joint, so the gear still
   * rides the animation and the placement numbers in the panel still mean what
   * they said — the reflection is a frame change wrapped around them, not a new
   * transform they have to agree with.
   *
   * The mount's matrix is what carries it. Its natural value is the scale cancel
   * `S`, giving the model a world transform of `bone · S · placement`; what is
   * wanted is that same transform seen through a reflection `R` of the body. So
   * the mount is handed `bone⁻¹ · R · bone · S`, which the bone then cancels
   * back down to `R · bone · S · placement` — and because `R` is rebuilt from the
   * joint's *current* matrix each frame, a mirrored scabbard swings with the hip
   * it is reflected from rather than being pinned to where it was.
   */
  _reflectMount(slot) {
    const body = this.character.tilt ?? this.character.root;
    const bone = slot.bone;
    if (!body || !bone) return;

    const [mx, my, mz] = normaliseMirror(slot.placement.mirror);
    // Half the body's height: the plane a Y mirror folds about, and the only
    // part of the centre that is not simply the origin. X and Z fold about the
    // body's own centre line, which is already there.
    const cy = (this.character.height || 1.8) * 0.5;

    // The reflection in the body's frame: `C · S · C⁻¹` for a diagonal `S` is
    // the flip plus a fixed offset. Several axes at once are one matrix and so
    // one mirrored piece, never two.
    _reflect.makeScale(mx ? -1 : 1, my ? -1 : 1, mz ? -1 : 1);
    if (my) _reflect.setPosition(0, cy * 2, 0);

    // …lifted into world space, then expressed in the joint's own.
    _bodyInverse.copy(body.matrixWorld).invert();
    _local.copy(bone.matrixWorld).invert().multiply(body.matrixWorld);
    _mirror.multiplyMatrices(_local, _reflect);
    _mirror.multiply(_bodyInverse).multiply(bone.matrixWorld);

    // And the scale cancel the mount was carrying anyway, on the inside of it.
    _local.makeScale(slot.mount.scale.x, slot.mount.scale.y, slot.mount.scale.z);
    slot.mount.matrix.multiplyMatrices(_mirror, _local);
    slot.mount.matrixWorldNeedsUpdate = true;
  }

  /* ------------------------------------------------------------------ */

  /** Parent a slot's mount to its bone and lay the model out inside it. */
  _attach(slot) {
    const bone = this.character.getBone(slot.placement.bone);
    if (!bone) {
      console.warn(`[EquipmentManager] "${slot.item.id}" wants a bone this rig lacks`);
      return;
    }

    slot.mount.parent?.remove(slot.mount);
    bone.add(slot.mount);
    slot.bone = bone;

    // The joint has to be current before its scale can be read — a mount added
    // this frame has never been through a render.
    bone.updateWorldMatrix(true, false);
    this._syncMountScale(slot);
    this._applyPlacement(slot);
    // The mirror is expressed against this joint, so a re-parent has to rebuild
    // it — this is the one path every attachment goes through.
    this._syncMirrors(slot);
  }

  /** Offsets in metres, rotation in degrees — the panel's units, applied. */
  _applyPlacement(slot) {
    const { position, rotation, scale } = slot.placement;
    slot.model.position.set(position[0], position[1], position[2]);
    slot.model.rotation.set(
      MathUtils.degToRad(rotation[0]),
      MathUtils.degToRad(rotation[1]),
      MathUtils.degToRad(rotation[2])
    );
    slot.model.scale.setScalar(scale);
  }

  /** Cancel the joint's world scale, so the mount's interior is in metres. */
  _syncMountScale(slot) {
    if (!slot.bone) return;
    slot.bone.getWorldScale(_scale);
    const k = Math.abs(_scale.x) > 1e-9 ? 1 / _scale.x : 1;
    slot.mount.scale.setScalar(k);
  }

  /**
   * Keep the mounts honest against the rig.
   *
   * The only thing that can invalidate a mount is the body being re-normalised
   * under it, so the mount pass early-outs on the scale the character reports and
   * does nothing at all on a frame where nobody touched `targetHeight`. The
   * mirrors are the exception: they track a pose that moves every frame, so they
   * are recomputed whenever any are up — and skipped outright when none are.
   */
  update() {
    const scale = this.character.modelScale;
    if (scale !== this._modelScale) {
      this._modelScale = scale;
      for (const slot of this.slots.values()) this._syncMountScale(slot);
    }
    this._updateMirrors();
  }

  /* ------------------------------------------------------------------ */
  /* loadouts                                                            */
  /* ------------------------------------------------------------------ */

  /** The whole loadout as plain JSON. */
  serialize() {
    return {
      version: 1,
      items: [...this.slots.values()].map((slot) => ({
        id: slot.item.id,
        ...clonePlacement(slot.placement)
      }))
    };
  }

  /**
   * Replace what is worn with a serialised loadout.
   * @param {{items?: Array<object>}} data
   */
  async apply(data) {
    const wanted = new Map((data?.items ?? []).map((entry) => [entry.id, entry]));

    // Locked gear is worn no matter what the file says — one saved without it
    // (or written before the lock existed) still boots the body wearing it.
    for (const item of ITEMS) {
      if (item.locked && !wanted.has(item.id)) {
        wanted.set(item.id, { id: item.id, ...defaultPlacement(item) });
      }
    }

    for (const id of [...this.slots.keys()]) {
      // A loadout saved before a piece was locked can be missing it; locked gear
      // stays on rather than being stripped by an old file.
      if (!wanted.has(id) && !this.isLocked(id)) this.unequip(id);
    }

    for (const [id, entry] of wanted) {
      const placement = {
        bone: entry.bone,
        position: entry.position ?? [0, 0, 0],
        rotation: entry.rotation ?? [0, 0, 0],
        scale: entry.scale ?? 1,
        mirror: normaliseMirror(entry.mirror)
      };
      if (this.slots.has(id)) {
        const slot = this.slots.get(id);
        slot.placement = clonePlacement(placement);
        this._attach(slot);
        this._emit('placed', id);
      } else {
        await this.equip(id, placement);
      }
    }
  }

  /**
   * Put on whatever the catalog ships as worn-by-default.
   *
   * The starting loadout, not a fallback: it runs at load, before anyone has
   * opened the screen, and leaves anything already equipped exactly where it is
   * so a restored loadout is never overwritten by it.
   */
  async equipDefaults() {
    await Promise.all(
      defaultItems()
        .filter((item) => !this.slots.has(item.id) && !this.pending.has(item.id))
        .map((item) => this.equip(item.id))
    );
  }

  /**
   * What the body boots wearing: the stored loadout, or the catalog's defaults.
   *
   * The stored one wins outright rather than being merged over the defaults —
   * "I took the sword off" is a placement decision too, and re-equipping it every
   * reload would make it impossible to say.
   *
   * @returns {Promise<boolean>} whether the stored loadout was the one used
   */
  async restoreOrDefaults() {
    const found = await this.restore();
    if (!found) await this.equipDefaults();
    return found;
  }

  /**
   * Take everything off.
   * @param {{locked?: boolean}} [options] `locked: true` strips locked gear too —
   *   teardown wants that, the screen's "clear" button does not
   */
  clear({ locked = false } = {}) {
    for (const id of [...this.slots.keys()]) {
      if (locked || !this.isLocked(id)) this.unequip(id);
    }
  }

  /** @returns {boolean} whether anything was written */
  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.serialize()));
      return true;
    } catch (error) {
      console.warn('[EquipmentManager] could not save the loadout', error);
      return false;
    }
  }

  /** @returns {Promise<boolean>} whether a stored loadout was found and applied */
  async restore() {
    let data = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      data = JSON.parse(raw);
    } catch (error) {
      console.warn('[EquipmentManager] stored loadout is unreadable', error);
      return false;
    }
    await this.apply(data);
    return true;
  }

  /**
   * The current placements as a catalog snippet.
   *
   * Tuning happens on screen; this is how it gets *shipped* — paste the result
   * over the `defaults` in `EquipmentCatalog.js` and the placement everyone
   * loads becomes the one that was just dialled in.
   */
  snippet() {
    const lines = [...this.slots.values()].map((slot) => {
      const p = slot.placement;
      const round = (n) => Number(n.toFixed(4));
      const mirror = normaliseMirror(p.mirror);
      // Mirroring is written only when it is on — an all-false line in every
      // entry is noise in a file that is read as documentation.
      const mirrored = mirror.some(Boolean);
      return [
        `  // ${slot.item.name}`,
        `  defaults: {`,
        `    bone: '${p.bone}',`,
        `    position: [${p.position.map(round).join(', ')}],`,
        `    rotation: [${p.rotation.map(round).join(', ')}],`,
        `    scale: ${round(p.scale)}${mirrored ? ',' : ''}`,
        ...(mirrored ? [`    mirror: [${mirror.join(', ')}]`] : []),
        `  },`
      ].join('\n');
    });
    return lines.join('\n\n') || '// nothing equipped';
  }

  /* ------------------------------------------------------------------ */

  _emit(type, id) {
    this.hooks.onChange?.({ type, id });
    if (this.autosave && PERSISTED_EVENTS.has(type)) this._queueSave();
  }

  /**
   * Write the loadout shortly after it settles.
   *
   * Coalesced because the gizmo raises `placed` on every frame of a drag, and a
   * `JSON.stringify` into `localStorage` per frame is a synchronous write in the
   * middle of one. One save at the end of the gesture says the same thing.
   */
  _queueSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = 0;
      this.save();
    }, SAVE_DELAY_MS);
  }

  dispose() {
    clearTimeout(this._saveTimer);
    this._saveTimer = 0;
    this.clear({ locked: true });
    this.pending.clear();
    this._cancelled.clear();
  }
}

/** Every known item id, in catalog order — the screen's list. */
export const ALL_ITEM_IDS = ITEMS.map((item) => item.id);

function clonePlacement(placement) {
  return {
    bone: placement.bone,
    position: [...placement.position],
    rotation: [...placement.rotation],
    scale: placement.scale,
    mirror: normaliseMirror(placement.mirror)
  };
}
