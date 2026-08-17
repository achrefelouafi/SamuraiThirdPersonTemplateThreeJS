import {
  AnimationClip,
  AnimationMixer,
  Box3,
  Group,
  MathUtils,
  MeshStandardMaterial,
  PropertyBinding,
  SRGBColorSpace,
  Vector3
} from 'three';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { MaterialLibrary } from '../loaders/MaterialLibrary.js';
import { disposeObject } from '../utils/dispose.js';
import { Attack } from './Attack.js';
import { Flight } from './Flight.js';
import { Jump } from './Jump.js';
import { Locomotion } from './Locomotion.js';

/** The skinned body. Geometry and skin weights; its materials are replaced below. */
const CHARACTER_URL = './models/tpose.fbx';

/**
 * Motion, exported as skeleton-only FBX files.
 *
 * These carry no mesh — just animated joints under the same `mixamorig:` names
 * the body is rigged with, which is what lets their clips be lifted straight
 * onto it (see `_retarget`). Adding a state is a line here plus a weight in
 * `Locomotion`.
 */
const ANIMATION_URLS = {
  idle: './animations/Idle.fbx',
  walk: './animations/Walk.fbx',
  run: './animations/Run.fbx',
  bigJump: './animations/BigJump.fbx',
  hop: './animations/Jump.fbx',
  // Not a player state: the summoned shadows hold this on their mark before
  // they go hunting (see `vfx/ShadowCharacter.js`). It is retargeted here
  // because this is where the rig and the retargeter are — the shadows are
  // clones of this skeleton, so a clip lifted onto it plays on them as well.
  crouch: './animations/Crouch.fbx',
  // The hover. Not a move but a *mode*: `X` puts the body in it and it loops
  // there until `X` takes it out again — see `animation/Flight.js`.
  float: './animations/fight animations/floating.fbx',
  // The touchdown out of it: a one-shot that catches the fall and stands back
  // up. It belongs to the same mode, and `Flight` times it against the descent
  // so the impact frame lands on the frame the feet do.
  land: './animations/fight animations/Landing.fbx',
  // The attacks. Unlike the others these exports carry a mesh as well as the
  // motion — only `animations[0]` is read off each, and the body it arrived with
  // is dropped on the floor of `_retarget`.
  kick: './animations/fight animations/Kick.fbx',
  slashHit: './animations/fight animations/Slash.fbx',
  crouchSlash: './animations/fight animations/Crouchslash.fbx'
};

/**
 * Clips whose hips translation is a journey rather than a bob.
 *
 * Everything else plays in place under a controller that owns the position (see
 * `_retarget`). These are the exception: the travel is lifted off the hips and
 * handed to whatever replays it onto the root, so the body ends the clip
 * somewhere new instead of back where it started.
 */
const ROOT_MOTION_CLIPS = new Set(['bigJump']);

/**
 * The look, as a glTF export of the same model.
 *
 * FBX is the only format the rig survives, and it carries almost none of the
 * authored surface — no metallic/roughness, no normal, no emissive. So the
 * materials come from an unrigged GLB of the same body instead, matched onto
 * the rig by material name (see `loaders/MaterialLibrary.js`). Set it to null
 * to fall back to whatever the FBX itself carries.
 */
const MATERIAL_LIBRARY_URL = './models/textures.glb';

/**
 * Rig material name → library material name, for exports that disagree.
 *
 * Normally empty: both files come out of the same scene, so the names already
 * line up and `MaterialLibrary` matches them without help. Add an entry only
 * when a rig arrives with a material the palette calls something else.
 */
const MATERIAL_ALIASES = {
  // 'skin_mat': 'body_mat'
};

/**
 * Whether the palette's textures have to be flipped to sit on this rig.
 *
 * glTF measures V from the top of the image, FBX from the bottom, so a glTF
 * material applied to an FBX body is upside down until one of them gives. Read
 * off the rig's own format rather than hardcoded, so swapping the body for a
 * glTF export turns the correction off by itself — the two files would then
 * already agree. See `MaterialLibrary#flipTextureV` for why this is not simply
 * `texture.flipY`.
 */
const MATERIAL_LIBRARY_FLIP_V = /\.fbx$/i.test(CHARACTER_URL);

