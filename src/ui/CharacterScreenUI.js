import { ATTACH_POINTS, CATEGORIES } from '../equipment/EquipmentCatalog.js';
import { settings } from '../config/settings.js';

/**
 * The character screen's panel.
 *
 * Plain DOM on purpose. lil-gui runs the stage editor next door and is right for
 * that — a flat tree of numbers over a settings object — but this is a workflow
 * with a shape of its own: pick a category, pick a piece, pick a joint, then
 * *tune* it against what the viewport is showing. That wants an item list, a
 * joint picker and a live inspector sitting where they do not cover the body,
 * which is a layout rather than a control tree.
 *
 * The panel holds no state of its own. Every control writes through a hook and
 * every value is re-read from `EquipmentManager` on `refresh()`, so the gizmo in
 * the viewport and the numbers here can never disagree — dragging the arrow
 * moves the slider, and typing in the box moves the item.
 */
export class CharacterScreenUI {
  /**
   * @param {object} config
   * @param {import('../equipment/EquipmentCatalog.js').EquipmentItem[]} config.items
   * @param {import('../equipment/EquipmentManager.js').EquipmentManager} config.equipment
   * @param {() => {selected: ?string, gizmoMode: string, preview: string}} config.state
   *   the screen's live mode, read on every refresh — the panel mirrors it and
   *   never holds a second copy
   * @param {object} config.hooks every action the screen can take
   */
  constructor({ items, equipment, state, hooks }) {
    this.items = items;
    this.equipment = equipment;
    this.state = state;
    this.hooks = hooks;
    this.selectedId = null;
    this.category = CATEGORIES[0]?.id ?? 'weapons';
    this.bones = [];

    this.root = document.createElement('div');
    this.root.className = 'cs';
    this.root.hidden = true;

    this.root.append(this._buildBar(), this._buildRail(), this._buildInspector());
    document.body.appendChild(this.root);

    this._renderCards();
  }

  /* ------------------------------------------------------------------ */
  /* chrome                                                              */
  /* ------------------------------------------------------------------ */

  _buildBar() {
    const bar = el('header', 'cs__bar');

    const brand = el('div', 'cs__brand');
    brand.innerHTML = '<i class="cs__pip"></i><span>Character</span>';
    bar.append(brand);

    bar.append(
      group('Frame', [
        button('Full', () => this.hooks.onFrame('full')),
        button('Bust', () => this.hooks.onFrame('bust')),
        button('Head', () => this.hooks.onFrame('head')),
        button('Piece', () => this.hooks.onFrame('item'))
      ])
    );

    this.gizmoButtons = {
      translate: button('Move', () => this.hooks.onGizmo('translate')),
      rotate: button('Rotate', () => this.hooks.onGizmo('rotate')),
      // Scale is the fire box's alone: a piece of equipment is sized by its
      // placement, which the gizmo has no way to write back uniformly.
      scale: button('Scale', () => this.hooks.onGizmo('scale')),
      none: button('Off', () => this.hooks.onGizmo('none'))
    };
    bar.append(group('Gizmo', Object.values(this.gizmoButtons)));

    this.previewButtons = {
      // First in the row because it is the one to tune against: the body holds
      // a single frame of the idle instead of breathing through it.
      stopped: button('Stopped', () => this.hooks.onPreview('stopped')),
      idle: button('Idle', () => this.hooks.onPreview('idle')),
      walk: button('Walk', () => this.hooks.onPreview('walk')),
      run: button('Run', () => this.hooks.onPreview('run'))
    };
    bar.append(group('Motion', Object.values(this.previewButtons)));

    this.skeletonToggle = toggle('Skeleton', false, (on) => this.hooks.onSkeleton(on));
    this.markerToggle = toggle('Joint marker', true, (on) => this.hooks.onMarker(on));
    bar.append(group('Overlays', [this.skeletonToggle.root, this.markerToggle.root]));

    // The fire's aim, where it is judged: the box is a volume on the weapon, so
    // it is dragged against the body rather than typed at from the stage editor.
    this.fireToggle = toggle('Flames', settings.fire.enabled, (on) => this.hooks.onFire(on));
    this.fireBoxToggle = toggle('Edit box', false, (on) => this.hooks.onFireBox(on));
    bar.append(
      group('Fire', [
        this.fireToggle.root,
        this.fireBoxToggle.root,
        button('Refit', () => this.hooks.onRefitFireBox())
      ])
    );

    this.turntable = slider({
      label: 'Turntable',
      min: -0.3,
      max: 0.3,
      step: 0.005,
      value: settings.studio.turntable,
      onInput: (value) => this.hooks.onTurntable(value)
    });
    bar.append(group('Rotate', [this.turntable.root]));

    const close = button('Close  ·  Tab', () => this.hooks.onExit());
    close.classList.add('cs__close');
    bar.append(close);

    return bar;
  }

