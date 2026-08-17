/**
 * What the player can *do*, in one list.
 *
 * Three things read this and nothing else describes a move: `core/Input.js`
 * builds its key map from the entries marked `attack` (so a rebind here rebinds
 * the game), `ui/ActionHUD.js` draws the panels along the bottom of the screen
 * from all of them, and `core/App.js` resolves a state per `id` each frame.
 *
 * `id` is the contract between the three. For an attack it is also the
 * `configKey` its `Attack` instance reads out of `config/settings.js` — one
 * word that names the clip, its tuning block, its glyph in `ui/icons.js` and
 * its chip in the HUD.
 *
 * `category` is the second contract, and it is a statement about *kind*, not
 * about layout: a technique is something the body does with the sword and the
 * feet, an ability is something rarer that the body alone could not. The HUD
 * gives each kind its own panel and its own shape on screen so the difference
 * is visible before either is read — see `ui/ActionHUD.js`.
 */

/**
 * @typedef {object} Category
 * @property {string} id matches an ability's `category`
 * @property {string} label the panel's heading
 * @property {string} kanji the mark beside it
 * @property {'top'|'main'} row which band of the HUD the panel sits in
 */

/**
 * The kinds of thing a move can be, in the order their panels are laid out.
 *
 * @type {Record<string, Category>}
 */
export const CATEGORIES = {
  /**
   * Getting somewhere, and getting dressed. Quiet, above the rest — neither is
   * a way to hurt anyone, and neither should compete with the panels that are.
   */
  movement: { id: 'movement', label: 'Movement', kanji: '歩', row: 'top' },
  /** Sword and body. The three the fight is actually fought with. */
  technique: { id: 'technique', label: 'Techniques', kanji: '技', row: 'main' },
  /** The rarer things. Both of them are aimed by marking a body first. */
  ability: { id: 'ability', label: 'Abilities', kanji: '術', row: 'main' }
};

/**
 * @typedef {object} Ability
 * @property {string} id matches the settings block, the `Attack` config key and the icon
 * @property {keyof typeof CATEGORIES} category which panel it is drawn in
 * @property {string} label what the chip says
 * @property {string} hotkey what the chip's key cap says
 * @property {string} code the physical `KeyboardEvent.code` behind it
 * @property {string} note one line, for the chip's tooltip
 * @property {boolean} [attack] buffered as an edge and routed to an `Attack`
 */

/** @type {Ability[]} */
export const ABILITIES = [
  {
    id: 'leap',
    category: 'movement',
    label: 'Leap',
    hotkey: 'Space',
    code: 'Space',
    note: 'A running long jump. At any lesser pace it is a hop instead.'
  },
  {
    id: 'customize',
    category: 'movement',
    label: 'Character',
    hotkey: 'Tab',
    code: 'Tab',
    note: 'The equipment studio: a stage of its own, for looking at the body and dressing it.'
  },
  {
    id: 'kick',
    category: 'technique',
    label: 'Kick',
    hotkey: 'E',
    code: 'KeyE',
    note: 'Steps onto the nearest body in front of you and plants a foot in it.',
    attack: true
  },
  {
    id: 'slashHit',
    category: 'technique',
    label: 'Slash Hit',
    hotkey: 'R',
    code: 'KeyR',
    note: 'Steps in and opens it across the waist. Longer reach, and it cuts.',
    attack: true
  },
  {
    id: 'crouchSlash',
    category: 'technique',
    label: 'Slide Cut',
    hotkey: 'T',
    code: 'KeyT',
    note: 'Runs it down, drops into a slide and opens it on the way past.',
    attack: true
  },
  {
    id: 'shadows',
    category: 'ability',
    label: 'Shadows',
    hotkey: 'V',
    code: 'KeyV',
    note: 'Look at two bodies and click to mark them. A shadow of you goes for each.'
  },
  {
    id: 'judgement',
    category: 'ability',
    label: 'Judgement',
    hotkey: 'C',
    code: 'KeyC',
    note: 'Mark one body. A seal opens over its head and a fist comes down through it.'
  },
  {
    id: 'flight',
    category: 'ability',
    label: 'Flight',
    hotkey: 'X',
    code: 'KeyX',
    note:
      'Leave the ground. Click bodies to forge a blade for each, Space looses them — ' +
      'and nothing else works while you are up there.'
  }
];

/** The attacks, in the order a press is offered to them. */
export const ATTACK_ABILITIES = ABILITIES.filter((ability) => ability.attack);
