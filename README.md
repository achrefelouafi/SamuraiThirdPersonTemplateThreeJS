# CharacterEquipmentThreeJS

A Three.js character stage: a rigged Mixamo body standing on a dark cinematic
floor, lit and graded exactly like the
[LinearAbiltyCastingThreeJS](../LinearAbiltyCastingThreeJS) sandbox — the camera,
environment and post-processing settings were lifted from it wholesale. This is
the base the equipment work goes on top of.

```bash
npm install
npm run dev      # http://127.0.0.1:5173
npm run build
```

`WASD` to move, hold `Shift` to run, `Space` to jump — the long jump from a run,
an in-place hop from anything slower. `B` kicks whoever is standing in front of
you, and puts them on the ground.
Drag to orbit, wheel to zoom, `C` for the character screen, `G` for the editor
panel, `F` for the frame stats, `P` to pause the clock.

## What is on screen

| System | File | Notes |
| --- | --- | --- |
| Lighting & atmosphere | [src/world/Environment.js](src/world/Environment.js) | One cool key with a 4096² shadow map re-centred on the character, a cool rim behind it, a deep blue sky fill and a pale bounce off frozen ground. The key and the rim light **the character only**: three has no per-object light filtering, so the world's own surfaces are patched to drop every directional light instead (`excludeFromKeyLights`, live off `environment.keyCharacterOnly`). The HDR probe is kept only as a (dim) specular response and is never the visible sky. |
| Air | [src/world/Atmosphere.js](src/world/Atmosphere.js) | The distance fog, and what replaces three's linear fog for the world's own materials: an analytic height-fog integral with a moonlit forward lobe, so haze pools in the hollows and glows looking into the moon. One `exp` per fragment more than a linear fog. |
| Sky | [src/world/Sky.js](src/world/Sky.js) | One fullscreen shader: a gradient whose horizon *is* the haze colour, a cell-hashed star field, and a moon with maria. It also **owns where the moon is** — `sky.moon.azimuth/elevation` resolve into `frame.uLightDir`, so the disc, the glare, the haze's inscatter lobe and the ground mist's lit side can never disagree. |
| Ground fog | [src/world/GroundFog.js](src/world/GroundFog.js) | The *other* fog: an emitter releasing soft billboard puffs that are carried downwind, spread as they age, and read the floor's own baked height field so they hug the ground and dissolve into it. The whole trajectory is closed-form in the vertex shader — the CPU only writes the handful of slots that expired this frame. |
| Terrain | [src/world/Terrain.js](src/world/Terrain.js) | The world's height field, and the only thing allowed to answer "how high is the ground here". Table-driven value noise, evaluated identically on the GPU (the floor, the grass) and in JS (the character, the camera, the shadow focus). Every knob is a live uniform. |
| Floor | [src/world/Ground.js](src/world/Ground.js) | A grid that follows the character and is displaced up the height field in its vertex shader, so there is no world edge to walk off — the tiling is world-locked through the texture offset and everything the shader does is a function of world position, so only the light pool travels. The plane is snapped to whole vertex spacings, which is what stops a moving displaced mesh from swimming. A radial light pool and a tiling surface: bare soil (`public/textures/terrain`, the default) or the original flagstone (`public/textures/stone`), picked with `settings.environment.floorTextureSet` — only the one in use is downloaded. Switch the maps off entirely and a procedural stone shader takes over. Under the grass the soil darkens and greens by the *same* coverage mask the blades are scattered by, and lifts back toward bare earth along a trampled trail. |
| Grass | [src/world/Grass.js](src/world/Grass.js) | An endless wind-blown field in **one draw call**: 300k blades scattered once, wrapped around the character in the vertex shader and planted on the height field, in five heavily overlapping levels whose *sum* is a smooth 1/d² falloff rather than a set of rings. Reacts to the wind and to being walked on. |
| Footprints | [src/world/TrampleField.js](src/world/TrampleField.js) | A 256² feedback texture that scrolls with the character and remembers where the grass was pressed down — the feet stamp into it, it relaxes back over `springBack` seconds, and the grass reads it per *vertex*. |
| Contact shadows | [src/world/ContactShadows.js](src/world/ContactShadows.js) | The tight darkening under the feet the sun's shadow map cannot resolve. |
| Dust | [src/world/DustMotes.js](src/world/DustMotes.js) | One `Points` draw call, animated entirely in the vertex shader. Character screen only — the play stage's air is the haze and the ground fog. |
| Camera | [src/core/CameraRig.js](src/core/CameraRig.js) | Orbit rig whose distance always resolves back to `settings.camera.distance`, so the wheel and the settings file never disagree. |
| Post | [src/postprocessing/PostProcessing.js](src/postprocessing/PostProcessing.js) | Bloom → tone map → one grade pass (aberration, contrast/saturation/temperature, vignette, grain). |
| Character | [src/animation/CharacterController.js](src/animation/CharacterController.js) | Loads `public/models/tpose.fbx`, normalises it to 1.78 m, converts its materials to PBR and retargets the skeleton-only clips in `public/animations` onto it. |
| Locomotion | [src/animation/Locomotion.js](src/animation/Locomotion.js) · [src/animation/ThirdPersonController.js](src/animation/ThirdPersonController.js) | Camera-relative WASD movement integrated into a velocity, and a phase-locked idle/walk/run blend driven by that speed. |
| Jump | [src/animation/Jump.js](src/animation/Jump.js) | Both jumps. The running long jump: `Space` from a run only, controls locked until the feet are down, and the clip's own root motion replayed onto the character so the landing spot is where it ends up (`settings.jump.distance` is the reach in metres). Below that pace the same class plays the in-place hop from `settings.hop`, which never takes the controls. |
| The kick | [src/animation/Attack.js](src/animation/Attack.js) | `B`, and the motion warping that aims it. The nearest body inside the cone is locked on the press, the spot the animator assumed the character would be standing on is resolved from it, and the body is carried there *inside the clip's own approach* — turning first, stepping in second — so the foot lands on the chest rather than a foot short of it. Contact then buys a few dozen milliseconds of hit-stop and a knock on the lens. |
| Enemies | [src/combat/EnemyManager.js](src/combat/EnemyManager.js) · [src/combat/Enemy.js](src/combat/Enemy.js) | Five bodies standing in a ring around the player, each a clone of one rig idling on its own phase of the same clip. A killed one lies there for `corpseTime` and then burns away on a noise dissolve; the slot refills a couple of seconds later around wherever the player has walked to. |
| Ragdoll | [src/combat/Ragdoll.js](src/combat/Ragdoll.js) | Death, without a physics engine: a particle per joint, bone lengths as distance constraints, braces across the pelvis and chest, and a relaxation solve. The animation is not faded out but *abandoned* mid-frame, so the solver's first pose is the frame the body was hit on. Sleeps once it has settled. |
| Character screen | [src/screens/CharacterScreen.js](src/screens/CharacterScreen.js) | A second scene the body is moved into to be inspected and equipped — its own five-point lighting rig, its own camera and its own grade. `C` toggles it. |
| Equipment | [src/equipment/](src/equipment/) | A catalog of weapons and cosmetic attachments, each mounted to a joint with an offset, rotation and scale that are tuned on screen and pasted back into the catalog. |
| Editor | [src/ui/Editor.js](src/ui/Editor.js) | lil-gui panel over the whole settings tree, with presets. `G` toggles it. |
| Stats | [src/ui/Stats.js](src/ui/Stats.js) | Frame rate, average and peak frame time, draw calls and triangles, averaged over a half-second window. `F` toggles it. |