/**
 * Optional colour map for exports that ship no texture of their own. The body
 * carries its own, so it is null — point it at a file in `public/models` (e.g.
 * `'./models/diffuse.png'`) if you swap in a skin that expects one, and every
 * untextured material will pick it up.
 */
const CHARACTER_TEXTURE_URL = null;

/**
 * Loads the rigged FBX, normalises it for the scene and drives its animation.
 *
 * The body and its motion come from different files: `tpose.fbx` is the skin,
 * and every clip is loaded from a skeleton-only export beside it and retargeted
 * onto that skin by joint name. `locomotion` then blends idle/walk/run from a
 * single speed, which `ThirdPersonController` feeds it.
 *
 * Attachment points are exposed through `getBone()`: equipment is parented to a
 * bone rather than to the root, so it rides the skeleton for free.
 */
export class CharacterController {
  constructor(environment) {
    this.environment = environment;
    this.root = new Group();
    this.root.name = 'Character';

    // Position and heading live on `root`; anything that leans or bobs the body
    // belongs on `tilt` underneath it, so the two never fight over the same
    // rotation.
    this.tilt = new Group();
    this.tilt.name = 'CharacterTilt';
    this.root.add(this.tilt);

    this.mixer = null;
    /** The idle/walk/run blend, built once the clips are in. */
    this.locomotion = null;
    /** The running long jump, built alongside it. */
    this.jump = null;
    /** The in-place hop — what space does at any pace short of a run. */
    this.hop = null;
    /** The hover. A mode rather than a move — see `animation/Flight.js`. */
    this.flight = null;
    /** The kick, and the warp that puts the foot on a target. Built with them. */
    this.attack = null;
    /** The slash — the same machine, a longer reach. Built with it. */
    this.slashHit = null;
    /** The sliding crouch cut — the same machine again, a much longer approach. */
    this.crouchSlash = null;
    /**
     * Every attack the body has, in the order a press is offered to them.
     *
     * The one list the controller reads and the one each attack checks to see
     * whether a sibling already has the pose, so adding a move is a clip, a
     * settings block and a line here.
     * @type {import('./Attack.js').Attack[]}
     */
    this.attacks = [];
    /** name → retargeted AnimationClip. */
    this.clips = new Map();
    /** name → hips travel lifted off a root-motion clip, in the model's units. */
    this.rootMotion = new Map();
    this.model = null;
    this.height = 1.8;
    this.headPosition = new Vector3(0, 1.5, 0);
    /** name (without the mixamorig namespace) → bone, for attaching equipment. */
    this.bones = new Map();
    /**
     * Materials the FBX brought and this class converted, because the palette
     * had nothing for them. These follow the editor's roughness/metalness.
     */
    this.materials = [];
    /**
     * Materials taken from the palette, each with the surface response it was
     * authored with — restored whenever the editor's override is switched off.
     * @type {{material: import('three').Material, roughness: number, metalness: number}[]}
     */
    this.authored = [];
    /** The palette itself, so equipment can dress itself from the same file. */
    this.materialLibrary = null;
    /**
     * The rig's bounding box as measured at `fbxScale`, so the normalisation can
     * be re-resolved whenever `targetHeight` moves instead of being baked in.
     */
    this._base = null;
    this._scale = 0;
    /** The rig's own forward, in model space. */
    this.forwardAxis = new Vector3(0, 0, 1);

    /**
     * Yaw of the rig's own forward in model space. Bind poses are not
     * necessarily axis aligned, so `setFacing` subtracts this to make "0 faces
     * +Z" true for the caller regardless of how the FBX was authored.
     */
    this._forwardYaw = 0;
    this._rightAxis = new Vector3(1, 0, 0);
  }

