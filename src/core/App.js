import { Renderer } from './Renderer.js';
import { Time } from './Time.js';
import { CameraRig } from './CameraRig.js';
import { Input } from './Input.js';
import { frame } from './FrameUniforms.js';

import { Environment } from '../world/Environment.js';
import { Atmosphere } from '../world/Atmosphere.js';
import { Sky } from '../world/Sky.js';
import { Moon } from '../world/Moon.js';
import { Ground } from '../world/Ground.js';
import { Terrain } from '../world/Terrain.js';
import { GroundFog } from '../world/GroundFog.js';
import { Leaves } from '../world/Leaves.js';
import { ContactShadows } from '../world/ContactShadows.js';

import { AssetLoader } from '../loaders/AssetLoader.js';
import { CharacterController } from '../animation/CharacterController.js';
import { ThirdPersonController } from '../animation/ThirdPersonController.js';
import { EnemyManager } from '../combat/EnemyManager.js';
import { TargetMarking } from '../combat/TargetMarking.js';

import { PostProcessing } from '../postprocessing/PostProcessing.js';
import { WeaponFire } from '../vfx/WeaponFire.js';
import { BloodBurst } from '../vfx/BloodBurst.js';
import { ShadowCharacter } from '../vfx/ShadowCharacter.js';
import { Judgement } from '../vfx/Judgement.js';
import { BladeStorm } from '../vfx/BladeStorm.js';
import { TargetRings } from '../vfx/TargetRings.js';
import { TargetMarkers } from '../vfx/TargetMarkers.js';
import { CharacterScreen } from '../screens/CharacterScreen.js';
import { LoadingScreen } from '../ui/LoadingScreen.js';
import { Editor } from '../ui/Editor.js';
import { Toast } from '../ui/Toast.js';
import { Stats } from '../ui/Stats.js';
import { ActionHUD } from '../ui/ActionHUD.js';
import { TargetHotkeys } from '../ui/TargetHotkeys.js';

import { settings } from '../config/settings.js';

const HDR_URL = './hdri/spruit_sunrise.hdr';

/**
 * Application root: owns every subsystem and the frame loop.
 *
 * The wiring is deliberately one-directional — App builds the systems and then
 * does nothing but order the per-frame updates. No subsystem reaches back into
 * App.
 *
 * What is on screen is a lit stage with a character standing on it: the key,
 * the rim, the air and the grade come from `config/settings.js`, and the body
 * loops its idle. Equipment goes on through the character screen (`Tab`), which is a second
 * scene the same body is moved into — see `screens/CharacterScreen.js`.
 *
 * There are therefore two modes, and exactly one thing switches between them:
 * `characterScreen.active` decides which scene the post pipeline draws, which
 * camera it draws it through, which grade block is in force, and which of the
 * two update paths runs. Neither mode knows about the other.
 */
