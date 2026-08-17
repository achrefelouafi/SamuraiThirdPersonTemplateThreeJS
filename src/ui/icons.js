/**
 * The glyph for each move, drawn rather than written.
 *
 * One 24×24 line drawing per ability id, in the same brush language: a single
 * stroke weight, round caps, and the faint marks — impact, trail, speed —
 * carried at lower opacity so the shape of the move reads first and the motion
 * second. Everything is `currentColor`, so a chip's state colours its icon by
 * setting `color` and nothing else.
 *
 * These are markup, not files: an inline `<svg>` costs no request, inherits the
 * chip's colour and transitions, and cannot arrive late and pop in over a HUD
 * that is already on screen.
 */

/** @param {string} body inner markup, in a 24×24 box */
const stroke = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/**
 * A hooded body, filled, centred on `cx`. Used twice for the shadow pair.
 *
 * The two overlap, so the front one is cut out of the back one with a stroke in
 * the seal's own ground rather than drawn flush against it — at 26px a shared
 * edge is the difference between two figures and one blob.
 *
 * @param {string} [cut] ground colour to carve a gap with, if it is the front one
 */
const figure = (cx, cut) => {
  const carve = cut ? ` stroke="${cut}" stroke-width="1.5" stroke-linejoin="round"` : ' stroke="none"';
  return (
    `<circle cx="${cx}" cy="6.4" r="2.4" fill="currentColor"${carve}/>` +
    `<path d="M${cx} 10.1c-2.8 0-4.6 2.5-4.9 5.9-.2 2.1 0 3.5.3 5h9.2` +
    `c.3-1.5.5-2.9.3-5-.3-3.4-2.1-5.9-4.9-5.9z" fill="currentColor"${carve}/>`
  );
};

/**
 * Icon markup by ability id.
 *
 * Keyed by the same `id` that names the settings block and the clip, so adding
 * a move means adding one entry here and one in `config/abilities.js`.
 *
 * @type {Record<string, string>}
 */