  /**
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   */
  async load(assets) {
    const names = Object.keys(ANIMATION_URLS);
    const [fbx, skin, library, ...motions] = await Promise.all([
      assets.loadFBX(CHARACTER_URL),
      CHARACTER_TEXTURE_URL ? assets.loadTexture(CHARACTER_TEXTURE_URL) : Promise.resolve(null),
      MATERIAL_LIBRARY_URL
        ? MaterialLibrary.load(assets, MATERIAL_LIBRARY_URL, {
            aliases: MATERIAL_ALIASES,
            flipV: MATERIAL_LIBRARY_FLIP_V
          })
        : Promise.resolve(null),
      ...names.map((name) => assets.loadFBX(ANIMATION_URLS[name]))
    ]);
    // The FBX resolves before its textures do; material prep inspects them.
    await assets.settled();

    const character = settings.character;
    fbx.scale.setScalar(character.fbxScale);
    fbx.updateMatrixWorld(true);

    // Measure once at the export's own scale. The box grows linearly with the
    // scale, so every normalisation below is a multiply on these numbers — which
    // is what lets `targetHeight` stay a live control.
    const box = new Box3().setFromObject(fbx);
    const size = new Vector3();
    const center = new Vector3();
    box.getSize(size);
    box.getCenter(center);
    this._base = { sizeY: size.y, cx: center.x, cz: center.z, minY: box.min.y };

    this.model = fbx;
    this._applyScale();

    this.materialLibrary = library;
    this._prepareMaterials(fbx, skin, library);
    this._indexBones(fbx);
    this._measureFacing();

    this.tilt.add(fbx);

    this.mixer = new AnimationMixer(fbx);

    names.forEach((name, index) => {
      const clip = this._retarget(motions[index], name);
      if (clip) this.clips.set(name, clip);
    });

    this.jump = new Jump(
      this.mixer,
      this.clips.get('bigJump'),
      this.rootMotion.get('bigJump') ?? null,
      this,
      'jump'
    );

    // No travel is read for this one even if the export carries some: the hop
    // is defined by staying put, and `_retarget` has already frozen the hips
    // horizontally for every clip outside `ROOT_MOTION_CLIPS`.
    this.hop = new Jump(this.mixer, this.clips.get('hop'), null, this, 'hop');

    // The attacks travel too — but as a *warp* onto a target rather than as root
    // motion, so their clips stay in place like every other one and `Attack`
    // resolves the ground they cover from where the enemy is standing. The
    // slash's hips drop into its follow-through and come back up; that is the
    // clip's own vertical, which `_retarget` keeps for every clip (only the
    // horizontal is frozen).
    this.attack = new Attack(this.mixer, this.clips.get('kick'), this, { configKey: 'kick' });
    this.slashHit = new Attack(this.mixer, this.clips.get('slashHit'), this, {
      configKey: 'slashHit'
    });
    this.crouchSlash = new Attack(this.mixer, this.clips.get('crouchSlash'), this, {
      configKey: 'crouchSlash'
    });
    this.attacks = [this.attack, this.slashHit, this.crouchSlash].filter(
      (move) => move.available
    );

    // The hover. It masks the gait exactly as the jumps do, and for longer:
    // there is no walk cycle worth leaving under a body that is six metres up.
    this.flight = new Flight(this.mixer, this.clips.get('float'), this, this.clips.get('land'));

    this.locomotion = new Locomotion(
      this.mixer,
      {
        idle: this.clips.get('idle'),
        walk: this.clips.get('walk'),
        run: this.clips.get('run')
      },
      [this.jump, this.hop, this.flight, ...this.attacks]
    );

    this.setFacing(character.facing);
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* retargeting                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Lift the first clip out of a skeleton-only export onto this body.
   *
   * The two files share Mixamo's joint names, and FBXLoader sanitises node names
   * and track names the same way, so binding is mostly a matter of dropping the
   * tracks that name a joint this rig does not have. The two things that are not
   * free:
   *
   *  - **Units.** The body and the motion can be exported at different scales
   *    (centimetres out of Mixamo, metres out of a DCC round-trip). Joint
   *    *rotations* do not care, but translations do, so they are rescaled by the
   *    ratio the bind pose implies — measured rather than assumed, because
   *    getting it wrong throws the hips a hundred metres into the air.
   *  - **Root motion.** The clips travel. The controller owns where the body is,
   *    so the horizontal component of the hips is frozen at its first frame and
   *    the animation plays in place; the vertical is kept, since that is the
   *    gait's bob rather than travel. For a clip in `ROOT_MOTION_CLIPS` that
   *    horizontal component is *recorded* on the way past rather than simply
   *    dropped — same frozen skeleton, but the journey it would have made is
   *    kept so something else can replay it onto the root.
   *
   * @param {import('three').Group} source the loaded animation FBX
   * @param {string} name what to call the resulting clip
   * @returns {import('three').AnimationClip|null}
   */
  _retarget(source, name) {
    const clip = (source?.animations ?? [])[0];
    if (!clip) {
      console.warn(`[CharacterController] "${name}" carries no animation`);
      return null;
    }

    const unitScale = this._measureClipUnits(clip);
    const hips = this._hipsTrackName();
    const tracks = [];

    for (const original of clip.tracks) {
      const track = original.clone();
      const node = PropertyBinding.parseTrackName(track.name).nodeName;

      if (!this.bones.has(node)) continue; // a joint this body does not have

      if (track.name.endsWith('.position')) {
        const values = track.values;
        if (unitScale !== 1) {
          for (let i = 0; i < values.length; i++) values[i] *= unitScale;
        }
        // Freeze travel, keep the bob (see the note above). Frozen onto the
        // *bind* pose rather than onto the clip's own first key: a clip authored
        // with the body standing somewhere other than the origin would otherwise
        // carry that offset in as a permanent shove sideways, and anything that
        // places the model by its root — the controller, a summoned shadow on
        // its mark — would be aiming the wrong point at the ground.
        if (node === hips) {
          if (ROOT_MOTION_CLIPS.has(name)) this.rootMotion.set(name, extractTravel(track, name));
          const bind = this.bones.get('Hips');
          const x = bind ? bind.position.x : values[0];
          const z = bind ? bind.position.z : values[2];
          for (let i = 0; i < values.length; i += 3) {
            values[i] = x;
            values[i + 2] = z;
          }
        }
      }

      tracks.push(track);
    }

    if (!tracks.length) {
      console.warn(`[CharacterController] "${name}" shares no joints with this rig`);
      return null;
    }

    return new AnimationClip(name, clip.duration, tracks);
  }

  /**
   * The hips under the name a track would address it by.
   *
   * `bones` indexes each joint twice (raw and namespace-stripped); tracks name
   * the raw one, which is the node's own name.
   */
  _hipsTrackName() {
    return this.bones.get('Hips')?.name ?? null;
  }

  /**
   * How far the clip's units are from the body's, read off a bone length.
   *
   * The body and the motion can be exported at different scales (centimetres
   * out of Mixamo, metres out of a DCC round-trip), and joint translations have
   * to be brought into the body's units before they mean anything.
   *
   * The measurement is taken off any joint *below* the hips, because every one
   * of those translations is a **bone length**: the offset from its parent,
   * which is fixed by the skeleton and identical in every pose the rig can hold.
   * The ratio against the same bone's bind translation is therefore the unit
   * conversion exactly, whatever the clip happens to be doing.
   *
   * The hips are the one joint this cannot be read off, and reading it off them
   * is what used to break: the hips translation is the *pose* — how high the
   * body is standing — so a clip whose first frame is a crouch measured as a
   * body two and a half times too small, and every translation in it, bone
   * lengths included, was multiplied to "correct" it. A crouch that arrives
   * hovering half a metre off the floor on a stretched skeleton is that number.
   *
   * The median across the joints is taken rather than the first, so one
   * mis-authored track cannot decide it, and anything inside a factor of two
   * falls back to 1 — small bind differences are rig, not units, and a wrong
   * guess here is far more visible than a missing correction.
   */
  _measureClipUnits(clip) {
    const hipsName = this._hipsTrackName();
    const ratios = [];

    for (const track of clip.tracks) {
      if (!track.name.endsWith('.position') || track.values.length < 3) continue;
      const nodeName = PropertyBinding.parseTrackName(track.name).nodeName;
      if (nodeName === hipsName) continue;

      const bone = this.bones.get(nodeName);
      if (!bone) continue;

      const clipLength = Math.hypot(track.values[0], track.values[1], track.values[2]);
      const bindLength = bone.position.length();
      if (clipLength < 1e-6 || bindLength < 1e-6) continue;

      ratios.push(bindLength / clipLength);
    }

    if (!ratios.length) return 1;

    ratios.sort((a, b) => a - b);
    const ratio = ratios[ratios.length >> 1];
    return ratio > 0.5 && ratio < 2 ? 1 : ratio;
  }

  /**
   * Dress the rig: authored materials where the palette has them, converted
   * FBX materials everywhere else.
   *
   * Each of the rig's materials is offered to `library` by name first, and the
   * match — a full glTF PBR material, with its metallic/roughness, normal and
   * emissive maps — is used as-is. Only what the palette cannot answer for goes
   * through `_toStandard`, which turns the FBX's Phong into something the HDR
   * probe and the stage's shadows can light.
   *
   * The FBX's own textures are dropped once nothing is left using them. It
   * embeds a full set that a matched palette makes redundant, and they are tens
   * of megabytes of decoded image.
   *
   * @param {import('three').Object3D} root
   * @param {import('three').Texture|null} skin fallback colour map
   * @param {MaterialLibrary|null} library authored materials, matched by name
   */
  _prepareMaterials(root, skin, library) {
    const converted = new Map();
    /** Textures the FBX arrived with, and the subset still referenced after. */
    const imported = new Set();
    const live = new Set();
    const unmatched = new Set();

    // TextureLoader assumes linear data; a skin is authored colour.
    if (skin) skin.colorSpace = SRGBColorSpace;

    root.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;

      node.castShadow = true;
      node.receiveShadow = true;
      node.frustumCulled = false;
      node.layers.set(LAYER.WORLD);
      node.layers.enable(LAYER.CONTACT); // captured by the contact shadow pass

      const source = Array.isArray(node.material) ? node.material : [node.material];
      const result = source.map((material) => {
        if (!material) return material;
        collectTextures(material, imported);
        if (converted.has(material)) return converted.get(material);

        const authored = library?.resolve(material.name, node.name) ?? null;
        // Two rig materials can resolve to one palette material; it is only
        // worth remembering once.
        if (authored && !this.authored.some((entry) => entry.material === authored)) {
          // Sampled every frame, so the authored response is remembered here
          // rather than read back off a material the editor may have written to.
          this.authored.push({
            material: authored,
            roughness: authored.roughness,
            metalness: authored.metalness
          });
        }
        if (!authored && library) {
          unmatched.add(material.name || '(unnamed)');
        }

        const applied = authored ?? this._toStandard(material, skin);
        this.environment.registerShadowCaster(applied);
        material.dispose(); // its textures are released below, not here
        converted.set(material, applied);
        return applied;
      });

      node.material = Array.isArray(node.material) ? result : result[0];
    });