  /** Left rail: the catalog, one card per item. */
  _buildRail() {
    const rail = el('aside', 'cs__rail');

    const tabs = el('div', 'cs__tabs');
    this.tabs = new Map();
    for (const category of CATEGORIES) {
      const tab = button(category.label, () => {
        this.category = category.id;
        this._renderCards();
        this.refresh();
      });
      tab.classList.add('cs__tab');
      tab.title = category.hint ?? '';
      this.tabs.set(category.id, tab);
      tabs.append(tab);
    }
    rail.append(tabs);

    this.cards = el('div', 'cs__cards');
    rail.append(this.cards);

    const actions = el('div', 'cs__actions');
    actions.append(
      button('Save', () => this.hooks.onSave()),
      button('Load', () => this.hooks.onLoad()),
      button('Export', () => this.hooks.onExport()),
      button('Copy defaults', () => this.hooks.onCopy()),
      button('Clear', () => this.hooks.onClear())
    );
    rail.append(actions);

    return rail;
  }

  /** Right panel: everything about the selected piece. */
  _buildInspector() {
    const panel = el('section', 'cs__inspector');

    this.inspectorTitle = el('div', 'cs__title');
    panel.append(this.inspectorTitle);

    this.empty = el('p', 'cs__empty');
    this.empty.textContent = 'Pick a piece on the left, or click one on the body.';
    panel.append(this.empty);

    this.body = el('div', 'cs__body');
    panel.append(this.body);

    /* ---- joint ---- */
    this.boneSelect = document.createElement('select');
    this.boneSelect.className = 'cs__select';
    this.boneSelect.addEventListener('change', () => {
      if (this.selectedId) this.hooks.onBone(this.selectedId, this.boneSelect.value);
    });
    this.body.append(field('Attached to', this.boneSelect));

    /* ---- offsets ---- */
    this.position = ['x', 'y', 'z'].map((axis, index) =>
      slider({
        label: `Offset ${axis.toUpperCase()}`,
        min: -0.6,
        max: 0.6,
        step: 0.001,
        unit: 'm',
        decimals: 3,
        onInput: (value) => this._patch('position', index, value)
      })
    );
    this.body.append(section('Offset — metres, in the joint’s own frame', this.position));

    /* ---- rotation ---- */
    this.rotation = ['x', 'y', 'z'].map((axis, index) =>
      slider({
        label: `Rotate ${axis.toUpperCase()}`,
        min: -180,
        max: 180,
        step: 0.5,
        unit: '°',
        decimals: 1,
        onInput: (value) => this._patch('rotation', index, value)
      })
    );
    this.body.append(section('Rotation — degrees, XYZ', this.rotation));

    /* ---- scale ---- */
    this.scale = slider({
      label: 'Scale',
      min: 0.1,
      max: 3,
      step: 0.01,
      decimals: 2,
      onInput: (value) => {
        if (this.selectedId) this.hooks.onPlacement(this.selectedId, { scale: value });
      }
    });
    this.body.append(section('Size', [this.scale]));

    /* ---- mirroring ---- */
    // The piece folded through the body's centre: X puts it on the other side,
    // Y folds it about the waist, Z front to back. It *moves* — there is still
    // one of it — so the placement below goes on describing the same piece and
    // the gizmo goes on holding it.
    this.mirrorToggles = ['X', 'Y', 'Z'].map((axis, index) =>
      toggle(`Mirror ${axis}`, false, (on) => {
        if (this.selectedId) this.hooks.onMirror(this.selectedId, index, on);
      })
    );
    const mirrors = section(
      'Mirror — fold the piece through the body’s centre',
      this.mirrorToggles.map((control) => control.root)
    );
    mirrors.classList.add('cs__section--inline');
    this.body.append(mirrors);

    // Hidden outright for locked gear (see `refresh`) rather than disabled: the
    // piece is not detachable at all, so the action does not belong on the row.
    this.detachButton = button('Detach', () => {
      if (this.selectedId && !this.equipment.isLocked(this.selectedId)) {
        this.hooks.onToggleItem(this.selectedId);
      }
    });

    const actions = el('div', 'cs__row');
    actions.append(
      button('Reset placement', () => {
        if (this.selectedId) this.hooks.onResetPlacement(this.selectedId);
      }),
      this.detachButton
    );
    this.body.append(actions);

    return panel;
  }