## The editor (`G`)

Every tweakable number lives in [src/config/settings.js](src/config/settings.js),
and [src/ui/Editor.js](src/ui/Editor.js) is a lil-gui panel bound straight to it
— **Presets · Environment · Grass · Post processing · Camera · Character ·
Locomotion**.

No controller has an onChange handler, because none is needed: the lights, the
floor shader, the dust, the rig and the post stack all *sample* those fields
every frame, so a slider re-lights the scene on the next one with no rebuild and
no shader recompile. That holds while the clock is paused (`P`), which is when a
pose is actually worth lighting. Two things cost slightly more and are marked in
the code: the floor's stone maps flip `USE_MAP`, so that toggle recompiles once,
and `targetHeight` re-normalises the rig (cheap — the bounding box is measured
once at load and every later scale is a multiply on it).

Presets are snapshots of the whole tree in localStorage, exportable and
importable as JSON, with a reset to the shipped defaults. Loading merges *into*
the live objects rather than replacing them, so bindings held by a shader or a
light stay valid.

The same fields are on `window`, so the console works too:

```js
settings.environment.sunIntensity = 4;    // re-lights on the next frame
settings.environment.floorTextureSet = 'stone'; // swap the soil for flagstone
settings.grass.density = 0.25;            // half the blades, on the next frame
settings.grass.windStrength = 1.2;        // a gale rolls across the field
settings.terrain.amplitude = 14;          // mountains, walked on the same frame
settings.terrain.ridge = 1;               // sharp crests instead of rolling downs
settings.terrain.amplitude = 0;           // back to a flat plane, for free
settings.character.spin = 0.05;           // turntable, revolutions/second
settings.camera.distance = 5;             // the rig glides in
```

