/**
 * settings.js — the single source of truth for every tweakable value on the stage.
 *
 * Nothing in the renderer owns state that lives here: the lights, the floor
 * shader, the dust and the post pipeline all *read* these objects every frame,
 * so mutating a field is immediately visible on screen without rebuilding
 * anything. Systems may only ever sample these values — never copy one into a
 * record at construction time and read it back later.
 *
 * The camera, environment and post blocks are lifted wholesale from the
 * LinearAbiltyCastingThreeJS sandbox, so this project's stage is lit, framed and
 * graded exactly like that one.
 *
 * Conventions
 *  - Colours are stored as `#rrggbb` strings. Read them through
 *    `utils/color.js#getColor()`, which caches one THREE.Color per string.
 *  - `global` holds multipliers that scale everything at once (1 = neutral).
 */

export const settings = {
  /* ------------------------------------------------------------------ */
  /* Global multipliers                                                  */
  /* ------------------------------------------------------------------ */
  global: {
    timeScale: 1.0, // slow-mo / fast forward for the whole simulation
    animationSpeed: 1.0 // character animation playback rate
  },

  /* ------------------------------------------------------------------ */
  /* Camera                                                              */
  /* ------------------------------------------------------------------ */
  /**
   * A third-person orbit rig. The distance always resolves back to `distance`,
   * so framing stays consistent however the target drifts, and the wheel zooms
   * by writing that same field — which keeps this file the one authority.
   */
  camera: {
    // Pulled back from the character-stage default: the subject here is a
    // forest, and at two metres the trunks are all out of frame.
    distance: 3.9,
    minDistance: 1.0,
    maxDistance: 12.0,
    zoomSpeed: 3.0,
    zoomDamping: 0.002,
    minPolar: 0.05,
    /**
     * How far the orbit may fall *below* the target, in radians from +Y.
     *
     * Past π/2 the camera drops under the point it is looking at and the view
     * tilts up — which is the only way anything in the sky gets into frame. At
     * the old 1.55 the rig could not raise its aim above about 26° of elevation,
     * and a moon parked higher than that was simply off the top of the screen.
     * Kept just past level: further down and a long zoom would put the lens
     * through the floor, which nothing here collides against.
     */
    maxPolar: 1.62,
    fov: 55,
    targetHeight: 1.3,
    damping: 0.001
  },

  /* ------------------------------------------------------------------ */
  /* Character                                                           */
  /* ------------------------------------------------------------------ */
  character: {
    /** Mixamo exports in centimetres. */
    fbxScale: 0.01,
    /** Rigs vary; normalise to a believable human height so world scale holds. */
    targetHeight: 1.78,
    /** Heading in radians about world +Y. 0 faces +Z, whichever way the rig binds. */
    facing: 0.0,
    /** Fraction of the heading gap left after 1s when turning (lower = snappier). */
    turnRate: 0.02,
    /**
     * Surface response of the imported skin.
     *
     * Materials matched out of the glTF palette carry their own authored
     * roughness/metalness *maps*, so these two are ignored for them until
     * `overrideSurface` is switched on — at which point they multiply the maps,
     * which is a way to look at the model rather than the shipped look. They
     * always apply to a material the palette had no match for.
     */
    overrideSurface: false,
    roughness: 1.0,
    metalness: 0.9,
    /** Slow turntable, revolutions/second. 0 parks the body where `facing` puts it. */
    spin: 0.0
  },

  /* ------------------------------------------------------------------ */
  /* Locomotion                                                          */
  /* ------------------------------------------------------------------ */
  /**
   * The third-person controller and the idle/walk/run blend it drives.
   *
   * `walkSpeed` and `runSpeed` are metres per second: how fast the body travels,
   * and the speeds the blend reads for its weights. `clipWalkSpeed` and
   * `clipRunSpeed` are what the *clips* were authored at, and they are what the
   * playback rate divides by — keeping the two apart is what makes raising
   * `runSpeed` speed the legs up to match instead of skating them.
   * `strideMin/Max` bound how far that rate is allowed to stretch.
   */
  locomotion: {
    enabled: true,
    walkSpeed: 1.5,
    runSpeed: 3.53,
    /** Ground speed each clip covers at rate 1. Fixed by the animation, not the design. */
    clipWalkSpeed: 1.35,
    clipRunSpeed: 6.35,
    /** m/s² toward the stick, and off it. Deceleration is the harder of the two. */
    acceleration: 14.0,
    deceleration: 20.0,
    /** Below this the body is standing still, whatever the residual velocity. */
    idleThreshold: 0.08,
    /** Fraction of the blend gap left after 1s (lower = snappier clip changes). */
    blendRate: 0.0005,
    /**
     * Trim on the stride rate, per gait — a multiplier on top of the
     * speed/clip-speed division, blended between the two the same way the
     * weights are. The division is only as right as `clipWalkSpeed` and
     * `clipRunSpeed` are, and those are guesses until someone watches the feet;
     * these are where that judgement goes. Leave them at 1 and nothing changes.
     *
     * The run trim is large because `clipRunSpeed` is set well above `runSpeed`:
     * the division alone would play the run clip at about half rate and drag the
     * feet, so the multiplier puts the legs back at the pace the ground is
     * actually passing at.
     */
    walkAnimSpeed: 0.8,
    runAnimSpeed: 2.42,
    /** Clamp on the clip playback rate, so a stretched speed never skates or sprints. */
    strideMin: 0.65,
    strideMax: 2.5
  },

  /* ------------------------------------------------------------------ */
  /* Jump                                                                */
  /* ------------------------------------------------------------------ */
  /**
   * The running long jump — space, from a run only. Space at any lesser pace
   * gets the in-place `hop` below instead.
   *
   * It is a committed move: the stick is dead from launch until the feet are
   * back down, and the body ends the jump wherever the arc put it. `distance`
   * is that reach in metres, applied by renormalising the clip's own hips
   * translation, so the animator's shape is kept and only its size is the
   * designer's; 0 means "travel exactly as far as the clip does".
   */
  jump: {
    enabled: true,
    /** Metres of ground the jump covers. 0 = whatever the clip itself travels. */
    distance: 7.0,
    /** Whether a run is a precondition. Off, and every jump is this one. */
    requiresRun: true,
    /** Fraction of `runSpeed` the body must already be doing to launch at all. */
    minRunFraction: 0.6,
    /** Normalised time in the clip at which the feet are down and control returns. */
    landAt: 0.86,
    /** Seconds to fade the jump over the run, and back off it after landing. */
    blendIn: 0.08,
    blendOut: 0.22
  },

  /**
   * The plain hop — space, from anything the long jump turns down.
   *
   * Standing, walking, or running below `jump.minRunFraction`, this is what
   * space does. The clip travels nowhere, and that is what lets it stay a
   * *modifier* rather than a move: it plays over the gait without taking the
   * stick, so a jump out of a walk keeps its momentum and comes down still
   * heading where the player was steering. Nothing here is a distance for the
   * same reason — the controller never stops owning the position.
   */
  hop: {
    enabled: true,
    /** No gait to clear, so the hop answers from a standstill too. */
    requiresRun: false,
    /**
     * How much of the gait keeps playing underneath, 0..1.
     *
     * The clip is a *standing* jump, so at full take-over it plants the legs
     * while the controller carries the body on — the body travels, but it reads
     * as the character stopping to jump and sliding. Leaving some of the walk or
     * run under it keeps the legs moving through the arc. Only the travelling
     * clips get this; a hop from a standstill is the pure pose.
     */
    gaitBleed: 0.35,
    /** Normalised time in the clip at which the feet are back down. */
    landAt: 0.82,
    /** Seconds to fade the hop over the gait, and back off it after landing. */
    blendIn: 0.07,
    blendOut: 0.18
  },

  /* ------------------------------------------------------------------ */
  /* The kick                                                            */
  /* ------------------------------------------------------------------ */
  /**
   * `E` — the one attack, and the thing that makes it read: **motion warping**.
   *
   * A kick animation is authored at one distance from one target, and a player
   * never stands there. Every third-person game worth the name answers this the
   * same way: the clip is not moved to the player, the *player* is moved to the
   * clip. On the press the nearest enemy inside `range` and the `cone` is
   * locked, the ideal contact spot is resolved (`standoff` metres short of it),
   * and the body is carried there over the first `warpAt` of the clip — turning
   * first, stepping in second. The foot lands where the animator put it, on a
   * target that is exactly where the animator assumed one would be.
   *
   * Everything after the contact is impact: `hitStop` freezes the world for a
   * few dozen milliseconds (the oldest trick in the fighting-game book, and
   * still the one that sells a hit), the lens takes a `shake`, and the enemy is
   * handed the impulse below as a ragdoll — see `combat/Ragdoll.js`.
   *
   * The three normalised times are the contract with the clip: `hitAt` is the
   * frame the foot is out, `recoverAt` the frame control comes back, and
   * `warpAt` the window the approach is allowed. Watch the kick once and dial
   * them; nothing else in here depends on the animation.
   */
  kick: {
    enabled: true,
    /** Metres a target can be locked from. Past this the kick swings at air. */
    range: 3.4,
    /** Full width of the search cone, degrees — a kick behind you is not a kick. */
    cone: 130,
    /**
     * Metres from the target's centre the strike is thrown from.
     *
     * This is the number that decides whether the foot lands on the chest or
     * through it. Mixamo's kicks are authored at roughly a metre and a bit.
     */
    standoff: 1.12,
    /** Ceiling on the warp, metres. Beyond it the body steps as far as it can. */
    maxWarp: 3.0,
    /** Fraction of the clip the approach takes. The rest is the strike itself. */
    warpAt: 0.36,
    /** Fraction of *that* window the turn finishes in: face first, then close. */
    turnAt: 0.5,
    /** Normalised time the foot connects. */
    hitAt: 0.42,
    /** Metres the strike still lands at, measured at `hitAt`. Slack on `standoff`. */
    reach: 2.1,
    /** Normalised time the stick is handed back. */
    recoverAt: 0.74,
    /** Played exactly as authored — see the slash's own note on this. */
    timeScale: 1,
    /** Seconds to fade the kick over the gait, and back off it. */
    blendIn: 0.08,
    blendOut: 0.24,

    /**
     * m/s along the kick, and straight up, given to the body it lands on.
     *
     * These two and `ragdoll.gravity` decide the distance: at the defaults the
     * body leaves the ground for about half a second and comes down some three
     * metres back. Far enough to read as a blow, near enough to still be in
     * frame when it lands.
     */
    impulse: 6.5,
    lift: 3.4,
    /**
     * How much more of that the *upper* body takes, per body-height above the
     * hips. This is the whole difference between a corpse sliding backwards and
     * one folding over the foot and going down — the shoulders leave faster
     * than the feet do, so the body rotates around the impact.
     */
    spin: 1.6,
    /** Seconds the world nearly stops on contact, and how far down it goes. */
    hitStop: 0.07,
    hitStopScale: 0.06,
    /** Metres the lens is kicked. Decays in about a third of a second. */
    shake: 0.16,
    /** A boot does not cut anyone in half — see `settings.slice`. */
    slices: false
  },

  /* ------------------------------------------------------------------ */
  /* The slash hit                                                       */
  /* ------------------------------------------------------------------ */
  /**
   * `R` — the second attack, and the same machine as the kick above.
   *
   * Every field means exactly what it means there, because both are driven by
   * the same `animation/Attack.js` and only the numbers differ. Read the block
   * above first; this one is only the ways the move is *not* a kick.
   *
   * The clip (`Slash.fbx`) is a two-handed sweep, and the numbers here are read
   * straight off it. It runs 2.4 seconds at its authored pace, which is half as
   * long again as anything else the body does — hence `timeScale`. Within that:
   *
   *  - **0 → 0.30** the wind-up, the blade carried back over the left shoulder.
   *    Nothing has happened yet, which is why the approach is allowed to run to
   *    `warpAt` before it has to be finished.
   *  - **0.33 → 0.42** the sweep. The hand crosses the body's front at 0.38 and
   *    reaches furthest at 0.40, so that is where the blow is (`hitAt`).
   *  - **0.42 → 0.66** the follow-through: the hips drop into a deep finish and
   *    come back up. Control returns as the body straightens, not after it has
   *    settled, or the move costs two whole seconds of standing still.
   *
   * It hits *across* rather than down — more shove than the jump it replaced,
   * still a lot of lift, because a top half that is thrown clear is the whole
   * point of a cut. See `settings.slice` for what happens to the body itself.
   */
  slashHit: {
    enabled: true,
    /** Metres a target can be locked from — a sword reaches past a foot. */
    range: 5.0,
    /** Full width of the search cone, degrees. Tighter: this one is committed. */
    cone: 110,
    /**
     * Metres from the target's centre the swing is thrown from.
     *
     * Further out than the kick's, and it has to be: the contact is the length
     * of an arm and a blade from the shoulder, not the length of a leg.
     */
    standoff: 1.6,
    /** Ceiling on the warp, metres. This one steps in rather than leaps. */
    maxWarp: 4.5,
    /**
     * Fraction of the clip the approach takes.
     *
     * The end of the wind-up, so the body arrives on its mark on the frame the
     * blade starts to move and the sweep itself is never slid through.
     */
    warpAt: 0.34,
    /** Fraction of *that* window the turn finishes in: face first, then close. */
    turnAt: 0.45,
    /** Normalised time the blow connects — the frame the edge crosses the front. */
    hitAt: 0.38,
    /** Metres the strike still lands at, measured at `hitAt`. */
    reach: 2.6,
    /** Normalised time the stick is handed back, as the body comes back up. */
    recoverAt: 0.66,
    /**
     * How much faster than authored the clip is played.
     *
     * 2.4 seconds is a long time to hold a player still. At 1.35 the swing is
     * about 1.8 seconds end to end and the commitment is a little over one,
     * which puts it in the same family as the kick without touching the export.
     */
    timeScale: 1.35,
    /** Seconds to fade the move over the gait, and back off it. */
    blendIn: 0.09,
    blendOut: 0.26,

    /**
     * m/s along the blow, and straight up.
     *
     * Lower than the kick's, and it still throws further: half a body weighs
     * half as much to this solver and `slice.split` adds to it on top. At these
     * the torso comes down about four and a half metres out, against the three
     * and a half a whole body kicked across the same ground manages — far
     * enough to read as *thrown clear*, near enough to still be in frame.
     */
    impulse: 4.6,
    lift: 5.2,
    /** Upper body multiplier — high, so what is left of the torso goes over. */
    spin: 2.0,
    /** Seconds the world nearly stops on contact, and how far down it goes. */
    hitStop: 0.1,
    hitStopScale: 0.05,
    /** Metres the lens is knocked. */
    shake: 0.24,
    /** This one comes across with the sword: the body it lands on comes apart. */
    slices: true
  },

  /* ------------------------------------------------------------------ */
  /* The slide cut                                                       */
  /* ------------------------------------------------------------------ */
  /**
   * `R` — the gap closer. Same machine again (`animation/Attack.js`), and the
   * one of the three whose *approach* is the move rather than a way of reaching
   * one.
   *
   * The clip (`Crouchslash.fbx`) runs 2.12 seconds at 60fps and carries about
   * three and a half metres of its own forward travel, which `_retarget` freezes
   * like every other non-root-motion clip — so the ground it covers is the warp's
   * to supply, and `maxWarp` is what decides how far the slide actually goes.
   * Read off the hips and the sword hand:
   *
   *  - **0 → 0.24** the run-up and the drop: the hips fall from standing to a
   *    third of their height and the blade is carried back and low.
   *  - **0.24 → 0.47** the slide itself, hips flat at their lowest. Nothing has
   *    happened yet, which is why the approach is allowed to run this late —
   *    `warpAt` sits at the end of it, so the whole distance is closed on the
   *    frames that are authored as travel.
   *  - **0.47 → 0.70** the body comes up out of the crouch and the arm sweeps
   *    across the front, furthest out at 0.60 and crossing the far shoulder at
   *    0.70 — the ~45th frame of the source, and `hitAt`. The body is still
   *    travelling here, and it is meant to be: this is the frame it draws level
   *    with what it is cutting, not the frame it stops in front of it.
   *  - **0.70 → 1** the follow-through and standing back up, on the far side of
   *    the body (`passThrough`). Control comes back as the character straightens
   *    rather than after it has settled.
   *
   * It is a sword and it cuts (`slices`), and it comes across low and hard: more
   * shove than the standing slash, since the whole body weight is behind it.
   */
  crouchSlash: {
    enabled: true,
    /**
     * Metres a target can be locked from.
     *
     * By far the longest of the three, because this is the move that *travels*:
     * the clip is a run into a slide, and locking only what is already in a
     * sword's reach would waste it.
     */
    range: 9.0,
    /** Full width of the search cone, degrees. Narrow — you commit to a line. */
    cone: 90,
    /**
     * Metres from the target's centre the cut is thrown from — as the slash.
     *
     * Not where the move ends, though: this one only *passes* the mark. See
     * `passThrough`.
     */
    standoff: 1.55,
    /** Ceiling on the warp, metres. The whole point of the move. */
    maxWarp: 8.0,
    /**
     * Metres past the body the slide finishes, and the thing that makes this a
     * pass rather than a stop.
     *
     * A slide cut that halts in front of what it cut is a run that ran out. The
     * warp gets a second leg for it (`animation/Attack.js`): the contact mark is
     * somewhere on the way rather than the end of the trip, and the body carries
     * on down the same line until it is standing behind what it just opened,
     * still facing the way it went. With `passAt` at `recoverAt` the travel ends
     * on the frame the stick comes back, so the player takes the body over
     * already on the far side.
     */
    passThrough: 1.9,
    /**
     * Normalised time the pass-through finishes.
     *
     * The far side of the cut and the frames the body is standing back up on —
     * it should not still be sliding once the player has it again, so this and
     * `recoverAt` are the same number.
     */
    passAt: 0.86,
    /**
     * Fraction of the clip the approach takes.
     *
     * The end of the slide, so the gap is closed while the body is low and
     * moving. What comes after it is no longer the approach but the pass: at
     * this frame the character is on the mark, at `hitAt` it is level with the
     * body, and by `passAt` it is behind it.
     */
    warpAt: 0.6,
    /**
     * Fraction of *that* window the turn finishes in.
     *
     * Early: a slide that curves reads as a homing missile, so the body is
     * pointed down the line before it has gone far along it.
     */
    turnAt: 0.3,
    /** Normalised time the blade crosses the target — the ~45th source frame. */
    hitAt: 0.7,
    /** Metres the strike still lands at, measured at `hitAt`. */
    reach: 2.8,
    /** Normalised time the stick is handed back, as the body stands back up. */
    recoverAt: 0.86,
    /**
     * How much faster than authored the clip is played.
     *
     * A touch quicker than authored, which puts the whole move at about 1.7
     * seconds and the commitment at 1.4 — long for an attack, and it should be:
     * this one crosses eight metres for it.
     */
    timeScale: 1.25,
    /** Seconds to fade the move over the gait, and back off it. */
    blendIn: 0.1,
    blendOut: 0.26,

    /**
     * m/s along the blow, and straight up.
     *
     * More along and less up than the standing slash: this comes across at hip
     * height with the body's own speed behind it, so what it lands on is taken
     * off its feet rather than lifted off them.
     */
    impulse: 5.8,
    lift: 4.2,
    /** Upper body multiplier — what is left of the torso goes over the cut. */
    spin: 2.1,
    /** Seconds the world nearly stops on contact, and how far down it goes. */
    hitStop: 0.11,
    hitStopScale: 0.05,
    /** Metres the lens is knocked. The heaviest of the three. */
    shake: 0.28,
    /** A sword, at the waist: the body it lands on comes apart. */
    slices: true
  },

  /* ------------------------------------------------------------------ */
  /* The slice                                                           */
  /* ------------------------------------------------------------------ */
  /**
   * Cutting a body in half — see `combat/Enemy.js` and `vfx/BloodBurst.js`.
   *
   * A move whose block says `slices` does not simply fell the body it lands on:
   * it parts it along a plane. Nothing is re-tessellated to do that. The body is
   * duplicated, each copy is given the *same* plane and told to keep the
   * opposite side of it (`uCutSide` in the enemy's shader), and each is handed
   * its own ragdoll — so the two halves are two bodies that happen to have been
   * one a frame ago, and every joint below the waist can fall while every joint
   * above it flies.
   *
   * The plane is measured in the mesh's **bind** space rather than in the posed
   * one, which is the only reason the cut stays at the waist while the halves
   * tumble: a plane in posed space would slide up the body as the corpse folded
   * over, and eventually eat all of it.
   *
   * The hollow the cut opens is filled by the same materials' back faces
   * (`interiorColor`), which is why every enemy is double-sided from birth —
   * flipping that at the moment of the blow would cost a shader recompile
   * exactly when the frame can least afford one.
   */
  slice: {
    enabled: true,
    /**
     * Where the plane sits, as a fraction of the body's own height.
     *
     * 0.60 is the waist on this export — between the hip joint and the base of
     * the spine. Below it and the plane goes through the pelvis, which leaves
     * the top half with a slab of hip hanging off it; much above and the legs
     * walk away with the ribcage.
     */
    height: 0.6,
    /** Degrees it is tilted off horizontal, tipping away along the blow. */
    tilt: 16,
    /** Metres the upper half is lifted clear on the frame the body parts. */
    separation: 0.09,
    /**
     * m/s the halves are driven *apart* along the blow, added on top of
     * whatever each one already took of it.
     *
     * The top half gets it the way the sword went and the legs get it the other
     * way, so the two travel in opposite directions instead of following each
     * other into the same heap — which is the difference between reading the
     * cut and reading a body that fell over in two bits. It is added evenly
     * rather than weighted up the body (`Ragdoll#shove`), so neither half is
     * spun by it: the fold is the blow's doing, this only separates them.
     *
     * Large enough here that the legs end up going slightly backwards, since
     * `lower.impulse` gives them a little forward to cancel first.
     */
    split: 1.8,
    /**
     * What each half does with the blow, as multipliers on the move's own
     * `impulse` / `lift` / `spin`. The top of a body cut in half leaves with
     * most of what the sword had; the bottom is a pair of legs that fold.
     *
     * Well under 1 rather than over it, which reads backwards until you see
     * why: `spin` is applied per *body height*, and half a body is half as
     * tall, so the same number throws its head twice as hard. At these the top
     * half comes down about where a whole body kicked by the same blow would
     * have, which is the reach the move was tuned against.
     */
    upper: { impulse: 0.78, lift: 0.72, spin: 0.55 },
    lower: { impulse: 0.22, lift: 0.1, spin: 0.2 },

    /**
     * The two halves as solid things — see `collideRagdolls` in
     * `combat/Ragdoll.js`.
     *
     * Each half is its own solver and neither knows the other is there, so
     * without this the torso falls through the legs it was cut off and the
     * whole thing reads as two sprites rather than one body coming apart. A
     * dozen spheres against a dozen, once a frame, for the second or two a
     * corpse is still moving.
     *
     * `radius` is the base — every joint scales it by its own size (a pelvis is
     * a chunk, a wrist is not). `maxPush` is what keeps it from exploding: it
     * caps how far one frame may separate a pair, so an overlap that starts
     * deep opens over several frames instead of firing the halves apart.
     */
    collide: {
      enabled: true,
      /** Metres, before each joint's own size multiplier. */
      radius: 0.09,
      /** How much of the closing speed comes back, and how much slide is lost. */
      bounce: 0.2,
      friction: 0.45,
      /** Metres a single frame may push one pair apart. */
      maxPush: 0.05
    },

    /** The meat the cut opens, and how much it glows in its own right. */
    interiorColor: '#4a0a0d',
    interiorEmissive: 0.4,
    /** The hot line the steel leaves, and how wide that band is (× height). */
    edgeColor: '#ff3a22',
    edgeEmissive: 3.5,
    edgeWidth: 0.012,

    /**
     * The blood — `vfx/BloodBurst.js`.
     *
     * One burst on the frame the body parts, then both stumps run for
     * `bleedTime`. Not additive: blood is dark, and additive dark is nothing.
     * `color` is the one control that matters; everything else is how it flies.
     */
    blood: {
      enabled: true,
      color: '#8b0a0a',
      /** Lifts it out of a blue night without turning it pink. */
      brightness: 1.15,
      /** Droplets thrown on the cut, and how fast they leave it. */
      burst: 220,
      speed: 5.0,
      /** How wide the spray opens, as a fraction of that speed. */
      spread: 0.6,
      /** Droplets a second from each stump afterwards, and for how long. */
      drip: 70,
      dripSpeed: 1.3,
      bleedTime: 2.4,
      /** Metres across. The streak is the speed's doing, not this. */
      size: 0.03,
      sizeVariance: 0.6,
      /** Seconds a droplet lives. */
      life: 1.2,
      lifeVariance: 0.45,
      /** Heavier than the ragdoll's air: drops arc rather than float. */
      gravity: -16,
      drag: 0.5,
      /** How far a droplet is smeared along its own screen velocity. */
      stretch: 0.05,
      maxStretch: 6,
      /** Fraction of the life spent fading out. */
      fade: 0.35
    }
  },

  /* ------------------------------------------------------------------ */
  /* The target ring                                                     */
  /* ------------------------------------------------------------------ */
  /**
   * The circle under anyone a move could land on — see `vfx/TargetRings.js`.
   *
   * Aim assist is invisible by nature: the cone and the range decide who a
   * press goes to, and until something says so the player is guessing. This is
   * that something, and it deliberately answers the *same* question the attack
   * asks — a body wears a ring exactly when `EnemyManager#findTarget` *returns
   * it* for some enabled move, which is the one body that press would take. Not
   * everyone standing inside the range and the cone: a swing only ever goes to
   * one of them, and lighting the rest is a promise three quarters of them
   * cannot keep.
   *
   * The look is a rim rather than a disc: `falloff` is the exponent on the
   * radius, so the brightness runs from nothing at the centre to full at the
   * edge — a fresnel pointed inwards — and `softness` is the feather that keeps
   * the outer edge off the ground. A filled disc under a body reads as a
   * shadow; only the glowing edge reads as a lock.
   */
  targetRing: {
    enabled: true,
    /** Metres from the body's centre to the edge of the circle. */
    radius: 0.7,
    /** Lifted clear of the floor, so it never z-fights the terrain. */
    lift: 0.03,
    /**
     * The inward gradient, as an exponent on the radius.
     *
     * 1 is a flat ramp from the centre out. Higher pins the light to the rim —
     * past about 6 it is a hard ring with nothing inside it.
     */
    falloff: 4.5,
    /** Fraction of the radius the outer edge feathers over. */
    softness: 0.12,
    color: '#ff7a3c',
    /** Master on the additive brightness. */
    intensity: 1.5,
    /** How much of that the slow breath takes off, and how fast it breathes. */
    pulse: 0.25,
    pulseSpeed: 3.2,
    /** Seconds the ring takes to come up, and to go out once out of reach. */
    fadeIn: 0.12,
    fadeOut: 0.2,

    /**
     * The key caps over the head of whoever is wearing a ring — see
     * `ui/TargetHotkeys.js`.
     *
     * The ring says *this one*; the caps say *with which key*. They matter
     * because the two attacks do not reach the same distance: at four metres
     * the slash has a target and the kick has nothing, and without this the
     * player has to learn that by whiffing. There is no fade of their own —
     * they come up and go out on the ring's, because they are one mark.
     */
    hotkeys: {
      enabled: true,
      /** Metres above the top of the body the row floats. */
      lift: 0.75,
      /** Master on the row's size, 1 being the size the stylesheet sets. */
      scale: 1.0
    }
  },

  /* ------------------------------------------------------------------ */
  /* Enemies                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * The bodies standing around waiting to be kicked — see `combat/`.
   *
   * `count` of them stand within `radius` of the player and no closer than
   * `minRadius`, each idling on its own phase of the same clip so the group
   * never breathes in unison. They watch the player turn, and that is the whole
   * of their behaviour: this is a combat *feel* sandbox, not an AI one.
   *
   * Death is `ragdoll` below — a Verlet skeleton with no physics engine behind
   * it — followed by `corpseTime` seconds on the ground and a `dissolveTime`
   * burn-away. A slot that empties is refilled `respawnDelay` later, around
   * wherever the player has walked to, so there are always `count` of them.
   */
  enemies: {
    enabled: true,
    /** How many are standing at any moment. */
    count: 5,
    /** Metres from the player they spawn inside, and no nearer than. */
    radius: 13,
    minRadius: 4.5,
    /** Metres between two of them, so they never share a patch of ground. */
    separation: 2.4,
    /** Normalised height, metres — the same treatment the player's rig gets. */
    height: 1.78,

    /** Whether they turn to watch the player, and from how far. */
    watch: true,
    watchRadius: 18,
    /** Fraction of the heading gap left after 1s (lower = they snap round). */
    turnRate: 0.02,

    /** Whether the player is stopped by them, and the radius of that cylinder. */
    collide: true,
    bodyRadius: 0.42,

    /** Seconds a corpse lies there, then the seconds it takes to burn away. */
    corpseTime: 5.0,
    dissolveTime: 1.3,
    /** Seconds before an empty slot is refilled. */
    respawnDelay: 2.5,

    /**
     * The look. The export carries no textures at all, so this is authored
     * rather than imported: a cold, near-black body with an ember rim, which is
     * the one combination that reads as hostile against a blue night and stays
     * legible at twenty metres.
     */
    look: {
      color: '#191c24',
      roughness: 0.78,
      metalness: 0.15,
      /** The rim that draws the silhouette. Same device the shadows use. */
      rimColor: '#ff5a1e',
      rimPower: 2.6,
      rimEmissive: 1.5,
      /** The burn edge as they dissolve, and how wide that band is. */
      edgeColor: '#ff8a3c',
      edgeEmissive: 6.0,
      edgeWidth: 0.12,
      /** Features per metre in the dissolve noise. */
      dissolveDetail: 9.0,
      /** How much the burn is driven by height rather than noise — 1 = a clean
       * line rising from the feet, 0 = pure static. */
      dissolveRise: 0.45
    },

    /**
     * The ragdoll — see `combat/Ragdoll.js` for what these actually drive.
     *
     * It is a particle per joint, the bone lengths as distance constraints and
     * a few braces across the pelvis and chest, solved by relaxation. `gravity`
     * is deliberately heavier than earth: a body that falls at 9.8 on a screen
     * this size reads as slow motion, and every game does the same thing.
     */
    ragdoll: {
      gravity: -19.0,
      /** Fraction of the velocity the air takes per second. */
      damping: 0.06,
      /** Relaxation passes per substep, and substeps per frame. More = stiffer. */
      iterations: 7,
      substeps: 2,
      /** How hard the braces pull compared to the bones themselves. */
      brace: 0.45,
      /** Metres a joint stands off the ground, and how it lands on it. */
      radius: 0.075,
      friction: 0.62,
      bounce: 0.06,
      /** Below this much movement per second, the body is asleep and free. */
      sleep: 0.03
    }
  },

  /* ------------------------------------------------------------------ */
  /* Terrain                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * The shape of the ground — see `world/Terrain.js`.
   *
   * Every value here is a live shader uniform, so the landscape can be redialled
   * while walking over it; nothing in this block rebuilds a buffer except
   * `seed` (which reshuffles a 256×256 table) and `segments` (which rebuilds the
   * floor mesh). The character, the camera and the shadow focus all read the
   * same height field on the CPU, so the body walks the hills it can see.
   *
   * Nothing here has a per-frame cost any more. The field is evaluated once
   * into a texture (`world/TerrainCache.js`) and the floor reads one texel per
   * vertex, so `octaves` now only prices the bake — which runs when a control
   * below moves, and about every sixty metres of walking.
   */
  terrain: {
    enabled: true,
    /**
     * Metres from the mean height to a peak. 0 is a flat plane.
     *
     * fbm almost never reaches its own extremes, so the ground actually swings
     * about ±2.5 m at this setting. Deliberately gentler than open ground would
     * want: a forest floor rolls, and every metre of relief is a metre of
     * trunk-base the ground hides.
     */
    amplitude: 3.4,
    /** Metres per lattice unit of the base octave — the size of the big hills. */
    scale: 62,
    octaves: 5,
    lacunarity: 2.05,
    gain: 0.5,
    /** Pushes the lattice around with a slower copy of itself: valleys, not blobs. */
    warp: 1.05,
    /** 0 rolling downs, 1 sharp ridges. */
    ridge: 0.28,
    seed: 3,
    /**
     * Floor mesh subdivisions per side. 400 m / this is the vertex spacing.
     *
     * 384 puts a vertex about every metre; below about 128 the hills start to
     * read as facets in silhouette.
     */
    segments: 384
  },

  /* ------------------------------------------------------------------ */
  /* Weapon fire                                                         */
  /* ------------------------------------------------------------------ */
  /**
   * The burning katana — see `vfx/WeaponFire.js`.
   *
   * The effect is aimed by a *volume* rather than by a bone or an offset:
   * `box` is an oriented box in the weapon's own frame, and every face of the
   * model inside it is emitting. It starts as the model's own bounding box, so
   * the whole sword is alight and already aligned with the blade at any angle
   * the hand holds it; shrink it down the blade to leave the grip cold. Faces
   * are picked by area, so the fire is even over whatever the box keeps.
   *
   * Everything here is live: the particles read these values every frame and
   * nothing rebuilds except the triangle selection, which re-runs only on a
   * frame the box actually moved.
   */
  fire: {
    enabled: true,
    /** Catalog id of the piece that burns. */
    item: 'sword',
    /** Master dial on emission and brightness together. 0 puts it out. */
    intensity: 1.0,

    /** The emitter volume, in the weapon's own frame. Metres and degrees. */
    box: {
      /** Draw the wireframe. The character screen turns this on to edit it. */
      show: false,
      /**
       * Refit to the model's bounds the next time the weapon is (re)bound.
       * Off by default: a refit overwrites the offsets below, so leaving it on
       * would discard the authored placement on every equip. The panel's
       * "Refit to weapon" button still does it on demand.
       */
      autoFit: false,
      x: 0,
      y: 0,
      z: 0.617,
      rotX: 0,
      rotY: 0,
      rotZ: 0,
      /** Multiplier on `size` — this is what the gizmo's scale handles write. */
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      /** Full extents before the scale above. Overwritten by an auto-fit. */
      sizeX: 0.08,
      sizeY: 0.08,
      sizeZ: 0.9
    },

    /**
     * The flame body — a raymarched black-body volume, so these are volume
     * parameters and not surface ones. See `vfx/VolumetricFireMaterial.js` for
     * how the four layers (sheath → silhouette → turbulence → shred) stack up,
     * and why the flame is shaded by temperature rather than by a palette.
     *
     * The volume is wrapped around a distance field baked off the faces the box
     * kept, which is what makes it the *sword* burning instead of a box of fire
     * around it.
     */
    volume: {
      enabled: true,
      /** Metres of burning gas off the steel. The single biggest look dial. */
      thickness: 0.035,
      /** How far that coating is drawn out downwind — 1 is a uniform sheath. */
      plume: 2.68,
      /** Metres the plume runs before the gas is spent. */
      length: 1.13,
      /** How much wider the sheath gets as it rises. */
      spread: 4.0,
      /** Buoyant speed, and how much of the blade's velocity bends the flow. */
      rise: 3.8,
      inherit: 0.7,
      softness: 0.23,
      /** How violently the fringe tears compared to the core. */
      shred: 2.62,
      /**
       * Lobes in the silhouette, and how many per metre.
       *
       * Higher than the sandbox this was ported from, and it has to be: lobes
       * are sized against the flame they are pinching, and a 45 mm sheath on a
       * blade wants them ten times finer than a metre-wide fireball does.
       */
      bulge: 0.2,
      bulgeScale: 30.0,
      /** How hard the tips tear off into separate puffs. */
      detachment: 2.0,
      /** How fast the field climbs, in noise widths per second. */
      buoyancy: 4.21,
      /**
       * Detail size, in features per metre.
       *
       * Everything downstream (buoyancy, lick) is expressed in *noise widths*
       * rather than metres, so those numbers carry over from a fireball to a
       * blade unchanged while this one does not.
       */
      noiseFrequency: 40.0,
      noiseStrength: 1.05,
      /** Domain warp — folds the noise into curling sheets. */
      warp: 0.2,
      /** > 1 draws structures out along the flow into licking tongues. */
      tongue: 2.8,
      /** How far the fringe is sheared downwind relative to the core. */
      lick: 3.6,
      /** Ridged filaments shredding the fringe into strands. */
      wisps: 2.0,
      flicker: 0.96,
      /** Turbulence octaves — quality against cost. */
      octaves: 5,

      /**
       * Temperature and radiance, in kelvin. The flame is a Planckian radiator:
       * the red fringe, orange body and white core are what a grey body emits
       * across this range, and `emissionCurve` is the exponent the radiated
       * power follows (4 is Stefan-Boltzmann; a little under is gentler).
       */
      // Hot enough that the gas against the steel is yellow-white and only the
      // spent tips are red. Under about 2200 K the whole plume comes out one
      // flat orange, which is the single most common way a good flame shader
      // still reads as a decal.
      tempCore: 2480,
      tempEdge: 1460,
      emissionCurve: 4.5,
      /** How fast the gas reaches full temperature inside the surface. */
      heatFocus: 0.57,
      /** How sharply it cools toward that surface. */
      heatFalloff: 1.86,
      /**
       * How far the turbulence may drag the temperature around.
       *
       * Radiated power goes as a high power of T, so this is amplified several
       * times over on screen — past about 0.5 the noise's own contour lines
       * start showing through as agate banding.
       */
      heatFollow: 0.23,
      /** Temperature of the spent gas at the tips. */
      tailHeat: 0.26,
      /** 0 = pure black-body physics, 1 = the hand-authored `look` colours. */
      palette: 0.0,
      /** Firelight bouncing inside the sooty fringe, and how fast it dies off. */
      scatter: 1.61,
      scatterFalloff: 3.4,

      density: 3.4,
      /** Absorption — how much the cool gas occludes. */
      soot: 1.42,
      /** Extinction left in the hottest gas. Low turns the core into a blob. */
      coreClarity: 0.54,
      // Emission and opacity are tuned as a pair, and this pair is the thin,
      // gassy read: the volume is barely opaque, so it is radiating far more
      // than it occludes and the hot steel stays visible straight through the
      // flame. Raising `opacity` back toward 1 at this emission turns the plume
      // into a solid orange bar.
      glow: 20.0,
      opacity: 0.39,
      /** Raymarch samples per pixel — quality against fill cost. */
      steps: 64,

      /** Only in force as `palette` is turned up: core → mid → edge → smoke. */
      colorCore: '#fff6d8',
      colorMid: '#ffb02e',
      colorEdge: '#ff3d10',
      colorSmoke: '#181616'
    },

    /**
     * The steel itself, glowing — see `vfx/BladeHeat.js`.
     *
     * What separates a burning sword from a sword standing in a fire. The
     * weapon's own materials get one extra emissive term, aimed by the same
     * emitter box as everything else, so the metal inside the box is a light
     * source: white at the edge, dull red where it is thick, dark and scaled
     * everywhere the box does not reach.
     */
    steel: {
      enabled: true,
      /** Master on the glow. 0 leaves the weapon its ordinary materials. */
      amount: 3.0,
      /**
       * Kelvin at the hottest and coolest the metal gets, and the exponent its
       * radiated power follows. The same law as the flame above, which is why
       * the two sit in one light instead of two — but the steel is run several
       * hundred kelvin cooler, so it reads as orange metal inside a hotter
       * yellow sheath rather than competing with it.
       */
      tempCore: 2060,
      tempEdge: 1380,
      curve: 4.0,
      /**
       * How much hotter grazing angles run.
       *
       * On a blade the silhouette *is* the cutting edge and the spine — the thin
       * steel that glows first — so this is what draws the white filament down
       * the edge in the reference, and it costs one dot product.
       */
      edge: 1.5,
      edgeSharpness: 2.6,
      /** Uneven heat crawling up the blade: how strong, how fine, how fast. */
      detail: 0.5,
      scale: 11.0,
      speed: 0.6,
      /**
       * How much the albedo's own relief drives temperature.
       *
       * Lighter map values come out hotter, which is what picks the tsuka-ito's
       * diamonds and the temper line out as glowing lattice rather than letting
       * the grip go to one orange blob.
       */
      relief: 0.75,
      /** Fraction of the box the glow fades out over at its faces. */
      falloff: 0.35,
      /** How far the glow darkens the metal under it — hot steel is not a mirror. */
      char: 0.7
    },

    /**
     * Sparks off the burning faces — see `vfx/EmberSystem.js`.
     *
     * Every one is born on an actual triangle of the model inside the box,
     * picked by area, and then flies a closed-form trajectory: linear drag
     * against buoyancy, wandered by noise, stretched along its own velocity into
     * a streak. They are let go into the world at birth, so a swing leaves its
     * sparks hanging in the air behind the blade.
     */
    embers: {
      enabled: true,
      // Many, and short-lived: three times the births burning for under a
      // second reads as a shower coming off the steel, where the same count at
      // a two-second life just hangs in the air as a cloud.
      /** Births per second at intensity 1, before the swing bonus. */
      rate: 341,
      /** Extra births per m/s of blade speed, as a fraction of `rate`. */
      swing: 0.67,
      /** Seconds one burns, and how much shorter the short ones are. */
      life: 0.56,
      lifeVariance: 0.55,

      /** Metres off the face it left, so it clears the steel it was born on. */
      standoff: 0.011,
      /** m/s straight out along that face's normal. */
      eject: 0.25,
      /** m/s along the flow — the draught off the flame carrying it up. */
      rise: 0.6,
      /** m/s of random scatter on top. */
      spread: 0.3,
      /** How much of the blade's own velocity a new spark keeps. */
      inherit: 0.6,

      /** Buoyant acceleration, m/s², and air drag, 1/s. */
      buoyancy: 0.54,
      drag: 1.27,
      /**
       * Metres of wander, and the size and speed of the air doing it.
       *
       * Off. At this life the spark is gone before a wander of any amplitude
       * has bent its path visibly, so it was only costing noise — turn it back
       * up alongside `life` if the sparks are ever made to linger.
       */
      turbulence: 0.0,
      turbulenceScale: 3.4,
      turbulenceSpeed: 0.41,

      /** Sprite radius in metres, what is left of it at death, and its spread. */
      size: 0.005,
      shrink: 0.4,
      sizeVariance: 0.6,
      /**
       * Motion streak: sprite lengths per m/s, and a ceiling on it.
       *
       * The tell that separates embers from additive dots — a fast spark draws
       * as a capsule along its own screen-space velocity, the way one does in a
       * photograph, and a slow one stays round.
       *
       * The default is not arbitrary: a streak is how far the spark moved during
       * the exposure, so `1 / (60 · size)` ≈ 2 is the number that matches a
       * 1/60 s shutter at this sprite radius. Turn it down for a crisper,
       * more stylised spark; up for a longer trail.
       */
      stretch: 2.36,
      maxStretch: 8.1,

      /**
       * Kelvin at birth and death, the radiance exponent, and how fast it cools.
       *
       * Deliberately inverted — a spark is *born* at 1530 K and ends at 1690 K,
       * so it warms toward its death instead of cooling to a red cinder. It is
       * not what a real ember does, but it is what keeps this one legible: at
       * these lifetimes a spark that cools is at its dimmest exactly when it has
       * travelled far enough from the blade to be seen against the dark, and the
       * shower reads as fading crumbs. Running it the other way keeps the far
       * end of every trail bright and the near end tucked inside the flame's own
       * glare. Swap the two back if the sparks are ever given a long life.
       */
      tempBirth: 1530,
      tempDeath: 1690,
      curve: 3.25,
      cool: 1.83,
      /** Tumbling twinkle, 0..1 — a flake showing a hot face and then an edge. */
      twinkle: 0.55,
      /** Brightness, and how tight the white centre inside the halo is. */
      emission: 3.5,
      core: 4.0
    },

    /** What the fire does to everything around it. */
    light: {
      enabled: true,
      /** Candela — the studio's spots are in the hundreds, so this is a lamp. */
      intensity: 10.9,
      /**
       * Reach, in metres, from the centre of the box.
       *
       * Short on purpose: half a metre only reaches the hand and the sleeve, so
       * the fire warms what it is actually touching and the rest of the armour
       * keeps the cool stage key. Open it up to light the whole body off the
       * sword — that is a different, much warmer shot.
       */
      distance: 0.5,
      decay: 1.8,
      color: '#d66d0a',
      /** Depth of the flicker, 0..1. */
      flicker: 0.33
    }
  },

  /* ------------------------------------------------------------------ */
  /* Shadow character                                                    */
  /* ------------------------------------------------------------------ */
  /**
   * Two shadows of the character, summoned to hunt for it — see
   * `vfx/ShadowCharacter.js`. `V` arms the mark; two locks send them out.
   *
   * Each one is a full clone of the rig (body, armour, weapon and all). It
   * steps out of the body carrying the character's own pose, crouches on its
   * mark for `crouch` seconds, then takes the body it was pointed at: it leaves
   * the crouch aimed at its mark, runs it down, finishes it with one of the
   * player's own attacks (`strike.move` — the slide cut, by default) and burns
   * away. What makes them *shadows* is entirely below: one black surface and a
   * fresnel rim so the silhouette reads against a dark stage.
   *
   * Everything is sampled every frame, so the pair can be re-dressed while they
   * are out there.
   */
  shadowCharacter: {
    /**
     * Whether the pair is out. `V` flips this; presets remember it.
     *
     * It is cleared by the shadows themselves once the last of them has
     * dissolved, so `V` is a summon rather than a switch — pressing it again
     * mid-hunt burns them away early.
     */
    active: false,

    /**
     * Choosing who they are sent at — see `combat/TargetMarking.js` and
     * `vfx/TargetMarkers.js`.
     *
     * `V` arms rather than summons: look at a body and the diamond over its
     * head lights, left-click and it locks, and the `count`th lock is what
     * actually sends the pair out — one shadow to each mark, in the order they
     * were taken. A shadow whose mark is felled before it arrives falls back to
     * the nearest body standing, so a summon is never spent on a corpse.
     */
    marking: {
      /**
       * How many bodies are locked before the pair steps out.
       *
       * There are two shadows, so two is the whole design. At one the second
       * shadow picks its own body; there is nothing above two to assign.
       */
      count: 2,
      /** Metres from the player a body may be marked at. */
      range: 30,
      /**
       * How far off the aim a body may be and still be the one meant, as a
       * fraction of the screen's *height*.
       *
       * Deliberately generous: this is a look, not a pixel hunt. Turn it down
       * for a tight reticle, up until the nearest body to the middle of the
       * frame is always the one that lights.
       */
      aim: 0.22,
      /** Seconds the arm survives with nothing marked. 0 leaves it up. */
      timeout: 12,

      /** The diamond itself. */
      look: {
        /** Metres across, in the world — so it shrinks with distance. */
        size: 0.5,
        /** Metres above the top of the body. */
        lift: 0.4,
        /** Under the aim, and once the click has landed. */
        color: '#8f5bff',
        lockColor: '#e0d0ff',
        /** Thickness of the outline and the feather on it, in marker widths. */
        width: 0.1,
        softness: 0.06,
        /** Master on the additive brightness. */
        intensity: 1.7,
        /** How much of that a *locked* marker's breath takes off, and how fast. */
        pulse: 0.35,
        pulseSpeed: 6.0,
        /** How far the marker overshoots its size as the lock closes. */
        pop: 0.5,
        /** Seconds it takes to come up, and to go out once it is dropped. */
        fadeIn: 0.09,
        fadeOut: 0.18
      }
    },

    /** Metres to each side of the body — the mark each one steps out onto. */
    offset: 1.05,
    /** Metres behind it, so they read as flanking rather than as a row. */
    back: 0.3,
    /**
     * Seconds to walk out of the body onto those marks. The pair starts the
     * summon standing exactly inside the character, which is what sells them as
     * its shadow stepping out.
     */
    emerge: 0.45,
    /** Size against the character. A shade under 1 makes them read as lesser. */
    scale: 1.0,

    /**
     * Seconds held in the crouch on the mark before the hunt starts.
     *
     * The beat the whole summon is built around: two things step out of you,
     * settle, *choose*, and only then move. Without it the pair reads as
     * projectiles fired at the nearest body.
     */
    crouch: 2.0,

    /** The hunt: from the crouch to the foot landing. */
    hunt: {
      /** Ground speed of the run, m/s. Faster than the player's, deliberately. */
      speed: 4.6,
      /**
       * Fraction of the angle gap to the target left after a second of turning.
       *
       * The *pose* only. Where the body steps is aimed at the target directly
       * and never reads this, which is what makes the approach converge no
       * matter how slowly the shoulders come round — see `_hunt`. Turn it right
       * down for a shadow that drifts in sideways and squares up late; it will
       * still arrive.
       */
      turnRate: 0.0006,
      /**
       * Seconds a shadow will chase before giving up and burning away.
       *
       * Insurance rather than design: a target that cannot be reached (across a
       * ravine, or one that dissolved while being run at) would otherwise leave
       * a shadow running at it forever.
       */
      timeout: 9.0,
      /**
       * Metres of slack on where the run hands over to the strike — on top of
       * the move's own `standoff` and the ground its warp is going to cover
       * (see `strike.lead`).
       */
      slack: 0.12
    },

    /**
     * The finisher: which of the player's own attacks a shadow arrives into.
     *
     * `move` is a settings key — `crouchSlash` (the slide cut), `slashHit` or
     * `kick` — and everything about the blow comes from that block: the clip,
     * its timing, its reach, the force it hands the body and whether the body
     * comes apart. A shadow throws the player's move, not an imitation of it.
     *
     * The slide cut is the default because it is the one the *approach* belongs
     * to. A shadow is already running when it gets there, and this is the move
     * that is authored as a run: it drops into the slide, opens the body on the
     * way past and burns away standing behind it.
     *
     * ## Where the run stops
     *
     * Not on the animator's mark. The move's warp window (`warpAt`) is frames of
     * travel, so the run hands over that much ground *short* of the mark and the
     * warp covers it — otherwise the slide would play on the spot. The distance
     * is measured out of the clip itself (see `_lunge` in
     * `vfx/ShadowCharacter.js`), which is why there is no metres control here.
     */
    strike: {
      /** Which attack it throws: 'crouchSlash' | 'slashHit' | 'kick'. */
      move: 'crouchSlash',
      /**
       * The move's travel speed against the run's.
       *
       * 1 is seamless: the body covers the approach at exactly the pace it was
       * chasing at, so there is no hitch where the run becomes the move. Below
       * it the shadow brakes into the cut, above it the cut is a lunge — either
       * reads, and both are visible at the hand-over, which is the frame to
       * watch when tuning this.
       */
      lead: 1.0
    },

    /**
     * The vanish: the same noise burn the enemies use, in the rim's colour.
     *
     * `detail` is the size of the noise against the body (higher = finer
     * flakes), `rise` how much of the threshold is height rather than noise —
     * 0 is static eating the model, 1 is a clean wipe up the body, and the
     * value between them is what looks like burning. `edge` is the line of
     * light riding the burn front.
     */
    dissolve: {
      time: 0.85,
      detail: 14.0,
      rise: 0.35,
      edgeColor: '#8f5bff',
      edgeEmissive: 3.4,
      edgeWidth: 0.06
    },

    /**
     * The dark itself.
     *
     * Not pure black: a black body under a cool key comes out as a hole in the
     * screen, and a few points of blue in the shadow is what makes it read as
     * something standing there rather than as a missing pixel. Roughness and
     * metalness are the same controls the skin has — turn metalness up for an
     * oily, reflective shade.
     */
    color: '#04050b',
    roughness: 0.85,
    metalness: 0.0,

    /**
     * The rim. Every grazing angle emits, which is what draws the silhouette.
     *
     * `power` is how tight the band is (higher = a thinner line hugging the
     * edge), `emissive` how brightly it burns.
     */
    fresnel: {
      color: '#7a4dff',
      power: 2.4,
      emissive: 2.2
    }
  },

  /* ------------------------------------------------------------------ */
  /* Judgement — the fist                                                */
  /* ------------------------------------------------------------------ */
  /**
   * `Q` — mark one body, and something on the other side of the world puts a
   * fist through it. See `vfx/Judgement.js`.
   *
   * The move is six beats and they are all in `beats` below: a seal draws
   * itself in the air over the marked body, holds while it gathers, a fist
   * comes down out of it, lands, rests on what is left, and is pulled back up
   * through the way it came. Nothing here is on a physics clock — every beat is
   * a number of seconds, because the whole thing is choreography.
   *
   * ## The three numbers that decide whether it reads
   *
   *  - `height` — how far above the body the seal hangs. It is the length of
   *    the drop, so it is also how heavy the blow looks. Under about two metres
   *    the fist has no room to gather speed and the move reads as a stamp.
   *  - `beats.fall` — how long that drop takes. A quarter of a second is a
   *    *punch*; half a second is a falling boulder. Both work, and they are
   *    different moves.
   *  - `fist.scale` — the size of the thing. At 1.5 the knuckles are wider than
   *    the body they land on, which is the whole joke.
   *
   * ## Why the seal cuts the arm off
   *
   * The fist is a forearm ending in a wrist, and the wrist has to go
   * *somewhere*. It goes into the seal: the material discards every fragment
   * above the seal's plane and burns a line where it crosses (`fist.birth`), so
   * the arm is not a floating prop — it is something reaching through a hole.
   * The arm also stretches to meet that hole however high it is hung, so the
   * two numbers above can be moved without the illusion coming apart. See the
   * shader note in `vfx/Judgement.js`.
   */
  judgement: {
    enabled: true,

    /**
     * Choosing who it lands on — the same aim the shadows are marked with
     * (`combat/TargetMarking.js`), on its own numbers. One body, always: this
     * is a single blow, and a second mark would have nothing to send.
     */
    marking: {
      /** One. Held here because the marking code asks for it by name. */
      count: 1,
      /** Metres from the player a body may be marked at. */
      range: 34,
      /** How far off the aim a body may be, as a fraction of the screen's height. */
      aim: 0.22,
      /** Seconds the arm survives with nothing marked. 0 leaves it up. */
      timeout: 12
    },

    /**
     * Metres above the marked body's feet that the seal opens.
     *
     * It is worth knowing what this is against: at `fist.scale` 1.6 the arm is
     * 2.9 m long, and the drop is `height` less `fist.crush` — so at 3.3 the arm
     * is very nearly exactly long enough to still be in the hole when the
     * knuckles land, and the vertex stretch has almost nothing to do. Hang it
     * higher and the forearm is drawn out like taffy to reach; that still works
     * and still reads, but it is a different, lankier thing.
     */
    height: 3.3,

    /**
     * The choreography, in seconds.
     *
     * `fall` is the only one that is about force rather than pacing — see the
     * note above. The rest are pauses, and pauses are what make a blow land:
     * `charge` is the beat where the player knows what is coming and cannot
     * stop it, and `dwell` is the fist sitting on the result.
     */
    beats: {
      /** The seal drawing itself, one full turn of the circle. */
      open: 0.5,
      /** Held open, gathering, before anything comes through. */
      charge: 0.34,
      /** The drop. Under a third of a second reads as a punch. */
      fall: 0.24,
      /** Planted on what it hit. */
      dwell: 0.55,
      /** Snatched back up through the seal. */
      withdraw: 0.42,
      /** And the circle folding away after it. */
      close: 0.3
    },

    /**
     * The seal itself — a horizontal magic circle, drawn entirely in the
     * fragment shader (`vfx/SummonSeal.js`). There is no texture here and no
     * geometry past one quad: every ring, tick, rune and spoke is arithmetic on
     * the polar coordinate.
     */
    seal: {
      /** Metres from the centre to the outer ring. Comfortably wider than the fist. */
      radius: 1.6,
      /** The lines. */
      color: '#2b5700',
      /** The hot centre, the drawing head, and the flash the fist comes through. */
      coreColor: '#039900',
      /** Master on the additive brightness. */
      intensity: 1.25,
      /** Turns a second of the outer band. The inner bands run against it. */
      spin: 0.03,
      /** Marks in the tick band, glyphs in the rune band, and long spokes. */
      ticks: 56,
      runes: 16,
      spokes: 13,
      /** Stroke weight and its feather, both in fractions of the radius. */
      width: 0.012,
      softness: 0.01,
      /** The soft light pooled inside the circle, and how mottled it is. */
      haze: 0.35,
      detail: 0.52,
      /** Depth and speed of the breath the whole thing sits on. */
      pulse: 0.29,
      pulseSpeed: 5.0
    },

    /**
     * The fist — `models/weapons/fist.glb`, which is a forearm with no colour
     * map at all and one normal map.
     *
     * That absence is what the look is built out of. There is no albedo to
     * light, so nothing here tries to: the surface is near-black and everything
     * you actually see is *emitted*. A fresnel draws the silhouette, and the
     * normal map — the only thing the export knows about the shape — is read
     * for its relief and used to place the light inside the sculpt, so the
     * knuckle creases and the seams down the forearm run hot while the flats
     * stay dark. It is the same idea as the katana's hot steel
     * (`vfx/BladeHeat.js`), aimed at a model that has nothing but geometry.
     */
    fist: {
      /** Size against the export. At 1.6 the knuckles are wider than a body. */
      scale: 1.6,
      /** Metres above the ground the knuckles stop. What is under them is flat. */
      crush: 0.3,
      /** The body of the arm — a deep, unlit green for the light to sit on. */
      color: '#013208',
      roughness: 0.44,
      metalness: 0.3,
      /**
       * How hard the normal map is pushed.
       *
       * The export ships at 0.3, which is a whisper. This is not only a look
       * control: the veins below are placed by how far the mapped normal has
       * been bent off the surface, so turning this down dims them too.
       */
      normalScale: 1.1,

      /**
       * The rim that draws the silhouette against a night sky.
       *
       * `power` is doing more work here than it does on the shadows, because
       * this rim is taken on the *mapped* normal: a low exponent floods the
       * whole forearm violet and the sculpt disappears into it. Around 3 the
       * band hugs the outline and breaks along the relief, which is the point.
       */
      fresnel: {
        color: '#008f1d',
        power: 2.9,
        emissive: 2.0
      },

      /**
       * The light in the sculpt.
       *
       * `gain` is the one to reach for: relief is a small number (the angle
       * between the mapped normal and the surface it sits on), so it has to be
       * opened right up before it reads. Past about 10 the flats start to light
       * as well and the fist goes from cracked to glowing.
       */
      veins: {
        color: '#8a52ff',
        /** What the veins run to as the blow lands — white, and briefly. */
        hotColor: '#fff0cf',
        emissive: 2.2,
        gain: 5.5,
        sharpness: 1.6,
        /** Scale and speed of the field crawling up the arm, so it is not static. */
        scale: 5.5,
        speed: 0.7,
        /** How much the crevices darken the surface itself. Cavity, by another name. */
        cavity: 0.65
      },

      /** The line of light where the arm passes through the seal's plane. */
      birth: {
        color: '#e9dcff',
        emissive: 3.0,
        /** Metres below the plane the line fades out over. */
        width: 0.1
      },

      /**
       * How hard the surface blows out on contact, and for how long.
       *
       * Weighted almost entirely onto the silhouette in the shader, so this is
       * really "how far the edges flare". Turned up past about 3 the flat of
       * the forearm saturates too and the whole arm goes to milk for a fifth of
       * a second, which reads as a bug rather than as a blow.
       */
      flash: 1.0,
      flashTime: 0.2
    },

    /**
     * What the blow does to the body, in the same shape every attack states it
     * in — so `App#_onStrike` takes this and the kick's block without knowing
     * which it was handed.
     *
     * `lift` is negative, which is the whole difference. Every other move in
     * the game throws a body up and away; this one drives it *down*, and the
     * ragdoll weights that by height up the skeleton — so the shoulders are
     * driven into the ground harder than the feet and the body folds flat under
     * the knuckles rather than skidding backwards.
     */
    force: {
      /**
       * Metres from the point of impact a body is still under the knuckles.
       *
       * The thing that lands is wider than a body, so this is an area rather
       * than a target: the mark is always taken, and anyone else standing
       * inside this radius goes down with it. Roughly half the width of the
       * fist at `fist.scale` 1.5 — turn it up and the blow clears a crowd.
       */
      reach: 1.35,
      /** Outward, along the blow. Small: there is barely a sideways to this. */
      impulse: 2.4,
      /** Down. See above. */
      lift: -9.5,
      spin: 1.2,
      /** The world nearly stops. Longer and harder than any of the melee moves. */
      hitStop: 0.12,
      hitStopScale: 0.045,
      /** Metres the lens is kicked. The heaviest thing that happens on this stage. */
      shake: 0.45,
      /** Knuckles do not cut anyone in half. */
      slices: false
    },

    /**
     * The ground's answer: one ring racing out from under the knuckles, and the
     * cracks it opens on the way — see `vfx/ShockRing.js`. Both lie on the
     * height field, so they run over a slope instead of cutting into it.
     */
    shock: {
      /** Metres the wave travels before it is spent. */
      radius: 3.6,
      /** Seconds it takes to get there. */
      life: 0.7,
      /** The wave front and what is left glowing in the cracks behind it. */
      color: '#0fff13',
      crackColor: '#3dff5d',
      intensity: 2.6,
      /** Thickness of the front, as a fraction of the radius, and its feather. */
      width: 0.09,
      softness: 0.12,
      /** How many cracks, how far out they reach, and how wide they open. */
      cracks: 11,
      crackLength: 0.85,
      crackWidth: 0.02,
      crackGlow: 1.4,
      /** Lifted clear of the floor so it never z-fights the terrain. */
      lift: 0.035
    },

    /**
     * The dust and the soil — see `vfx/DustBurst.js`.
     *
     * Two populations out of one buffer and one draw: the *dust*, which is
     * light, slow, huge and grows as it goes, and the *soil*, which is dark,
     * fast, small and falls back down. Neither glows — this is the only effect
     * in the ability that is lit rather than emitted, which is exactly why it
     * sells the impact as something that happened to the ground.
     */
    dust: {
      enabled: true,
      /** Puffs thrown out in the ring, and clods of soil with them. */
      puffs: 34,
      clods: 46,
      /** Metres a second the ring leaves at, and the scatter on it. */
      speed: 5.4,
      spread: 0.35,
      /** How much of that is upward rather than outward, 0..1. */
      rise: 0.32,
      /** Metres from the impact the ring is born on. */
      ring: 0.5,
      /** Seconds a puff and a clod last. */
      dustLife: 1.5,
      soilLife: 1.1,
      /** Metres across at birth, and the multiple a puff swells to. */
      dustSize: 0.42,
      dustGrow: 3.4,
      soilSize: 0.055,
      /** Air drag, and the pull on a clod. Dust is light enough to hang. */
      dustDrag: 2.6,
      soilDrag: 0.35,
      gravity: -17,
      /** Buoyancy on the dust alone — what makes a plume climb as it spreads. */
      lift: 1.5,
      /** The moonlit face of a puff, its shaded side, and the soil. */
      color: '#b9b2a4',
      shadeColor: '#2b2f3a',
      soilColor: '#33291f',
      /** Master on the opacity. Dust that is too solid reads as smoke. */
      opacity: 0.72
    },

    /**
     * One light, doing two jobs: it hangs under the seal while the circle is
     * drawing itself, and on the frame the fist lands it drops to the ground
     * and flashes. Nothing else in the frame says "that happened *here*" as
     * cheaply as a light that moves.
     */
    light: {
      enabled: true,
      color: '#60ff0a',
      flashColor: '#ffe8c0',
      /**
       * Candela while the seal is up, and at the moment of contact.
       *
       * `flash` is deliberately modest for a flash. It is a point light sitting
       * half a metre from the knuckles, so inverse-square does most of the work
       * before the number does any: past about 60 the fist itself blows out
       * white and the effect stops being a light on the ground and becomes a
       * lamp inside the prop.
       */
      intensity: 14,
      flash: 30,
      /** Seconds the flash takes to fall back to nothing. */
      flashTime: 0.35,
      distance: 9,
      decay: 1.9
    }
  },

  /* ------------------------------------------------------------------ */
  /* Flight — the air, and the blades that hang in it                    */
  /* ------------------------------------------------------------------ */
  /**
   * `X` — the body leaves the ground, and stays there until it is told not to.
   *
   * This is the one ability that is a *mode* rather than a move: while it is up
   * the feet never touch anything, the stick flies the body instead of walking
   * it, and every other move in the game is refused (see
   * `App#_syncAbilities`). That exclusivity is the design — a katana technique
   * thrown from six metres up is a different game, and the answer to "what do I
   * do up here" has to be the thing this ability brings with it.
   *
   * What it brings is the halo. Every body marked from the air (the same aim
   * `V` and `Q` use — `combat/TargetMarking.js`) forges a blade out of the
   * weapon actually on the character's hip, and that blade takes up station
   * around them. They orbit, they charge, and on `Space` the whole set is
   * loosed at once — one blade per mark, each one arriving on its own body a
   * fraction of a second after the last. See `vfx/BladeStorm.js`.
   *
   * ## The three numbers that decide how it feels
   *
   *  - `height` — how far off the floor the body cruises. Under about three
   *    metres it reads as a hover; past six the enemies are ants and the aim
   *    stops being a look.
   *  - `speed` — flying is meant to be *fast*. At the walk's pace the whole
   *    mode reads as the character being stuck in treacle at altitude.
   *  - `blades.chargeTime` — the beat between a mark and a blade being ready.
   *    It is the reason marking six bodies takes a moment rather than being a
   *    button-mash, and it is what makes the volley feel gathered.
   */
  flight: {
    enabled: true,

    /**
     * Metres above the ground the body cruises at.
     *
     * The height is held against the *terrain*, re-read every frame, so flying
     * over a hill climbs the hill. That is what keeps the camera from being
     * buried by the first slope and what keeps the marks in reach of the aim.
     */
    height: 4.6,

    /** Seconds to climb to that height, and to come back down out of it. */
    takeoff: 0.75,
    land: 0.6,

    /**
     * The idle rise and fall of a body that is hanging in the air.
     *
     * Small, and slow. It is the single cheapest thing here that says the
     * character is *floating* rather than parked on an invisible platform —
     * take it out and the hover reads as a bug in the terrain code.
     */
    bob: 0.16,
    bobSpeed: 0.9,

    /** Cruise and boost, m/s. Shift is the boost, as it is on the ground. */
    speed: 8.5,
    boost: 14.5,
    /** How hard the air is pushed against, m/s². Loose on both ends: this drifts. */
    acceleration: 11,
    deceleration: 7,
    /** Fraction of the heading gap left after a second. Slower than the walk's. */
    turnRate: 0.004,

    /**
     * The lean.
     *
     * Two rotations on the body, and between them they are the whole of what
     * makes this read as flight rather than as a walk cycle at altitude:
     * `bank` rolls into a turn (an aircraft's answer to changing direction) and
     * `pitch` drops the nose with speed. Both are damped by `leanRate` so they
     * arrive after the turn does — a body that snaps into its lean is a body on
     * rails.
     */
    bank: 0.62,
    pitch: 0.3,
    leanRate: 4.2,

    /** Seconds to fade the float clip over the gait, and back off it on landing. */
    blendIn: 0.3,
    blendOut: 0.35,

    /**
     * The touchdown — `Landing.fbx`, once, and then back into the idle.
     *
     * The one thing that has to be right here is `lead`: the clip opens on a
     * body already falling, so it is started that many seconds *before* the
     * feet arrive rather than when they do. Too little and the character
     * absorbs an impact it already took; too much and it crouches in mid-air.
     * The descent is `land` seconds long, so anything past that starts the
     * recovery the instant `X` is released.
     */
    recover: {
      enabled: true,
      /** Seconds before touchdown the clip starts. */
      lead: 0.18,
      /** Seconds to fade it over the gait, and back off it into the idle. */
      blendIn: 0.1,
      blendOut: 0.32,
      /**
       * How far through the clip the pose is handed back, 0..1.
       *
       * The tail of a landing is a body standing up again, which is what the
       * idle already is — leaving it to play to the last frame holds the
       * character in a recovery it finished a beat ago. Cutting at three
       * quarters and crossing the rest into the gait is what makes the two
       * read as one movement.
       */
      exitAt: 0.74
    },

    /**
     * Choosing who a blade is forged for — `combat/TargetMarking.js` again, on
     * its own numbers.
     *
     * One at a time, because every click is a *whole* mark here rather than one
     * of a set: the mode re-arms itself the instant a lock lands, so marking is
     * something the player does continuously while flying rather than a thing
     * they enter and leave. The range is the longest in the game — this is the
     * ability that is aimed from above everything.
     */
    marking: {
      count: 1,
      range: 46,
      aim: 0.2,
      /** Never expires: the arm *is* the flight mode, and it ends when that does. */
      timeout: 0
    },

    /**
     * The blades — see `vfx/BladeStorm.js`.
     *
     * Each one is the character's own weapon, cloned out of what is equipped on
     * the hand at the moment it is forged — its own material, its own textures —
     * under a fresnel rim, with the light of the thing that made it still
     * running up the blade.
     */
    blades: {
      /** How many can hang at once. Marking past this is refused, loudly. */
      max: 6,

      /**
       * Size against the weapon as it is worn.
       *
       * A shade over 1: a blade hanging two metres away from the camera reads
       * smaller than the same blade in the character's hand, and the halo wants
       * to be legible from wherever the player happens to be looking.
       */
      scale: 1.15,

      /**
       * The halo.
       *
       * `radius` is metres from the body, `height` metres up it, and `rise` how
       * far the ring is tilted out of horizontal — a flat ring of swords reads
       * as a carousel, and a little tilt is what makes it read as a formation.
       * `spin` is turns a second, and `sway` the slow individual drift that
       * keeps the six of them from being one rigid object.
       */
      orbit: {
        radius: 1.75,
        /**
         * How far up the body the ring hangs, as a multiple of the character's
         * own height — so it sits in the same place whatever `targetHeight` is
         * set to. Just over 1: the guards ride at head height and the blades
         * hang tip-down beside the body from there.
         */
        height: 1.05,
        rise: 0.55,
        spin: 0.16,
        tilt: 0.28,
        sway: 0.14,
        swaySpeed: 1.6
      },

      /**
       * Seconds a blade takes to write itself into the air, and then to come up
       * to full charge.
       *
       * The forge is a threshold sweeping up the model in the fragment shader
       * (see the shader note in `vfx/BladeStorm.js`) — the blade is *drawn*
       * from guard to tip rather than faded in, which is worth the two lines it
       * costs. `chargeTime` is the beat after it: the blade is there, and now it
       * is getting hot.
       */
      formTime: 0.4,
      chargeTime: 1.1,

      /**
       * The volley.
       *
       * `stagger` is the gap between one blade leaving and the next. It is the
       * most important number in the ability: at 0 the whole set arrives as one
       * event and the six kills read as one kill, and at a tenth of a second the
       * camera has time to be shaken six separate times.
       *
       * `windUp` is the pull-back before each one goes — the blade rocks
       * backwards away from its target, aims, and *then* leaves, which is the
       * anticipation the launch would be nothing without.
       */
      stagger: 0.1,
      windUp: 0.24,
      windBack: 0.85,

      /** How fast one travels, m/s, and how hard it accelerates into that. */
      speed: 38,
      acceleration: 110,
      /** Metres from the chest it counts as arrived. */
      hitRadius: 0.5,
      /**
       * Metres past the body it carries on before it plants.
       *
       * A blade that stops dead in a chest is a prop stuck to a corpse. This one
       * goes *through* and buries itself in the ground behind, which is what
       * says how fast it was going.
       */
      overshoot: 2.6,
      /** Seconds it stands in the ground, quivering, then burns away. */
      plantTime: 1.6,
      fadeTime: 0.7,
      /** How far the plant rings, in radians, and how fast that dies out. */
      quiver: 0.09,
      quiverSpeed: 26,

      /**
       * The steel.
       *
       * The blade wears the weapon's *own* material — the same textured katana
       * the character is holding, maps and all. Everything below is added on
       * top of it, which is what makes the halo read as the sword doing
       * something rather than as six props that happen to be sword-shaped.
       */
      look: {
        /**
         * The rim that draws the blade against a night sky, and the only thing
         * the summon adds to the weapon's own material.
         *
         * `power` is how tight the band is — high, here, because a katana is
         * mostly flat and a loose exponent floods the whole face with colour
         * instead of finding its edges.
         */
        fresnel: {
          color: '#59c7ff',
          power: 3.2,
          emissive: 2.6
        },

        /**
         * How far the blade smears backwards while it is travelling.
         *
         * A stretch along its own length, in the vertex shader, scaled by how
         * fast it is actually going: 1 is the model as authored, 3 is a streak.
         * The cheapest motion blur there is, and on a shape this thin it is
         * indistinguishable from an expensive one.
         */
        stretch: 2.6
      },

      /**
       * What a blade does to a body, in the same shape every other move states
       * it in — so `App#_onStrike` takes it without knowing what threw it.
       *
       * `slices` is true, and it is the point: this is a sword arriving at
       * thirty-eight metres a second, and anything less than the body coming
       * apart would be a weaker answer than the player's own slide cut gives.
       */
      force: {
        impulse: 7.5,
        lift: 3.2,
        spin: 1.8,
        /** Short. Six of these land in under a second, and they must not stack. */
        hitStop: 0.055,
        hitStopScale: 0.14,
        shake: 0.16,
        slices: true
      },

      /**
       * The hit — see `vfx/BladeImpact.js`.
       *
       * One burst and a shower of sparks out of one buffer: the burst is the
       * ring and the star at the point of contact, the sparks are what comes off
       * the steel and falls. Both are additive; both are gone in half a second.
       */
      impact: {
        enabled: true,
        /** The core flash and the ring racing out of it. */
        color: '#cfeeff',
        ringColor: '#63c8ff',
        size: 1.5,
        life: 0.42,
        intensity: 2.8,
        /** How many spikes the star throws, and how far past the ring they reach. */
        spikes: 7,
        spikeLength: 1.5,

        /** The sparks. */
        sparks: 42,
        sparkColor: '#ffd9a0',
        sparkSpeed: 9.0,
        sparkSpread: 0.55,
        sparkLife: 0.55,
        sparkSize: 0.055,
        /** Metres a spark smears along its own velocity, per m/s of it. */
        sparkStretch: 0.055,
        sparkDrag: 1.6,
        sparkGravity: -16
      },

      /**
       * One light, doing two jobs — the same trick the fist's light plays.
       *
       * It hangs in the halo while the blades gather, so the character is lit
       * from the ring of them; on contact it jumps to whatever was just hit and
       * flashes there. A light that *moves* to the kill is the cheapest thing
       * in the frame that says the kill happened.
       */
      light: {
        enabled: true,
        color: '#4fb8ff',
        flashColor: '#ffe6bb',
        intensity: 9,
        flash: 26,
        flashTime: 0.3,
        distance: 11,
        decay: 1.9
      }
    }
  },

  /* ------------------------------------------------------------------ */
  /* Environment & lighting                                              */
  /* ------------------------------------------------------------------ */
  environment: {
    // **Moonlight.** One cool key, a deep blue sky fill, and a pale bounce off
    // frozen ground — the whole frame is two or three steps of blue and nothing
    // else, which is what a night shot actually is. It is not a dark scene: a
    // full moon on open ground is bright, and the reference reads as night
    // because everything in it is *one cool hue*, not because it is
    // underexposed. Turning `sunIntensity` down from here does not make it more
    // nocturnal, it makes it muddy — the colour is doing the work.
    //
    // "sun" throughout is the key light. It used to double as the moon; it does
    // not any more. The moon is a body in the sky with its own azimuth and
    // elevation (`sky.moon`), and it is what the haze, the mist and the sky's
    // own glow are lit from. This is the *portrait* key, and under
    // `keyCharacterOnly` below it lights the character and nothing else — so it
    // can be placed for the body without dragging the whole landscape with it.
    // High, because it is a *character* key now rather than a scene sun: under
    // `keyCharacterOnly` nothing else in the frame sees it, so it can be driven
    // hard enough to model the armour without blowing the landscape out.
    sunIntensity: 5.18,
    sunColor: '#b8d2f0',
    // Down world +Z, a little to one side, so the ground runs into the light.
    sunAzimuth: 1.42,
    // High. With the key off the landscape this is a portrait angle rather than
    // a time of day: it decides where the shadow across the character's own
    // armour falls, and nothing else.
    sunElevation: 0.72,
    /**
     * Whether the key and the rim light the character *only*.
     *
     * three has no per-object light filtering — a light in a scene is in every
     * material in it — so this is done from the other end: the world's own
     * surfaces are patched to drop every directional light
     * (`Environment#excludeFromKeyLights`), and the key and the rim are the only
     * two directional lights there are. What is left lighting the ground is the
     * ambient, the hemisphere and the probe, which is what makes the landscape
     * read as moonlit air rather than as a spotlit set.
     *
     * A live uniform rather than a define, so the switch costs nothing and no
     * shader recompiles when it moves.
     */
    keyCharacterOnly: true,
    ambientIntensity: 0.34,
    ambientColor: '#3f6396',
    hemiIntensity: 0.75,
    hemiSkyColor: '#5c86bb',
    // The bounce off frozen ground: pale, cold, and only a little of it.
    hemiGroundColor: '#2b3f52',
    // Same story as the key: character-only, so it is strong enough to cut a
    // cold edge down the silhouette against the haze behind it.
    rimIntensity: 4,
    rimColor: '#9ec8ff',
    rimAzimuth: 3.69,
    rimElevation: 0.69,
    // Low. The probe is a daylight HDR (`spruit_sunrise`) and it is kept only as
    // a specular response for metal — at anything much above this it starts
    // putting a warm afternoon back into the armour.
    envIntensity: 0.14,
    // There is no backdrop colour and no linear fog here any more. The sky
    // (`world/Sky.js`) is drawn over every pixel before anything else, so a
    // scene background was never visible; and `world/Atmosphere.js` owns the
    // air, which it can do the two things linear fog cannot — pool in the
    // hollows, and glow looking into the moon.
    shadowBias: -0.0006,
    /**
     * How far a shadow lookup is walked along the surface normal before it is
     * taken, metres.
     *
     * The character screen has had this control since it was built; the play
     * stage was carrying a hard-coded 0.035 and no way to reach it. It is the
     * scale-free half of the acne fix — `shadowBias` offsets in depth and has to
     * be re-dialled whenever the frustum changes size, while this one is in
     * metres of world and does not. Too little and lit surfaces speckle
     * themselves; too much and contact shadows detach from their feet.
     */
    shadowNormalBias: 0.035,
    /**
     * Softness of the shadow edge.
     *
     * Note that `PCFSoftShadowMap` (what `core/Renderer.js` selects) uses a
     * fixed kernel and ignores this — it is in force only under `PCFShadowMap`.
     * Left here because the character screen's spot does honour it.
     */
    shadowRadius: 2.6,
    /**
     * Half-width of the sun's shadow box, metres, and how far up-sun the light
     * is parked. The box has to cover the trees whose shadows fall across the
     * frame, and the distance has to clear the tallest of them — at a low
     * elevation a light parked close is a light *below* the canopy, and the
     * near plane starts slicing crowns off.
     */
    shadowExtent: 46,
    shadowDistance: 210,
    floorColor: '#1c2b3a',
    floorTint: '#3c5a74',
    floorRoughness: 0.94,
    floorSheen: 0.12,
    // Nearly off. The pool is a dark-stage device — it sinks the floor into a
    // black backdrop past 40 m — and out here the haze is what does that job,
    // in a colour the sky agrees with.
    floorPool: 0.0,
    // The tiling that dresses the floor. `floorTextureSet` picks between the
    // soil the grass is planted in (ambientCG Ground103, public/textures/terrain)
    // and the original flagstone (Rock030, public/textures/stone); only the one
    // in use is downloaded. `floorTextureScale` is metres of floor one tile
    // covers; `floorTexTint` grades it toward `floorTint` so it sits inside the
    // cool stage palette. Switch the texture off for the procedural fallback in
    // Ground.js.
    floorTexture: true,
    floorTextureSet: 'terrain',
    floorTextureScale: 3.0,
    floorNormalScale: 1.0,
    // Pushed up from the daylight value: the soil is a brown photograph and the
    // stage is blue, so more of the tiling's own colour has to be graded away
    // than a warm scene ever needed.
    floorTexTint: 0.62,
    contactShadow: 0.5
  },

  /* ------------------------------------------------------------------ */
  /* The air                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * Haze, ground mist and inscatter — see `world/Atmosphere.js`.
   *
   * This replaces three's fog for the world's own surfaces (the character keeps
   * it, and never gets far enough from the lens for the difference to show), and
   * it exists to do the two things linear fog cannot.
   *
   * `ground` is the layer that pools in the hollows: density falls off
   * exponentially above `base` with an e-folding height of `falloff`, so at the
   * defaults here the mist is thick in the valleys, thinning to nothing by about
   * fifteen metres up. It is what puts white between the far trunks while the
   * ones nearby stay clear.
   *
   * `inscatter` is the other half, and the one that does the most work per unit:
   * how far the haze goes toward `sunColor` when you are looking down the beam.
   * At 0 the air is a flat wash from every angle; at 1 the quarter of the scene
   * around the moon glows and the rest does not, which is what a long exposure
   * into a full moon actually looks like.
   *
   * This is the *distance* fog — the air itself, everywhere, with no shape of
   * its own. The mist that rolls along the ground with a body and an edge is
   * `groundFog` below, and the two are meant to be used together.
   */
  haze: {
    enabled: true,
    /** What the distance dissolves into looking away from the moon. */
    color: '#48789e',
    /** And looking into it. The sky's horizon and glow are the same two colours. */
    sunColor: '#c6e0f5',
    /** 1/m of the layer that is everywhere. 0.004 is half-hidden at ~170 m. */
    density: 0.0048,
    /** Metres of clear air in front of the lens, so the character is never hazed. */
    start: 4,
    /** Extra 1/m at the floor of the mist. */
    ground: 0.016,
    /** World Y the mist sits on, and the metres it takes to thin by 1/e. */
    base: -1.5,
    falloff: 7.5,
    inscatter: 0.62,
    /** How tight the moon lobe is. Higher = the glow hugs the disc more closely. */
    sunPower: 5.0,
    /** Ceiling on the blend, so the far field never goes perfectly flat. */
    max: 0.94
  },

  /* ------------------------------------------------------------------ */
  /* Sky                                                                 */
  /* ------------------------------------------------------------------ */
  /**
   * The backdrop — see `world/Sky.js`.
   *
   * Only the zenith, the stars and the moon's own glow are authored: the horizon
   * is the haze colour, bound from the block above by identity, because the sky
   * is what every distant surface has to dissolve *into* and any other colour
   * there puts a visible line across the far field.
   *
   * The whole block is drawn by one fullscreen shader that runs before anything
   * else, so every control here is priced per screen pixel per frame.
   */
  sky: {
    enabled: true,
    // Deep navy overhead, dissolving to the haze at the horizon. The gap
    // between this and `haze.color` is the single strongest read of depth in
    // the frame — close them up and the sky goes flat.
    zenith: '#041834',
    /** How fast the zenith takes over from the horizon. Low = a tall gradient. */
    gradient: 1.33,
    /**
     * The glare around the disc, and how tight it is.
     *
     * Off. With `moon.geometry` on there is a real lit sphere up there, and the
     * shader's glare was stacking a second, softer disc on top of it. Turn it
     * back up only alongside the fallback disc.
     */
    sunGlow: 0.0,
    sunGlowPower: 51.5,
    /** The broad wash the moon puts over its whole quarter of the sky. */
    broadGlow: 0.0,
    /**
     * The disc itself, and its angular size (1 - cos, so 0.0035 ≈ 9.6° across).
     *
     * Many times a real moon (which is half a degree) — it is the subject of
     * the shot. What keeps it from reading as a blown-out lamp at that size is
     * not this number but `moon.opacity` below: the body is drawn nearly
     * transparent, so it is big *and* soft.
     */
    disc: 2.0,
    discSize: 0.0035,
    // Down hard. The sky is a backdrop for a moonlit ground, and at 1.0 the
    // gradient was bright enough that the haze had nothing to dissolve into.
    exposure: 0.35,

    /**
     * The moon: where it hangs, and what its face looks like.
     *
     * `azimuth` and `elevation` are the same convention every other angle in the
     * project uses — azimuth measured from world +X toward +Z, elevation from
     * the horizon — and they are the *world's* light direction: the sky's disc
     * and glare, the haze's inscatter lobe and the ground mist's moonlight all
     * resolve from this one pair (`world/Sky.js` writes `frame.uLightDir` from
     * it). The character's key is a separate angle in `environment` above.
     *
     * **On elevation.** The rig cannot aim much above 30° (`camera.maxPolar`),
     * so a moon parked higher than about 0.5 rad is off the top of the frame and
     * only its glare is ever on screen. Low is also the better shot here —
     * everything backlit in this scene is built around looking *into* it.
     *
     * **`geometry` is the moon that ships.** With it on, `world/Moon.js` hangs a
     * displaced sphere carrying a real lunar surface material out at the angles
     * above and the sky's own disc stands down; `detail`/`detailScale` below then
     * do nothing, because they belong to that disc. Turn it off (or lose the
     * maps) and the shader disc comes back — which is what `detail` is for: two
     * octaves of value noise standing in for the maria, evaluated *only* inside
     * the disc, without which the fallback is a white circle that reads as a
     * lens flare.
     *
     * Everything from `phase` down is the body, and `phase` is the one that
     * changes the picture: it is where its *sun* is, measured from full (lit
     * from behind the lens) round toward the limb, so it is the difference
     * between a full moon and a crescent. `brightness` and `size` are shared
     * with the glare — they are `sky.disc` and `sky.discSize` above, so the halo
     * in the air can never be sized for a moon that is not there.
     */
    moon: {
      azimuth: 1.69,
      elevation: 0.325,
      color: '#eef6ff',

      /** The textured sphere rather than the shader disc. */
      geometry: true,

      /**
       * The body's own exposure and its coverage, both of which belong to it
       * alone.
       *
       * `sky.disc` above is *shared* — it is the glare's brightness and the
       * scale the haze's lobe is sized against — so turning the sphere down
       * with it drags the whole quarter of the sky down too. `brightness` is a
       * multiplier on top of it: 1 leaves the body where the glare thinks it
       * is, below that is a moon that is no longer the brightest thing in the
       * frame. `opacity` is the other half of the same complaint — it scales
       * the alpha, so the face washes into the sky behind it rather than
       * sitting on it as a pasted-on plate. Both at 1 is the old behaviour
       * exactly.
       *
       * They are set as a *pair*, and the pair is the whole look: the face is
       * drawn at four percent coverage, so it is very nearly the sky it hangs
       * in, and the exposure is up three times to put it back. The result is a
       * body you can see through — soft, grey, sitting *in* the air rather than
       * punched through it. Raising `opacity` without dropping `brightness` to
       * match blows the disc out to white immediately.
       */
      brightness: 3.0,
      opacity: 0.04,

      /** Where its sun is: 0 full, π/2 half, π new. And how far that sun is
       * lifted off the line of sight, which leans the terminator. */
      phase: 0.84,
      phaseTilt: 0.64,
      /** Which stretch of ground faces the lens. The material is uniform, so
       * these only reseed the view — there is no "right" side to this moon. */
      tilt: 0.0,
      spin: -0.74159,

      /**
       * The surface material, projected triplanar in the body's object space.
       *
       * `textureScale` is tiles per radius: up puts more, smaller craters on the
       * face. `blendSharpness` is how narrow the band is where two of the three
       * projections meet — low smears them together, high can show a seam.
       */
      textureScale: 0.35,
      blendSharpness: 1.0,

      /**
       * `displacement` is the height map moving actual vertices, as a fraction
       * of the radius — it is what breaks the silhouette into crater rims
       * instead of leaving a circle with a picture on it. `relief` is the normal
       * map's weight in the shading, which carries everything finer than the
       * 96×64 sphere can hold.
       */
      displacement: 0.0,
      relief: 1.0,
      /** The AO map's weight. Crater floors and rim shadows, on both sides. */
      ao: 1.0,
      /** A weak wide highlight off the smoother patches, from the roughness map. */
      sheen: 0.225,

      /**
       * `terminator` is how many degrees the day/night edge takes to cross, and
       * `flatten` is the exponent on the cosine: real regolith throws light
       * straight back where it came from, so a lambert sphere looks wrong in the
       * most recognisable way there is. Low = flat and bright to the limb.
       */
      terminator: 0.29,
      flatten: 0.86,
      /** Earthshine on the night side, and how far the limb dissolves. */
      earthshine: 0.0,
      edge: 0.4,

      /** Fallback disc only: the maria, and the size of the patches. */
      detail: 0.25,
      detailScale: 8.8
    },

    /**
     * Stars — one hash per lattice cell, so a whole sky of them costs about what
     * a single texture lookup would.
     *
     * `density` is cells per unit of direction: higher packs more in and makes
     * each one smaller. `horizon` is the elevation below which they are gone,
     * because the air near the horizon is thick enough to swallow them.
     */
    stars: {
      enabled: true,
      density: 155.0,
      brightness: 2.65,
      twinkle: 0.37,
      horizon: 0.06
    }
  },

  /* ------------------------------------------------------------------ */
  /* Ground fog                                                          */
  /* ------------------------------------------------------------------ */
  /**
   * The mist that crawls over the ground — see `world/GroundFog.js`.
   *
   * The *other* fog, and a different kind of thing from `haze` above. That one
   * is a property of the air with no shape of its own; this one is an emitter
   * letting go of puffs that are carried downwind, spread as they age, and hug
   * whatever the ground beneath them is doing (the height field is read straight
   * out of the floor's own baked texture, so mist blowing across a hollow goes
   * down into it).
   *
   * Every puff's whole trajectory is closed-form in the vertex shader, so the
   * per-frame CPU cost is a loop comparing `count` floats against the clock. The
   * GPU cost is fill: `count` × `sizeEnd`² of soft transparent quads, which is
   * the thing to turn down if the frame is tight — `count` first, then `detail`.
   */
  groundFog: {
    enabled: true,
    /**
     * Puffs in the air. Density is this against `life`: the emitter releases
     * `count / life` per second, because a slot respawns the moment it dies.
     * Capped at 512 by the buffer.
     */
    count: 190,
    /** Seconds one puff lives, and how much shorter the short ones are. */
    life: 15.0,
    lifeVariance: 0.45,

    /**
     * The emitter. `follow` parks it on the character (with `x`/`z` as an offset
     * from them), which is what keeps mist around the camera on an endless
     * ground; switch it off and `x`/`z` are a fixed world position, which is how
     * you put a bank of fog in one particular hollow.
     */
    follow: true,
    x: 0,
    z: 26,
    /** Metres of the disc puffs are born over. */
    radius: 32.5,

    /** Metres per second the mist is carried. */
    windX: 0.1,
    windZ: -1.35,
    /** Metres per second it climbs. Small — this is mist, not smoke. */
    rise: 0.06,
    /** Metres the centre floats above the surface under it. */
    hover: 0.7,
    /** Lateral wander, metres, and how fast it wanders. */
    swirl: 1.1,
    swirlSpeed: 0.12,

    /**
     * Metres across at birth and at death.
     *
     * Birth is the *larger* of the two here: these are few, very wide banks that
     * tighten slightly as they age, which reads as mist settling rather than as
     * smoke billowing out.
     */
    sizeStart: 13.0,
    sizeEnd: 9.3,
    /** Radians per second the billboard rolls, so no two show the same face. */
    spin: 0.05,

    /** The mist itself, and what it goes toward looking into the moon. */
    color: '#5f819e',
    litColor: '#cfe4f6',
    /** Master on the alpha. The one control that is always right to reach for. */
    opacity: 0.08,
    /** How much of the radius is the soft shoulder. 1 = pure gradient. */
    softness: 0.85,
    /** Fractions of the life spent fading in and out. */
    fadeIn: 0.18,
    fadeOut: 0.45,
    /**
     * Metres above the ground the alpha ramps up over.
     *
     * This is what hides the line where a billboard crosses the terrain — by the
     * time the depth test cuts the quad, there is nothing there to cut. Too
     * small and the cut shows; too large and the mist floats.
     */
    groundFade: 2.55,
    /** Noise breaking the disc up: how much, and how fine. 0 skips the lookup. */
    detail: 0.45,
    detailScale: 10.7,
    /**
     * How far the mist goes toward `litColor` down the beam, and how tightly.
     *
     * Off. Puffs are large enough now that one drifting across the moon swung
     * its whole face to `litColor` at once, which read as a flicker rather than
     * as light — the haze behind them carries the beam instead.
     */
    moonlight: 0.0,
    moonPower: 3.0,

    /**
     * The hole kept clear around the lens: metres at which a puff is completely
     * gone, and metres over which it comes back to full.
     *
     * Nothing else in the block can fix a puff being *between* you and the
     * character. It is metres across and a metre from the lens, so it covers the
     * frame, and its birth and death are then a wash of colour over everything —
     * the one place where mist that is otherwise correct is simply in the way.
     * So the alpha is taken to zero inside `nearFade` and ramped back over
     * `nearFadeRange`, and the puff is still there in the world, still drifting,
     * just not drawn where it could only be an obstruction. Keep `nearFade` a
     * little beyond the closest the camera ever gets to the character.
     */
    nearFade: 7.0,
    nearFadeRange: 9.0
  },

  /* ------------------------------------------------------------------ */
  /* Leaves                                                              */
  /* ------------------------------------------------------------------ */
  /**
   * The forest floor's litter and the leaves in the air above it — see
   * `world/Leaves.js`, `world/LeafLitter.js`, `world/LeafDrift.js`.
   *
   * The block at this level is everything the two populations *share*: they are
   * the same leaves off the same 3 × 3 sheet, in the same grade, backlit by the
   * same moon, on the same wind. Only `litter` and `drift` below differ, and
   * they differ because a leaf lying in the mud and a leaf being carried across
   * the field are doing genuinely different things.
   */
  leaves: {
    enabled: true,

    /**
     * Metres along the blade of an average leaf.
     *
     * The single most load-bearing number here. Beech leaves are eight to ten
     * centimetres; the quad is a little larger than the leaf inside it, so this
     * runs a touch over. Too small and the field reads as gravel, too large and
     * it reads as a bed of lily pads.
     */
    size: 0.17,
    sizeVariance: 0.45,

    /** How rough the blade is. Damp leaves are shinier than dry ones. */
    roughness: 0.72,
    normalScale: 1.0,

    /**
     * The alpha cutoff.
     *
     * Leaves are drawn *opaque and alpha-tested* rather than blended: they write
     * depth, they need no sorting, and they can be drawn in any order — which is
     * the only reason five thousand of them costs one draw call. Lower cuts out
     * more of the soft edge (fatter leaves, more aliasing), higher eats into the
     * blade. `alphaToCoverage` is what pays off the usual price of testing: the
     * cut-out edge is resolved against the composer's MSAA samples instead of
     * per pixel, so it comes out as clean as a blended edge with none of the
     * ordering.
     *
     * That last part needs multisampling to exist: it is honoured only while
     * `post.samples` is above 0, because on a single-sampled target there is no
     * coverage mask to resolve against and the switch would cost a `fwidth` for
     * nothing. Left on here so that raising `post.samples` improves the leaves
     * without anyone having to come back for this.
     */
    alphaTest: 0.42,
    alphaToCoverage: true,
    /**
     * How far inside its own cell a leaf's UVs are kept, in cells.
     *
     * The sheet is nine leaves in one image and a minified sample near a cell
     * border reaches into the leaf next door. This is the cheap answer: pull
     * every fetch a little inside its own ninth.
     */
    atlasInset: 0.02,

    /**
     * The grade.
     *
     * The sheet is a daylight photograph of a green beech and this stage is a
     * blue night, so the leaves are pushed toward `tint` the same way the floor's
     * soil is: normalised to unit luminance, so the hue moves and the brightness
     * does not. At 0 they are summer-green in a moonlit field, which is the one
     * thing that would give the whole effect away.
     */
    tint: '#ff0505',
    tintAmount: 0.55,

    /**
     * Light coming *through* the blade.
     *
     * A leaf is one cell thick and it glows when the moon is behind it. This is
     * the highest-value control in the block: without it a leaf is an opaque
     * chip and the field reads as stickers on the ground; with it the leaves
     * facing away from you into the moon light up in their own colour, which is
     * what a photograph of a woodland floor at night actually shows. `power` is
     * how tightly it hugs the beam.
     */
    backlight: 0.9,
    backlightColor: '#b9d69a',
    backlightPower: 6.0,

    /**
     * The wind, metres per second — one wind for both populations.
     *
     * The gust triple on top of it is a slow travelling wave over world
     * position: `speed` is how fast it beats, `scale` how big the gusts are
     * (radians per metre, so small numbers mean broad ones) and `strength` how
     * hard. It quivers the litter where it lies *and* pushes the leaves in the
     * air, so one gust visibly crosses the whole field.
     */
    windX: 0.55,
    windZ: -1.5,
    gustSpeed: 0.55,
    gustScale: 0.06,
    gustStrength: 1.0,

    /**
     * The leaves on the ground, and what happens when you walk through them.
     *
     * A leaf lies flat on the slope under it and does nothing at all until
     * something disturbs it, at which point it is thrown along a closed-form
     * arc and lands where the arc ends — from which it can be kicked again. The
     * whole flight lives in the vertex shader; the CPU writes four floats per
     * kick and nothing else, ever.
     */
    litter: {
      enabled: true,

      /**
       * Metres across the window of leaves that follows the character, and how
       * many leaves each of its 20 × 20 cells holds.
       *
       * These two are the cost. `perCell` × 400 is the leaf count — 14 is
       * 5 600 leaves, about 1.8 per square metre, which is a well-covered
       * woodland floor. Both are live: the buffers are allocated once at the
       * ceiling, so a lower density leaves the tail of every cell empty rather
       * than rebuilding anything, and moving either simply re-lays the grid.
       */
      field: 56,
      perCell: 14,

      /** Metres a leaf floats above the surface, so it cannot z-fight the floor. */
      hover: 0.015,
      /** Radians the wind lifts the tip of a resting leaf. */
      rustle: 0.16,

      /**
       * Metres at which the field starts to erode away and at which it is gone.
       *
       * Not an optimisation you can see: at this density the far field is more
       * leaves than pixels, and drawing it is a grey shimmer. Keep `fadeEnd`
       * inside `field / 2` or the window's own edge comes into view.
       */
      fadeStart: 20,
      fadeEnd: 29,

      /**
       * A kick, once it is in the air. `flight` is how long one lasts, `drag`
       * how fast the launch speed bleeds off (higher = shorter, sharper throws),
       * `swirl` how far it wanders sideways on the way and `spin` how hard it
       * tumbles. The swirl and the spin are both built to die out exactly at the
       * end of the flight — that is what makes the landing place computable, and
       * it is what lets a leaf be kicked again from where it came down.
       */
      flight: 1.15,
      drag: 2.4,
      swirl: 0.22,
      swirlSpeed: 5.0,
      spin: 14,

      /**
       * What a foot does to them.
       *
       * `pushSpeed` is the metres per second below which nothing is disturbed —
       * without it the leaves under a standing character would be re-kicked
       * every frame and boil. `pushRadius` is how wide the sweep is and
       * `pushLead` how far ahead of the body it is centred (the character is
       * positioned by their root, and the foot going through the leaves is in
       * front of it). `pushForward` blends the throw between straight away from
       * the foot (0 — reads as an explosion underneath you) and along the way it
       * is going (1 — reads as a conveyor); the middle is a sweep. `pushForce`
       * scales it against your speed, `pushLift` how high they go, and
       * `pushBudget` caps how many one frame may disturb.
       */
      pushSpeed: 0.35,
      pushRadius: 0.75,
      pushLead: 0.35,
      pushForward: 0.6,
      pushForce: 0.5,
      pushLift: 0.35,
      pushBudget: 40,

      /**
       * And what the wind does: leaves a second that come unstuck and skitter
       * downwind. The same kick with smaller numbers, and `gustSpread` is the
       * radians either side of downwind they are fanned over, because a gust is
       * turbulent and a field leaving on one bearing reads as a conveyor belt.
       */
      gustRate: 5,
      gustForce: 0.5,
      gustLift: 0.18,
      gustSpread: 1.1
    },

    /**
     * The leaves in the air.
     *
     * Born over the character, carried downwind, falling the whole time and
     * swinging from side to side as they go — the glide a leaf does because it
     * is a wing. They land on the same ground the litter lies on and skitter
     * along it until their life runs out.
     */
    drift: {
      enabled: true,
      /** Leaves in the air. Capped at 1024 by the buffer; this is the cost dial. */
      count: 260,
      /** Metres of the disc around the character they are born over. */
      radius: 26,
      /** Seconds one lives, and how much shorter the short ones are. */
      life: 18,
      lifeVariance: 0.4,
      /** Metres above the ground they are born between. */
      heightMin: 0.6,
      heightMax: 8,
      /** These are the leaves you see close up, so they can run a little larger. */
      sizeScale: 1.0,

      /** Metres per second it sinks. */
      fall: 0.6,
      /** Metres of the sideways swing, and how fast it swings. */
      flutter: 0.55,
      flutterSpeed: 2.0,
      /** How hard it turns over about its long axis as it swings. */
      tumble: 1.0,
      /** Radians per second the whole leaf yaws as it goes. */
      yawDrift: 0.35,

      /** Metres it rests above the surface once it is down. */
      hover: 0.02,
      /**
       * Metres of descent over which the tumble is unwound.
       *
       * What makes one land instead of stopping dead on its edge: over the last
       * metre it flattens out and lies down on the slope.
       */
      settle: 1.1,

      fadeStart: 30,
      fadeEnd: 42,
      /** Fractions of the life spent dissolving in and out. */
      fadeIn: 0.05,
      fadeOut: 0.22,
      /**
       * The hole kept clear around the lens: metres at which a leaf is gone
       * entirely, and metres over which it comes back. A leaf twenty
       * centimetres from the camera is a green wall across the frame.
       */
      nearFade: 0.8,
      nearFadeRange: 1.2
    }
  },

  /* ------------------------------------------------------------------ */
  /* Post processing                                                     */
  /* ------------------------------------------------------------------ */
  post: {
    enabled: true,
    /**
     * Multisample count on the composer's render targets.
     *
     * The scene is drawn into a render target rather than into the canvas, so
     * the renderer's own `antialias` flag never touches it — this is the only
     * anti-aliasing in the project. Without it every ridge line against the sky
     * and every hard shadow edge crawls as the camera moves, which reads on
     * screen as a fringe of noise rather than as aliasing.
     *
     * It is also the most expensive single thing in the pipeline, because the
     * whole chain writes through these targets. 2 keeps most of the benefit for
     * half the bandwidth; 0 — where it ships — is the cheapest, and what the
     * stage is currently dialled for.
     */
    samples: 0,
    // Just over 1. The night is lit by one cool key and a sky that is mostly
    // dark, so there is far less in the frame competing for the tone mapper's
    // shoulder than the daylit version had.
    exposure: 1.02,
    // Off. The volumetric flame and the moon carry their own brightness, and the
    // bloom on top of them was smearing the blade's edge into the haze. Turn
    // `bloomStrength` back up if the moon ever needs a halo again.
    bloomStrength: 0.0,
    bloomRadius: 0.0,
    bloomThreshold: 0.0,
    vignette: 0.69,
    chromaticAberration: 0.0,
    contrast: 1.0,
    saturation: 1.0,
    temperature: 0.0, // + warm / - cool
    lift: 0.0,
    gain: 1.0,
    // Off. Film grain is a per-pixel hash redrawn every frame; the grade is
    // clean enough now that it read as crawling dots rather than emulsion.
    grain: 0.0
  },

  /* ------------------------------------------------------------------ */
  /* Character screen (the equipment studio)                             */
  /* ------------------------------------------------------------------ */
  /**
   * The lit stage the character is inspected and equipped on — a scene of its
   * own, with its own camera, lights and grade (see `world/StudioStage.js`).
   *
   * Nothing here is shared with the world stage above. That separation is the
   * point: the play stage is lit for readability at a distance, and this one is
   * lit for a single body standing two metres from the lens, where the light has
   * to model the armour rather than merely reveal it.
   */
  studio: {
    /**
     * Framing. The rig owns the live target and distance (it is an orbit under
     * the pointer); these are the limits it works inside and the frame it
     * returns to.
     */
    camera: {
      fov: 34,
      distance: 3.3,
      minDistance: 0.3,
      maxDistance: 9.0,
      /** Height the default frame looks at, metres up the body. */
      targetHeight: 1.05,
      /** Fraction of the gap left after 1s while gliding to a framing preset. */
      damping: 0.0006,
      /** Idle camera drift, revolutions/second. 0 parks it. */
      autoOrbit: 0.0
    },

    /** Turntable on the body itself, revolutions/second. */
    turntable: 0.0,

    /**
     * Five-point cinematic rig.
     *
     * Key and fill are each a *pair*: a spot that carries the shadow and the
     * falloff, and a rect-area softbox at the same angle that does the wrapping
     * and the long specular roll across metal. That pairing is what a single
     * light of either kind cannot do — an area light casts no shadow, and a spot
     * alone leaves armour reading as plastic.
     *
     * Spot intensities are candela and fall off with the square of the distance;
     * area intensities are nits and do not, which is why the two scales look
     * nothing alike.
     */
    lights: {
      keyIntensity: 187,
      keyColor: '#ffeedd',
      keyAzimuth: 5.03,
      keyElevation: 0.72,
      keyDistance: 4.2,
      keyAngle: 1.39,
      keyPenumbra: 1.0,
      /** The softbox at the key's angle: size in metres, and its own intensity. */
      keySoftbox: 8.7,
      keySoftboxSize: 1.6,

      fillIntensity: 2.85,
      fillColor: '#ffffff',
      fillAzimuth: 2.79,
      fillElevation: 0.3,
      fillDistance: 4.75,
      fillSize: 2.7,

      /** Separation down the far edge of the silhouette. */
      rimIntensity: 251,
      rimColor: '#00b33c',
      rimAzimuth: 3.5,
      rimElevation: 0.42,
      rimDistance: 3.8,

      /** Warm kicker from the other side behind, so the two edges differ. */
      kickerIntensity: 70,
      kickerColor: '#ff8c00',
      kickerAzimuth: 5.5,
      kickerElevation: 0.3,
      kickerDistance: 3.6,

      /** Hair light, straight down and slightly behind. */
      topIntensity: 55,
      topColor: '#e6f0ff',

      ambientIntensity: 0.17,
      ambientColor: '#ffffff',
      /** The HDR probe, as spec response rather than as light. */
      envIntensity: 0.88,

      shadowBias: 0.001,
      shadowNormalBias: 0.019,
      shadowRadius: 5.3
    },

    /** The set the body stands on. */
    stage: {
      backdropTop: '#275403',
      backdropBottom: '#0e1f00',
      /** A halo on the backdrop that stays behind the body as the camera orbits. */
      backdropGlow: '#004216',
      glowStrength: 0.5,
      glowSpread: 0.28,

      floorColor: '#090c11',
      floorRoughness: 0.3,
      floorMetalness: 0.9,
      /** Radius of the plinth, metres. The floor fades out well inside it. */
      floorRadius: 2.55,

      ringColor: '#11fa00',
      ringIntensity: 1.51,

      contactShadow: 0.9,
      dust: 0.55
    },

    /**
     * The screen's own grade. Same fields as `post`, swapped in wholesale while
     * the character screen is up, so tuning the play stage's look never drags
     * this one with it.
     */
    post: {
      enabled: true,
      exposure: 0.49,
      bloomStrength: 0.02,
      bloomRadius: 0.86,
      bloomThreshold: 1.76,
      vignette: 1.5,
      chromaticAberration: 0.0,
      contrast: 1.15,
      saturation: 1.06,
      temperature: -0.02,
      lift: -0.004,
      gain: 1.0,
      grain: 0.0
    }
  }
};

/** Immutable snapshot used by "Reset to defaults" and the preset system. */
export const DEFAULT_SETTINGS = structuredClone(settings);

/**
 * Deep-merge a plain object into `settings` in place.
 * Existing object identity is preserved so every live binding keeps working.
 */
export function applySettings(patch, target = settings) {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (target[key] && typeof target[key] === 'object') applySettings(value, target[key]);
    } else if (key in target) {
      target[key] = value;
    }
  }
  return target;
}

/** Restore every value to the shipped defaults (in place). */
export function resetSettings() {
  applySettings(structuredClone(DEFAULT_SETTINGS));
}

/** Serialisable clone of the current state. */
export function snapshotSettings() {
  return structuredClone(settings);
}