  /* ------------------------------------------------------------------ */
  /* data                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * The joints this rig offers, grouped.
   *
   * `ATTACH_POINTS` gives the order the common ones appear in; anything else the
   * skeleton carries lands under "Other joints" rather than being hidden, so an
   * unusual attachment is a scroll away instead of a code change.
   *
   * @param {string[]} bones every short bone name on the rig
   */
  setBones(bones) {
    this.bones = bones;
    this.boneSelect.replaceChildren();

    const used = new Set();
    for (const { group: name, bones: wanted } of ATTACH_POINTS) {
      const available = wanted.filter((bone) => bones.includes(bone));
      if (!available.length) continue;
      const optgroup = document.createElement('optgroup');
      optgroup.label = name;
      for (const bone of available) {
        optgroup.append(option(bone));
        used.add(bone);
      }
      this.boneSelect.append(optgroup);
    }

    const rest = bones.filter((bone) => !used.has(bone));
    if (rest.length) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = 'Other joints';
      for (const bone of rest) optgroup.append(option(bone));
      this.boneSelect.append(optgroup);
    }
  }

  _renderCards() {
    this.cards.replaceChildren();
    this.cardsById = new Map();

    for (const item of this.items) {
      if (item.category !== this.category) continue;

      const card = el('button', 'cs__card');
      card.type = 'button';

      const name = el('span', 'cs__cardName');
      name.textContent = item.name;
      const note = el('span', 'cs__cardNote');
      note.textContent = item.note ?? '';
      const state = el('span', 'cs__cardState');

      card.append(name, note, state);
      card.addEventListener('click', (event) => {
        // The body of the card equips; the state chip alone selects, so a
        // tuned piece is never taken off by a mis-click on its own row. A locked
        // piece is already on and stays on, so its whole card just selects.
        if (event.target === state || this.equipment.isLocked(item.id)) {
          this.hooks.onSelect(item.id);
        } else {
          this.hooks.onToggleItem(item.id);
        }
      });

      this.cards.append(card);
      this.cardsById.set(item.id, { card, state });
    }
  }

  _patch(key, index, value) {
    const id = this.selectedId;
    if (!id) return;
    const slot = this.equipment.get(id);
    if (!slot) return;
    const next = [...slot.placement[key]];
    next[index] = value;
    this.hooks.onPlacement(id, { [key]: next });
  }

  /* ------------------------------------------------------------------ */
  /* state                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Re-read everything from the manager.
   *
   * Called on every equipment event *and* on every frame of a gizmo drag, so it
   * has to be cheap and it must never fight the pointer: a control the user is
   * currently holding keeps its value (`isBusy`), and only the ones they are not
   * touching are written.
   */
  refresh() {
    const state = this.state();
    this.selectedId = state.selected;

    for (const [id, tab] of this.tabs) tab.classList.toggle('is-active', id === this.category);

    for (const [id, { card, state: chip }] of this.cardsById ?? []) {
      const equipped = this.equipment.isEquipped(id);
      const pending = this.equipment.isPending(id);
      const locked = this.equipment.isLocked(id);
      card.classList.toggle('is-equipped', equipped);
      card.classList.toggle('is-selected', this.selectedId === id);
      card.classList.toggle('is-pending', pending);
      card.classList.toggle('is-locked', locked);
      chip.textContent = pending
        ? 'loading…'
        : locked && equipped
          ? 'locked'
          : equipped
            ? 'equipped'
            : 'equip';
    }

    const slot = this.selectedId ? this.equipment.get(this.selectedId) : null;
    this.body.hidden = !slot;
    this.empty.hidden = !!slot;
    this.inspectorTitle.textContent = slot ? slot.item.name : 'Nothing selected';
    this.detachButton.hidden = !slot || this.equipment.isLocked(this.selectedId);

    if (slot) {
      const placement = slot.placement;
      if (document.activeElement !== this.boneSelect) this.boneSelect.value = placement.bone;
      this.position.forEach((control, index) => control.set(placement.position[index]));
      this.rotation.forEach((control, index) => control.set(placement.rotation[index]));
      this.scale.set(placement.scale);
      const mirror = this.equipment.getMirror(this.selectedId);
      this.mirrorToggles.forEach((control, index) => {
        control.input.checked = mirror[index];
      });
    }

    const editingBox = state.fireBox === true;
    for (const [mode, node] of Object.entries(this.gizmoButtons)) {
      node.classList.toggle('is-active', state.gizmoMode === mode);
    }
    this.gizmoButtons.scale.hidden = !editingBox;
    this.fireToggle.input.checked = settings.fire.enabled;
    this.fireBoxToggle.input.checked = editingBox;
    // The inspector is about the selected piece; while the box is under the
    // gizmo the piece's own numbers are not what the handles are writing.
    this.body.classList.toggle('is-muted', editingBox);
    for (const [name, node] of Object.entries(this.previewButtons)) {
      node.classList.toggle('is-active', (state.preview ?? 'idle') === name);
    }
    this.turntable.set(settings.studio.turntable);
  }

  show() {
    this.root.hidden = false;
    // The stage editor auto-places itself against the right edge, which is where
    // the inspector is. The class shifts it inboard for as long as this is up
    // (see `styles.css`), so both panels stay usable together.
    document.body.classList.add('cs-open');
    // Re-entering after a resize or a preset load: the sliders re-read.
    this.refresh();
  }

  hide() {
    this.root.hidden = true;
    document.body.classList.remove('cs-open');
  }

  dispose() {
    this.root.remove();
  }
}