## The terrain

One height field, three consumers, and they cannot disagree.

`terrainHeightAt(vec2)` in
[src/shaders/lib/terrain.glsl.js](src/shaders/lib/terrain.glsl.js) is the world's
surface. The floor mesh is displaced by it in its vertex shader, the grass plants
every blade on it, and [src/world/Terrain.js](src/world/Terrain.js) mirrors the
same arithmetic in JS so the character, the camera anchor, the contact shadow and
the sun's shadow focus all stand on exactly the ground you can see.

That mirroring is why the noise is **table-driven** rather than the project's
usual `snoise`. A procedural hash (`fract(sin(...) * 43758.5)`) does not evaluate
identically on a GPU and in JS — it agrees to a few decimals, which is
centimetres of terrain, which is a character sinking into a hill. A 256×256 byte
table sampled with `NEAREST` returns exactly `byte / 255` on both sides, and
everything downstream of it is plain float maths that lands within a micrometre.

Two things then have to be handled or the ground boils:

- **Swimming.** The floor plane follows the character, so a vertex's world
  position — and therefore its height — would change under it every frame.
  `Ground#setCenter` snaps the plane to whole vertex spacings, so every vertex
  keeps landing on the same world positions and the mesh slides beneath a
  surface that never moves.
- **Normals.** Taken analytically from the field by central difference, over
  exactly half the vertex spacing, so the shading never claims detail the
  triangles cannot show. The tiling's own normal map rides on top.

Everything in `settings.terrain` is a live uniform — amplitude, hill size,
octaves, warp, ridges — so the landscape can be redialled while walking over it.
The two exceptions are `seed` (reshuffles the table) and `segments` (rebuilds the
floor grid). `octaves` is the real cost dial: the grass evaluates this field once
per *vertex*, so an octave is paid for by every blade on screen. Amplitude 0
collapses the whole thing back to a flat plane at y = 0, for free.

## The grass

One draw call, no CPU work per blade, and it never ends.

**Endless.** 300k blades are scattered once into a square tile and never move
again. The vertex shader wraps each one into the tile centred on the character:

```glsl
vec2 world = cell - area * floor((cell - uAnchor) / area + 0.5);
```

Because the window is exactly *one* tile wide, no two copies of the scatter are
ever on screen together, so the field reads as continuous ground however far you
walk — for the price of one `vec2` uniform per frame. A blade only teleports
across the tile when it is already faded out, so nothing pops.

**Affordable, without rings.** `levels` (5) copies of that trick run at once,
each tile `levelRatio` (2×) wider than the last with the same share of the
blades — so each level is `levelRatio²` times sparser than the one inside it.
Get the hand-over wrong and that ratio is exactly what you see: a dense disc
around the character with a hard edge where it drops to a scatter. Two things
stop it.