export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.time = new Time();
    this.elapsed = 0;
    this.paused = false;
    this._raf = 0;

    /* ---- core ---- */
    this.renderer = new Renderer(canvas);
    this.rig = new CameraRig(canvas);
    this.camera = this.rig.camera;

    this.environment = new Environment(this.renderer, this.camera);
    this.scene = this.environment.scene;

    /* ---- world ---- */
    // The air comes first because almost everything else is shaded through it:
    // the ground and the sky both bind the same uniform block, which is what
    // keeps the horizon and the haze one colour instead of two.
    this.atmosphere = new Atmosphere();
    this.sky = new Sky(this.atmosphere);
    // The body in that sky. It hangs itself at the angles the sky resolves, so
    // it is only ever as right as the sky is — and it takes the sky's own disc
    // off the moment its maps are in (see `world/Moon.js`).
    this.moon = new Moon();
    // Then the terrain, because it is the surface everything else is placed on:
    // the floor mesh is displaced by it, and the character, camera and shadow
    // focus all read it on the CPU.
    this.terrain = new Terrain();
    this.ground = new Ground(this.environment, {
      terrain: this.terrain,
      atmosphere: this.atmosphere
    });
    // After the ground, because it reads the floor's own baked height field —
    // that shared texture is what lets a puff blowing across a hollow go down
    // into the hollow for the price of one fetch.
    this.groundFog = new GroundFog({
      terrain: this.terrain,
      cache: this.ground.cache,
      atmosphere: this.atmosphere
    });
    // What is actually lying on that floor. Both populations read the same
    // baked height field the floor is displaced by, so the litter lies flat on
    // the slope the ground is drawing rather than on a guess at it — and the
    // meshes themselves are not built until the sheet is in (`load`), so a
    // failed download costs a warning and nothing else.
    this.leaves = new Leaves({
      terrain: this.terrain,
      cache: this.ground.cache,
      environment: this.environment,
      atmosphere: this.atmosphere
    });
    this.contactShadows = new ContactShadows(this.renderer, {
      size: 2.6,
      height: 2.4,
      blur: 2.0,
      terrain: this.terrain
    });

    this.scene.add(
      this.sky.mesh,
      this.moon.mesh,
      this.ground.mesh,
      this.groundFog.mesh,
      this.leaves.group,
      this.contactShadows.group
    );

    /* ---- character ---- */
    this.character = new CharacterController(this.environment);
    this.scene.add(this.character.root);

    this.input = new Input();
    this.controller = new ThirdPersonController(this.character, this.input, this.rig);

    /* ---- combat ---- */
    // What a body cut in half throws off. A pool with nothing in it until
    // something is cut, and it runs on the *simulation's* clock, so a burst is
    // held by the hit-stop of the blow that caused it.
    this.blood = new BloodBurst();
    this.scene.add(this.blood.mesh);

    // The bodies to kick. The rig they clone is loaded in `load()`; until then
    // this is an empty field, and everything that reads it copes with that.
    // A body decides nothing about how a cut *looks* — it only says where and
    // how hard it bleeds, and this draws it.
    this.enemies = new EnemyManager({
      terrain: this.terrain,
      effects: {
        onBlood: (point, direction, count, speed) =>
          this.blood.emit(point, direction, count, speed)
      }
    });
    this.scene.add(this.enemies.group);
    this.controller.setEnemies(this.enemies);

    // Who a press would actually go to, drawn on the ground. It is told what to
    // mark and works nothing out itself — the answer comes from the same call
    // the attacks lock their targets with (`_updateTargetRings`).
    this.targetRings = new TargetRings({ terrain: this.terrain });
    this.scene.add(this.targetRings.mesh);

    /**
     * Who each enabled attack has locked this frame: body → the config keys of
     * the moves that would take it. Rebuilt in place every frame, and the ring
     * and the key caps are both drawn straight off it.
     * @type {Map<object, string[]>}
     */
    this._locked = new Map();
    /** Which of those keys would fire right now, rather than merely aim. */
    this._readyMoves = new Set();
    /** Key lists handed back by dead entries, so a frame allocates nothing. */
    this._keyLists = [];

    /**
     * Seconds of hit-stop left to run.
     *
     * The oldest impact trick there is: on contact the whole simulation drops
     * to a crawl for a few dozen milliseconds, so the frame the foot lands is
     * held long enough to be *seen*. It is deliberately a scale on `dt` rather
     * than a pause — the animation, the ragdoll and the mist all slow together,
     * which is what makes it read as weight rather than as a dropped frame.
     *
     * The scale is taken from whichever move landed rather than read per frame:
     * a slash stops the world harder and for longer than a kick, and the
     * blow it belongs to is over by the time the freeze runs out.
     */
    this._hitStop = 0;
    this._hitStopScale = 1;

    // The summons. They clone whatever is on the body at the moment they are
    // called, so this only has to exist before `V` is pressed — it builds
    // nothing until then, and nothing at all if the shadows are never used.
    // They leave the body to hunt, so they need the ground to run over, the
    // bodies to run at, and somewhere to send a landed foot.
    this.shadows = new ShadowCharacter(this.character, {
      terrain: this.terrain,
      enemies: this.enemies,
      onStrike: (enemy, x, z, force) => this._onShadowStrike(enemy, x, z, force)
    });
    this.scene.add(this.shadows.group);

    // The other one that is aimed rather than swung: a seal over a marked body
    // and a fist through it. Like the shadows it needs the ground it lands on,
    // the bodies it lands among, and somewhere to send the blow.
    this.judgement = new Judgement({
      terrain: this.terrain,
      enemies: this.enemies,
      onStrike: (enemy, x, z, force) => this._onStrike(enemy, x, z, force)
    });
    this.scene.add(this.judgement.group);

    // The third of them, and the only one that is a *mode*: while `X` has the
    // body in the air, every body marked forges a blade out of the weapon that
    // is actually equipped and hangs it around the character until it is
    // loosed. The equipment is asked for rather than held — the loadout does
    // not exist yet, and the blade should be whatever is on the body at the
    // moment one is forged.
    this.blades = new BladeStorm({
      terrain: this.terrain,
      equipment: () => this.characterScreen?.equipment ?? null,
      onStrike: (enemy, x, z, force) => this._onStrike(enemy, x, z, force)
    });
    this.scene.add(this.blades.group);

    // Who they are sent at. `V` and `Q` arm rather than casting: the body under
    // the aim wears a diamond, a left click locks it, and the last lock is what
    // hands the list over. Neither decides anything about the ability behind it
    // and neither draws anything — both are wired here, from the two answers
    // each of them holds.
    //
    // One instance per ability, on its own block of settings: the shadows want
    // a pair and the fist wants one body, and a shared mode would have to be
    // told which it was in the middle of every frame.
    this.marking = new TargetMarking({
      camera: this.camera,
      enemies: this.enemies,
      domElement: this.canvas,
      config: () => settings.shadowCharacter.marking,
      // The last lock is deliberately not announced — the pair stepping out of
      // the body says it, and a line of text on top of that is noise.
      onMark: (count, wanted) => {
        if (count < wanted) this.toast.show(`Marked ${count} of ${wanted}`);
      },
      onCancel: () => this.toast.show('The mark fades'),
      onComplete: (targets) => {
        this.shadows.summon(targets);
        this.toast.show('Two shadows step out and go for them');
      }
    });
    this.judgeMarking = new TargetMarking({
      camera: this.camera,
      enemies: this.enemies,
      domElement: this.canvas,
      config: () => settings.judgement.marking,
      onCancel: () => this.toast.show('The mark fades'),
      onComplete: (targets) => {
        if (this.judgement.cast(targets[0])) this.toast.show('Judgement — something reaches through');
      }
    });

    // The third aim, and the one that behaves differently: it wants one body at
    // a time and it re-arms itself the instant it has one, so marking from the
    // air is something the player does *continuously* rather than a mode they
    // enter and leave. It is armed by taking off and disarmed by landing.
    this.flightMarking = new TargetMarking({
      camera: this.camera,
      enemies: this.enemies,
      domElement: this.canvas,
      config: () => settings.flight.marking,
      onComplete: (targets) => this._forgeBlade(targets[0])
    });

    this.targetMarkers = new TargetMarkers();
    this.scene.add(this.targetMarkers.mesh);

    /**
     * Whoever is currently wearing a diamond, gathered once a frame.
     *
     * Two abilities can each be on their way to a body, and the markers take
     * one list. Reused rather than rebuilt so a frame allocates nothing.
     * @type {object[]}
     */
    this._marked = [];

    /* ---- post ---- */
    this.post = new PostProcessing(this.renderer, this.scene, this.camera);

    /* ---- UI ---- */
    this.loading = new LoadingScreen();
    this.toast = new Toast();
    this.stats = new Stats();
    // The moves and their keys, along the bottom — one panel per category. Fed a
    // state per ability every frame from `_syncAbilities`; it decides nothing.
    this.actionHUD = new ActionHUD();
    // The same answer as the ring, over the head instead of under the feet: the
    // ring says which body, these say with which key. Fed from
    // `_updateTargetRings` — it resolves nothing of its own either.
    this.targetHotkeys = new TargetHotkeys({ camera: this.camera, domElement: this.canvas });
    this.editor = new Editor({
      onToast: (message) => this.toast.show(message),
      // The fire is built later, with the loadout; the editor asks for it when
      // a control needs it rather than holding a reference that starts null.
      getWeaponFire: () => this.weaponFire,
      onRespawnEnemies: () => {
        this.enemies.respawnAll();
        this.toast.show('A fresh ring of them');
      },
      onCastJudgement: () => this._castJudgement()
    });

    /**
     * The equipment studio. Built in `load()`, because it needs the rig's
     * skeleton and material palette — neither exists until the character is in.
     * @type {CharacterScreen|null}
     */
    this.characterScreen = null;

    /**
     * The katana's fire. Built with the studio, because it rides whatever the
     * equipment manager has on the body.
     * @type {WeaponFire|null}
     */
    this.weaponFire = null;

    this._bindEvents();
  }

  /** Whether the equipment studio is the thing on screen. */
  get inCharacterScreen() {
    return this.characterScreen?.active === true;
  }

  /* ------------------------------------------------------------------ */

  _bindEvents() {
    this.renderer.onResize((width, height, pixelRatio) => {
      this.rig.resize(width, height);
      this.post.setSize(width, height, pixelRatio);
      this.characterScreen?.resize(width, height, pixelRatio);
    });

    this._onKeyDown = (event) => {
      // Ignore keys typed into a panel's own fields — the equipment inspector
      // is full of number boxes, and most of these keys are characters in them.
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      switch (event.code) {
        case 'KeyP':
          this.paused = !this.paused;
          this.toast.show(this.paused ? 'Paused — the editor still applies' : 'Resumed');
          break;
        case 'KeyG':
          this.editor.toggle();
          break;
        case 'KeyF':
          this.stats.toggle();
          break;
        case 'Tab':
          // The browser would move focus into the editor's fields otherwise,
          // and the next press would be typed into a number box instead.
          event.preventDefault();
          this.toggleCharacterScreen();
          break;
        case 'KeyX': {
          // Auto-repeat is the key still being held, not a second press — and
          // this one is a toggle, so a held key would flip the mode thirty
          // times a second.
          if (this.inCharacterScreen || event.repeat) break;
          this._toggleFlight();
          break;
        }
        case 'Space': {
          // Space is a jump on the ground and the loose in the air. The two
          // never overlap — the controller refuses a jump while the body is
          // flying — so one key can mean both without a modifier.
          if (this.inCharacterScreen || event.repeat) break;
          if (!this.character.flight?.flying) break;
          event.preventDefault();
          this._loose();
          break;
        }
        case 'KeyV': {
          // Not on the set: the shadows hunt on the play stage, and there is
          // nothing in the studio for them to run at.
          if (this.inCharacterScreen) break;
          // Nor in the air: flight is the one ability that excludes the others,
          // and a press that silently did nothing would read as a dropped key.
          if (this._groundedOnly()) break;
          // One key, three meanings, in the order they can be true: call the
          // pair back, throw a half-taken mark away, or start taking one.
          if (this.shadows.active) {
            this.shadows.dismiss();
            this.toast.show('The shadows burn away');
          } else if (this.marking.active) {
            this.marking.cancel();
          } else {
            // Only one arm at a time. There is one left button and it cannot be
            // asked to mean two things, so the other mode goes quietly — the
            // line below says which one is up now.
            this.judgeMarking.end();
            const wanted = this.marking.begin();
            this.toast.show(`Look at a body and click to mark it — ${wanted} of them`);
          }
          break;
        }
        case 'KeyC': {
          if (this.inCharacterScreen) break;
          if (this._groundedOnly()) break;
          // The same three meanings, except that the middle one is missing: a
          // fist already on its way through cannot be called back, and the
          // press says so rather than being swallowed.
          if (this.judgement.active) {
            this.toast.show('It is already coming down');
          } else if (this.judgeMarking.active) {
            this.judgeMarking.cancel();
          } else {
            this.marking.end();
            this.judgeMarking.begin();
            this.toast.show('Look at a body and click to call it down on');
          }
          break;
        }
        case 'Escape':
          if (this.inCharacterScreen) {
            this.characterScreen.exit();
          } else if (this.character.flight?.active) {
            // Escape is the way out of anything, and in the air the thing to be
            // got out of is the mode itself.
            this._toggleFlight();
          } else {
            this.marking.cancel();
            this.judgeMarking.cancel();
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  /* ------------------------------------------------------------------ */

  /**
   * Refuse a ground ability while the body is in the air, and say so.
   *
   * Flight is the one ability that excludes the rest, and this is where that
   * rule actually lives — every other key handler asks it first. A press that
   * did nothing at all would read as a dropped input, so it costs a line of
   * text rather than silence.
   *
   * @returns {boolean} whether the press should be swallowed
   */
  _groundedOnly() {
    if (!this.character.flight?.active) return false;
    this.toast.show('Not from up here — X to come down first');
    return true;
  }

  /**
   * Take off, or land.
   *
   * The mode is three things starting at once and they have to start together
   * or it reads as three separate events: the body leaves the ground, the aim
   * comes up (so the very next click is a mark), and everything that belongs to
   * the ground is put away — a summon mid-hunt, a fist mid-fall, a half-taken
   * mark. Landing is the same in reverse, except that anything still hanging in
   * the halo is *loosed* rather than dropped: the player marked those bodies,
   * and throwing the volley away on the way down would be taking it back.
   */
  _toggleFlight() {
    const flight = this.character.flight;
    if (!flight?.available) {
      this.toast.show('The float clip did not load — flight is unavailable');
      return;
    }

    if (flight.active) {
      flight.stop();
      this.flightMarking.end();
      const loosed = this.blades.launch();
      this.toast.show(
        loosed > 0
          ? `Coming down — ${loosed} ${loosed === 1 ? 'blade goes' : 'blades go'} with you`
          : 'Coming down'
      );
      return;
    }

    if (!settings.flight.enabled) {
      this.toast.show('Flight is switched off in the editor');
      return;
    }

    // The ground's abilities do not come along. Anything mid-cast is sent away
    // the same way entering the studio sends it away, and both marks go
    // silently — the line below is what the press has to say.
    this.marking.end();
    this.judgeMarking.end();
    this.shadows.dismiss();
    this.judgement.dismiss();
    this.targetRings.clear();
    this.targetHotkeys.clear();
    // And anything the *body* is in the middle of. The controller stops
    // advancing the jumps and the attacks the moment flight has the stick
    // (`ThirdPersonController#update`), so a swing left running would be frozen
    // mid-pose and would still be holding the body when the feet came back down.
    this.character.jump?.cancel();
    this.character.hop?.cancel();
    for (const move of this.character.attacks ?? []) move.cancel();

    flight.start();
    this.flightMarking.begin();
    this.toast.show('Airborne — click a body to forge a blade for it · Space looses them');
  }

  /**
   * A body was marked from the air.
   *
   * The aim re-arms itself immediately whatever the answer was, because in this
   * mode marking is the thing the player is *doing* rather than a mode they are
   * in — the click that fills the last slot should leave them able to click
   * again the moment one comes free.
   */
  _forgeBlade(enemy) {
    const result = this.blades.mark(enemy);
    if (result === 'full') this.toast.show('The ring is full — Space');
    else if (result === 'unavailable') this.toast.show('Nothing to forge a blade from');
    // A duplicate is a mis-click on a body that already has one coming, and
    // saying so every time would be noise.

    if (this.character.flight?.flying) this.flightMarking.begin();
  }

  /** Loose whatever is hanging, and say what went. */
  _loose() {
    const sent = this.blades.launch();
    if (sent > 0) this.toast.show(`${sent} away`);
    else this.toast.show('Nothing hanging — click a body first');
  }

  /**
   * Swap between the play stage and the equipment studio.
   *
   * Everything mode-dependent is resolved from `inCharacterScreen` in `frame()`,
   * so this only has to move the character, park the world's controls and say
   * which view the post stack draws.
   */
  toggleCharacterScreen() {
    const screen = this.characterScreen;
    if (!screen) return;

    // Leaving goes through the screen's own exit path, so the panel's close
    // button and this key land in exactly the same place (`_onScreenExit`).
    if (screen.active) {
      screen.exit();
      return;
    }

    screen.enter();
    // The summons belong to the play stage — they stand in the world, not on
    // the body, so they cannot come along. Anything mid-hunt is sent away, and
    // so is anything mid-fall: the seal hangs over a body that is not in this
    // scene either.
    this.shadows.dismiss({ immediate: true });
    this.judgement.dismiss({ immediate: true });
    // And the halo, along with the mode that raised it: the body is about to be
    // stood on a turntable indoors, and it cannot be hovering when it gets there.
    this.character.flight?.cancel();
    this.flightMarking.end();
    this.blades.dismiss({ immediate: true });
    // Nothing to be in reach of on the set, and the rings are not simulated
    // while it is up — so they come off now rather than being left mid-fade.
    // The marks go the same way, silently: the toast below is what the screen
    // has to say, and "the mark fades" over the top of it would be noise.
    this.marking.end();
    this.judgeMarking.end();
    this.targetRings.clear();
    this.targetHotkeys.clear();
    this.targetMarkers.clear();
    this.rig.controls.enabled = false;
    this.post.setView(screen.stage.scene, screen.camera.camera);
    this.toast.show('Character screen — drag to orbit · right-drag to pan · wheel to zoom');
  }

  /**
   * A blow landed on someone.
   *
   * Three things happen at once and they are all the same beat: the body is
   * handed to the ragdoll, the world nearly stops, and the lens takes a knock.
   * Any one of them alone reads as a bug; together they read as contact.
   *
   * All three are read off the move that landed, which is the whole difference
   * between the two attacks at the moment of impact — the kick's is a short,
   * flat shove, the slash's a longer freeze and a body in two pieces.
   *
   * @param {object} config the striking move's settings block
   */
  _onStrike(enemy, x, z, config) {
    if (!this.enemies.kill(enemy, x, z, config)) return;
    this._hitStop = config.hitStop;
    this._hitStopScale = config.hitStopScale;
    this.rig.shake(config.shake);
  }

  /**
   * A *shadow's* blow landed on someone.
   *
   * The same kill on the same terms as the player's — the force comes from the
   * move the shadow threw, so its slide cut takes a body apart exactly as the
   * player's does. Deliberately not the same *beat*, though: no hit-stop, and
   * half the shake. Hit-stop is the player's own blow being sold back to them,
   * and freezing the world for a cut thrown thirty metres away by something
   * that is not you reads as a stutter. The knock on the lens stays, because it
   * is the only thing that says the hit happened when it is out of frame.
   *
   * @param {object} force the striking move's settings block
   */
  _onShadowStrike(enemy, x, z, force = settings.kick) {
    if (!this.enemies.kill(enemy, x, z, force)) return;
    this.rig.shake(force.shake * 0.5);
  }

  /**
   * Light a ring under whoever a press would land on, and say which press.
   *
   * The question is asked one move at a time, and it is the move's *own*
   * question: `findTarget` with that move's range and cone, which is the exact
   * call `ThirdPersonController` makes on the press. So a body wears a ring
   * because a key would take it — not because it happens to be standing inside
   * some cone alongside three others the swing will never reach. Two rings can
   * still come up, and when they do they are telling the truth: the kick and
   * the slash have locked different bodies, and the caps over each head say
   * which key goes where.
   *
   * Every *enabled* attack is asked, rather than only the ones that could start
   * this instant: the moves lock each other out for the length of a swing (see
   * `Attack#canStart`), and a ring that blinked off for the half second the
   * body was busy would read as the target being lost. `ready` carries that
   * difference instead, and only dims the cap.
   *
   * That `ready` set is the single answer to "would this key do anything right
   * now", and three things are drawn off it: the cap over the head, the plate
   * along the bottom (`_syncAbilities`) and the press itself, which the
   * controller refuses on the same `findTarget` call. One answer, so a plate
   * cannot come up over a body no key would reach.
   *
   * @param {number} dt
   * @param {import('three').Vector3} position
   */
  _updateTargetRings(dt, position) {
    const locked = this._locked;
    const ready = this._readyMoves;

    // Every list back to the pool before the map is emptied — the map is the
    // only thing holding them.
    for (const keys of locked.values()) {
      keys.length = 0;
      this._keyLists.push(keys);
    }
    locked.clear();
    ready.clear();

    // Nothing on the ground can be reached from the air, so nothing on the
    // ground is lit: the rings and the caps go out with the take-off rather
    // than hanging under bodies no key would take.
    if (this.character.flight?.active) {
      this.targetRings.update(dt, locked, this.elapsed);
      this.targetHotkeys.update(dt, locked, ready);
      return;
    }

    const facing = this.character.facing;
    for (const move of this.character.attacks ?? []) {
      if (!move.available || !move.config.enabled) continue;

      const enemy = this.enemies.findTarget(position, facing, move.config);
      if (!enemy) continue;

      // Mid-swing counts as ready: the cap should be lit on the move the body
      // is committed to, not dimmed the instant the key does its job.
      if (move.locked || move.canStart()) ready.add(move.configKey);

      let keys = locked.get(enemy);
      if (!keys) {
        keys = this._keyLists.pop() ?? [];
        locked.set(enemy, keys);
      }
      keys.push(move.configKey);
    }

    this.targetRings.update(dt, locked, this.elapsed);
    this.targetHotkeys.update(dt, locked, ready);
  }

  /**
   * Resolve the aim, take any click on it, and draw the diamonds.
   *
   * Either marking pass may cast from inside here (its `onComplete`), which is
   * why this runs before `shadows.update` and `judgement.update` rather than
   * after: the last lock and the thing it called are the same frame, not two.
   *
   * The markers outlive the mode on purpose. While an arm is up they follow
   * what the player is choosing; once it is spent they follow what is on its
   * way — so a lock stays on the body it was taken on until the shadow sent for
   * it arrives, or until the fist lands on it.
   *
   * Only one of the two modes can be armed at a time (see the key handlers), so
   * there is only ever one hover to draw; but both abilities can be out at once,
   * and the bodies they are on their way to are gathered together.
   *
   * @param {number} dt
   * @param {import('three').Vector3} position
   */
  _updateMarks(dt, position) {
    this.marking.update(dt, position);
    this.judgeMarking.update(dt, position);
    this.flightMarking.update(dt, position);

    const aiming = this.marking.active
      ? this.marking
      : this.judgeMarking.active
        ? this.judgeMarking
        : this.flightMarking.active
          ? this.flightMarking
          : null;

    const marked = this._marked;
    marked.length = 0;
    if (aiming) {
      for (const enemy of aiming.marks) marked.push(enemy);
    } else {
      for (const enemy of this.shadows.assignments) marked.push(enemy);
      for (const enemy of this.judgement.assignments) marked.push(enemy);
    }
    // The halo's marks are gathered whether or not an aim is up, and they have
    // to be: the flight aim re-arms itself on every click, so it is *always*
    // up, and a blade already forged for a body would otherwise lose the marker
    // the click that forged it put there.
    for (const enemy of this.blades.assignments) {
      if (!marked.includes(enemy)) marked.push(enemy);
    }

    this.targetMarkers.update(dt, aiming?.hovered ?? null, marked, this.elapsed);
  }

  /**
   * Say which moves the player can reach right now.
   *
   * Every answer is asked of the thing that owns it — the moves' own
   * `canStart()`, the summons' own `active` — rather than re-derived here, so
   * the row cannot claim a key will work when the press would be swallowed.
   * The attacks report `off` while another one has the body, which is exactly
   * what a press would do.
   *
   * For the techniques that is only half the question: a move also needs
   * someone inside its range and its cone, or the controller spends the press
   * and walks on (`ThirdPersonController#update`). That half is not re-asked
   * here — `_readyMoves` was filled from the same `findTarget` call the press
   * itself makes, one pass earlier in this frame, and is already "in reach
   * *and* able to start". Asking it twice is how the plate and the key drift
   * into disagreeing about the frame a body crosses the edge of the cone.
   */
  _syncAbilities() {
    const jump = this.character.jump;
    const hop = this.character.hop;
    const flight = this.character.flight;
    // The one state that changes what every other one means. While it is up the
    // row goes dark except for its own chip, which is the HUD saying out loud
    // what the key handlers enforce: this ability excludes the rest.
    const airborne = flight?.active === true;
    const state = {
      leap:
        airborne
          ? 'off'
          : jump?.locked || hop?.locked
            ? 'active'
            : jump?.canStart(this.controller.speed, this.input.running) || hop?.canStart()
              ? 'ready'
              : 'off',
      // Lit from the take-off to the landing, and never merely `ready` in
      // between: there is no half of this mode.
      flight: airborne ? 'active' : flight?.available && settings.flight.enabled ? 'ready' : 'off',
      // Always open, and never `active`: the studio hides this row while it is
      // up (`body.cs-open .hud`), so the only state it can be seen in is ready.
      customize: 'ready',
      // Lit from the moment `V` arms the mark, not from the moment the pair
      // steps out: the key has been spent either way, and the chip is what says
      // the next press means something else.
      shadows: airborne
        ? 'off'
        : this.shadows.active || this.marking.active
          ? 'active'
          : 'ready',
      // The same, and `off` while the fist is actually through — that is the
      // one window in which the key genuinely does nothing.
      judgement: airborne || this.judgement.active
        ? 'off'
        : this.judgeMarking.active
          ? 'active'
          : settings.judgement.enabled
            ? 'ready'
            : 'off'
    };

    for (const move of this.character.attacks ?? []) {
      state[move.configKey] = move.locked
        ? 'active'
        : !airborne && this._readyMoves.has(move.configKey)
          ? 'ready'
          : 'off';
    }

    this.actionHUD.update(state);
  }

  /**
   * Call the fist down on whoever is nearest, skipping the mark.
   *
   * The editor's way in, so the effect can be dialled without aiming it forty
   * times. It is the same cast the last lock makes — the only thing missing is
   * the choice, which is not what anyone is tuning at that moment.
   */
  _castJudgement() {
    const position = this.character.position;
    let best = null;
    let bestDistance = Infinity;

    for (const enemy of this.enemies.enemies) {
      if (!enemy.alive) continue;
      const dx = enemy.position.x - position.x;
      const dz = enemy.position.z - position.z;
      const distance = dx * dx + dz * dz;
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = enemy;
    }

    if (!best) this.toast.show('Nothing standing to call it down on');
    else if (!this.judgement.cast(best)) this.toast.show('It is already coming down');
    else this.toast.show('Judgement — something reaches through');
  }

  /** However the screen was closed, the play stage comes back here. */
  _onScreenExit() {
    this.rig.controls.enabled = true;
    this.post.setView(this.scene, this.camera);
    this.toast.show('Back on the stage');
  }

  /* ------------------------------------------------------------------ */

  /** Load assets, warm the shader cache, then start the loop. */
  async load() {
    const assets = new AssetLoader();

    this.loading.setProgress(0.05, 'Loading environment…');
    const hdr = await assets.loadHDR(HDR_URL);
    await this.environment.loadEnvironment(hdr);
    frame.uEnvMap.value = this.environment.equirect;

    this.loading.setProgress(0.3, 'Loading the forest floor…');
    await this.ground.loadTextures(assets);
    // And what is lying on it. Before the shader warm-up below, so the two leaf
    // materials are compiled with everything else rather than on the first frame
    // a leaf is in shot.
    await this.leaves.load(assets, this.renderer);

    // Before the shader warm-up below, so the moon is compiled with the rest and
    // the first frame has a body in it rather than a disc that swaps a moment
    // later. If the maps fail the sky keeps its own disc and nothing else knows.
    await this.moon.load(assets);

    // One build before the first frame, so the ground is shaped when the
    // loading screen lifts rather than settling a frame into it. The floor
    // follows, because it is what re-bakes the height field the terrain has just
    // described (see `world/TerrainCache.js`) — and it has to happen before the
    // shader compile below, not on the first frame after it.
    this.terrain.update();
    this.ground.update(0, 0, 0);

    this.loading.setProgress(0.55, 'Loading character, materials & animations…');
    await this.character.load(assets);

    this.loading.setProgress(0.72, 'Waking the enemies…');
    await this.enemies.load(assets);
    // An attack knows the frame the blow lands and nothing else; what being hit
    // means is decided here. Each hands over its own settings block, so the
    // impact is the one the move was tuned with.
    for (const move of this.character.attacks) {
      move.onHit = (enemy, x, z) => this._onStrike(enemy, x, z, move.config);
    }
    // Stood up now rather than on the first frame, so their materials are in
    // the scene for the shader warm-up below.
    this.enemies.respawnAll();

    this.loading.setProgress(0.76, 'Forging the fist…');
    // The arm the ability drops. It is in the scene from here on, hidden, so
    // its material is compiled with everything else below rather than on the
    // frame it is first called for. A failure costs a warning and an ability
    // that does nothing — see `Judgement#load`.
    await this.judgement.load(assets);

    this.loading.setProgress(0.8, 'Building the character screen…');
    // The set and its rig cost nothing until they are drawn, and building them
    // now means `C` is instant. The equipment models themselves stay on disk
    // until the screen is opened — see `EquipmentLibrary`.
    this.characterScreen = new CharacterScreen({
      renderer: this.renderer,
      canvas: this.canvas,
      character: this.character,
      worldScene: this.scene,
      envMap: this.environment.envMap,
      onToast: (message) => this.toast.show(message),
      onExit: () => this._onScreenExit()
    });

    this.loading.setProgress(0.83, 'Equipping…');
    // The starting loadout — whatever was last dialled in on the set, or the
    // catalog's defaults on a first run. Gear hangs off the skeleton rather than
    // off either stage, so equipping here puts it on the body for the play scene
    // too, and a placement tuned in the screen is the one the world shows.
    await this.characterScreen.equipment.restoreOrDefaults();

    // The fire rides whatever the manager has equipped, so it is built once the
    // loadout is on. It binds itself on the first frame it is updated.
    this.weaponFire = new WeaponFire({ equipment: this.characterScreen.equipment });
    this.characterScreen.setWeaponFire(this.weaponFire);

    this.loading.setProgress(0.85, 'Compiling shaders…');
    // Compile everything up front so the first frame never stutters — both
    // stages, so opening the character screen is not its own first frame. The
    // fire's light is walked through both scenes on the way, because adding a
    // light to a scene is what invalidates every material program in it.
    this.weaponFire.attachTo(this.characterScreen.stage.scene);
    await this.renderer.gl.compileAsync(
      this.characterScreen.stage.scene,
      this.characterScreen.camera.camera
    );
    this.weaponFire.attachTo(this.scene);
    await this.renderer.gl.compileAsync(this.scene, this.camera);

    // Every texture has decoded by now, so the blobs the character's embedded
    // images were served from can go.
    await assets.settled();
    assets.dispose();

    this.loading.setProgress(1, 'Ready');
    this.loading.hide();
    // The moves are named by the row along the bottom, so this only has to
    // cover what the row does not: the stick, and where to look for the rest.
    this.toast.show('WASD to move · Shift to run · your moves are along the bottom');

    this.start();
  }

  start() {
    this.time.reset();
    this.stats.reset();
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.frame();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this._raf);
  }

  /* ------------------------------------------------------------------ */

  frame() {
    const gl = this.renderer.gl;
    // The counters still standing are the ones the *previous* frame ran up, and
    // they are about to be cleared — so the readout is fed here, where a frame
    // ends for certain, rather than at each of the several places one can end.
    this.stats.sample(gl.info.render);
    gl.info.reset();

    const raw = this.time.tick();
    // The impact freeze, spent in *real* time so it lasts as long on any frame
    // rate, and applied as a scale so everything slows together (see `_hitStop`).
    let scale = settings.global.timeScale;
    if (this._hitStop > 0) {
      this._hitStop = Math.max(0, this._hitStop - raw);
      scale *= this._hitStopScale;
    }
    const dt = this.paused ? 0 : raw * scale;
    this.elapsed += dt;

    /* ---- shared uniforms ---- */
    frame.uTime.value = this.elapsed;
    frame.uDelta.value = dt;
    frame.uCameraNear.value = this.camera.near;
    frame.uCameraFar.value = this.camera.far;

    // Which grade is in force. Everything downstream reads this one object.
    const look = this.inCharacterScreen ? this.characterScreen.postLook : settings.post;

    /* ---- simulation ---- */
    this.renderer.syncSettings(look);

    if (this.inCharacterScreen) {
      // The play stage is not simulated while the studio is up: its lights,
      // floor and mist are not on screen, and the body is not standing on it.
      this.characterScreen.update(dt, raw);
      // After the body, so the flame is born off the pose that is about to be
      // drawn rather than off the last one. The shadows are not updated here at
      // all: they stand in the world and hunt bodies that only exist on the play
      // stage, so entering the studio sends them away (`toggleCharacterScreen`).
      this.weaponFire?.update(dt, this.characterScreen.stage.scene);

      gl.shadowMap.needsUpdate = true;
      this.post.sync(this.elapsed, look);
      this.post.render();
      return;
    }

    // Any terrain slider moved this frame lands here, before anything reads a
    // height — so the floor and the body both see the same landscape.
    this.terrain.update();
    // The air and the sky are one look, so they are re-read together. The sky
    // drops its own disc for as long as there is a body to draw instead, and the
    // body comes second because it hangs itself on the light direction the sky
    // has just resolved.
    this.atmosphere.update();
    this.sky.discEnabled = !this.moon.active;
    this.sky.update(this.elapsed);
    this.moon.update();

    // Movement first: it sets the heading and the speed the blend animates to.
    // It only ever touches XZ; which is the whole reason the body can be dropped
    // onto the ground here without the controller knowing the ground exists.
    this.controller.update(dt);
    // Stand the character on the surface. The jump's arc lives inside the model
    // (it is the clip's own hips translation), so this stays the body's *ground*
    // height throughout and a leap over a valley still lands on the far side.
    const position = this.character.position;
    const groundY = this.terrain.heightAt(position.x, position.z);
    // The hover is metres above *the ground*, resolved by `Flight` and added
    // here, which is the one place in the project that owns the body's height.
    // Held against the terrain rather than against an absolute altitude, so
    // flying over a hill climbs it and the camera is never buried by a slope.
    const lift = this.character.flight?.lift ?? 0;
    position.y = groundY + lift;
    this.character.update(dt);

    // Before the bodies, not after: a blow landing this frame emits into this,
    // and a droplet has to be stamped with a clock the shader has already been
    // given or it is born a frame in the past.
    this.blood.sync(this.elapsed);

    // The bodies: their idles, their ragdolls and the ring they stand in. After
    // the character, because where the player is standing is what they watch,
    // what they are spawned around, and what the kick's reach was measured
    // against this frame.
    this.enemies.update(dt, position);
    // After them, so a body that has just been felled or has just walked out of
    // the cone loses its ring on the same frame it stops being a target.
    this._updateTargetRings(dt, position);
    // And who the shadows would be sent at. After the bodies for the same
    // reason: a marked body felled this frame drops its mark on this frame.
    this._updateMarks(dt, position);

    this.environment.setFocus(position.x, position.z, groundY);
    this.environment.update();
    // Gear rides the skeleton, so this is only the mounts' scale against a rig
    // the editor may have just re-normalised.
    this.characterScreen?.equipment.update();
    this.weaponFire?.update(dt, this.scene);
    // Last of the body's followers: the mounts have their final scale and the
    // skeleton its final pose, which is exactly what a shadow steps out of. On
    // the *simulation's* clock, not the real one — a summon that is out there
    // hunting is combat, so it slows with the hit-stop and stops with `P`.
    this.shadows.update(dt);
    // And the fist, on the same clock and for the same reason — it *causes* the
    // hit-stop it then hangs in, which is most of why the blow lands as hard as
    // it does.
    this.judgement.update(dt, this.elapsed);
    // And the halo, last of the three: it hangs off the body's *final* position
    // for this frame, so the ring never lags a frame behind the character it is
    // supposed to be orbiting.
    this.blades.update(dt, this.elapsed, position, this.character.height);

    // After everything that could have taken the body, so a chip lights on the
    // frame the move it names actually starts.
    this._syncAbilities();

    this.ground.update(this.elapsed, position.x, position.z);
    // After the floor, because the puffs stand on the height field the bake it
    // just refreshed describes.
    this.groundFog.update(this.elapsed, position);
    // And the leaves, for the same reason — they lie on that bake, and the
    // window of them follows the body that has just finished moving. The
    // velocity is what scatters them: it goes in raw, so a walk stirs the litter
    // and a sprint throws it, and standing still disturbs nothing.
    this.leaves.update(dt, this.elapsed, position, this.controller.velocity);

    /* ---- camera ---- */
    // The rig runs on *real* time so orbiting stays responsive while paused.
    // The anchor takes the hover with it — the rig damps toward it, so the
    // climb is a camera move rather than a jump cut, and the body stays framed
    // at any altitude.
    this.rig.setAnchor(position.x, groundY + lift, position.z);
    this.rig.update(raw);

    this.contactShadows.setPosition(position.x, position.z, groundY);
    this.contactShadows.render(this.scene);

    /* ---- render ---- */
    // Exactly one shadow map update per frame (see Renderer).
    gl.shadowMap.needsUpdate = true;
    this.post.sync(this.elapsed, look);
    this.post.render();
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    this.stop();
    window.removeEventListener('keydown', this._onKeyDown);
    this.input.dispose();
    this.shadows.dispose();
    this.judgement.dispose();
    this.blades.dispose();
    this.marking.dispose();
    this.judgeMarking.dispose();
    this.flightMarking.dispose();
    this.targetRings.dispose();
    this.targetHotkeys.dispose();
    this.targetMarkers.dispose();
    this.enemies.dispose();
    this.blood.dispose();
    this.weaponFire?.dispose();
    this.characterScreen?.dispose();
    this.character.dispose();
    this.sky.dispose();
    this.moon.dispose();
    this.ground.dispose();
    this.groundFog.dispose();
    this.leaves.dispose();
    this.terrain.dispose();
    this.contactShadows.dispose();
    this.post.dispose();
    this.environment.dispose();
    this.editor.dispose();
    this.toast.dispose();
    this.stats.dispose();
    this.actionHUD.dispose();
    this.rig.dispose();
    this.renderer.dispose();
  }
}