/* -------------------------------------------------------------------- */
/* tiny DOM helpers                                                      */
/* -------------------------------------------------------------------- */

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(label, onClick) {
  const node = el('button', 'cs__btn');
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function option(value) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = value.replace(/([a-z])([A-Z])/g, '$1 $2');
  return node;
}

/** A labelled cluster in the top bar. */
function group(label, children) {
  const node = el('div', 'cs__group');
  const caption = el('span', 'cs__groupLabel');
  caption.textContent = label;
  node.append(caption, ...children);
  return node;
}

/** A labelled block in the inspector. */
function section(label, controls) {
  const node = el('div', 'cs__section');
  const caption = el('span', 'cs__sectionLabel');
  caption.textContent = label;
  node.append(caption, ...controls.map((control) => control.root ?? control));
  return node;
}

function field(label, control) {
  const node = el('div', 'cs__field');
  const caption = el('span', 'cs__fieldLabel');
  caption.textContent = label;
  node.append(caption, control);
  return node;
}

/**
 * A range and a number box over one value.
 *
 * The two are one control: the range is for finding the value and the box is
 * for saying it exactly, and the box is deliberately *not* clamped to the
 * range — a placement that needs 0.9 m should not be impossible because the
 * slider stops at 0.6.
 */
function slider({ label, min, max, step, value = 0, unit = '', decimals = 2, onInput }) {
  const root = el('label', 'cs__slider');

  const caption = el('span', 'cs__sliderLabel');
  caption.textContent = label;

  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(min);
  range.max = String(max);
  range.step = String(step);
  range.value = String(value);

  const number = document.createElement('input');
  number.type = 'number';
  number.step = String(step);
  number.value = value.toFixed(decimals);
  number.className = 'cs__number';

  const suffix = el('span', 'cs__unit');
  suffix.textContent = unit;

  const emit = (next) => {
    if (!Number.isFinite(next)) return;
    onInput(next);
  };

  range.addEventListener('input', () => {
    number.value = Number(range.value).toFixed(decimals);
    emit(Number(range.value));
  });
  number.addEventListener('input', () => {
    const next = Number(number.value);
    if (!Number.isFinite(next)) return;
    range.value = String(next);
    emit(next);
  });

  root.append(caption, range, number, suffix);

  return {
    root,
    /** Write a value in, unless the user is holding this control. */
    set(next) {
      if (document.activeElement === range || document.activeElement === number) return;
      range.value = String(next);
      number.value = Number(next).toFixed(decimals);
    }
  };
}

function toggle(label, initial, onChange) {
  const root = el('label', 'cs__toggle');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = initial;
  const caption = el('span', '');
  caption.textContent = label;
  input.addEventListener('change', () => onChange(input.checked));
  root.append(input, caption);
  return { root, input };
}
