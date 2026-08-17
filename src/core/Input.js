import { ATTACK_ABILITIES } from '../config/abilities.js';

/**
 * Keyboard state for the character controller.
 *
 * Holds *state*, not events: the controller asks "which way is the stick
 * pushed" once a frame rather than reacting to keystrokes, so a dropped frame
 * can never swallow a movement input. Keys are read by `event.code`, which is
 * layout-independent — W is the same physical key on AZERTY.
 *
 * The window losing focus releases everything. Without that, alt-tabbing while
 * running leaves the character sprinting into the fog forever.
 */
const MOVE_KEYS = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right'
};

/**
 * Physical key code → ability id, for the moves that are buffered edges.
 *
 * Derived from the one list in `config/abilities.js` rather than written out
 * here, so a rebind there is a rebind everywhere — the same entry draws the
 * chip in the HUD that this reads the key off.
 */
const ATTACK_KEYS = Object.fromEntries(
  ATTACK_ABILITIES.map((ability) => [ability.code, ability.id])
);

export class Input {
  constructor(target = window) {
    this.target = target;
    /** Physical key codes currently held. */
    this.pressed = new Set();

    /** Movement axes, refreshed by `sample()`. x = strafe, y = forward. */
    this.axis = { x: 0, y: 0 };
    this.running = false;
    /**
     * One buffered jump press.
     *
     * The exception to the state-not-events rule above: a jump is an *edge*, and
     * a held space bar must not relaunch the moment the last one lands. Buffering
     * the press instead of reading the key means a tap between two frames still
     * counts, which is what stops a jump silently going missing on a long frame.
     */
    this._jump = false;
    /**
     * One buffered press per attack (`E`, `R`, `T`), on the jump's exact terms.
     *
     * Keyed by ability id — the same word the move's settings block and its
     * `Attack` instance are named by, so the controller can ask for a press by
     * the name of the move rather than by the key it happened to arrive on.
     * @type {Record<string, boolean>}
     */
    this._attacks = {};

    this._onKeyDown = (event) => {
      if (this._isTyping(event.target)) return;
      // Arrow keys scroll the page and space would too; movement keys are ours.
      if (MOVE_KEYS[event.code] || event.code === 'Space') event.preventDefault();
      // Auto-repeat is the key still being held, not a second press.
      if (event.code === 'Space' && !event.repeat) this._jump = true;
      const attack = ATTACK_KEYS[event.code];
      if (attack && !event.repeat) this._attacks[attack] = true;
      this.pressed.add(event.code);
    };
    this._onKeyUp = (event) => this.pressed.delete(event.code);
    this._onBlur = () => {
      this.pressed.clear();
      this._jump = false;
      this._attacks = {};
    };

    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
  }

  /** Keystrokes meant for the editor's own fields are not movement. */
  _isTyping(node) {
    return (
      node instanceof HTMLInputElement ||
      node instanceof HTMLTextAreaElement ||
      node instanceof HTMLSelectElement
    );
  }

  /**
   * Collapse the held keys into an axis pair, once per frame.
   *
   * The diagonal is normalised — pressing W+D must not be faster than W alone —
   * and opposite keys cancel, which is what makes tapping both feel like a stop
   * rather than a stutter.
   */
  sample() {
    const held = this.pressed;
    let x = 0;
    let y = 0;

    for (const [code, direction] of Object.entries(MOVE_KEYS)) {
      if (!held.has(code)) continue;
      if (direction === 'forward') y += 1;
      else if (direction === 'back') y -= 1;
      else if (direction === 'right') x += 1;
      else x -= 1;
    }

    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }

    this.axis.x = x;
    this.axis.y = y;
    this.running = held.has('ShiftLeft') || held.has('ShiftRight');
    return this.axis;
  }

  /**
   * Take the buffered jump press, if there is one.
   *
   * Always call it, even where a jump cannot start — leaving a press in the
   * buffer would fire it later, at a moment the player did not ask for.
   */
  consumeJump() {
    const pressed = this._jump;
    this._jump = false;
    return pressed;
  }

  /**
   * Take the buffered press for one attack, if there is one.
   *
   * Same contract as `consumeJump`: always call it for *every* attack, or a
   * press left behind fires the move at whatever happens to be standing there
   * later.
   *
   * @param {string} id the ability id, e.g. `'kick'` or `'slashHit'`
   */
  consumeAttack(id) {
    const pressed = this._attacks[id] === true;
    this._attacks[id] = false;
    return pressed;
  }

  /** True while the stick is pushed at all. */
  get moving() {
    return this.axis.x !== 0 || this.axis.y !== 0;
  }

  dispose() {
    this.target.removeEventListener('keydown', this._onKeyDown);
    this.target.removeEventListener('keyup', this._onKeyUp);
    this.target.removeEventListener('blur', this._onBlur);
    this.pressed.clear();
  }
}