export const ABILITY_ICONS = {
  // An arc of travel with the leap's own arrowhead at the far end, dashed
  // because the ground under it is the part that is not there.
  leap: stroke(
    `<path d="M3 19.2c1.4-7.4 6.2-11.6 13.4-11.6" stroke-dasharray="2.4 2.6" opacity="0.8"/>` +
      `<path d="M12.8 4.4 17 7.6 13.6 11"/>` +
      `<circle cx="3" cy="19.2" r="1.5" fill="currentColor" stroke="none"/>`
  ),

  // A body on the stand, with a slot open either side of it — the studio is
  // where gear goes on, so the glyph is the fitting rather than the armour.
  customize: stroke(
    `<circle cx="12" cy="5.4" r="2.5"/>` +
      `<path d="M7.3 20.6c0-4.9.9-7.8 4.7-7.8s4.7 2.9 4.7 7.8" stroke-width="1.8"/>` +
      `<path d="M9.2 9.1 12 10.6l2.8-1.5" opacity="0.85"/>` +
      `<rect x="1.4" y="10.2" width="3.8" height="3.8" rx="1" opacity="0.6"/>` +
      `<rect x="18.8" y="10.2" width="3.8" height="3.8" rx="1" opacity="0.6"/>` +
      `<path d="M5.6 12.1h1.8M16.6 12.1h1.8" stroke-width="1.4" opacity="0.45"/>`
  ),

  // The leg, hip to knee to ankle to toe, with the impact thrown off the toe.
  // The hip is a dot and the foot a wedge: without them the joints read as a
  // tick mark rather than as a limb coming out of a body.
  kick: stroke(
    `<circle cx="4.6" cy="3.8" r="1.7" fill="currentColor" stroke="none"/>` +
      `<path d="M4.8 4.6 9 10.1 5.5 14 12.2 17.2" stroke-width="2.1"/>` +
      `<path d="M11.4 15.6 15.8 17.7 14.6 20.2 10.4 18.2z" fill="currentColor" stroke="none"/>` +
      `<path d="M17.2 13.2 20.4 11.2M18.4 16.6 22 16.2M17 19.8 20.4 21.4" ` +
      `stroke-width="1.4" opacity="0.62"/>`
  ),

  // Blade rising out of the guard, and the crescent the edge left behind it.
  slashHit: stroke(
    `<path d="M2.6 11.4C6.4 4.6 14.4 2.6 21.4 5.4" stroke-width="1.4" opacity="0.6"/>` +
      `<path d="M6.6 17.4 19 5" stroke-width="2"/>` +
      `<path d="M3.4 20.6 6.6 17.4" stroke-width="2.4"/>` +
      `<path d="M4.8 15.6 9 19.8" stroke-width="1.5"/>`
  ),

  // The same blade laid flat, its trail low and wide, and the speed behind it.
  crouchSlash: stroke(
    `<path d="M2.2 15.6C7.2 20.2 15.6 20.6 21.8 16" stroke-width="1.4" opacity="0.6"/>` +
      `<path d="M5.8 14.2 19 9.4" stroke-width="2"/>` +
      `<path d="M2.8 15.3 5.8 14.2" stroke-width="2.4"/>` +
      `<path d="M5 12.4 6.6 16.8" stroke-width="1.5"/>` +
      `<path d="M2.6 6.6h4.6M3.8 9.6h3.2" stroke-width="1.4" opacity="0.45"/>`
  ),

  // Two of you: the one that goes, and the one that follows it out.
  shadows: stroke(
    `<g opacity="0.42">${figure(16)}</g>` + `<g>${figure(8.4, 'rgba(6, 8, 11, 0.92)')}</g>`
  ),

  // The seal seen edge-on, and what is coming through it. The arm is drawn and
  // the fist is filled, because the whole move is about the weight on the end
  // of it — an outline at this size reads as a glove.
  judgement: stroke(
    `<ellipse cx="12" cy="5.2" rx="8.4" ry="2.9"/>` +
      `<ellipse cx="12" cy="5.2" rx="4.9" ry="1.6" stroke-dasharray="1.9 1.9" opacity="0.55"/>` +
      `<path d="M9.8 6.8 8.7 12.6M14.2 6.8 15.3 12.6" opacity="0.85"/>` +
      `<path d="M8.3 12.4h7.4c1 0 1.8.8 1.8 1.8l-.1 3.1c0 1.5-1.2 2.6-2.7 2.6H9.3` +
      `c-1.5 0-2.7-1.1-2.7-2.6l-.1-3.1c0-1 .8-1.8 1.8-1.8z" fill="currentColor" stroke="none"/>` +
      `<circle cx="6.6" cy="15.9" r="1.6" fill="currentColor" stroke="none"/>` +
      // The knuckles, carved out of the mass rather than drawn on it.
      `<path d="M10.3 16.8v2.5M12.7 16.8v2.5M15.1 16.8v2.2" ` +
      `stroke="rgba(6, 8, 11, 0.92)" stroke-width="1.3"/>` +
      // And what it did to the ground.
      `<path d="M3.4 21.6 6 20.3M20.6 21.6 18 20.3" stroke-width="1.4" opacity="0.6"/>`
  ),

  // A body off the ground with the ring of blades around it. The figure is
  // filled and the swords are outlines, because the halo is the part that has
  // to read at 26px — a filled sword at this size is a smudge, and three
  // tapering strokes at three angles are unmistakably a ring of them.
  flight: stroke(
    // The blades: two out to the sides, tips down, and one behind the head.
    `<g opacity="0.9">` +
      `<path d="M2.9 5.4 4.3 13.4" stroke-width="1.6"/><path d="M2 6.1 3.8 4.7" stroke-width="1.3"/>` +
      `<path d="M21.1 5.4 19.7 13.4" stroke-width="1.6"/><path d="M22 6.1 20.2 4.7" stroke-width="1.3"/>` +
      `<path d="M12 1.4v3.1" stroke-width="1.4" opacity="0.7"/>` +
      `</g>` +
      // The body, hanging.
      `<circle cx="12" cy="8.2" r="2.2" fill="currentColor" stroke="none"/>` +
      `<path d="M12 10.8c-2.3 0-3.6 1.9-3.8 4.3-.1 1.2 0 2 .2 2.8h7.2c.2-.8.3-1.6.2-2.8` +
      `-.2-2.4-1.5-4.3-3.8-4.3z" fill="currentColor" stroke="none"/>` +
      // The trailing legs — the one line that says the feet are not on anything.
      `<path d="M10.4 17.9 8 21.4M13.6 17.9 16 21.4" stroke-width="1.6"/>` +
      // And the air under it.
      `<path d="M5.4 20.4h2.2M16.4 20.4h2.2" stroke-width="1.3" opacity="0.45"/>`
  )
};

/**
 * The icon for an ability, as an element ready to append.
 *
 * Falls back to an empty span when an id has no drawing yet — a new move should
 * cost a missing glyph, not a HUD that fails to build.
 *
 * @param {string} id
 * @param {string} [className]
 */
export function createIcon(id, className = 'hud__icon') {
  const holder = document.createElement('span');
  holder.className = className;
  holder.innerHTML = ABILITY_ICONS[id] ?? '';
  return holder;
}