The first is that the levels **overlap** instead of tiling. A level covers its
whole tile and only starts thinning at `fadeStart` (0.3) of it, with no fade-in
at all, so at any distance three or four levels are contributing at once and what
you see is their *sum*: a continuous slide from about 980 blades/m² underfoot
down to nothing at 53 m, with no radius at which one level is solely responsible
for the ground. Keeping `levelRatio` near 2 is what holds the steps in that sum
below the noise.

That fade is measured **radially**, not to the square tile's own edge. Fading on
the tile's metric is free — it uses every blade, corners included — but it makes
the falloff a *square*: at the same distance the diagonals carry twice the grass
the axes do, and since every level's square is concentric and aligned, the field
wears a faint four-pointed star that swings around as you orbit. Measuring
distance as distance costs the corners of each tile (about a third of its blades
render degenerate) and leaves a falloff with no preferred direction.

The second is that thinning **removes blades rather than shrinking them**. Each
blade carries its own threshold and is simply absent once its level's fade drops
past it, so the far field is full-height grass getting sparser — never a lawn of
stubs. `widthGrow` fattens what is left, because at a grazing angle it is
*coverage*, not blade count, that the eye reads.

**Planted.** Every blade samples the shared height field at its own world
position, so the field lies on the hills rather than hovering over them.

**Wind.** One coherent gust front travels across the whole field (a phase term
in world space, so the wave is shared rather than per-blade), plus a fine
per-blade flutter. Grass that is already flat has nothing left to lean.

**Footsteps.** [src/world/TrampleField.js](src/world/TrampleField.js) is a 256²
half-float texture that scrolls with the character, fed back into itself every
frame: `rg` is the direction the blades were shoved, `b` is how far down they
are. The toe and ankle joints stamp into it whenever they are *inside* the
field — the contact strength is how far below the blade tips the joint has sunk
— which is what turns a walk into alternating prints, a run into a broken trail
and a jump into a gap, with no gait-specific code anywhere. The whole buffer
relaxes toward zero, so a trail closes behind you over `springBack` seconds. The
window is snapped to whole texels so the scroll is an exact texel shift and the
history stays crisp instead of smearing itself into mush.

The grass samples it in the **vertex** shader, so 150k blades react to the
player for one texture fetch each. The floor samples the same map, which is why
a trail is still readable at a distance where the individual bent blades no
longer resolve. Joint heights are measured against the ground *under the joint*,
so footprints keep working on a slope.

**Cost.** `settings.grass.density` is the dial — it truncates the instance list,
and a blade's level is a per-blade random rather than its index, so any prefix of
that list is an even sample of the whole field: the slider thins near and far
together instead of eating the distance. `area` spreads the same blades over more
ground, and `height` is the other lever, since tall blades are what drive the
overdraw. The editor shows blades/m² underfoot and the field's reach, because
`density` and `area` both move them and neither means much on its own.

## The character

The body and its motion live in different files.

`public/models/tpose.fbx` is the skin: one textured, skinned mesh rigged to
Mixamo's `mixamorig:` skeleton, in a T-pose with no animation of its own.
`CharacterController` normalises it to `settings.character.targetHeight`,
converts its materials to PBR and keeps whatever maps and colours the export
carries. (`CHARACTER_TEXTURE_URL` is the fallback hook for a skin that ships no
texture at all.)

`public/animations/*.fbx` are skeleton-only exports — joints, no mesh. Because
both files name their joints identically, `_retarget()` lifts the first clip out
of each and binds it to the body, dropping tracks for joints this rig does not
have. Two corrections happen on the way:

- **Units.** Translation tracks are rescaled by the ratio the two bind poses
  imply, measured off the hips, so a body exported in metres takes a clip
  authored in centimetres without launching into the sky. Rotations need none.
- **Root motion.** The controller owns where the body is, so the hips' horizontal
  travel is frozen at its first frame and the clip plays in place. The vertical
  is kept — that is the gait's bob, not travel. A clip named in
  `ROOT_MOTION_CLIPS` has that horizontal travel *recorded* on the way past
  instead of merely dropped, so something else can replay it onto the root — the
  jump is the one that does.

