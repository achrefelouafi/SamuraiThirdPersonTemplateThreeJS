/**
 * What can be equipped, and where.
 *
 * This file is the whole content layer: adding a sword is one entry here and no
 * code anywhere else. Everything downstream — the loader, the attachment mounts,
 * the character screen's item list — is driven off these objects and knows
 * nothing about any particular item.
 *
 * Categories exist so the two kinds of thing stay separable. `weapons` is the
 * category that will grow rules (draw/sheathe, damage, a hand it has to be in);
 * `attachments` is cosmetic and never will. Keeping them apart now is what makes
 * that later work a change to one category rather than a filter over a flat list.
 */

/**
 * @typedef {object} EquipmentItem
 * @property {string} id stable key — used by the saved loadout, so do not rename
 * @property {string} name what the screen calls it
 * @property {string} category a `CATEGORIES` id
 * @property {string} url a .glb, relative to the site root
 * @property {string} [note] one line of flavour for the item card
 * @property {boolean} [equipByDefault] worn on load, with no saved loadout involved
 * @property {boolean} [locked] cannot be taken off — the screen offers no way to
 *   unequip it, and `EquipmentManager.toggle` refuses to
 * @property {EquipmentPlacement} defaults where it goes before anyone tunes it
 */

/**
 * @typedef {object} EquipmentPlacement
 * @property {string} bone joint name, without the `mixamorig:` namespace
 * @property {[number, number, number]} position metres, in the bone's own frame
 * @property {[number, number, number]} rotation degrees, XYZ order
 * @property {number} scale multiplier on the model's authored size
 * @property {[boolean, boolean, boolean]} [mirror] per-axis reflection of the
 *   piece through the body's centre — X gives the matching copy on the other
 *   side, Y flips it about the waist, Z about the coronal plane
 */

export const CATEGORIES = [
  {
    id: 'weapons',
    label: 'Weapons',
    /** Held gear. Everything here will eventually answer to combat state. */
    hint: 'Held gear — the category future combat work hangs off.'
  },
  {
    id: 'attachments',
    label: 'Attachments',
    hint: 'Cosmetic. Rides the skeleton and does nothing else.'
  }
];

/** @type {EquipmentItem[]} */
export const ITEMS = [
  {
    id: 'sword',
    name: 'Katana',
    category: 'weapons',
    url: './models/weapons/sword.glb',
    note: 'Blade runs down +Z from the guard.',
    // Worn from the first frame — the character is never seen unarmed, and the
    // screen cannot take it off: combat and its VFX assume the blade is there.
    equipByDefault: true,
    locked: true,
    defaults: {
      bone: 'RightHand',
      position: [-0.051, 0.102, 0.052],
      rotation: [-168.3, 84, -0.8],
      scale: 1
    }
  },
  {
    id: 'scabbard',
    name: 'Scabbard',
    category: 'attachments',
    url: './models/attachements/Scabbard.glb',
    note: 'Sits on the left hip, mouth forward.',
    defaults: {
      bone: 'Hips',
      position: [0.12, 0.02, 0],
      rotation: [0, 0, 20],
      scale: 1
    }
  },
  {
    id: 'potion',
    name: 'Potion',
    category: 'attachments',
    url: './models/attachements/Potion.glb',
    note: 'Belt flask.',
    defaults: {
      bone: 'Spine',
      position: [-0.14, 0, 0.06],
      rotation: [0, 0, 0],
      scale: 1
    }
  }
];

/**
 * The joints worth offering first.
 *
 * The screen lists every bone the rig actually has — this is only the order and
 * the grouping the common ones appear in, so picking "right hand" is one click
 * rather than a scroll through fifty finger joints. A name no rig here carries
 * is skipped silently.
 */
export const ATTACH_POINTS = [
  { group: 'Hands', bones: ['RightHand', 'LeftHand'] },
  { group: 'Arms', bones: ['RightForeArm', 'RightArm', 'LeftForeArm', 'LeftArm'] },
  { group: 'Back & hips', bones: ['Spine2', 'Spine1', 'Spine', 'Hips'] },
  { group: 'Head', bones: ['Head', 'Neck', 'RightShoulder', 'LeftShoulder'] },
  { group: 'Legs', bones: ['RightUpLeg', 'RightLeg', 'RightFoot', 'LeftUpLeg', 'LeftLeg', 'LeftFoot'] }
];

/** Deep copy of an item's shipped placement — never hand the catalog out live. */
export function defaultPlacement(item) {
  const d = item.defaults ?? {};
  return {
    bone: d.bone ?? 'RightHand',
    position: [...(d.position ?? [0, 0, 0])],
    rotation: [...(d.rotation ?? [0, 0, 0])],
    scale: d.scale ?? 1,
    mirror: normaliseMirror(d.mirror)
  };
}

/** Three booleans, whatever a catalog entry or a stored loadout offered. */
export function normaliseMirror(mirror) {
  return [0, 1, 2].map((axis) => mirror?.[axis] === true);
}

/** @returns {EquipmentItem|null} */
export function findItem(id) {
  return ITEMS.find((item) => item.id === id) ?? null;
}

/** What the character starts out wearing, in catalog order. */
export function defaultItems() {
  return ITEMS.filter((item) => item.equipByDefault === true);
}

/** Items in one category, in catalog order. */
export function itemsInCategory(categoryId) {
  return ITEMS.filter((item) => item.category === categoryId);
}