    // A converted material shares the FBX's textures; an authored one does not,
    // so anything the palette displaced is now unreferenced.
    for (const material of this.materials) collectTextures(material, live);
    for (const texture of imported) if (!live.has(texture)) texture.dispose();

    if (unmatched.size) {
      console.warn(
        `[CharacterController] no palette material for ${[...unmatched].join(', ')} — ` +
          `the library offers ${library.names.join(', ')}. ` +
          'Rename to match, or add an entry to MATERIAL_ALIASES.'
      );
    }
  }

  /**
   * Convert one imported FBX material to PBR.
   *
   * FBX gives us Phong/Lambert; Standard is what picks up the HDR probe and the
   * stage's shadows. Everything the export actually carries is kept — its
   * colour, its maps. `skin` only fills in for a material that has no map of its
   * own, and is null unless `CHARACTER_TEXTURE_URL` is set.
   *
   * @param {import('three').Material} material
   * @param {import('three').Texture|null} skin
   */
  _toStandard(material, skin) {
    const character = settings.character;
    const map = material.map ?? skin ?? null;
    // Drop the tint only when a *fallback* skin is standing in for a missing
    // map: an untextured FBX defaults to a flat grey that would otherwise
    // darken every texel of it. A material's own colour is the authored look
    // and is kept.
    const color = material.map || !skin ? (material.color ?? 0xffffff) : 0xffffff;

    // Exporters disagree on which slot the normal map lands in, so both are
    // passed through and the empty one costs nothing.
    const standard = new MeshStandardMaterial({
      name: material.name,
      color,
      map,
      normalMap: material.normalMap ?? null,
      bumpMap: material.normalMap ? null : (material.bumpMap ?? null),
      roughness: character.roughness,
      metalness: character.metalness,
      transparent: material.transparent ?? false,
      opacity: material.opacity ?? 1,
      side: material.side
    });

    // Worth the samples: the character is the one thing on screen the camera
    // gets close to, and its texels sit at a grazing angle across the torso.
    for (const texture of [standard.map, standard.normalMap, standard.bumpMap]) {
      if (texture) texture.anisotropy = 4;
    }

    this.materials.push(standard);
    return standard;
  }

  /**
   * Index every bone under both its raw and its namespace-stripped name.
   *
   * Exporters disagree on the namespace ("mixamorig:LeftHand" vs
   * "mixamorigLeftHand"), so equipment can ask for the plain joint name and get
   * it whichever way this particular file was written.
   */
  _indexBones(root) {
    root.traverse((node) => {
      if (!node.isBone) return;
      this.bones.set(node.name, node);
      const short = node.name.split(':').pop().replace(/^mixamorig/i, '');
      if (short && !this.bones.has(short)) this.bones.set(short, node);
    });
  }

  /**
   * A skeleton joint, for parenting equipment to.
   * @param {string} name e.g. `'RightHand'`, `'Head'`, `'Spine2'`
   */
  getBone(name) {
    return this.bones.get(name) ?? null;
  }

  /**
   * Parent an object to a bone so it rides the skeleton.
   *
   * The rig is scaled down to metres, so anything attached inherits that scale:
   * author equipment at the same units as the model it is going on.
   *
   * @param {import('three').Object3D} object
   * @param {string} boneName
   * @returns {boolean} false if this rig has no such joint
   */
  attach(object, boneName) {
    const bone = this.getBone(boneName);
    if (!bone) {
      console.warn(`[CharacterController] no bone named "${boneName}" on this rig`);
      return false;
    }
    bone.add(object);
    return true;
  }

  /**
   * Derive the rig's own forward from the bind pose.
   *
   * The heel → toe vector is the most reliable indicator of facing on a bind
   * pose that may not be axis aligned, and everything that turns the body reads
   * the yaw it produces.
   */
  _measureFacing() {
    this.model?.updateMatrixWorld(true);

    const foot = this.getBone('LeftFoot');
    const toe = this.getBone('LeftToeBase');
    if (foot && toe) {
      const heel = foot.getWorldPosition(new Vector3());
      const tip = toe.getWorldPosition(new Vector3()).sub(heel).setY(0);
      if (tip.lengthSq() > 1e-6) this.forwardAxis.copy(tip).normalize();
    }

    this._forwardYaw = Math.atan2(this.forwardAxis.x, this.forwardAxis.z);
    this._rightAxis.set(0, 1, 0).cross(this.forwardAxis).normalize();
  }

  /* ------------------------------------------------------------------ */
  /* placement                                                           */
  /* ------------------------------------------------------------------ */

  /** Heading, radians about world +Y. 0 faces +Z, whichever way the rig binds. */
  setFacing(yaw) {
    this.root.rotation.y = yaw - this._forwardYaw;
  }

  get facing() {
    return this.root.rotation.y + this._forwardYaw;
  }

  /**
   * Turn toward `yaw` over time rather than snapping.
   *
   * Writes the result back into `settings.character.facing` — that field is the
   * heading, and `update()` reads it every frame, so anything that turns the
   * body has to go through it or be overwritten on the next tick.
   *
   * @param {number} rate fraction of the angle gap left after one second
   */
  turnToward(yaw, rate, dt) {
    const current = this.facing;
    // Shortest way round, so turning across the -Z seam does not spin the body.
    const delta = MathUtils.euclideanModulo(yaw - current + Math.PI, Math.PI * 2) - Math.PI;
    const next = current + delta * (1 - Math.pow(MathUtils.clamp(rate, 1e-6, 1), dt));
    settings.character.facing = next;
    this.setFacing(next);
  }

  /** Put the character back on the floor, upright and facing where it was. */
  resetPlacement() {
    this.root.position.y = 0;
    this.tilt.quaternion.identity();
    this.tilt.position.set(0, 0, 0);
  }

  /**
   * Re-resolve the rig's normalisation against `targetHeight`.
   *
   * Scale the export by `fbxScale`, then by whatever it takes to reach the
   * target height, and drop the result onto y = 0 centred on the origin. Cheap
   * enough to run every frame, and it early-outs when nothing has moved.
   */
  _applyScale() {
    const c = settings.character;
    const base = this._base;
    if (!base || !this.model) return;

    const k = c.targetHeight / Math.max(0.001, base.sizeY);
    const scale = c.fbxScale * k;
    if (scale === this._scale) return;
    this._scale = scale;

    this.model.scale.setScalar(scale);
    this.model.position.set(-base.cx * k, -base.minY * k, -base.cz * k);
    this.height = base.sizeY * k;
    this.headPosition.set(0, this.height * 0.86, 0);
  }

  update(dt) {
    const character = settings.character;

    this._applyScale();

    // A turntable, when one is asked for. It advances the setting itself, so
    // `facing` stays the one answer to "which way is the body pointing" — and
    // sampling it every frame is what makes the editor's slider live.
    if (character.spin !== 0 && dt > 0) {
      character.facing += character.spin * Math.PI * 2 * dt;
    }
    this.setFacing(character.facing);

    // The skin's response to the stage's lights, re-read like everything else.
    // Materials that came from the palette were authored with theirs, so the
    // sliders only reach them while `overrideSurface` is on — and switching it
    // off puts the authored values back.
    for (const material of this.materials) {
      material.roughness = character.roughness;
      material.metalness = character.metalness;
    }
    for (const entry of this.authored) {
      entry.material.roughness = character.overrideSurface ? character.roughness : entry.roughness;
      entry.material.metalness = character.overrideSurface ? character.metalness : entry.metalness;
    }

    if (!this.mixer) return;

    // Weights and stride first: the blend reads the walk cycle's phase, which
    // the mixer is about to advance.
    this.locomotion?.update(dt);

    this.mixer.timeScale = settings.global.animationSpeed;
    this.mixer.update(dt);
  }

  get position() {
    return this.root.position;
  }

  /**
   * Metres per unit of the model's own space, after normalisation.
   *
   * Anything that reads a distance off a clip's tracks has to go through this to
   * land in world units — the tracks were authored against the export's scale,
   * not the one `targetHeight` resolved it to.
   */
  get modelScale() {
    return this._scale;
  }

  dispose() {
    this.jump?.cancel();
    this.jump = null;
    this.hop?.cancel();
    this.hop = null;
    this.flight?.cancel();
    this.flight = null;
    for (const move of this.attacks) move.cancel();
    this.attacks = [];
    this.attack = null;
    this.slashHit = null;
    this.crouchSlash = null;
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.locomotion = null;
    this.rootMotion.clear();
    this.clips.clear();
    this.bones.clear();
    this.materials.length = 0;
    this.authored.length = 0;
    this.materialLibrary = null;
    disposeObject(this.root);
  }
}

/**
 * Lift the horizontal journey out of a hips translation track.
 *
 * Stored relative to the first key and in the model's own units — the same
 * space the track is in — so a later `targetHeight` change rescales the travel
 * with the body instead of leaving a jump that overshoots a smaller character.
 *
 * @param {import('three').KeyframeTrack} track hips `.position`, already unit-corrected
 * @param {string} name for the warning, if it turns out to carry nothing
 */
function extractTravel(track, name) {
  const values = track.values;
  const count = Math.floor(values.length / 3);
  if (count < 2) return null;

  const x = new Float32Array(count);
  const z = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    x[i] = values[i * 3] - values[0];
    z[i] = values[i * 3 + 2] - values[2];
  }

  const total = Math.hypot(x[count - 1], z[count - 1]);
  if (total <= 1e-5) {
    console.warn(
      `[CharacterController] "${name}" was exported in place — no root motion to read. ` +
        'settings.jump.distance drives the travel instead.'
    );
    return null;
  }

  return { times: track.times, x, z, total };
}

/** Add every texture a material references to `out`. */
function collectTextures(material, out) {
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value && value.isTexture) out.add(value);
  }
}
