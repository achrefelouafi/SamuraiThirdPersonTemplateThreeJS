import { ABILITIES, CATEGORIES } from '../config/abilities.js';
import { createIcon } from './icons.js';

/**
 * The moves along the bottom of the screen.
 *
 * A read-only HUD: it draws one chip per entry in `config/abilities.js` and is
 * told a state per frame. It knows nothing about what any of them *do* — the
 * app resolves that, because "can this start right now" is already answered by
 * the move itself and duplicating the answer here is how the two drift apart.
 *
 * Each `category` gets its own panel and its own shape, because they are not
 * the same kind of thing and a single uniform row said they were:
 *
 *  - **movement** — one thin plate above the rest, barely there. It is how you
 *    get about, not how you win, and it should not compete with the two panels
 *    that are read mid-fight.
 *  - **techniques** — angular lacquer plates in a row, each an icon over its
 *    name with the key cut into the corner. Three of them, read as a set: this
 *    is the hand the player is playing from.
 *  - **abilities** — a *mon*: a round seal on a ring, standing apart from the
 *    plates on purpose. There is one for now and the panel is built to take
 *    more without changing shape.
 *
 * Three states, and each one says something different:
 *
 *  - **ready** — the key will do something if pressed now.
 *  - **active** — it is happening. The chip lights so the player can see which
 *    of the attacks the body is committed to, which matters while they are
 *    learning that one locks the stick out for longer than the other.
 *  - **off** — pressing the key would do nothing. Nobody is inside the move's
 *    range and cone, or it is switched off in the editor, or its clip failed to
 *    load, or something else has the body. Drained of colour and dimmed rather
 *    than removed: a gap in a row would read as the move being gone for good.
 *    For the techniques this is the common case — the plates come up as you
 *    close on a body and go out as you leave it, which is the row saying what
 *    the rings on the ground say.
 *
 * Writes are diffed against the last state, so the common case — nothing has
 * changed since the previous frame — touches no DOM at all.
 */
export class ActionHUD {
  constructor(parent = document.body) {
    this.element = document.createElement('div');
    this.element.className = 'hud';

    /** @type {Map<string, HTMLElement>} */
    this.chips = new Map();
    /** Last state written per id, so an unchanged frame costs nothing. */
    this._state = new Map();

    /** The two bands, in order. A band with no panels is dropped below. */
    const rows = new Map(
      ['top', 'main'].map((name) => {
        const row = document.createElement('div');
        row.className = `hud__row hud__row--${name}`;
        return [name, row];
      })
    );

    /** Panels, built on first use so an empty category costs no heading. */
    const panels = new Map();

    for (const ability of ABILITIES) {
      const category = CATEGORIES[ability.category] ?? CATEGORIES.technique;

      let items = panels.get(category.id);
      if (!items) {
        items = this._createPanel(category, rows.get(category.row));
        panels.set(category.id, items);
      }

      const chip = CHIPS[category.id](ability);
      chip.title = `${ability.hotkey} — ${ability.note}`;
      items.appendChild(chip);
      this.chips.set(ability.id, chip);
    }

    for (const row of rows.values()) {
      if (row.childElementCount) this.element.appendChild(row);
    }

    parent.appendChild(this.element);
  }

  /**
   * A headed panel for one category, appended to its band.
   *
   * @param {import('../config/abilities.js').Category} category
   * @param {HTMLElement} row
   * @returns {HTMLElement} the element the chips go in
   */
  _createPanel(category, row) {
    const panel = document.createElement('section');
    panel.className = `hud__panel hud__panel--${category.id}`;

    const head = document.createElement('div');
    head.className = 'hud__head';

    const kanji = document.createElement('span');
    kanji.className = 'hud__kanji';
    kanji.textContent = category.kanji;

    const label = document.createElement('span');
    label.className = 'hud__label';
    label.textContent = category.label;

    head.append(kanji, label);

    const items = document.createElement('div');
    items.className = 'hud__items';

    panel.append(head, items);
    row.appendChild(panel);
    return items;
  }

  /**
   * @param {Record<string, 'ready'|'active'|'off'>} state keyed by ability id;
   *   anything missing is treated as unavailable.
   */
  update(state) {
    for (const [id, chip] of this.chips) {
      const next = state[id] ?? 'off';
      if (this._state.get(id) === next) continue;
      this._state.set(id, next);
      chip.classList.toggle('is-active', next === 'active');
      chip.classList.toggle('is-off', next === 'off');
    }
  }

  dispose() {
    this.chips.clear();
    this._state.clear();
    this.element.remove();
  }
}

/** @param {string} className @param {string} text */
function span(className, text) {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

/**
 * How each category draws one of its moves.
 *
 * The three shapes are the whole point of the split, so they are written out
 * rather than parameterised: a plate, a seal and a strip have nothing in common
 * past the class the state is toggled on.
 *
 * @type {Record<string, (ability: import('../config/abilities.js').Ability) => HTMLElement>}
 */
const CHIPS = {
  /** A lacquer plate: key in the corner, icon over the name. */
  technique(ability) {
    const chip = document.createElement('div');
    chip.className = 'tech';
    chip.append(
      span('tech__key', ability.hotkey),
      createIcon(ability.id, 'tech__icon'),
      span('tech__name', ability.label)
    );
    return chip;
  },

  /** A seal on a ring, with its name and key stacked under it. */
  ability(ability) {
    const chip = document.createElement('div');
    chip.className = 'seal';

    const disc = document.createElement('span');
    disc.className = 'seal__disc';

    const ring = document.createElement('span');
    ring.className = 'seal__ring';

    // The key rides the rim of the seal rather than sitting under the name: it
    // keeps the panel the same height as the plates beside it, and a cap struck
    // through the edge of a seal is the right thing for it to be.
    disc.append(ring, createIcon(ability.id, 'seal__icon'), span('seal__key', ability.hotkey));
    chip.append(disc, span('seal__name', ability.label));
    return chip;
  },

  /** One thin strip: icon, name, key, all on a line. */
  movement(ability) {
    const chip = document.createElement('div');
    chip.className = 'move';
    chip.append(
      createIcon(ability.id, 'move__icon'),
      span('move__name', ability.label),
      span('move__key', ability.hotkey)
    );
    return chip;
  }
};