Adding a state is one line in `ANIMATION_URLS` plus a weight in `Locomotion`.

## Moving

`WASD` (or the arrows) moves, `Shift` runs, and the drag-orbit rig is the frame
the input is resolved in — forward is always away from the camera.

[ThirdPersonController](src/animation/ThirdPersonController.js) integrates the
input into a velocity rather than applying it as a position delta, and turns the
body toward where it is *going* rather than where the camera looks.
[Locomotion](src/animation/Locomotion.js) reads that one speed and blends
idle → walk → run from it. All three clips play permanently and only their
weights move, so a stop-start input can never catch the body between fades; walk
is the master gait and run is slaved to its normalised phase, which is what stops
the mid-blend shuffle. Playback rate is the body's real speed divided by the
speed the clips themselves cover (`clipWalkSpeed`/`clipRunSpeed`), so raising
`walkSpeed` or `runSpeed` in the editor turns the legs over faster to match
instead of skating them, up to the `strideMin`/`strideMax` clamp.
`walkAnimSpeed`/`runAnimSpeed` trim that rate per gait — blended between the two
on the same curve as the weights — for whatever the clip speeds fail to explain.

`Space` from a run — never from a walk, and never from standing — commits the
body to [Jump](src/animation/Jump.js). It is a committed move: the stick is dead
from launch until the feet are down, and the arc's own travel is what carries the
character, so wherever it lands is where it now is. `settings.jump.distance`
renormalises that travel to an exact reach in metres (0 keeps the clip's own),
`minRunFraction` is how much of `runSpeed` the body must already be doing to
launch at all, and `landAt` is the point in the clip where control comes back.
The gait keeps resolving underneath at the speed it launched with, so touching
down rejoins the run in stride rather than dropping into an idle.

`Space` at any lesser pace — standing, walking, or running below
`minRunFraction` — plays the in-place hop from the same class instead, tuned by
`settings.hop`. It covers no ground, which is what lets it stay a pose laid over
the gait rather than a move: the controller never stops driving the body, so a
jump out of a walk keeps its momentum and comes down still heading where the
stick was pointing. `gaitBleed` is how much of the walk or run keeps playing
underneath — the clip is a standing jump, and taking the whole pose would plant
the legs while the body travels on, which reads as a stop the character never
made. A hop from a standstill gets the pure clip; only the travelling gait
bleeds through.

## Fighting

`B` kicks. Everything about it is in the `Combat` folder of the editor, and the
whole system is three files.

### Aiming an animation that was authored for someone else

A kick is authored against an imaginary opponent at one exact distance and one
exact angle, and the player is never standing there. Sliding the body over with
an ease reads as skating; letting the foot swing through the air a foot short
reads as a bug. [Attack](src/animation/Attack.js) does the third thing —
**motion warping**, which is what third-person games have done since about 2013.

On the press, [EnemyManager#findTarget](src/combat/EnemyManager.js) locks the
nearest body inside `range` and the `cone`, weighted so a target dead ahead wins
over one slightly closer off to the side. The spot the clip needs — `standoff`
metres short of that body, facing it — is resolved once, and the character is
carried onto it over the first `warpAt` of the clip, *turning first and stepping
in second* (`turnAt`), because that is the order a person does it in. By `hitAt`
the body is exactly where the animator assumed it was, and the foot lands.

The class never writes a transform. Like [Jump](src/animation/Jump.js) it only
resolves where the body *should* be, and `ThirdPersonController` — still the one
authority over position — puts it there. Its clock is the action's own, so the
whole move obeys `animationSpeed`, the pause key and the hit-stop for free.

A press with nothing in range still swings. An attack button that does nothing
feels broken, and a whiff is information.

### Contact

Three things happen on the same frame, and all three are the same beat: the body
is handed to the ragdoll, the world drops to `hitStopScale` of its speed for
`hitStop` seconds, and the lens takes a `shake`. Any one alone reads as a
glitch; together they read as weight. The hit-stop is a scale on `dt` rather
than a pause, so the animation, the ragdoll and the mist all slow together — and
the shake runs on real time, so the lens keeps moving while the world holds
still.

### The ragdoll

[Ragdoll](src/combat/Ragdoll.js) adds no physics engine, because a ragdoll does
not need one. What the eye reads as a body falling is bone lengths that never
change and limbs that cannot bend the wrong way, under gravity, with the ground
in the way — and all three of those are distance constraints. So the skeleton
becomes a particle per joint, the bones become constraints, and the whole thing
is relaxed a few times per substep. The solve is position-based rather than
plain Verlet: predict, project, then read the velocity back out of the
correction, which is the form that survives a hit-stop and a paused clock.

Three things stop it reading as a rope:

- **Mass.** The pelvis and chest are heavy, the hands and feet light, held as
  inverse mass. Corrections split in that ratio, so an arm whips off a torso
  that barely notices.
- **Bracing.** Bone lengths alone give a chain that folds flat. A dozen extra
  constraints across the pelvis, the chest and the spine (`brace`) give the body
  a shape it is trying to keep while everything else flails.
- **Limits.** A knee that bends both ways is the most recognisable tell there
  is, so the hip-to-ankle distance is floored and capped — cheap for a hinge,
  and it cannot hyperextend or fold flat.

Getting points back onto a skeleton is the other half. Every bone is turned to
*aim* at its child's particle, which leaves the twist about its own axis exactly
as the death pose had it. The pelvis and the chest have two independent
directions available (up the spine, across the hips or the shoulders), so their
full orientation is rebuilt from that frame instead — without it, a body face-up
and a body face-down are the same aim vector and the corpse lands on its side
every time.

The handover is not a blend. The mixer is stopped mid-frame and the solver's
first pose is whatever the clip was showing when the foot connected, which is
the only way a death looks like it happened to the same body that was standing
there. Once nothing is moving faster than `sleep`, the whole thing stops for
good.

### The bodies

`count` of them stand within `radius` of the player and no nearer than
`minRadius`, spread over the *area* of that ring rather than its radius, and
rejected against each other so no two share a patch of ground. One rig is
downloaded and every enemy is a `SkeletonUtils` clone of it, each idling on its
own phase of the same clip at its own slight pace — five bodies breathing in
unison is the most artificial thing a crowd can do.

A corpse does not hold a slot: the refill timer starts when the body dies, so
the ring is back to full while the old one is still lying there. It stays for
`corpseTime`, then burns away over `dissolveTime` on a noise dissolve that
rises from the feet — `discard` rather than alpha, so a body lying inside a bank
of ground mist never has to be sorted against it.

The export carries no textures at all, so the look is authored rather than
imported: a cold near-black body with an ember fresnel rim, which is the one
combination that stays legible against a blue night at twenty metres.

## The character screen (`C`)

`C` moves the body out of the play scene and onto a set built for one thing:
looking at it and dressing it. `Esc` or the panel's close button brings it back,
including where the character was standing.

| Piece | File | Notes |
| --- | --- | --- |
| The set | [src/world/StudioStage.js](src/world/StudioStage.js) | A scene of its own. Key light *twice* — a spot that carries the shadow and a rect-area softbox at the same angle that does the wrap and the specular roll — plus an area fill from the opposite quarter, a cool rim and a warm kicker behind each shoulder (deliberately unmatched: equal edges read as a mistake, differing ones read as a room), a hair light, and a cyclorama whose halo is placed from the view vector every frame so the silhouette is always framed against the bright part of the wall. The plinth is polished metal that alpha-fades before its own edge, so there is no disc sitting in a void. |
| Camera | [src/screens/StudioCamera.js](src/screens/StudioCamera.js) | A free inspection orbit — drag to spin, wheel to dolly, right-drag to pan — plus framing presets (whole body, bust, head, the piece being tuned) that glide and abandon themselves the moment the pointer touches the canvas. |
| The mode | [src/screens/CharacterScreen.js](src/screens/CharacterScreen.js) | Owns the switch: which scene the post stack draws, which camera, which grade block, and which update path runs. Nothing is duplicated — same skeleton, same mixer, same mounts — which is what makes gear tuned here already correct out in the world. |
| Panel | [src/ui/CharacterScreenUI.js](src/ui/CharacterScreenUI.js) | Plain DOM. Holds no state: every value is re-read from the manager, so the gizmo and the number boxes can never disagree. |

Tuning a placement: pick a category, click an item to equip it, then set the
joint and nudge the offset. The `Move`/`Rotate` gizmo in the viewport writes the
same numbers the inspector's sliders do — drag the arrow and the slider follows,
type in the box and the piece moves. Clicking a piece on the body selects it, the
joint marker shows where it is anchored, and `Skeleton` draws the rig through the
armour. `Motion` plays the walk and run so gear can be judged while the body
moves.

When it looks right, **Copy defaults** puts the placements on the clipboard as a
snippet to paste over `defaults` in the catalog — that is how a tuned placement
becomes the one everyone loads. **Save** keeps a loadout in localStorage and
**Export** writes it as JSON.

The whole lighting rig is live under **Character screen** in the editor (`G`),
the same way everything else in this project is: `StudioStage` re-resolves every
light from `settings.studio` each frame, so a slider re-lights the set on the
next one.

## Equipment

The catalog is the whole content layer — adding a sword is one entry in
[src/equipment/EquipmentCatalog.js](src/equipment/EquipmentCatalog.js) and no code
anywhere else:

```js
{
  id: 'sword',
  name: 'Katana',
  category: 'weapons',
  url: './models/weapons/sword.glb',
  defaults: { bone: 'RightHand', position: [0, 0.04, 0.02], rotation: [-90, 0, 0], scale: 1 }
}
```

`weapons` and `attachments` are kept apart on purpose. Weapons is the category
that will grow rules — drawing and sheathing, a hand it has to be in, damage;
attachments are cosmetic and never will. Splitting them now makes that later work
a change to one category rather than a filter over a flat list.

Two things happen to a model on the way in:

- **It loads lazily.** Each of these GLBs is ~4.5 MB, and nothing downloads until
  something asks for it — the boot path is untouched by a catalog of any size.
  The rest is prefetched in the background once the screen is actually open.
- **It wears the body's materials.** Every one of these exports embeds the same
  four 1024² maps the character's palette already carries under `weapon_mat`;
  they came out of one Blender scene. So the material is resolved against
  [MaterialLibrary](src/loaders/MaterialLibrary.js) by name and the export's own
  is released — three items, zero extra texture memory, and gear lit by exactly
  the same material the armour is. (The palette is flipped to sit on an FBX body;
  these models are glTF and agree with the texture as authored, so the flip is
  cancelled on the geometry's UVs, once, in
  [EquipmentLibrary](src/equipment/EquipmentLibrary.js).)

### Mounts, and why offsets are in metres

[EquipmentManager](src/equipment/EquipmentManager.js) parents each piece to a
*mount* rather than straight to the joint, and the mount's scale is the inverse
of the joint's world scale. The rig is a Mixamo FBX — authored in centimetres,
scaled by `fbxScale` and again to reach `targetHeight` — so a joint's world scale
is about 0.01, and an object parented straight to it would arrive a hundred times
too small with offsets to match. The mount cancels exactly that: everything
inside it is in metres, whatever the rig was exported at, and the numbers stay
valid when `targetHeight` moves.

Straight to a bone still works, for code that wants no placement of its own:

```js
app.character.attach(sword, 'RightHand');
const head = app.character.getBone('Head');
```

Bones are indexed under both their raw and namespace-stripped names, so ask for
the plain joint. Anything parented to one rides the skeleton for free.

From the console:

```js
const screen = app.characterScreen;
app.toggleCharacterScreen();                      // same as pressing C
await screen.equipment.equip('sword');
screen.equipment.setBone('sword', 'LeftHand');
screen.equipment.setPlacement('sword', { position: [0, 0.05, 0], rotation: [-90, 0, 0] });
console.log(screen.equipment.snippet());          // paste over the catalog defaults
```

## Credits

- **Character model** — [dark_igorek](https://sketchfab.com/dark_igorek) on Sketchfab
- **Textures** — [ambientCG](https://ambientcg.com)
