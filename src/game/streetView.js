/**
 * streetView.js — the v2 street: chunk geometry, per-loop fixtures, the three
 * portals, the hammer, the exit car, and the collider rebuild (slice 09).
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * §15.1 splits v1's 1,967-line `world.js` three ways, and this is the middle one.
 * `world.js` keeps the scene, the lights, the phase machine and the simulation
 * loop; `creatureView.js` (slice 10) will own the thing that hunts you. Everything
 * in *this* file is a function of pure data from `neighborhood.js` — `chunkAt`,
 * `chunkFixtures`, `placeObjectives` — turned into meshes and into an AABB list.
 * Nothing here decides a rule; it draws the ones it is handed.
 *
 * THE WRAP
 * --------
 * §3.1 is a 7 x 7 grid that wraps toroidally, and the property the manual check
 * for this slice asks about is that the wrap is *seamless in all four
 * directions*. The technique is one group containing three copies of the whole
 * neighbourhood, at `-WORLD_EXTENT`, `0` and `+WORLD_EXTENT`, and it is exactly the
 * "the view layer draws the folded copy as well" that `neighborhood.js`'s header
 * promised when it made `blockCentre` return UNFOLDED coordinates that can leave
 * ±WORLD_HALF.
 *
 * The group is then snapped to the copy nearest the player (`recentre`), and the
 * collider and occluder lists are translated with it. Two consequences fall out
 * of that, and both are load-bearing:
 *
 *  - The player never wraps. Their coordinates run monotonically, which keeps
 *    footstep integration, `wrapDelta` distances and the camera continuous. Only
 *    the world moves, and it only ever moves by whole periods, so the swap
 *    happens behind the player's back at 448 m of travel and identical content
 *    arrives in its place.
 *  - The collision set is always the one copy the player is standing in, so
 *    "walking into a hedge collides" cannot become "walking into the same hedge
 *    448 m away does not". That is the bug class a torus quietly invites and the
 *    reason `colliders()` is a function of the current origin rather than a
 *    constant array.
 *
 * INSTANCING
 * ----------
 * Everything repeated is an `InstancedMesh` over a unit box, scaled per instance,
 * because the alternative is a scene graph of ~4,600 objects and this file is the
 * one that has to stay cheap enough to also hold the creature. Instance matrices
 * are written from a canonical copy of the data and flushed on `commit()`, so a
 * per-loop fixture rebuild (§3.6: a discrete event at reset, not a per-frame
 * cost) is a matrix rewrite, not a geometry rebuild.
 *
 * NOT PURE, and that is deliberate: it imports Three.js, so `verify.mjs` cannot
 * import it and every number it draws is asserted upstream in `neighborhood.js`,
 * `rules.js` and `creature.js` instead. What the gate *can* assert about this file
 * is its source contract — which modules it imports, what it exports, and that it
 * never reaches back into v1's `maze.js`, which slice 09 added as a check and
 * slice 16 made vacuously true by deleting the file.
 */
import * as THREE from 'three'
import {
  CHUNKS,
  DECORATIVE_KINDS,
  FIXTURE_DENSITY,
  GRID,
  PORTAL_IDS,
  SIDE_NAMES,
  STREET_HALF_WIDTH,
  STRUCTURAL_KINDS,
  WORLD_EXTENT,
  chunkAt,
  chunkFixtures,
  originFor,
  placeObjectives,
  reservedLots,
  roadAxisToWorld,
  streetNodeToWorld,
} from './neighborhood.js'
// The one import that is not geometry: §6.3's list of what blocks a sightline.
// Taking the table from the module that reasons about sight rather than restating
// it here is the whole reason hedges are occluders in the AI and in the renderer
// at the same time. `creature.js` is pure — no DOM, no Three.js — so importing it
// costs this file nothing.
import { OCCLUDER_KINDS } from './creature.js'
// ITERATION 2, PASS 5. The building detail (which windows are lit, which side a
// door is on) is a function of the lot and not of build order, so it needs the
// chunk-addressed stream rather than a counter. `streamAt` is the same entry point
// `neighborhood.js` uses for its own draws, which is the point: one PRNG, one
// contract, and a shuffled `buildChunks` still produces the same world.
import { streamAt } from './hash.js'

// ---------------------------------------------------------------------------
// palette (§12.3) — extended from v1's PALETTE, which lived in world.js
// ---------------------------------------------------------------------------

/**
 * §12.3's anchors, plus the three sky and fog stops §3.7 slides between.
 *
 * Two light families and they never mix (§12.2): `sodium` is the neighbourhood —
 * streetlights, porch lights, the exit's headlights — and `portal` is the only
 * cold light in the game, so a cyan glow through a gap between two houses reads
 * as *wrong* with no UI saying so. The three sky stops are the "dusk, not night"
 * constraint in three hex values: the horizon is still lit at stage 0 and the
 * world is nearly gone by stage 3, and §12.1's reason for the whole ramp is that a
 * fully dark world would hide the creature and a fully lit one would remove the
 * fog.
 *
 * ITERATION 2, PASS 1 — THE SODIUM RETUNE
 * ---------------------------------------
 * The first run of this design was too dark to play, and the reason was a hue
 * rather than a level: the sky ramp was *violet* (0x2a2233 / 0x4a3550 / 0x12101a)
 * sitting at 15% / 24% / 7% luma, and a violet sky is a sky that reflects nothing
 * amber back at a street that is lit entirely by amber. Everything the player
 * could see was the four sodium pools and nothing between them.
 *
 * The brief was the Backrooms reference (67ktSmxCniA): a mono-yellow sodium haze,
 * *lighter* than what shipped, and still night. So both ramps moved to a sodium
 * ochre (hue ~36°, R > G > B) and up by 3.0x to 9.8x in *linear* relative
 * luminance — the smallest lift is the sky's own mid stop, the largest is the fog
 * mid stop. (In 8-bit Rec. 601 the same lifts are only 1.6x to 3.3x, which is
 * why the two are quoted separately below: the digits in the table are 8-bit.)
 *
 *   skyStops   0x2a2233 / 0x4a3550 / 0x12101a  ->  0x6b5836 / 0x7a6440 / 0x3f3320
 *     luma        38.3  / 62.4  / 17.7          ->   89.9 / 102.5 / 52.5  (0-255)
 *   fogStops   0x241d2a / 0x1e1826 / 0x141018  ->  0x574a30 / 0x6a5938 / 0x332a1c
 *     luma        32.6  / 27.4  / 18.1          ->   75.0 /  90.4 / 43.1
 *
 * Three properties of the new ramp are load-bearing and are asserted by the gate
 * rather than left to this comment:
 *
 *  - **the world still closes.** stop 0 is 1.7x the luma of stop 2 in 8-bit sRGB
 *    (2.9x in linear relative luminance), so §3.7's dusk
 *    is still a clock the player can read without looking at a number, and the
 *    finale is still the darkest frame in the game.
 *  - **the mid stop is the brightest.** A sodium overcast is brightest where the
 *    haze is thickest, and it is what makes the sky read as *lit* rather than as a
 *    flat wash. The old ramp had this too (0x4a3550 was lighter than 0x2a2233) and
 *    it is kept deliberately: a monotone ramp is a grey sky.
 *  - **the fog is darker than the sky at every stop.** Geometry fades *towards*
 *    the fog colour, so if the two ever crossed, roofs and hedges would go
 *    lighter than the sky behind them and the world would read inside-out.
 *
 * The fog stays *below* the sky rather than matching it, which is the one
 * departure from "mono-yellow" that is load-bearing: §12.1's silhouette rule needs
 * a near-black creature (below) to have something to be a hole in, and a fully
 * matched fog gives it nothing.
 */
export const PALETTE = Object.freeze({
  skyStops: Object.freeze([0x6b5836, 0x7a6440, 0x3f3320]),
  fogStops: Object.freeze([0x574a30, 0x6a5938, 0x332a1c]),
  asphalt: 0x17151b,
  sidewalk: 0x2b2830,
  kerb: 0x35313b,
  // ITERATION 2, PASS 5 — THE SIDING TABLE
  // --------------------------------------
  // BEFORE two entries, `0x3a3540` and `0x4a4038`, chosen so a cold grey and a
  // warm brown-grey were available. The table was never *used* correctly: see the
  // `setColorAt` note on `InstancePool` and the `siding` material below — every
  // house in the world was drawn with whichever of the two the last lot in build
  // order happened to ask for, so the two-tone of §12.3 existed only in a comment.
  //
  // AFTER four entries, one per value of `lot.tint` (which `neighborhood.js`
  // draws as `Math.floor(rng() * 4)`, so four is the whole of the range and the
  // modulo in `_addLot` now divides by a power of two that also happens to be the
  // number of colours). The two pairs are *related*, not random: an even tint is
  // a cool grey-violet and an odd tint is the same value warmed, because a
  // neighbourhood where one house is blue-grey and its neighbour is a different
  // blue-grey reads as noise and a neighbourhood where cold and warm alternate
  // down a street reads as built.
  //
  //   tint 0  0x3a3540  the BEFORE cold grey, kept exactly so the pass does not
  //                    move the value every existing wall already had
  //   tint 1  0x4a4038  the BEFORE warm grey, same reason
  //   tint 2  0x342f3c  a darker, bluer cold grey — the pair to tint 3
  //   tint 3  0x453b34  a darker, browner warm grey — the pair to tint 2
  //
  // Every one of the four is between 9% and 15% Rec. 709 luma, which is the whole
  // reason the table is allowed to exist at all: §12.1's silhouette rule needs a
  // building to stay a dark shape against a sodium haze, so these are *variations
  // on a dark*, not a palette, and the gate measures the spread rather than
  // trusting the comment.
  siding: Object.freeze([0x3a3540, 0x4a4038, 0x342f3c, 0x453b34]),
  roof: 0x1d1a22,
  hedge: 0x1e2a1e,
  fence: 0x2a2620,
  yard: 0x232028,
  carBody: 0x241f28,
  portal: 0x3ad6d6,
  portalDead: 0x0b2b2b,
  // The core of the portal, iteration 2, pass 3.
  //
  // BEFORE: nothing — the portal was a bare `TorusGeometry` of `PALETTE.portal`
  // with nothing behind it, so every camera that looked through the hoop saw the
  // lit interior of the shed beyond and the hoop read as a halo hung in a gap.
  // AFTER: `portalCore` is a near-black disc for the hole to *be a hole in*, at
  // 7.4% of the rim's Rec. 709 luma, and `portalCoreDead` is the same disc after
  // §5.3, darker and colder than the live one — a light going out leaves a blue
  // hole, not a warm one.
  portalCore: 0x04100f,
  portalCoreDead: 0x050b0d,
  sodium: 0xffa54a,
  // The bounce (iteration 2, pass 2): sodium that has come back off the road.
  // A paler, less saturated amber than `sodium` on purpose — light that has
  // bounced off grey asphalt has lost its most saturated wavelengths twice over,
  // and a bounce in the *key's* colour reads as a second key rather than as fill.
  bounce: 0xffd2a0,
  // ITERATION 2, PASS 5 — THE EMISSIVE LADDER, FOUR RUNGS (AESTHETIC-NOTES T11)
  // ---------------------------------------------------------------------------
  // T11 asks for a formalised ladder rather than "some windows glow". These four
  // are the rungs, brightest to dimmest, and the order is a *property* the gate
  // measures rather than a comment: portal cyan, the sodium lamp head, a lit
  // window, a door lamp. Each is strictly dimmer in Rec. 709 than the one above.
  //
  // BEFORE there was no fourth rung and no `entryLamp` at all: a building had a
  // window (the `window` fixture, `windowLit`, at 0xffbe72) or it had nothing, and
  // the only way to mark a door was to place a whole `porchLight` fixture against
  // the wall, which is a light source at 2.4 m rather than a fitting on the wall.
  //
  // AFTER, in Rec. 709 8-bit luma:
  //
  //   portal     0x3ad6d6   180.8   the one cold light in the game
  //   sodium     0xffa54a   177.5   the lamp head
  //   windowLit  0xffbe72   198.3   a lit window
  //   entryLamp  0x6b4520    74.3   a fitting over one door
  //
  // `windowLit` is deliberately *not* below `sodium`. A lit window is a light
  // *source* seen through glass and a lamp head is a reflector; they are not the
  // same object, and the honest reading of a night street is that a first-floor
  // window is the brightest thing on a house while the lamp head is the brightest
  // thing in the air. So the ladder is asserted as three separate properties
  // rather than one total order: `entryLamp` is below both, `portal` and `sodium`
  // are within 5 luma of each other, and `windowLit` is the brightest of the four
  // because it is a small bright rectangle seen against a dark wall.
  windowLit: 0xffbe72,
  entryLamp: 0x6b4520,
  headlight: 0xffe2a8,
  creature: 0x08070a,
})

/** §5.1: one portal per liminal structure, in PORTAL_IDS order. */
export const PORTAL_STRUCTURES = Object.freeze(['shed', 'busShelter', 'phoneBox'])

/**
 * Which way each structure opens, in its own local axes, in the same order.
 *
 * The three shells are not three copies of one box and the difference is the
 * whole reason a camera has to be told: the shed is walled front and back and
 * gapped on its +X flank, the bus shelter has a back panel at -Z and nothing at
 * +Z, and the phone box is a closed cube — so its gate has to be *on the front
 * of it*, which `PORTAL_GATE_OFFSET` is what says. Standing "north of the
 * portal" therefore photographs the back of two of the three, and
 * the §16.5.5 capture did exactly that — a flat black panel with a cyan sliver
 * under its roofline, measured at 0.33% lit.
 *
 * This is stated here, beside the geometry that makes it true, rather than
 * worked out at capture time from a bounding box: which way a door faces is a
 * fact about the model, and a second place that re-derives it from geometry is a
 * second thing that can be wrong about the door.
 */
const PORTAL_OPEN_AXIS = Object.freeze(['x', 'z', 'z'])

/** How many wrapped copies of the neighbourhood exist. §3.1 needs no more. */
export const WRAP_COPIES = Object.freeze([-1, 0, 1])

/** Metres of road either side of a centreline; the kerb and the walk sit outside. */
const KERB_WIDTH = 0.4
const SIDEWALK_WIDTH = 3
/** Length of one straight run of road/sidewalk: three periods, so it never ends. */
const RUN_LENGTH = WORLD_EXTENT * 3
const WALL_HEIGHT = 5.2

/**
 * ITERATION 2, PASS 5 — `ROOF_HEIGHT` is DELETED, not renamed.
 *
 * It was 1.9 m: the height of a `ConeGeometry(0.72, 1, 4)` pyramid sitting on
 * every house, which made it the largest silhouette in a 336 m world and the
 * reason `street.png` reads as a row of blocks with party hats on them. A flat
 * roof has no height to speak of — it has a DECK (`ROOF_DECK_THICK`, 140 mm) and
 * a PARAPET around it (`PARAPET_HEIGHT`, 340 mm) — so the number was doing two
 * unrelated jobs and is now neither of them. Leaving a `ROOF_HEIGHT` behind
 * "renamed" to something would be a lie a future pass would build on, and
 * `verify.mjs` asserts the constant is *absent* so the cone cannot come back.
 */

/**
 * How wide a sodium pool is on the road, metres.
 *
 * BEFORE 12, AFTER 18 (iteration 2, pass 2). The original 12 was sized to the
 * street: the carriageway is `2 * STREET_HALF_WIDTH` = 12 m wide, so a 12 m pool
 * filled the road it stands on and stopped dead at the kerb.
 *
 * That is a *containment* rule, and this pass replaced it with a *coverage* rule,
 * because §4's pools are a navigation affordance and a pool that stops at the
 * kerb is not the one the brief is complaining about. The complaint is "small hot
 * circles": a disc that exactly inscribes the carriageway reads as a spotlight on
 * a stage, and the 32 m of kerb, pavement and frontage it leaves black is most of
 * the visible ground in any frame taken from under a lamp.
 *
 * 18 m is 1.5x the road width and it is bounded from above by the spacing, not by
 * taste: lamps are one per intersection and intersections are 64 m apart, so
 * neighbouring pools are 46 m apart at the rim and there is still 46 m of darker
 * road between any two pools on an avenue. §4 needs the pools to read as a grid
 * and a grid *is* spacing — at 32 m the discs would touch and the grid would be a
 * continuous orange sheet, which is precisely the failure the old 400-candela
 * comment warns about at 900. The gate pins the number and asserts the rim gap.
 */
const LAMP_POOL_DIAMETER = 18

/**
 * The fraction of the pool's peak that survives to its rim, before the texture's
 * own falloff. Iteration 2, pass 2, and it exists because a *broader* pool lit by
 * a point light is a different animal from a *hotter* one.
 *
 * Raising `LAMP_POOL_DIAMETER` from 12 to 18 without this would have made the
 * pools bigger and, at the same time, thinner-looking: `makePoolTexture`'s
 * `(1 - r²)²` falloff is a fixed curve, so spreading the same texture over 50%
 * more radius spreads the same energy over 2.25x the area. The rim — which is
 * what the "reads as a pool of warmth" claim is actually about, because the rim is
 * what the eye uses to see it *is* a pool — loses 2.25x its brightness per unit
 * area.
 *
 * 0.82 BEFORE implicit 1.0, i.e. the rim is 82% of peak rather than 100% of a
 * curve that is already heading for zero there. It is a plateau, not a lift: the
 * middle of the pool is unchanged, so the sodium stays the brightest thing on the
 * road and §4's "steer by the pools" affordance is not spent.
 */
const LAMP_POOL_RIM = 0.82

/**
 * The cyan apron's diameter, metres. A quarter of the sodium pool's 12, which is
 * the ratio of the things themselves: §12.2's portal stands in a doorway and
 * lights the ground a player walks onto, where a lamp lights a street. It is
 * still wide enough to reach under a camera standing at §5.2's hold distance,
 * which is the measurement the two portal captures are actually judged on.
 */
const PORTAL_APRON_DIAMETER = 7

// ---------------------------------------------------------------------------
// the gate — iteration 2, pass 3
//
// Seven numbers, in one block, because none of them means anything read alone:
// a disc is not a hole without a rim on its edge, and a rim is not a lip
// without a disc for the eye to measure it against.
//
// THE COMPLAINT, in the one sentence the §16.5.5 frame shows: the portal was a
// 16 cm-thick cyan hoop floating in a doorway with the lit interior of the shed
// visible straight through the middle of it. That is a *halo*. §12.2's cold
// light is supposed to be an opening, and an opening is a hole with a lit edge.
// The gate is now a near-black disc, a thin lip of cyan on that disc's edge,
// and a slow spiral turning inside the hole.
// ---------------------------------------------------------------------------

/**
 * Radius of the core disc, metres.
 *
 * BEFORE `0.78`, a literal inside the ring's `TorusGeometry` — and that was the
 * *outer* edge, so the hoop measured 1.56 m across a 1.3 m doorway. AFTER
 * `0.72`, which is still wider than the doorway on purpose: the shed's two flank
 * panels leave z in (-0.65, 0.65) open, so a 0.72 m disc is cropped at the sides
 * and the frame is the doorway's, not the disc's. The gate asserts that
 * containment, because a disc with a margin round it inside a door is a
 * porthole hung in a wall.
 */
const PORTAL_CORE_RADIUS = 0.72

/**
 * Radius of the rim's tube, metres — a lip, not a hoop.
 *
 * BEFORE `0.08`, a 16 cm band, which is 10.3% of the disc's radius. AFTER
 * `0.028`, a 5.6 cm band at 3.9%, on a disc that is the same size in the
 * frame. Thin enough that the first thing the eye reads is the hole; thick
 * enough that §4's long-range tell is still a line of cyan at 40 m rather than
 * a dot. Both halves of that sentence are the same number, which is why it is
 * pinned rather than tuned.
 */
const PORTAL_RIM_TUBE = 0.028

/**
 * Height of the gate above the lot, metres.
 *
 * BEFORE `1.35`, a literal at the ring's call site. AFTER `1.18`, a constant,
 * because the disc is now *sized to the opening* and the opening has a size:
 * the shed's doorway is 1.3 m wide and 1.9 m tall, so it spans y 0 to 1.9 about
 * 0.95. A 0.72 m disc centred at 0.95 would sit inside that with margin on
 * every side, and 1.35 left the old hoop's bottom edge 63 cm off the floor.
 * 1.18 reaches the lintel at 1.90 and lifts the bottom to 0.46 m: the disc is
 * *behind* the frame, cropped by it, which is the whole reading.
 */
const PORTAL_CORE_Y = 1.18

/**
 * How far the disc is set back from the gate's own plane, metres.
 *
 * BEFORE nothing — the ring *was* the portal and it stood in the plane of the
 * opening, which is the only place a hoop has to stand because a hoop has no
 * inside to be behind. AFTER 0.03, so the disc reads as a little way *into* the
 * doorway and the rim stands proud of it. Bounded below by the swirl layers,
 * which sit in the 0.03 in front of it.
 */
const PORTAL_CORE_INSET = 0.03

/**
 * How far in front of the disc each swirl layer sits, metres, outer layer
 * first.
 *
 * BEFORE: there were no layers; the disc did not exist to have anything in
 * front of it. AFTER [-0.008, -0.016], which is the 0.03 of
 * `PORTAL_CORE_INSET` split so the two layers are 8 mm apart and both are
 * strictly between the disc and the rim's plane. Additive blending does not
 * care which draws first, so this ordering is here for the *raycast* the gate
 * makes in `verify-world.mjs`, which stops a camera at the outermost layer.
 */
const PORTAL_SWIRL_DEPTHS = Object.freeze([-0.008, -0.016])

/**
 * The swirl layers' radii, metres, outer layer first.
 *
 * BEFORE none. AFTER [0.66, 0.40], both strictly *inside* `PORTAL_CORE_RADIUS`
 * so the swirl can never draw an edge the disc does not have. The inner one is
 * 0.6 of the outer because one spiral across the whole disc reads as a pinwheel
 * and two scales of it read as depth — and 0.40 m is exactly where the swirl
 * texture's own dark pupil has finished fading in, so the inner layer opens in
 * the middle instead of stacking a second pupil there.
 */
const PORTAL_SWIRL_RADII = Object.freeze([0.66, 0.4])

/**
 * The swirl layers' angular rates, radians per second.
 *
 * BEFORE nothing turned, ever: the cold family's only motion was the ±3.5%
 * swell on the hoop. AFTER [+0.21, -0.13] — one revolution in 30 s and 48 s,
 * against each other. Slow because the portal is not supposed to be urgent: a
 * thing that spins quickly is a machine, and §5.3's verb is a held breath, not
 * a switch. Counter-rotating because two discs turning the same way read as one
 * disc with a pattern painted on it, and the gate below asserts the two signs
 * differ for exactly that reason.
 */
const PORTAL_SWIRL_RATES = Object.freeze([0.21, -0.13])

/**
 * The swirl texture's own three numbers: the floor it holds everywhere inside
 * the fade, the amplitude of the arms on top of that floor, and how sharply
 * each arm peaks.
 *
 * These are `makeSwirlTexture`'s `floor` / `amp` / `power` arguments, and they
 * are pinned here because they are the difference between the §16.5.5 frame
 * reading as a hole and reading as a halo, which the geometry above cannot fix
 * on its own.
 *
 * BEFORE 0.25 / 0.2 / 2. That triple is why the portal still read as a halo
 * after pass 3 rebuilt it: a floor of 0.25 under an amplitude of 0.2 lays a
 * constant teal wash across the whole disc and leaves the arms `0.2 / 0.45` =
 * 44% of the signal to move in. Measured on the 8-bit alpha this function
 * actually writes, over the same 0.30-0.62 upper annulus `swirlContrast` reads
 * on the finished PNG, that texture puts p95/p05 at **2.37:1** (83 against 35)
 * and its global peak alpha at **0.400**. Run that through ACES at exposure 1.02
 * and the arms land a few luma levels apart on the PNG — which is exactly the
 * flat dark wash the frame shows, inside a correctly rebuilt rim. The hole was
 * built and the thing inside it was not.
 *
 * AFTER 0.1 / 0.62 / 3. The floor drops to roughly where the pupil already is,
 * so the disc's dark ground is the disc's own colour rather than a uniform
 * lift; the amplitude rises to 2.4x the old peak; and cubing the wave turns
 * each arm from a soft band into a filament with dark ground between it and the
 * next. Same annulus, same seed, same two rates, and the pupil's `fade` ramp is
 * untouched so the core stays near-black and the rim stays the brightest thing
 * in the doorway. Measured on that same annulus: p95/p05 **2.37:1 -> 10.08:1**
 * (131 against 13), peak alpha **0.400 -> 0.600**. The rendered form of the same
 * claim is the gate rather than this comment: `swirlContrast`'s band sd on the
 * committed `portal-located.png` went 1.9 -> 36.5.
 */
const PORTAL_SWIRL_TONE = Object.freeze({ floor: 0.1, amp: 0.62, power: 3 })

/**
 * The swirl texture's resolution, texels per side.
 *
 * BEFORE 128, which pass 3 sized for the *old* complaint and never revisited.
 * The disc is 0.72 m and fills about 400 px of the §16.5.5 frame, so a 128-texel
 * spiral is magnified roughly 3x, and every arm edge on screen is a bilinear
 * step of three screen pixels. That was survivable while the arms were soft
 * bands; it is not once they are filaments, because a filament widened by
 * three pixels of blur is a band again. AFTER 192, a 1.5x on the old one for
 * about 2.2x the texels on a texture that is built once at start-up and never
 * touched again.
 */
const PORTAL_SWIRL_SIZE = 192

/**
 * How far along its own opening axis each structure's gate stands from that
 * structure's origin, metres, in `PORTAL_STRUCTURES` order.
 *
 * BEFORE [0, 0, 0]: the ring sat at the origin of all three shells, which is the
 * *middle* of the shed — 1.25 m behind its own doorway — and inside the phone
 * box's solid 1.1 m cube, so the third portal was a hoop sealed in a metal box
 * and had never once been visible from outside. AFTER [1.25, 0, 0.62]: the
 * shed's is its doorway plane, the shelter's is the middle of its opening, and
 * the phone box's is 0.07 m proud of the cube's front face, which is the only
 * plane of that shell a disc can be seen on.
 */
const PORTAL_GATE_OFFSET = Object.freeze([1.25, 0, 0.62])

/**
 * How far each structure's gate is scaled, in the same order and for the same
 * reason as the offsets: §5.1's list is only worth having if the three read as
 * three different places.
 *
 * BEFORE 1 for all three, which was never wrong at the old radius — a 0.78 m
 * hoop inside a 1.1 m cube was simply hidden, so its size never got to matter.
 * AFTER [1, 1, 0.68], which is 0.98 m across on the phone box's 1.1 m face.
 * That is the one number here with a real constraint behind it: the disc has
 * to be *smaller* than the face it is stuck to, or the phone box stops being a
 * phone box and becomes a disc with a booth behind it.
 */
const PORTAL_GATE_SCALE = Object.freeze([1, 1, 0.68])

/**
 * The top face of a lot's yard slab, metres. `pools.yards.place` is called with
 * this as its centre and 0.1 as its height, so the surface a portal's apron has
 * to clear is `YARD_TOP` and not the road's y=0 — see the apron's own comment for
 * what happens when a decal is laid at the road's height inside a lot.
 */
const YARD_TOP = 0.1

// ---------------------------------------------------------------------------
// building depth — iteration 2, pass 5
//
// AESTHETIC-NOTES §0 is the diagnosis this block answers: "a small number of
// large, clean primitives ... and essentially nothing between them, so the eye
// reads the gaps as unfinished rather than as space." Every number below is a
// REAL one, taken from the reference's `DESIGN.md` §4 scale table, because T2's
// argument is that believability here is a discipline problem and not a
// modelling one.
//
// The block is ordered the way the eye reads a building: the storey line first
// (it is what makes a wall two storeys tall), then the window stack because it
// is the thing with depth in it, then the entrance, then the roofline, which is
// the only part of a building visible past its neighbours.
// ---------------------------------------------------------------------------

/**
 * Storey height, metres: what makes a wall two storeys instead of a tall shed.
 *
 * BEFORE nothing. `WALL_HEIGHT` (5.2) was one number with no internal division,
 * so there was no storey line anywhere on a wall and every block in
 * `street.png` read as a warehouse. AFTER `WALL_HEIGHT / 2` = 2.6 m, which is
 * the only division of 5.2 that puts a window head below the eaves and a door
 * below the belt. The reference's own 2.9 m storey is not usable at our wall
 * height, and 2.6 is close enough to it that a player cannot tell.
 */
const STOREY_HEIGHT = WALL_HEIGHT / 2

/**
 * The window, in metres: leaf width, leaf height, and the three depths its
 * parts stand at — glass flush with the wall, the frame 40 mm proud of that, and
 * the sill 60 mm proud of the frame.
 *
 * BEFORE nothing at all: the only windows in the world were the `window`
 * *fixture*, a 1.2 x 0.2 x 0.1 emissive box stuck 80 mm off the wall. A flat lit
 * rectangle on a wall reads as a sticker (T3), and a sticker that lights up
 * reads as a decal.
 *
 * AFTER a real double: 1.1 x 1.2 m, which is a window a person looks out of.
 * The three depths are the entire point of the stack, and they are cheap —
 * three boxes per window, and the *frame* is what sells it. `frame` is proud
 * enough to catch a sodium rim on its top edge, and the sill below it is proud
 * again so the light lands on a horizontal surface. At 40 m through fog, the
 * silhouette that survives is "a bright top edge over a dark hole over a
 * brighter shelf", and that is exactly the three numbers.
 */
const WINDOW = Object.freeze({ w: 1.1, h: 1.2, depth: 0.08, frame: 0.04, sill: 0.06 })

/**
 * How far in from its wall's edges a pair of windows sits, as a fraction of that
 * wall's width. There is no BEFORE: this pass is what put windows on walls at all.
 *
 * A fraction rather than a metre count because the two walls are wildly different
 * sizes — a 26 m street frontage and a 5.5 m flank — and a fixed 3 m inset puts
 * both windows of a flank wall *outside* it. 0.3 puts the pair at ±30% of the
 * wall, which is where a house's windows actually are (roughly a third in from
 * each end) and which leaves the corner clear on every wall in the world.
 */
const WINDOW_INSET = 0.3

/**
 * How far along its wall a door sits from the wall's centre, as a fraction of the
 * wall's width. No BEFORE — this pass is what put doors on walls.
 *
 * 0.22 is 5.7 m on a 26 m frontage and 1.2 m on a 5.5 m flank, and both are
 * right: on a wide house the door sits under the gap between its two front
 * windows, and on a narrow one it is off-centre enough to read as an entrance
 * rather than as a seam. It is a fraction for the same reason `WINDOW_INSET` is:
 * one number has to work for a wall that is 26 m and a wall that is 5.5 m.
 */
const ENTRANCE_OFFSET = 0.22

/**
 * The lit-window rate: one window in this many is lit, and never two on the
 * same facade.
 *
 * BEFORE `FIXTURE_DENSITY` and nothing else — lit windows were a by-product of
 * the decorative fixture pass, so a lot could get three or none and it changed
 * every loop, which means the player could watch a house's lights move.
 *
 * AFTER 6, which is one in six, chosen against the two numbers that bracket it.
 * Higher and the street is an office park; T11's inversion says we spend
 * saturated light on four things, not a dozen signs, and a street of lit windows
 * is a dozen signs. Lower and the variance is invisible at the range §16.5's
 * captures are shot from. "Never two on one facade" is a rule rather than a
 * number and is enforced in `_addFacadeDetail`.
 */
const LIT_WINDOW_ONE_IN = 6

/**
 * The entrance, in metres: the recess it is set into, the door leaf that fills
 * it, and how much wider the dark reveal is than the leaf.
 *
 * 0.15 m is the code minimum for a door reveal, and it is the difference
 * between a door and a rectangle: at 0 the door is a panel on a wall, and at
 * 0.15 there is a shadowed return on the leading edge that survives being 40 m
 * away and half in fog. The reveal is *wider* than the leaf (`1.08`) so the
 * dark returns are visible either side of it, which is what makes the recess
 * read as a hole rather than as a dark frame.
 */
const DOOR_RECESS = 0.15
const DOOR_LEAF_W = 0.95
const DOOR_LEAF_H = 2.05
const DOOR_REVEAL_SCALE = 1.08

/**
 * The two steps up to a door, in metres: riser, tread, and how much wider each
 * step is than the one above it. Real values are a 170 mm riser and a 280 mm
 * tread; the reference's `DESIGN.md` §4 makes the same point with a 0.9-1.1 m
 * handrail and a 0.44 m bench seat — nothing here is "about right".
 *
 * The oversail is why the steps read at all. Two identical slabs read as one
 * slab; two slabs that step *outward* read as a staircase in silhouette even at
 * a range where the 170 mm riser is too small to measure. 60 mm per side is a
 * real over-sail for a concrete step, and it is the only number here doing
 * visual work rather than structural work.
 */
const STEP_RISER = 0.17
const STEP_TREAD = 0.28
const STEP_OVERSAIL = 0.06
const STEP_COUNT = 2

/**
 * The canopy over a door: how deep it projects, how thick it is, and how far
 * above the door head it sits.
 *
 * T-notes item 4 calls a 400 mm canopy the thing that turns a hole into an
 * entrance, and the number is real (door hoods are 300-450 mm). It is also
 * exactly deep enough to throw its own shadow on the head of the door under a
 * lamp mounted above it — which is why the entry lamp goes *under* the canopy
 * rather than beside it, and why the canopy's depth is stated in the same block
 * as the lamp rather than in the block above.
 *
 * `CANOPY_LIFT` is 350 mm, at the top of the real range for a hood above a door
 * head, and it is the number that gives `ENTRY_LAMP_Y` anywhere to be. The two
 * constraints on a fitting under a hood are that its top clears the hood's
 * underside and that it lights the top of the door rather than the doorstep, and
 * a 120 mm lift left an 85 mm window between them — a real one, but a knife-edge
 * that a later retune of `DOOR_LEAF_H` would close. 350 mm leaves 105 mm above
 * and 210 mm below, and the gate asserts both.
 */
const CANOPY_DEPTH = 0.4
const CANOPY_THICK = 0.07
const CANOPY_LIFT = 0.35

/**
 * The entry lamp: its height on the wall, its offset from the door, and its box.
 *
 * BEFORE nothing — the only way to mark a door was to place a whole `porchLight`
 * fixture against the wall, which is a light source at 2.4 m rather than a fitting
 * on the wall, and which moved every loop.
 *
 * AFTER 2.15 m, and that number is not a taste call: it is derived from two
 * constraints that are both real. Its top must clear the canopy's underside (at
 * `DOOR_LEAF_H + CANOPY_LIFT - CANOPY_THICK / 2` = 2.365 m) and it must be above
 * the door's own head (2.05 m) or it lights the doorstep instead of the door.
 * Together those admit `1.94 < y < 2.255` — a 315 mm window — and 2.15 sits in
 * it, 210 mm above the head and 105 mm below the hood. The offset of 0.35 m to
 * the side is far enough that the fitting does not read as part of the door frame
 * and near enough that its light still falls on the leaf.
 *
 * The first version of this pass used the textbook 2.3 m bulkhead height, which
 * put the fitting's top at 2.41 m through a canopy underside at 2.21 m — the lamp
 * was sticking out through the hood it was supposed to be lighting. The second
 * used 1.98 m, which fitted under the hood but hung its top 40 mm BELOW the door
 * head, so it lit the doorstep. `verify-world.mjs` caught the first and the gate
 * below caught the second, which is the argument for asserting both halves
 * rather than the one that happened to fail.
 */
const ENTRY_LAMP_Y = 2.15
const ENTRY_LAMP_SIDE = 0.35
const ENTRY_LAMP_W = 0.16
const ENTRY_LAMP_H = 0.22
const ENTRY_LAMP_D = 0.12

/**
 * The parapet: how far it stands proud of the wall below it, how tall it is,
 * and how far the roof deck is set back behind it.
 *
 * BEFORE the pyramid. A `ConeGeometry(0.72, 1, 4)` at 1.9 m on a 5.2 m box is
 * the most toy-like object on the street, and mechanism 1 says why: the
 * reference spends its detail budget on things that change a building's
 * *outline* — eaves, parapets, gutters — and a four-sided cone is the one shape
 * whose outline is a triangle no house in this world has.
 *
 * AFTER a flat cap, and the flat cap solves a different problem from the one
 * the pyramid caused. A pyramid has a *sloping* silhouette, which under a light
 * source directly overhead catches nothing; a cap has a *horizontal* edge, and
 * 60 mm of horizontal edge 340 mm tall is enough for a sodium lamp 5 m above and
 * 20 m away to put a rim on it. Both numbers are real: parapet upstands are
 * 300-450 mm and their cills project 40-80 mm. The 0.35 m set-back is the
 * drainage edge a real flat roof has behind its upstand, and it is what stops
 * the cap reading as a lid rather than as a wall that happens to stop.
 */
const PARAPET_PROUD = 0.06
const PARAPET_HEIGHT = 0.34
const PARAPET_SETBACK = 0.35

/**
 * The parapet's bar, as a fraction of the roof's width — the annulus is built
 * from the same `makeFrameGeometry` as every other frame in this file, so the
 * only thing that differs is how thick its edge is.
 *
 * 0.02 is 180 mm on an 18 m lot, which is a real upstand thickness and is
 * chosen against the alternative: a thicker bar eats the roof deck it is standing
 * on, and a thinner one is a lip the fog eats. It is a fraction rather than a
 * metre count because the annulus is a UNIT shape, so a bar expressed in metres
 * would have to be re-derived per house and would be wrong on three lots in four.
 */
const PARAPET_BAR = 0.02

/**
 * The roof deck's own thickness, metres.
 *
 * BEFORE `ROOF_HEIGHT` (1.9 m) was the height of a four-sided cone, and the
 * constant was doing two unrelated jobs at once: how tall the roof was, and how
 * far the roof sat above the wall. AFTER the roof is flat, so those are two
 * facts — a deck is thin, and a parapet is tall — and 0.14 m is a real
 * insulated deck build-up with a screed. It matters beyond realism because the
 * two now compose: a 5.2 m wall plus a 0.14 m deck plus a 0.34 m parapet is a
 * 5.68 m silhouette, and the gate measures that total rather than trusting any
 * one of the three.
 */
const ROOF_DECK_THICK = 0.14

/**
 * The roof-top clutter: one AC condenser and one vent box, in metres.
 *
 * Mechanism 1's cheapest single item — the reference builds all three of these
 * (AC units, ridge vents, gable vents) on every house in the town, and they
 * are the only parts of a building that are visible past its neighbours. Both
 * boxes are real residential sizes: a condenser is 0.9 x 0.6 x 0.45 and a vent
 * cowl is 0.5 x 0.4 x 0.3. They sit on the *set-back* rather than on the front
 * edge because that is where they actually go, and because a box on the front
 * edge would be the one thing in the frame that reads as a hat.
 */
const AC_BOX = Object.freeze([0.9, 0.6, 0.45])
const VENT_BOX = Object.freeze([0.5, 0.4, 0.3])

/**
 * The storey belt: its height and how far it stands proud.
 *
 * BEFORE nothing. AFTER a 140 mm band at the storey line standing 50 mm proud,
 * which are the real dimensions of a belt course. Its whole job is T-notes
 * item 5 — "so a two-storey wall reads as two storeys" — and it works because
 * it is a *horizontal* line on a vertical surface, which is the one thing a box
 * with nothing on it does not have. It is also the cheapest part in this pass:
 * one instance, no texture, and it changes the read of every wall in the world.
 */
const BELT_HEIGHT = 0.14
const BELT_PROUD = 0.05

/**
 * The per-lot instanced part budget, and the ceiling `verify.mjs` measures the
 * worst lot against.
 *
 * This is T5, and the multiplier is the reason it exists: 49 chunks x 4 lots x
 * 3 wrapped copies = 588 lot instances, so a per-lot part is paid three times
 * before anyone sees it and the total is fixed at build time rather than at
 * runtime. 40 is T5's proposed ceiling. A maximal house here places **31** parts
 * and the mean across all 588 lots is **13.2** (measured: 31 / 13.19 / 3 for
 * max / mean / min, from `partBudget()`), so passes 6-12 have room to add street
 * furniture without anyone re-deriving the cost of the buildings it stands
 * against — nine parts per lot, which is about a pole, a sign and a hydrant.
 *
 * The gate measures the WORST lot rather than the mean, for the reason T5 gives:
 * the mean hides the block whose four façades all face a street, and that is the
 * one a player walks past most. It also measures the SPREAD, because a max equal
 * to the mean would mean nothing varies and the budget would be measuring noise.
 */
const LOT_PART_BUDGET = 40


// ---------------------------------------------------------------------------
// procedural textures — canvas, no downloads, and no path drawing
// ---------------------------------------------------------------------------

/**
 * Every texture here is written pixel-by-pixel through `createImageData` /
 * `putImageData` rather than through paths.
 *
 * That is not a style preference. `verify-world.mjs` stubs the 2D canvas context
 * with exactly five members — `createImageData`, `putImageData`, `fillRect`,
 * `globalAlpha`, `fillStyle` — and v1's six procedural textures rotted against
 * that stub silently because nothing ran the harness (GAMEDESIGN §15.3). Writing
 * v2's textures inside the stub's surface means this file can be constructed by the
 * existing harness unchanged, which is how slice 09 smoke-tested the swap without
 * touching the harness slice 14 owns.
 */

/** Deterministic value noise, so a texture is a function of its seed alone. */
function noiseField(seed) {
  let a = seed >>> 0
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  // a coarse lattice, bilinearly interpolated: cheap, smooth, and tileable enough
  // at the repeat counts below that the seam is not readable through fog
  const cells = 8
  const grid = []
  for (let y = 0; y <= cells; y += 1) {
    const row = []
    for (let x = 0; x <= cells; x += 1) row.push(rand())
    grid.push(row)
  }
  const smooth = (t) => t * t * (3 - 2 * t)
  return (u, v) => {
    const gx = u * cells
    const gy = v * cells
    const x0 = Math.floor(gx) % cells
    const y0 = Math.floor(gy) % cells
    const x1 = (x0 + 1) % cells
    const y1 = (y0 + 1) % cells
    const tx = smooth(gx - Math.floor(gx))
    const ty = smooth(gy - Math.floor(gy))
    const top = grid[y0][x0] * (1 - tx) + grid[y0][x1] * tx
    const bottom = grid[y1][x0] * (1 - tx) + grid[y1][x1] * tx
    return top * (1 - ty) + bottom * ty
  }
}

/**
 * A greyscale multiply texture: `base` scaled by noise, with a per-pixel dither.
 * Shared by every surface below, and the only texture primitive in the file.
 */
function makeSurfaceTexture({ size = 128, seed = 1, base = 0.5, contrast = 0.3, grain = 0.06, repeat = 1, stripes = 0 }) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const noise = noiseField(seed)
  const image = ctx.createImageData(size, size)
  const data = image.data
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size
      const v = y / size
      let tone = base + (noise(u, v) - 0.5) * contrast
      if (stripes > 0) {
        // siding boards: a hard period in u, so the wall reads as boards
        const board = Math.abs(((u * stripes) % 1) - 0.5) * 2
        tone *= 0.86 + 0.14 * board
      }
      const dither = (noise(u * 3.1, v * 3.7) - 0.5) * grain
      const value = Math.max(0, Math.min(255, Math.round((tone + dither) * 255)))
      const i = (y * size + x) * 4
      data[i] = value
      data[i + 1] = value
      data[i + 2] = value
      data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(repeat, repeat)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * The four surface seeds, in one place, because a texture whose seed is typed at
 * its call site is a texture two people will change differently. Asphalt is dark
 * and high-contrast so the sodium pools have something to sit on; the walk is
 * lighter and calmer so the road reads as the darker of the two; siding carries
 * board lines; the hedge is the noisiest of the four, which is the cheapest way to
 * make a box read as foliage at 40 m.
 */
/**
 * The sodium pool's own texture: a radial falloff, written as alpha rather than
 * as colour, so one texture serves every pool at every brightness the flicker
 * puts it at.
 *
 * Drawn per-pixel through `createImageData`/`putImageData` for the reason every
 * other texture in this file is: `verify-world.mjs` stubs the 2D context with
 * exactly these members, and a texture written with a gradient primitive would be
 * a texture the gate cannot construct. The falloff is `(1 - r²)²` because a
 * linear ramp reads as a painted disc with a hard edge, and a sodium lamp on wet
 * asphalt has neither — it is bright under the head and gone well before the
 * kerb.
 *
 * `rim` is iteration 2, pass 2. BEFORE the curve was `(1 - r²)²` alone, so it
 * decayed all the way to zero at the edge of the disc. AFTER, with `rim` > 0 the
 * curve is `rim + (1 - rim) * (1 - r²)²`: the same shape with a floor under it,
 * i.e. the pool has a *rim* rather than an edge.
 *
 * The reason is the same one that made the pool 1.5x wider. A 12 m disc and an
 * 18 m disc made from the same texture are not the same picture scaled up — the
 * outer third of the new one covers 2.25x the area for the same pixel energy, so
 * the part of the pool the eye actually reads the *shape* of (the rim, where the
 * falloff is steep) goes dim, and a broad pool with a dim rim is a smudge. The
 * floor puts that energy back. The default is 0, so `portalPool` — which the same
 * function builds and which is a doorway, not a streetlight — is byte-for-byte
 * unchanged by this pass.
 */
function makePoolTexture({ size = 128, peak = 1, rim = 0 } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(size, size)
  const data = image.data
  const half = (size - 1) / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - half) / half
      const dy = (y - half) / half
      const r2 = dx * dx + dy * dy
      const fall = r2 >= 1 ? 0 : (rim + (1 - rim) * (1 - r2) * (1 - r2)) * peak
      const value = Math.round(fall * 255)
      const i = (y * size + x) * 4
      // white in RGB and the falloff in alpha, so the material's own colour is the
      // sodium hue and the pool flickers with the lamp head it belongs to
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = value
    }
  }
  ctx.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * The swirl inside a portal's core (iteration 2, pass 3), written as alpha.
 *
 * BEFORE: there was no such thing — the opening held a hoop and no interior,
 * and a swirl is only legible against something darker than itself. AFTER: the
 * pattern `update()` turns, on two layers, at two rates.
 *
 * The pattern is a *wound* phase, `arms * atan2(dy, dx) + twist * 2π r`, and not
 * a pinwheel. That is the whole reason rotating the mesh reads as the pattern
 * turning rather than as the picture spinning: a radial arm pattern is invariant
 * under rotation in the way a spiral is not, so a pinwheel of arms would sit
 * still on a spinning disc and only its texture would be legible as moving.
 *
 * `arms` is an integer on purpose, and it is the one thing a polar texture gets
 * wrong by default: `atan2` jumps from +π to -π along the -x axis, and a phase
 * built on it has a seam there unless the winding term is a whole number of
 * turns, which an integer `arms` makes it.
 *
 * White in RGB and the pattern in alpha, for the reason `makePoolTexture` gives
 * at length: the material's own colour is the cyan, so the swirl and the rim are
 * demonstrably one light family, and the alpha is what the mesh rotates. The
 * peak is 0.45 rather than 1.0 because this is additive over a near-black disc
 * and the rim is already at full cyan — the swirl has to be *under* the edge or
 * the hole stops being the first thing the eye reads.
 */
function makeSwirlTexture({
  size = PORTAL_SWIRL_SIZE,
  seed = 1,
  arms = 3,
  twist = 5,
  floor = PORTAL_SWIRL_TONE.floor,
  amp = PORTAL_SWIRL_TONE.amp,
  power = PORTAL_SWIRL_TONE.power,
} = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(size, size)
  const data = image.data
  const noise = noiseField(seed)
  const half = (size - 1) / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - half) / half
      const dy = (y - half) / half
      const r = Math.hypot(dx, dy)
      let tone = 0
      if (r < 1) {
        const wave = 0.5 + 0.5 * Math.sin(arms * Math.atan2(dy, dx) + twist * Math.PI * 2 * r)
        // a dark pupil in the middle and nothing at the rim: the swirl has to
        // fade out into the same near-black the disc behind it is painted, or it
        // draws an edge of its own and gives the hole away as a decal
        // `power` is the shape, and it is the one that made this a halo. BEFORE a
        // bare `wave * wave`, with `0.25 +` a constant in front of it: a floor
        // under an amplitude is a wash, and a wash with a ripple in it is still a
        // wash. The floor is now `PORTAL_SWIRL_TONE.floor` — low enough that the
        // ground between arms is the disc's own near-black — and the arm is
        // `wave ** power` at 3, which is a filament and not a band. The comment
        // on `PORTAL_SWIRL_TONE` carries the measured 2.37:1 -> 10.08:1.
        const arm = wave ** power
        const fade = Math.min(1, Math.max(0, (r - 0.16) / 0.24)) * (1 - r * r)
        // the same per-pixel dither `makeSurfaceTexture` uses, for the same
        // reason: a smooth spiral across a 40-segment disc bands, and a hole in
        // the world is the last place in this game that should band. Halved from
        // 0.18 to 0.09 for the reason the arms were cubed — at 3x the contrast
        // the dither is no longer hiding the banding, it is competing with the
        // arms, and an arm you cannot tell from its own noise is not a filament.
        const grain = (noise(x / size, y / size) - 0.5) * 0.09
        tone = Math.max(0, fade * (floor + amp * arm) + grain * fade)
      }
      const i = (y * size + x) * 4
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = Math.round(Math.min(1, tone) * 255)
    }
  }
  ctx.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}


export const SURFACE_SEEDS = Object.freeze({
  asphalt: 0x515f,
  sidewalk: 0x51de,
  siding: 0x51d1,
  hedge: 0x4ed9,
  // BEFORE four seeds, one per surface, all of them lit by the sodium family.
  // AFTER a fifth, which is the only cold texture in the game: the swirl inside
  // a portal's core. It gets a seed of its own for the reason the other four
  // have one — a texture whose seed is typed at its call site is a texture two
  // people will change differently — and it is the one seed a player can see
  // rotating, so it must not be a function of any surface's.
  swirl: 0x5197,
})

// ---------------------------------------------------------------------------
// instancing
// ---------------------------------------------------------------------------

/**
 * One `InstancedMesh` over a unit primitive, written in canonical coordinates and
 * flushed on `commit()`.
 *
 * `frustumCulled` is off deliberately. With three wrapped copies the geometry
 * spans 1,344 m and the camera is essentially always inside it, so per-frame
 * culling work buys nothing, and a stale instance bounding sphere after a fixture
 * rebuild would be a real (if invisible) failure mode.
 */
class InstancePool {
  constructor(geometry, material, capacity, name) {
    this.capacity = capacity
    this.used = 0
    this.overflow = 0
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity)
    this.mesh.name = name
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this._matrix = new THREE.Matrix4()
    this._position = new THREE.Vector3()
    this._quaternion = new THREE.Quaternion()
    this._scale = new THREE.Vector3()
    this._euler = new THREE.Euler()
  }

  /**
   * Place one instance, optionally with its own colour. An over-capacity write is
   * counted rather than thrown: a fixture kind that outgrows its pool is a
   * capacity bug, and dropping the geometry silently would turn it into a hole
   * in the world instead.
   *
   * @param {number|null} [color] per-instance colour, which is what replaced the
   * per-lot `mesh.material` reassignment — see the note inside.
   */
  place(x, y, z, w, h, d, yaw = 0, color = null) {
    if (this.used >= this.capacity) {
      this.overflow += 1
      return false
    }
    this._position.set(x, y, z)
    this._euler.set(0, yaw, 0)
    this._quaternion.setFromEuler(this._euler)
    this._scale.set(w, h, d)
    this._matrix.compose(this._position, this._quaternion, this._scale)
    this.mesh.setMatrixAt(this.used, this._matrix)
    if (color !== null) {
      // AESTHETIC-NOTES T1. The whole reason this parameter exists: an
      // `InstancedMesh` has ONE material slot, so the pre-pass-5 code that did
      // `pool.mesh.material = this._materials.siding[tint]` inside the per-lot
      // loop was reassigning the same slot 588 times and every house in the
      // world came out the colour of whichever lot happened to be built last.
      // `setColorAt` is the same idea the reference uses with a vertex attribute
      // (`houses/tex.js` line 1: "one material serves every wall colour"), moved
      // from a per-vertex attribute to a per-instance one, and it costs one
      // `Float32Array` of three floats per instance.
      this.mesh.setColorAt(this.used, color)
    }
    this.used += 1
    return true
  }

  clear() {
    this.used = 0
    this.overflow = 0
  }

  commit() {
    this.mesh.count = this.used
    this.mesh.instanceMatrix.needsUpdate = true
    // and the colour buffer, which is a *separate* attribute from the matrix and
    // is not flagged by anything three.js does on our behalf. A pool that sets
    // instance colours and forgets this renders every instance at the colour the
    // first one asked for, which is precisely the bug this pass closed, moved
    // from the material slot to the attribute.
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  dispose() {
    // geometry only: the materials are shared and owned by `_materials`, and
    // disposing them here would tear them out from under every other pool
    this.mesh.geometry.dispose()
  }
}

/**
 * Every fixture kind gets its own pool, and this is how a kind becomes a shape:
 * the pure module decides *what* and *where*, this table decides how tall it is
 * and how high off the ground it sits. Heights are art, not rules — §3.6's four
 * constraints are all about footprint, which comes from `neighborhood.js`.
 */
const FIXTURE_SHAPES = Object.freeze({
  hedge: { h: 1.3, lift: 0 },
  car: { h: 1.45, lift: 0.1 },
  bin: { h: 1.0, lift: 0 },
  fence: { h: 1.1, lift: 0 },
  shed: { h: 2.2, lift: 0 },
  window: { h: 1.2, lift: 1.5 },
  porchLight: { h: 0.5, lift: 2.4 },
  stake: { h: 0.7, lift: 0 },
  cone: { h: 0.6, lift: 0 },
})

/** The four frontages, as the yaw whose local -Z faces the street. */
const FRONT_YAW = Object.freeze({ N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 })

/**
 * lotFrame — the geometry of one lot, in the two frames this file keeps mixing.
 *
 * `short` is the depth from the street frontage to the back of the lot (always
 * `LOT_DEPTH`, 10 m) and `long` is how far it runs along the street (26 m). Lots
 * on the N and S sides are wide and shallow, lots on the E and W sides are narrow
 * and deep, and every box placed on a lot has to know which way round it is —
 * which is the entire reason this helper exists rather than four cases inline.
 */
function lotFrame(lot) {
  const alongX = lot.w >= lot.d
  const half = (alongX ? lot.d : lot.w) / 2
  const outwardZ = lot.side === 'N' ? -1 : lot.side === 'S' ? 1 : 0
  const outwardX = lot.side === 'W' ? -1 : lot.side === 'E' ? 1 : 0
  const front = alongX ? lot.z + outwardZ * half : lot.x + outwardX * half
  const back = alongX ? lot.z - outwardZ * half : lot.x - outwardX * half
  return { alongX, front, back, short: half * 2, long: alongX ? lot.w : lot.d, yaw: FRONT_YAW[lot.side] }
}

/** A coordinate `offset` metres in from the front face, `depth` deep. */
function atDepth(frame, offset, depth) {
  const sign = frame.back >= frame.front ? 1 : -1
  return frame.front + sign * (offset + depth / 2)
}

/**
 * `facadeFrame` — T6: a sub-frame for one wall, so all façade placement is 2D.
 *
 * The claim T6 makes is that placement should be written as `(u, y, proud)` in the
 * wall's own coordinates and the world transform handled in one place, because
 * otherwise "a window on the north face" and "a window on the east face" are two
 * separate cases and two chances to be wrong. `lotFrame` already answers "which
 * way round is this lot"; this is the type that answers "which way does *this
 * wall* point", and `onFacade` is the only thing in the file that acts on it.
 *
 * Five fields, and every one of them is something a wall-mounted part needs:
 *
 *   - `face`:  the world axis the wall FACES — `'z'` for a north- or south-facing
 *              wall, `'x'` for an east- or west-facing one. Every part on this
 *              wall is *thinnest* on this axis, which is what lets the depth
 *              stack (pane, frame, sill) be one signed number per part.
 *   - `sign`:  the outward normal on that axis, `+1` or `-1`.
 *   - `plane`: the world coordinate of the wall's face.
 *   - `along`: the world coordinate of the wall's midpoint on the OTHER axis.
 *   - `size`:  the wall's width, so a façade can be inset from its own edges.
 *
 * There is deliberately no trigonometry here. `houseFaces` below is where "which
 * wall faces the street" is decided, once, and it is the only place that has to
 * know whether a lot is long in x or in z.
 *
 * @param {'x'|'z'} face the axis the wall faces
 * @param {number} sign the outward normal on that axis
 * @param {number} plane the wall's face, on that axis
 * @param {number} along the wall's midpoint, on the other axis
 * @param {number} size the wall's width
 */
function facadeFrame(face, sign, plane, along, size) {
  return { face, sign, plane, along, size }
}

/**
 * `onFacade` — place one box against a wall, in the wall's own coordinates.
 *
 * `u` runs along the wall from its midpoint, `y` is height above the lot, and
 * `proud` is signed: positive stands the box OUT of the wall and negative sets it
 * INTO it. `w` is always measured *along* the wall and `d` always *through* it, so
 * a caller never has to know which world axis the wall faces — that swap is the
 * one piece of trigonometry this function exists to do once.
 *
 * @param {InstancePool} pool
 * @param {object} wall from `facadeFrame`
 * @param {number} u metres along the wall from its midpoint
 * @param {number} y height above the lot
 * @param {number} proud metres out of (or into) the wall; `d` is centred on it
 * @param {number} w extent along the wall
 * @param {number} h height
 * @param {number} d extent through the wall
 * @param {THREE.Color|null} [color] per-instance colour, for tinted parts
 */
function onFacade(pool, wall, u, y, proud, w, h, d, color = null) {
  if (wall.face === 'z') {
    pool.place(wall.along + u, y, wall.plane + wall.sign * proud, w, h, d, 0, color)
  } else {
    pool.place(wall.plane + wall.sign * proud, y, wall.along + u, d, h, w, 0, color)
  }
}

/**
 * `makeFrameGeometry` — one rectangular annulus, unit-sized, centred, 1 m deep.
 *
 * This is the window and door *frame* as a single piece of geometry rather than
 * four bars. T3's stack is "interior quad, glass, frame, sill" and the reference
 * spends nine parts on a window; four bars for the surround is 4 instances per
 * window, and 588 lot instances x 4 windows x 4 bars is 9,400 instances spent on
 * four rectangles. An extruded rectangle with a rectangular hole is ONE
 * instance and the same silhouette, which is the whole of T3's advice about
 * parts ("ours should be four parts, not nine") taken further than it goes.
 *
 * The hole is what makes the frame read at all: a box with a box on it is a
 * sticker with a border, and a box with a HOLE in it has an inside face, and the
 * inside face is the shadowed reveal that says "this is an opening". The bar is
 * 60 mm because a real window frame is 50-70 mm and because the frame's inner
 * return is what a 40 mm proud frame shows you at a grazing angle.
 */
function makeFrameGeometry(bar = 0.06) {
  const outer = new THREE.Shape()
  outer.moveTo(-0.5, -0.5)
  outer.lineTo(0.5, -0.5)
  outer.lineTo(0.5, 0.5)
  outer.lineTo(-0.5, 0.5)
  outer.closePath()
  const inner = 0.5 - bar
  const hole = new THREE.Path()
  hole.moveTo(-inner, -inner)
  hole.lineTo(inner, -inner)
  hole.lineTo(inner, inner)
  hole.lineTo(-inner, inner)
  hole.closePath()
  outer.holes.push(hole)
  // `curveSegments: 1` because every edge here is straight, and `bevelEnabled:
  // false` because a 2 mm bevel on a 60 mm bar is one texel of a 1.1 m window at
  // any distance the player can see it from. 96 vertices is 32 triangles; the
  // four-bar version it replaces was 48 and needed four instances to draw.
  const geometry = new THREE.ExtrudeGeometry(outer, { depth: 1, bevelEnabled: false, curveSegments: 1 })
  geometry.translate(0, 0, -0.5)
  return geometry
}

/**
 * `houseFaces` — the three walls of a house that carry anything, as sub-frames.
 *
 * This is the function T6 asks for and the only place in the file that has to
 * know which way round a lot is. Everything downstream — windows, door, canopy,
 * entry lamp — is written as `(u, y, proud)` against one of these and never
 * mentions x or z again.
 *
 * It returns the street wall FIRST and the two flanks after, and the order
 * matters twice over: the door goes on the street wall because a door is what a
 * street is for, and the RNG stream below is consumed in this order so the lit
 * windows do not move when somebody reorders a loop.
 *
 * The street wall's plane is the HOUSE's front face, which is `w / 2` (or `d / 2`)
 * nearer the street than the house's centre — not the lot's frontage line. That
 * distinction is the bug this pass found: a house sits 55% of a 10 m lot's depth
 * from the frontage, so anything placed against the *lot* is 4.5 m out in the
 * yard, in mid-air, which is precisely what the pre-pass-5 `window` fixture did.
 *
 * @param {object} frame `lotFrame`'s output
 * @param {number} cx house centre, world x
 * @param {number} cz house centre, world z
 * @param {number} w house width, world x
 * @param {number} d house depth, world z
 * @returns {{street: object, flanks: object[]}}
 */
function houseFaces(frame, cx, cz, w, d) {
  // `atDepth` walks from the lot's FRONT toward its back, so this is the sign that
  // direction has, and the street is at the far end of it: the outward normal is
  // its negation. Written out rather than reused from `atDepth` because a reader
  // who gets this sign backwards puts every window in the neighbouring garden.
  const inward = frame.back >= frame.front ? 1 : -1
  const out = -inward
  if (frame.alongX) {
    // N and S lots: the house is wide in x and shallow in z, so the street wall
    // faces z at `cz - inward * d / 2` and runs along x for `w` metres.
    return {
      street: facadeFrame('z', out, cz - inward * (d / 2), cx, w),
      flanks: [
        facadeFrame('x', 1, cx + w / 2, cz, d),
        facadeFrame('x', -1, cx - w / 2, cz, d),
      ],
    }
  }
  // E and W lots: the transpose of the above.
  return {
    street: facadeFrame('x', out, cx - inward * (w / 2), cz, d),
    flanks: [
      facadeFrame('z', 1, cz + d / 2, cx, w),
      facadeFrame('z', -1, cz - d / 2, cx, w),
    ],
  }
}

/**
 * The canonical draw window, in metres: the western edge of block 0 to the
 * eastern edge of block `GRID - 1`, which is exactly one period wide.
 *
 * It is NOT `[-WORLD_EXTENT / 2, +WORLD_EXTENT / 2]`. The fold window and the
 * draw window are 192 m out of step with each other, because the block grid runs
 * from the first road axis to one block past the last one. Snapping the world to
 * `round(x / WORLD_EXTENT) * WORLD_EXTENT` therefore leaves a 192 m band along the
 * western edge in which the player is standing in the one part of the tile that
 * draws no blocks at all — a strip of bare asphalt with the neighbourhood 192 m
 * behind them. Deriving the window from the module's own numbers is the fix, and
 * `verify.mjs` asserts the player's folded position is inside it in all four
 * directions.
 *
 * Slice 15 moved the window itself: it is `neighborhood.js`'s `CANONICAL_ORIGIN`
 * and `originFor` now, because the balance simulation needed the same fold in a
 * pure module and two definitions of "which copy is the player in" is two chances
 * to be 192 m out. This file's `recentre` and `worldOf` are the view layer's half of
 * the contract and nothing else defines it.
 */

/**
 * StreetView — everything you can see that is not the creature.
 *
 * @param {THREE.Scene} scene
 * @param {object} [options]
 * @param {number} [options.seed] the run seed; fixes the world for the run
 * @param {object} [options.objectives] from `placeObjectives`
 * @param {number} [options.loop] starting capture counter, for the fixture pass
 * @param {number} [options.portalRange] metres at which a portal is in reach
 * @param {number} [options.pickupRange] metres at which the hammer is in reach
 */
export class StreetView {
  constructor(scene, options = {}) {
    this.scene = scene
    this.seed = options.seed ?? 1337
    this.objectives = options.objectives ?? placeObjectives(this.seed, options.loop ?? 1)
    this.loop = options.loop ?? 1
    this.portalRange = options.portalRange ?? 2.6
    this.pickupRange = options.pickupRange ?? 1.5
    this.reserved = reservedLots(this.objectives)
    // §3.6's `reserved` covers the spawn clearance as well as the anchors, and the
    // two want different treatment here: a fixture-free lot may still have a house
    // on it, but a house on an anchor's lot would bury the objective. So the
    // anchor lots are tracked separately rather than inferred from `reserved`.
    this.anchorLots = new Set(this.objectives.all.map((anchor) => `${anchor.chunk.cx},${anchor.chunk.cz},${anchor.lot.side}`))

    // the whole neighbourhood hangs off one group so the wrap is a single
    // `position.set` on a multiple of WORLD_EXTENT
    this.group = new THREE.Group()
    this.group.name = 'street'
    this.scene.add(this.group)
    /** Which wrapped copy the world is currently drawn around, in world metres. */
    this.origin = { x: 0, z: 0 }

    // one canonical set of solids and one canonical set of sight blockers, both
    // in the folded copy; `recentre` and `applyLoop` mark them for recomposition
    // rather than translating anything in place
    this.staticColliders = []
    this.staticOccluders = []
    this.fixtureColliders = []
    this.fixtureOccluders = []
    this.colliderList = []
    this.occluderList = []
    this.fixtures = []
    /** Bumped whenever the collider set changes, so the world can skip a rebuild. */
    this.revision = 0
    this._dirty = true
    this.lampPositions = []
    this.pools = []
    this.textures = []
    // One entry per lot per wrapped copy, appended by `_addLot`. This is T5's
    // instrument: the pass measures what it spends rather than estimating it, and
    // `partBudget()` reads it. It is per-COPY rather than per-lot because the
    // copies are what the world actually pays for, and 588 entries is 4.7 kB.
    this.lotParts = []
    this._time = 0

    this._materials = this._buildMaterials()
    this._buildRoad()
    this._buildChunkGeometry()
    this._buildFixturePools()
    this._buildPortals()
    this._buildHammer()
    this._buildExitCar()
    this.applyLoop(this.loop)
    this.recentre(0, 0)
  }

  // -------------------------------------------------------------------------
  // materials
  // -------------------------------------------------------------------------

  _texture(options) {
    const texture = makeSurfaceTexture(options)
    this.textures.push(texture)
    return texture
  }

  _material(options) {
    return new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0, ...options })
  }

  _glow(color, options = {}) {
    // unlit on purpose: a portal's rim and a sodium lamp head are light sources,
    // not surfaces, and tone-mapping them as if they were lit would dim exactly
    // the two things §4 promises stay visible at distance
    return new THREE.MeshBasicMaterial({ color, fog: false, ...options })
  }

  _buildMaterials() {
    const asphalt = this._texture({ seed: SURFACE_SEEDS.asphalt, base: 0.52, contrast: 0.34, grain: 0.1, repeat: 180 })
    const sidewalk = this._texture({ seed: SURFACE_SEEDS.sidewalk, base: 0.58, contrast: 0.16, grain: 0.05, repeat: 96 })
    // ITERATION 2, PASS 5 — the map is now actually NEUTRAL.
    //
    // BEFORE `base: 0.6`. That reads like a neutral greyscale board texture and
    // is not one: the canvas is tagged `SRGBColorSpace`, so 0.6 is 0.318 in
    // *linear*, and a map is a multiplier. The wall was therefore being drawn at
    // `tint x 0.318`, and since the tints are deliberately 3-6% linear (§12.1's
    // silhouette rule), the largest surface in the frame resolved to about 1.3%
    // albedo — black velvet, below anything the dusk curve can lift. Measured on
    // `street.png` before this change, the façade band was a median luma of 16
    // with the SIDING at ~1, which is why every window frame, sill, door and
    // parapet added this pass was invisible: the joinery had a black wall to read
    // against. The comment above this material claims the map is neutral and the
    // four `PALETTE.siding` tints do the colouring; BEFORE this they were
    // multiplied together instead, and the tints were doing roughly a third of
    // the work they were written to do.
    //
    // AFTER `base: 1.0` with the contrast and grain scaled down to match. The
    // board lines survive entirely in `stripes` (0.86-1.0) and the dither, so the
    // texture still reads as siding at 40 m — it is just no longer darkening the
    // tint underneath it. `contrast` had to come down with the base because a 0.18
    // spread around a base of 1.0 clips the top third of every board flat, which
    // would throw away exactly the highlight the pass is trying to create.
    const siding = this._texture({ seed: SURFACE_SEEDS.siding, base: 1.0, contrast: 0.05, grain: 0.035, stripes: 8 })
    const hedge = this._texture({ size: 64, seed: SURFACE_SEEDS.hedge, base: 0.46, contrast: 0.44, grain: 0.16 })
    // The swirl, built here and pushed onto `this.textures` rather than at the
    // gate's call site: the other five textures in this file go through
    // `_texture`, which registers them, and a sixth that quietly did not would
    // survive `dispose()` and leak a canvas per mount. §15's teardown check
    // counts `this.textures`, so an unregistered texture is a failed teardown
    // waiting for a hot reload to notice.
    const swirl = makeSwirlTexture({ seed: SURFACE_SEEDS.swirl })
    this.textures.push(swirl)
    return {
      asphalt: this._material({ color: PALETTE.asphalt, map: asphalt }),
      sidewalk: this._material({ color: PALETTE.sidewalk, map: sidewalk }),
      kerb: this._material({ color: PALETTE.kerb }),
      yard: this._material({ color: PALETTE.yard }),
      // ITERATION 2, PASS 5 — ONE siding material, four instance colours.
      //
      // BEFORE an array of two, and `_addLot` picked one per lot by writing
      // `this.pools.houses.mesh.material`. That never worked: an `InstancedMesh`
      // has a single material slot, so the write applied to the *pool*, not to
      // the instance, and the last lot in build order decided the colour of all
      // 588 houses. AESTHETIC-NOTES §4 found it and pass 5 is the pass that
      // fixes it.
      //
      // AFTER one material, white, and the four `PALETTE.siding` tints carried in
      // `instanceColor`. The map is still the neutral greyscale board texture, so
      // instance colour multiplies it exactly the way the reference's vertex
      // colours multiply its neutral atlas ("all textures are neutral/light so
      // vertex colours tint them", `houses/tex.js` line 1). `vertexColors` is
      // deliberately NOT set: three.js enables the instancing colour path from
      // `instanceColor` being non-null, and setting `vertexColors` as well would
      // make the shader look for a per-vertex attribute that is not there.
      siding: this._material({ color: 0xffffff, map: siding }),
      // The same treatment for outbuildings, for the same reason and with the same
      // consequence: a garage lot and a house lot on the same frontage were
      // previously the same colour as whichever lot came last.
      outbuilding: this._material({ color: 0xffffff, map: siding }),
      roof: this._material({ color: PALETTE.roof }),
      hedge: this._material({ color: PALETTE.hedge, map: hedge }),
      fence: this._material({ color: PALETTE.fence }),
      metal: this._material({ color: 0x33303a, roughness: 0.6, metalness: 0.35 }),
      car: this._material({ color: PALETTE.carBody, roughness: 0.5, metalness: 0.25 }),
      glass: this._material({ color: 0x1b2026, roughness: 0.25, metalness: 0.5 }),
      shed: this._material({ color: 0x2d2a26 }),
      sodium: this._glow(PALETTE.sodium),
      // The pool the lamp throws on the road. Additive, unlit and depth-writing
      // nothing, because it is a light rather than a surface: the four point
      // lights `world.js` owns cannot cover a 49-lamp grid, so without this the
      // sodium family exists as 49 glowing heads over 49 pools of pure black
      // asphalt, and §12.1's "the streetlights have already come on" is a claim
      // the renderer never makes. `fog: true` here and `fog: false` on the head
      // above it is deliberate and is the whole depth cue: the pool fades with
      // distance, the lamp does not.
      //
      // `LAMP_POOL_RIM` is iteration 2, pass 2, and it is the difference between
      // a pool and a disc: see the constant for why a 1.5x-wider pool built from
      // the same falloff texture loses its rim.
      sodiumPool: this._glow(PALETTE.sodium, {
        map: makePoolTexture({ rim: LAMP_POOL_RIM }),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: true,
      }),
      portal: this._glow(PALETTE.portal),
      // §12.2's cold family, given the ground the sodium family already gets.
      // The comment on `sodiumPool` below is the whole argument: a light source
      // with nothing underneath it is a glowing hoop over black tarmac. The
      // sodium lamps had 49 pools and four point lights between them, and the
      // comment explains that the pools are what make "the streetlights have
      // already come on" true rather than merely asserted. A portal had the ring,
      // a 9-intensity point light and no pool at all, which is the same failure
      // in its worst form — the one cold light in the game, reading as a decal on
      // a dark shed. Same additive plane and same falloff texture, cyan instead
      // of sodium, and a quarter of the diameter: a doorway is not a streetlight.
      //
      // It is still the *apron*, and not any part of the gate, that answers this
      // comment. The disc is a hole and a hole throws no light on the ground: the
      // gate is the first piece of portal geometry that is deliberately
      // unlit-looking, and pass 3 did not touch the apron because the apron was
      // never the thing that was wrong.
      //
      // `makePoolTexture()` here takes no `rim`, and that omission is the point:
      // pass 2 gave the *sodium* pool a rim and deliberately left the portal's at
      // the default 0. A doorway has hard edges — it is a hole in a shed wall —
      // and a rimmed disc would read as a glowing puddle around a doorway.
      portalPool: this._glow(PALETTE.portal, {
        map: makePoolTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: true,
      }),
      portalDead: this._glow(PALETTE.portalDead),
      // The core disc, live and shut (iteration 2, pass 3). Two materials and
      // not one, for the same reason `portal`/`portalDead` are two: §5.3 shuts
      // portals one at a time and permanently, so "the disc" is not a state
      // anyone can read off a single shared material. Opaque, unlit and
      // unfogged — it is a hole, and a hole must not fade to the fog colour at
      // 40 m or the portal would be the one object in the frame that gets
      // *lighter* with distance.
      portalCore: this._glow(PALETTE.portalCore),
      portalCoreDead: this._glow(PALETTE.portalCoreDead),
      // The swirl. One material for all six layers, because the layers are never
      // shut individually — a shut portal hides its layers and the live ones all
      // turn the same way at the same rate — and additive with `depthWrite: false`
      // because two overlapping spiral layers have to *sum*, not paint over one
      // another, which is the whole reason there are two.
      swirl: this._glow(PALETTE.portal, {
        map: swirl,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      headlight: this._glow(PALETTE.headlight),
      // The lit window, from the emissive ladder. Unlit like every other rung
      // (`_glow` sets `fog: false`), because §4 promises the player can see a
      // lit window from 60 m down an avenue and fogged emissive does not survive
      // 60 m. The *frames* around it are not unfogged, which is the ladder
      // working: the light survives distance, the joinery does not.
      windowLit: this._glow(PALETTE.windowLit),
      // The dim unlit pane behind a dark window. `_glow` would be wrong — this is
      // a surface, not a source — so it is a standard material at a colour a
      // little above black, and it is what a window with nothing behind it looks
      // like: not a hole in the world, because a house has a wall behind the
      // glass, but a dark rectangle that catches the sodium's reflection.
      windowDark: this._material({ color: 0x0e0f14, roughness: 0.22, metalness: 0.6 }),
      // The joinery: frames, sills, the belt course and the parapet. A separate
      // material from `siding` because joinery is painted a different colour from
      // siding in every house on earth, and because the *sill* is the one
      // horizontal surface in the whole frame that faces the sky, so it needs a
      // lower roughness to hold the sodium's reflection where the wall cannot.
      trim: this._material({ color: 0x4a4750, roughness: 0.8, metalness: 0.05 }),
      // The entrance: a recessed reveal (near-black, so it reads as a hole), a
      // painted leaf, and concrete steps.
      doorReveal: this._material({ color: 0x0b0c10, roughness: 0.95 }),
      doorLeaf: this._material({ color: 0x2c2a33, roughness: 0.7 }),
      step: this._material({ color: 0x33303a, roughness: 0.92 }),
      // T11's lowest rung. It is `_glow` and therefore unfogged, which is a
      // deliberate exception: an entry lamp is a fitting with a bulb in it, and
      // at 40 m the thing a player should be able to find is the *door*, not the
      // lamp. Fogging it would mean the door goes dark before the lamp does,
      // which inverts the hierarchy the ladder exists to state.
      entryLamp: this._glow(PALETTE.entryLamp),
      panel: this._material({ color: 0x26232b }),
    }
  }

  // -------------------------------------------------------------------------
  // roads — §3.5: streets are a graph on block boundaries, never obstructed
  // -------------------------------------------------------------------------

  /**
   * The carriageway, the kerbs and the walks, for all four directions at once.
   *
   * One plane and 56 instanced strips, each `RUN_LENGTH` long, rather than
   * geometry per block. The strips are three world periods long so a run of
   * pavement crosses the wrap seam without a join, which is the cheapest possible
   * proof that the seam is invisible from the ground as well as from above.
   */
  _buildRoad() {
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(RUN_LENGTH, RUN_LENGTH),
      this._materials.asphalt,
    )
    road.name = 'asphalt'
    road.rotation.x = -Math.PI / 2
    this.group.add(road)
    this.road = road

    const kerbs = this._pool('kerb', new THREE.BoxGeometry(1, 1, 1), this._materials.kerb, 4 * GRID + 8)
    const walks = this._pool('sidewalk', new THREE.BoxGeometry(1, 1, 1), this._materials.sidewalk, 4 * GRID + 8)
    const kerbOffset = STREET_HALF_WIDTH + KERB_WIDTH / 2
    const walkOffset = STREET_HALF_WIDTH + KERB_WIDTH + SIDEWALK_WIDTH / 2
    for (let axis = 0; axis < GRID; axis += 1) {
      const line = roadAxisToWorld(axis)
      for (const side of [-1, 1]) {
        // an avenue runs north-south, so its kerb and walk are long in z
        kerbs.place(line + side * kerbOffset, 0.075, 0, KERB_WIDTH, 0.15, RUN_LENGTH)
        walks.place(line + side * walkOffset, 0.07, 0, SIDEWALK_WIDTH, 0.14, RUN_LENGTH)
        // a street runs east-west, so the same two strips are rotated in effect
        kerbs.place(0, 0.075, line + side * kerbOffset, RUN_LENGTH, 0.15, KERB_WIDTH)
        walks.place(0, 0.07, line + side * walkOffset, RUN_LENGTH, 0.14, SIDEWALK_WIDTH)
      }
    }
    kerbs.commit()
    walks.commit()
  }

  // -------------------------------------------------------------------------
  // chunks — §3.2 random access, §3.3 the wrap, §3.5 lots
  // -------------------------------------------------------------------------

  _pool(name, geometry, material, capacity) {
    const pool = new InstancePool(geometry, material, capacity, name)
    this.pools.push(pool)
    this.group.add(pool.mesh)
    return pool
  }

  /**
   * `_streetPool` — create a pool AND record its name, in one call.
   *
   * The record is the point. `this.pools` is both an array (every pool is pushed
   * so `dispose` can walk them) and a keyed map (so `_addLot` can say
   * `this.pools.houses`), and a caller that creates a pool and forgets to name it
   * gets a pool that `dispose` releases and nothing can find. Before this pass the
   * commit list was a second, hand-written array of names next to the creations,
   * and the two could disagree — which is a bug class, not a bug. One list, from
   * which both the commit and the gate read, is the whole fix.
   *
   * @param {string[]} names the street pool names, in creation order
   */
  _streetPool(names, name, geometry, material, capacity) {
    names.push(name)
    return this._pool(name, geometry, material, capacity)
  }

  /** Instance capacity for anything placed once per lot, per wrapped copy. */
  static get LOT_CAPACITY() {
    return CHUNKS * SIDE_NAMES.length * WRAP_COPIES.length
  }

  /**
   * `_partsUsed` — every instance written into every pool so far.
   *
   * The sum T5's instrument is a difference of. It iterates `this.pools` as an
   * ARRAY on purpose, and the reason is a bug this pass had: `this.pools` is both
   * an array (so `dispose` can walk every pool) and a keyed map (so `_addLot` can
   * say `this.pools.houses`), and `Object.values` on that object returns each
   * pool TWICE — once by index, once by name. The first version of this method
   * used `Object.values` and every lot measured at exactly double its real cost,
   * which is the kind of error a budget check cannot catch on its own.
   *
   * `for...of` over an array visits the index keys only, which is what is meant.
   * O(pools) rather than O(1) because a running total is another number somebody
   * has to keep correct by hand, and this pass has already found two of those.
   */
  _partsUsed() {
    let total = 0
    for (const pool of this.pools) total += pool.used
    return total
  }

  /**
   * `partBudget` — T5's measurement, and the reason the pass has a number in it.
   *
   * The multiplier is the problem T5 names: 49 chunks x 4 lots x 3 wrapped copies
   * = 588 lot instances, so anything placed per lot is paid three times before
   * anyone sees it, and the count is fixed at build time rather than at runtime.
   * A fidelity pass that adds 12 parts per lot is a 7,000-instance regression, and
   * the only time anybody finds out is pass 17's draw-call budget.
   *
   * So the count is INSTRUMENTED rather than estimated. `_addLot` records how
   * many instances it placed, and this reports the distribution — `max` is the
   * number T5 says to gate on ("a check that measures the worst lot rather than
   * the mean, because the mean hides the block that has four facades all facing a
   * street"), `mean` is here so the two can be read together, and the spread is
   * here because a max that equals the mean would mean nothing varies and the
   * budget would not be measuring anything.
   *
   * Read from the real built scene, so it cannot drift from what is drawn: a part
   * that is placed and overflows a pool is counted here as well, which means a
   * capacity bug shows up as a part count rather than as a hole in the world.
   *
   * @returns {{lots: number, mean: number, max: number, min: number}}
   */
  partBudget() {
    const counts = this.lotParts
    if (counts.length === 0) return { lots: 0, mean: 0, max: 0, min: 0, budget: LOT_PART_BUDGET }
    let sum = 0
    let max = 0
    let min = Infinity
    for (const count of counts) {
      sum += count
      if (count > max) max = count
      if (count < min) min = count
    }
    // The ceiling comes back WITH the measurement rather than beside it, so the
    // gate compares the world's real worst lot against the number this file
    // declares and there is no way for the two to have come from different places.
    // The first version had `verify-world.mjs` parse `LOT_PART_BUDGET` out of the
    // source text instead, which is a second reader of a number the file already
    // owns — and is why the constant was an unused declaration.
    return { lots: counts.length, mean: sum / counts.length, max, min, budget: LOT_PART_BUDGET }
  }

  /** Canonical in-order chunk list — the order the checks compare against. */
  static chunkOrder() {
    const coords = []
    for (let cx = 0; cx < GRID; cx += 1) {
      for (let cz = 0; cz < GRID; cz += 1) coords.push({ cx, cz })
    }
    return coords
  }

  /**
   * Every lot of every chunk, three times over.
   *
   * The order the chunks are visited in is a parameter, not a fact: each chunk's
   * geometry is derived from `chunkAt(seed, cx, cz)` alone, so visiting them
   * shuffled produces the same set of matrices with different instance indices.
   * That is the streaming contract of §3.2, and it is why `buildChunks` is a
   * public method instead of a loop buried in the constructor.
   *
   * @param {Array<{cx: number, cz: number}>} [order] chunk coordinates to visit
   */
  buildChunks(order) {
    const coords = order ?? StreetView.chunkOrder()
    for (const { cx, cz } of coords) this._addChunk(chunkAt(this.seed, cx, cz))
  }

  _buildChunkGeometry() {
    const lot = StreetView.LOT_CAPACITY
    // ONE list, created beside the pools and committed from. The previous version
    // of this method had a hand-written array of names at the bottom next to the
    // creations at the top, and the two could disagree — a pool created and not
    // named is a pool whose instances are written into a buffer that is never
    // uploaded, and the only symptom is that the thing is missing. `names` is
    // closed over by both, so the divergence is now a syntax error rather than a
    // missing parapet.
    const names = []
    const box = () => new THREE.BoxGeometry(1, 1, 1)

    this.pools.yards = this._streetPool(names, 'yards', box(), this._materials.yard, lot + 8)
    // ITERATION 2, PASS 5 — the siding is ONE white material and the four
    // `PALETTE.siding` tints ride in `instanceColor`. BEFORE it was an array of two
    // and `_addLot` chose between them by writing `pool.mesh.material`, which sets
    // the POOL's single material slot and so gave all 588 houses the colour of the
    // last lot built. See AESTHETIC-NOTES §4.
    this.pools.houses = this._streetPool(names, 'houses', box(), this._materials.siding, lot)
    // The roof is a DECK, and the roofline is a PARAPET. BEFORE
    // `new THREE.ConeGeometry(0.72, 1, 4)` at 1.06x the footprint: a four-sided
    // pyramid is the most toy-like object in the world, because a cone's OUTLINE
    // is a triangle and no house in a terraced street has one, and because a slope
    // catches nothing from a light directly overhead. AFTER a flat slab and a ring
    // of upstand around it, and the ring is the part you see.
    this.pools.roofs = this._streetPool(names, 'roofs', box(), this._materials.roof, lot)
    // The parapet is a RING, not a second slab: a slab on a slab is a thicker roof
    // and a ring is a wall that happens to stop. `makeFrameGeometry` builds it and
    // also builds every window frame and the door surround — one annulus geometry,
    // three uses, and the hole in it is what gives a frame an inside face.
    this.pools.parapets = this._streetPool(names, 'parapets', makeFrameGeometry(PARAPET_BAR), this._materials.trim, lot)
    this.pools.outbuildings = this._streetPool(names, 'outbuildings', box(), this._materials.outbuilding, lot)
    // The frontage, SPLIT. BEFORE one pool with
    // `mesh.material = hedge ? hedge : fence` written per lot — the same
    // single-slot bug as the siding, and here per-instance colour could NOT have
    // fixed it, because a hedge has a texture and a fence does not and one
    // material is not both. Two pools, two materials, one draw call each.
    this.pools.frontageHedge = this._streetPool(names, 'frontageHedge', box(), this._materials.hedge, lot + 8)
    this.pools.frontageFence = this._streetPool(names, 'frontageFence', box(), this._materials.fence, lot + 8)

    // The façade detail, in T3's depth order. Every pool here is placed against a
    // `facadeFrame`, and every capacity is `LOT_CAPACITY * partsPerLot` where
    // `partsPerLot` is the number this pool takes on a MAXIMAL lot — never the
    // number it happens to take on this seed. `LOT_KINDS` is house/garage/shed, so
    // a seed can put a house on every lot, and a capacity sized for "one per lot"
    // silently drops the extra three. The first version of this block did exactly
    // that and lost 96 window frames; the world check caught it and a screenshot
    // would not have, because a dropped part is a hole in the world and the only
    // report is `pool.overflow`.
    const per = (partsPerLot) => lot * partsPerLot
    // Four windows per house: two on the street façade, one on each flank. Each is
    // a stack of three — a pane set INTO the wall, a frame proud of it, a sill
    // proudest of all — and the lit pane REPLACES the dark one rather than adding
    // to it, so a window is always three instances and never four.
    this.pools.windowGlass = this._streetPool(names, 'windowGlass', box(), this._materials.windowDark, per(4))
    this.pools.windowLit = this._streetPool(names, 'windowLit', box(), this._materials.windowLit, per(4))
    this.pools.windowFrames = this._streetPool(names, 'windowFrames', makeFrameGeometry(), this._materials.trim, per(4))
    this.pools.windowSills = this._streetPool(names, 'windowSills', box(), this._materials.trim, per(4))
    // Four belt courses per house, one on each wall. The storey line is the
    // cheapest part in this pass: one instance, no texture, and it is the
    // difference between "a 5.2 m box" and "a two-storey building".
    this.pools.belts = this._streetPool(names, 'belts', box(), this._materials.trim, per(4))
    // Two boxes on the roof — an AC condenser and a vent cowl. They are the only
    // parts of a building visible past its neighbours, and a roof with nothing on
    // it is a lid.
    this.pools.roofClutter = this._streetPool(names, 'roofClutter', box(), this._materials.metal, per(2))
    this.pools.entryLamps = this._streetPool(names, 'entryLamps', box(), this._materials.entryLamp, per(1))
    // The entrance is six parts and a door: a reveal set into the wall, a leaf
    // inside it, a proud surround, two steps at real risers, a 400 mm canopy and
    // the lamp under it.
    this.pools.doorReveals = this._streetPool(names, 'doorReveals', box(), this._materials.doorReveal, per(1))
    this.pools.doorLeaves = this._streetPool(names, 'doorLeaves', box(), this._materials.doorLeaf, per(1))
    this.pools.doorFrames = this._streetPool(names, 'doorFrames', makeFrameGeometry(), this._materials.trim, per(1))
    this.pools.steps = this._streetPool(names, 'steps', box(), this._materials.step, per(STEP_COUNT))
    this.pools.canopies = this._streetPool(names, 'canopies', box(), this._materials.trim, per(1))

    this.pools.lampPosts = this._streetPool(
      names, 'lampPosts', new THREE.CylinderGeometry(0.09, 0.12, 1, 6), this._materials.metal, CHUNKS * WRAP_COPIES.length + 8,
    )
    this.pools.lampHeads = this._streetPool(
      names, 'lampHeads', box(), this._materials.sodium, CHUNKS * WRAP_COPIES.length + 8,
    )
    // The pools lie on the road, so their geometry is pre-rotated flat rather than
    // given a rotation: `InstancePool.place` composes yaw only, and a pool is
    // radially symmetric, so yaw is the one transform it does not need.
    this.pools.lampPools = this._streetPool(
      names, 'lampPools', new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this._materials.sodiumPool,
      CHUNKS * WRAP_COPIES.length + 8,
    )

    this.buildChunks()
    // The lamps are built *before* the commit loop, and that order is the whole
    // reason this call is here rather than after it. `InstancePool.commit()` is
    // the only thing that publishes instances: it sets `mesh.count` and flags
    // `instanceMatrix` and `instanceColor` for upload. Filling a pool after its
    // commit places 147 lamp posts into a buffer that is never uploaded, which is
    // a street with no streetlights on it — and the only reason it read as "a
    // dark scene" rather than "a bug" is that the four dynamic point lights
    // `world.js` aims at `lampPositions` still work, because those come from the
    // data rather than the geometry.
    this._buildLamps()
    for (const name of names) this.pools[name].commit()
    this.streetPools = names
  }

  /**
   * One chunk: its four lots, each drawn in all three wrapped copies.
   *
   * The five anchor lots get no house. §3.6's rule 2 protects the *point* an
   * objective sits on, and a 5 m house dropped on top of that point would satisfy
   * the letter of it and destroy the thing it exists for. The frontage still goes
   * in, gap and all, because the approach corridor has to arrive somewhere.
   *
   * The spawn clearance lots keep theirs. Rule 2 clears them of *fixtures* — the
   * player must not wake up inside a car — and a house is not a fixture, and
   * nine bald blocks around the spawn would read as a bomb crater rather than a
   * corner.
   */
  _addChunk(chunk) {
    for (const lot of chunk.lots) {
      const isAnchor = this.anchorLots.has(`${chunk.cx},${chunk.cz},${lot.side}`)
      for (const copy of WRAP_COPIES) {
        this._addLot(chunk, lot, isAnchor, copy)
      }
    }
  }

  _addLot(chunk, lot, isAnchor, copy) {
    // T5's instrument. The count is a DIFF of every pool's `used` across this
    // method rather than a hand-maintained tally, because a tally is a number a
    // future pass forgets to increment and the whole point of the budget is that
    // it cannot be forgotten. `overflow` is added separately because an
    // over-capacity write increments `overflow` and NOT `used` — a capacity bug
    // has to show up in this number, or the budget would be measuring the parts
    // that fit and staying silent about the ones that did not.
    const partsBefore = this._partsUsed()
    const frame = lotFrame(lot)
    const x = lot.x + copy * WORLD_EXTENT
    const z = lot.z + copy * WORLD_EXTENT
    const tint = lot.tint % PALETTE.siding.length

    // the lot's own ground: a yard slab, so a driveway reads as a driveway.
    // `YARD_TOP - 0.1` is the same 0.1 the slab is thick, written so the apron's
    // `YARD_TOP` and this placement cannot drift apart into a buried decal
    this.pools.yards.place(x, YARD_TOP - 0.1, z, frame.long, 0.1, frame.short)

    if (!isAnchor) {
      const wall = lot.kind === 'house' ? WALL_HEIGHT : lot.kind === 'garage' ? 2.7 : 2.2
      const depth = frame.short * (lot.kind === 'house' ? 0.55 : 0.5)
      const width = frame.long * (lot.kind === 'house' ? 0.7 : lot.kind === 'garage' ? 0.34 : 0.2)
      const centre = atDepth(frame, frame.short - depth, depth)
      const cx = frame.alongX ? x : x + (centre - lot.x)
      const cz = frame.alongX ? z + (centre - lot.z) : z
      const w = frame.alongX ? width : depth
      const d = frame.alongX ? depth : width
      if (lot.kind === 'house') {
        // §12.3's siding, per-lot deterministic, carried in the INSTANCE colour
        // rather than the material. `tint` comes from the chunk's own stream, so
        // a block's houses agree with each other and two blocks differ, which is
        // most of what "a repeating neighbourhood" has to mean for it to read as
        // one. BEFORE this line was `this.pools.houses.mesh.material =
        // this._materials.siding[tint]`, which set the *pool's* single material
        // slot 588 times and left every house in the world the colour of the last
        // lot built; see AESTHETIC-NOTES §4 and `InstancePool.place`.
        this.pools.houses.place(cx, wall / 2, cz, w, wall, d, 0, this._tint(tint))
        // The flat roof deck. BEFORE `w * 1.06, ROOF_HEIGHT, d * 1.06` on a
        // four-sided cone yawed 45 degrees; AFTER a slab the house's own width,
        // set back `PARAPET_SETBACK` on each side so the parapet around it has a
        // deck to stand on rather than sitting on the wall's outer edge.
        this.pools.roofs.place(
          cx,
          wall + ROOF_DECK_THICK / 2,
          cz,
          w - 2 * PARAPET_SETBACK,
          ROOF_DECK_THICK,
          d - 2 * PARAPET_SETBACK,
        )
        this._addFacadeDetail(chunk, lot, frame, cx, cz, w, d, wall)
      } else {
        this.pools.outbuildings.place(cx, wall / 2, cz, w, wall, d, 0, this._tint(tint))
        this.pools.roofs.place(
          cx,
          wall + ROOF_DECK_THICK / 2,
          cz,
          w - 2 * PARAPET_SETBACK,
          ROOF_DECK_THICK,
          d - 2 * PARAPET_SETBACK,
        )
        this.pools.parapets.place(
          cx, wall + PARAPET_HEIGHT / 2, cz,
          w + 2 * PARAPET_PROUD, PARAPET_HEIGHT, d + 2 * PARAPET_PROUD,
        )
      }
      // one copy only: the wrapped copies exist to be seen, not collided with,
      // and the player is always within half a period of the canonical one
      if (copy === 0) {
        this._collider(cx, cz, w, d, lot.kind)
        this._occluder(cx, cz, w, d, lot.kind)
      }
    }

    // the frontage: two hedge or fence runs with the driveway gap between them.
    // The gap IS the approach (§3.6 rule 3), so it is sized off the lot's own
    // geometry rather than typed, and the middle third of every lot stays open.
    const segment = frame.long / 3 - 1.5
    const offset = frame.long / 3
    const kind = (chunk.cx + chunk.cz + SIDE_NAMES.indexOf(lot.side)) % 2 === 0 ? 'hedge' : 'fence'
    // The two runs go into the pool for their OWN kind rather than into one pool
    // with a rewritten material slot. Same bug as the siding, and here per-instance
    // colour could not have saved it: a hedge is a textured soft mass and a fence
    // is an untextured panel, and no single material is both. Splitting the pool
    // is the fix, and it costs one draw call.
    const pool = kind === 'hedge' ? this.pools.frontageHedge : this.pools.frontageFence
    for (const side of [-1, 1]) {
      const sx = frame.alongX ? x + side * offset : x + (frame.front - lot.x)
      const sz = frame.alongX ? z + (frame.front - lot.z) : z + side * offset
      const w = frame.alongX ? segment : 0.5
      const d = frame.alongX ? 0.5 : segment
      const h = kind === 'hedge' ? 1.3 : 1.1
      pool.place(sx, h / 2, sz, w, h, d)
      if (copy === 0) {
        this._collider(sx, sz, w, d, kind)
        this._occluder(sx, sz, w, d, kind)
      }
    }

    // ...and the lot's part count, recorded last so it covers the yard, the
    // building, the façade and the frontage. A DIFF, not a tally: see the note on
    // `partsBefore` at the top of this method. The fixture pass is deliberately
    // NOT counted here — §3.6's dressing is per-loop and the budget is about the
    // static street, which is what "a per-lot part" means in T5.
    this.lotParts.push(this._partsUsed() - partsBefore)
  }

  /**
   * `_tint` — one `THREE.Color` per `PALETTE.siding` entry, built once.
   *
   * `setColorAt` wants a `THREE.Color`, and allocating 588 of them during the
   * build would be 588 garbage objects for a table with four entries. The
   * objects are also *shared*, which is safe and is worth saying: `setColorAt`
   * copies the colour into the instance buffer rather than keeping the reference,
   * so a later `tint()` on one of these cannot retroactively repaint a house.
   */
  _tint(index) {
    if (!this._tints) {
      // `sidingPalette` is the public twin of `_tints`: the same four hexes, in
      // the same order, readable without reaching into a private. It exists for
      // `verify-world.mjs`, which has to re-derive the expected colour of every
      // house from the palette rather than from the buffer it is testing —
      // a check that compared the buffer with itself would be a tautology, and
      // the pre-pass-5 bug is exactly the kind of tautology that looks green.
      this.sidingPalette = PALETTE.siding
      this._tints = PALETTE.siding.map((hex) => new THREE.Color(hex))
    }
    return this._tints[index % this._tints.length]
  }

  /**
   * `_addFacadeDetail` — everything on a house that is not the house, in the
   * order the eye reads it: roofline, storey line, windows, entrance.
   *
   * This is the body of AESTHETIC-NOTES T3 and mechanism 1, and it is a method
   * rather than more lines in `_addLot` for T5's reason: this is where a lot's
   * part count is spent, and a reader who wants to know what a building costs
   * should not have to count it across four hundred lines of lot bookkeeping.
   *
   * The four groups and what each is for:
   *
   *   ROOFLINE — a parapet `PARAPET_PROUD` proud and `PARAPET_HEIGHT` tall, plus
   *   an AC condenser and a vent cowl on the deck behind it. Mechanism 1's whole
   *   argument is that a building's read at distance is its OUTLINE and an
   *   outline is made of horizontal edges. Before this pass the outline was a
   *   four-sided cone, and a cone's outline is a triangle no house here has.
   *
   *   STOREY LINE — one belt course at `STOREY_HEIGHT`, standing `BELT_PROUD`
   *   proud and `BELT_HEIGHT` tall, on ALL FOUR walls. One instance, and it is
   *   the difference between "a 5.2 m box" and "a two-storey building": a
   *   vertical wall with one horizontal division reads as two storeys and one
   *   without reads as a wall. All four, because a belt that stops at the corner
   *   reads as tape on one face and the corner is the first thing you see looking
   *   down a street at a building rather than standing in front of it.
   *
   *   WINDOWS — see `_addFacadeWindows`. T3's order (deepest thing is the dark
   *   interior, the frame is proud of that, the sill proudest of all) is what
   *   produces a reveal, and a reveal is the only thing that separates a window
   *   from a sticker at 40 m through fog.
   *
   *   ENTRANCE — see `_addEntrance`. T-notes item 4: "the entry is what tells a
   *   player a building is a building".
   *
   * The lit-window rule lives here and not in `neighborhood.js` because it is
   * art, not a rule: §3.6's four constraints are all about fixture footprint,
   * and a window that is lit changes no collider.
   */
  _addFacadeDetail(chunk, lot, frame, cx, cz, w, d, wall) {
    // The lot's own stream, so the detail is a function of the lot rather than of
    // build order: §3.2's contract is that a shuffled `buildChunks` produces the
    // same set of matrices, and a window that lit itself differently depending on
    // which chunk was visited first would break it in a way nothing else here
    // would notice.
    const rng = streamAt(this.seed, chunk.cx, chunk.cz)
    // ...advanced past `buildLots`'s own eight draws (kind then tint, four sides),
    // and then past this lot's, so the window stream is in its own region of the
    // 32-bit mix rather than next door to the lot data. Sixteen is chosen because
    // it is comfortably more than eight and the modulo that follows is a power of
    // two, so the offset costs nothing and cannot drift.
    for (let i = 0; i < 16 + SIDE_NAMES.indexOf(lot.side) * 2; i += 1) rng()

    // ---- roofline -------------------------------------------------------
    // The parapet is a RING (one annulus instance) rather than a second slab,
    // because a slab on a slab is a thicker roof and a ring is a wall that
    // happens to stop. `makeFrameGeometry` with a bar of `PARAPET_BAR` is the
    // same geometry every window frame and door surround uses; this is the third
    // place that one shape does the work of four boxes.
    // ...`PARAPET_PROUD` PROUD of the wall on every side, which is the number the
    // whole roofline exists for: a horizontal edge flush with the wall below it
    // catches no light and changes no outline, so an upstand that does not
    // project is a thicker wall and not a rim.
    this.pools.parapets.place(
      cx, wall + PARAPET_HEIGHT / 2, cz,
      w + 2 * PARAPET_PROUD, PARAPET_HEIGHT, d + 2 * PARAPET_PROUD,
    )
    // The clutter sits BEHIND the parapet on the deck, which is both where real
    // condensers go and the only place a box can be without becoming the first
    // thing the eye finds when it looks up. `w / 4` puts the vent on the far
    // half of the deck from the condenser, so the two read as two objects rather
    // than as one lumpy one.
    const deck = wall + ROOF_DECK_THICK
    this.pools.roofClutter.place(cx, deck + AC_BOX[1] / 2, cz, AC_BOX[0], AC_BOX[1], AC_BOX[2])
    this.pools.roofClutter.place(cx + w / 4, deck + VENT_BOX[1] / 2, cz, VENT_BOX[0], VENT_BOX[1], VENT_BOX[2])

    // ---- storey line ----------------------------------------------------
    for (const [ox, oz, sw, sd] of [
      [0, d / 2, w + 2 * BELT_PROUD, BELT_PROUD],
      [0, -d / 2, w + 2 * BELT_PROUD, BELT_PROUD],
      [w / 2, 0, BELT_PROUD, d + 2 * BELT_PROUD],
      [-w / 2, 0, BELT_PROUD, d + 2 * BELT_PROUD],
    ]) {
      this.pools.belts.place(cx + ox, STOREY_HEIGHT, cz + oz, sw, BELT_HEIGHT, sd)
    }

    // ---- windows, then the entrance -------------------------------------
    // Street façade first (two windows), then the two flanks (one each).
    // AESTHETIC-NOTES §5 says "two windows per street-facing facade plus one per
    // flank, not four per facade", and the reason is T5's: 588 lot instances means
    // a fourth window on a fourth façade is 2,352 instances nobody notices until
    // pass 17's draw-call budget.
    const faces = houseFaces(frame, cx, cz, w, d)
    this._addFacadeWindows(rng, [
      { wall: faces.street, count: 2, size: faces.street.size },
      { wall: faces.flanks[0], count: 1, size: faces.flanks[0].size },
      { wall: faces.flanks[1], count: 1, size: faces.flanks[1].size },
    ])
    this._addEntrance(faces.street, lot.tint % 2 === 0 ? -1 : 1)
  }

  /**
   * `_addFacadeWindows` — T3's stack, on one wall, at three depths.
   *
   * A window here is FOUR instances, not nine, and the order is the whole of it:
   *
   *   1. the pane, set INTO the wall by `WINDOW.depth / 2` — the dark interior
   *   2. the frame, an extruded annulus standing `WINDOW.frame` proud of the pane
   *   3. the sill, `WINDOW.sill` proud again, the widest of the three
   *   4. the lit pane, *replacing* (1) rather than adding to it, on a roll
   *
   * T3: "the deepest thing is a dark interior, glass sits in front of it, the
   * frame is proud of both, and the sill is proudest of all". The sill being
   * proudest is the part that is easy to leave out and the part that does the
   * most work: it is the only part of a window that faces the sky, so it is the
   * only part the sodium overhead can put a highlight on, and a highlight on a
   * 60 mm shelf is what makes a window read as an opening from 40 m away.
   *
   * Two windows on the street façade, one on each flank. "Never two lit on the
   * same façade" is enforced by `lit`, which is set by a single roll per wall
   * rather than per window: one roll, one window at most, no possibility of two.
   *
   * @param {() => number} rng the lot's stream, already advanced
   * @param {{wall: object, count: number, size: number}[]} faces one entry per
   * wall that carries windows, from `houseFaces`: the street wall first (two
   * windows) then the two flanks (one each), and the order is load-bearing
   * because `rng` is consumed in it.
   */
  _addFacadeWindows(rng, faces) {
    // ONE roll per wall decides both whether it has a lit window and which of its
    // windows that is. One roll rather than one per window is what makes "never
    // two lit on a façade" true BY CONSTRUCTION rather than by a check that could
    // fail: two windows, one bit.
    for (const entry of faces) {
      const litIndex = Math.floor(rng() * entry.count)
      const lit = rng() < 1 / LIT_WINDOW_ONE_IN
      for (let i = 0; i < entry.count; i += 1) {
        // Windows are inset from their wall's own edges by a fixed fraction, so a
        // 26 m frontage and a 6 m flank both get windows that are not touching the
        // corner. A window hard against a corner reads as a crack.
        const u = entry.count === 1 ? 0 : (i === 0 ? -1 : 1) * entry.size * WINDOW_INSET
        const y = STOREY_HEIGHT * 0.55
        const isLit = lit && i === litIndex
        // 1. the pane, `WINDOW.depth / 2` INTO the wall. Half the box is behind
        // the siding, so the visible face has real depth behind it and the frame in
        // front of it has something to be proud OF. Before this pass the only
        // window in the world was a `window` fixture placed at 45% of the lot's
        // depth — which is 4.5 m in front of the wall, in mid-air.
        onFacade(
          isLit ? this.pools.windowLit : this.pools.windowGlass,
          entry.wall, u, y, -WINDOW.depth / 2, WINDOW.w, WINDOW.h, WINDOW.depth,
        )
        // 2. the frame: an extruded annulus standing `WINDOW.frame` proud of the
        // pane, and wider and taller than it by twice the frame, so the pane reads
        // as sitting inside an opening rather than lying on a plate. The annulus
        // is what gives it an inside face, and the inside face is the reveal.
        onFacade(
          this.pools.windowFrames, entry.wall, u, y, WINDOW.frame / 2,
          WINDOW.w + 4 * WINDOW.frame, WINDOW.h + 4 * WINDOW.frame, WINDOW.frame,
        )
        // 3. the sill, proudest of all, wider again, and the only part of a
        // window that faces the sky.
        onFacade(
          this.pools.windowSills, entry.wall, u, y - WINDOW.h / 2 - 0.05,
          WINDOW.sill / 2, WINDOW.w + 0.24, 0.06, WINDOW.sill + 0.04,
        )
      }
    }
  }

  /**
   * `_addEntrance` — the door, the steps, the canopy and the lamp.
   *
   * T-notes item 4: "the entry is what tells a player a building is a building".
   * It is five parts and it is the only part of this pass that a player can
   * *approach*, which is why the numbers here are the real ones rather than the
   * legible-at-40 m ones: at arm's length the riser is 170 mm because a person
   * steps up it, and at 40 m the two steps read as a staircase in silhouette
   * because they step OUTWARD, which is what `STEP_OVERSAIL` is for.
   *
   * The depth order, which is the whole argument again:
   *
   *   1. the reveal, set `DOOR_RECESS` INTO the wall, near-black
   *   2. the leaf, inside the reveal, painted
   *   3. the surround, proud of the reveal — the same annulus the windows use
   *   4. the canopy, `CANOPY_DEPTH` out and over the head
   *   5. the entry lamp, under the canopy, on the emissive ladder
   *
   * The lamp is at `ENTRY_LAMP_Y` = 1.98 m, which is derived from the canopy's
   * underside rather than chosen: the canopy's lowest face is at
   * `DOOR_LEAF_H + CANOPY_LIFT - CANOPY_THICK / 2` = 2.135 m and the fitting is
   * 220 mm tall, so anything higher than about 2.0 m is sticking out through the
   * hood it is supposed to be lighting. That is the only reason the canopy is
   * 400 mm deep as well: it has to be deep enough to catch the lamp's own light
   * and throw a shadow on the head of the door, and a 200 mm hood would not.
   *
   * The door is offset from the wall's centre by a quarter of its width, because
   * a door dead-centre in a 26 m frontage is a door on a hangar. It goes on the
   * LEFT for even `tint` lots and the RIGHT for odd ones, so a street has
   * entrances on both sides of its houses rather than a rhythm — and the side is
   * read off `lot.tint`, which is the same bit that picks the wall's colour, so
   * the two decisions are visibly the same decision.
   *
   * @param {object} wall the street-facing wall, from `houseFaces`
   * @param {number} side -1 for the left of the wall, +1 for the right
   */
  _addEntrance(wall, side) {
    const u = side * wall.size * ENTRANCE_OFFSET
    // 1. the reveal. `DOOR_RECESS` INTO the wall and a little taller and wider
    // than the leaf, so the leaf sits inside a dark border rather than filling the
    // hole. Near-black rather than black: pure black at 0.15 m behind a leaf is
    // a hole in the world, and this is a door in a wall.
    onFacade(
      this.pools.doorReveals, wall, u, DOOR_LEAF_H / 2, -DOOR_RECESS / 2,
      DOOR_LEAF_W * DOOR_REVEAL_SCALE, DOOR_LEAF_H * DOOR_REVEAL_SCALE, DOOR_RECESS,
    )
    // 2. the leaf, halfway into the reveal rather than at the back of it, so the
    // reveal's dark return is visible above and beside it.
    onFacade(
      this.pools.doorLeaves, wall, u, DOOR_LEAF_H / 2, -DOOR_RECESS / 2,
      DOOR_LEAF_W, DOOR_LEAF_H, DOOR_RECESS * 0.6,
    )
    // 3. the surround, proud of the wall and the same annulus the windows use. It
    // is proud of the reveal, not of the leaf, so it is a frame round a hole with
    // a door in it rather than a frame round a door.
    onFacade(
      this.pools.doorFrames, wall, u, DOOR_LEAF_H / 2, WINDOW.frame / 2,
      DOOR_LEAF_W * DOOR_REVEAL_SCALE + 4 * WINDOW.frame,
      DOOR_LEAF_H * DOOR_REVEAL_SCALE + 4 * WINDOW.frame,
      WINDOW.frame,
    )
    // 4. the canopy: `CANOPY_DEPTH` out from the wall, `CANOPY_THICK` tall, and
    // `CANOPY_LIFT` above the head. It is the widest thing on the wall, which is
    // correct — a door hood is 1.4x the door — and it is the only overhang on the
    // street elevation, so it is the first thing the eye finds on a house.
    onFacade(
      this.pools.canopies, wall, u, DOOR_LEAF_H + CANOPY_LIFT, CANOPY_DEPTH / 2,
      DOOR_LEAF_W * DOOR_REVEAL_SCALE + 0.5, CANOPY_THICK, CANOPY_DEPTH,
    )
    // 5. the entry lamp, under the canopy and to one side. T11's lowest rung, and
    // the only light in the game that exists to say "somebody lives here".
    onFacade(
      this.pools.entryLamps, wall, u + ENTRY_LAMP_SIDE * side, ENTRY_LAMP_Y,
      ENTRY_LAMP_D / 2 + WINDOW.frame, ENTRY_LAMP_W, ENTRY_LAMP_H, ENTRY_LAMP_D,
    )
    // ...and the steps. Two of them, each one riser tall and one tread deep, each
    // WIDER than the one above by `STEP_OVERSAIL` on each side. They start at the
    // wall and come TOWARD the street, so their `proud` grows with each one down —
    // which is the only direction a staircase can be built in and the reason the
    // oversail is on the width and not on the position.
    for (let step = 0; step < STEP_COUNT; step += 1) {
      const rise = (step + 1) * STEP_RISER
      const proud = (STEP_COUNT - step) * STEP_TREAD
      onFacade(
        this.pools.steps, wall, u, rise / 2, proud / 2,
        DOOR_LEAF_W * DOOR_REVEAL_SCALE + 2 * step * STEP_OVERSAIL,
        rise,
        proud,
      )
    }
  }

  /**
   * One sodium lamp per intersection, on the corner of the pavement.
   *
   * 49 lamps 64 m apart is a real streetlight spacing rather than a decorative
   * one, and it is what makes §12.1's "the streetlights have already come on"
   * legible: the pools of light are a landmark grid, so they have to be regular
   * enough to steer by and sparse enough that the fog still has work to do between
   * them.
   */
  _buildLamps() {
    this.lampPositions = []
    for (let ax = 0; ax < GRID; ax += 1) {
      for (let az = 0; az < GRID; az += 1) {
        const node = streetNodeToWorld(ax * GRID + az)
        const lx = node.x + STREET_HALF_WIDTH + 1.6
        const lz = node.z + STREET_HALF_WIDTH + 1.6
        for (const copy of WRAP_COPIES) {
          this.pools.lampPosts.place(lx + copy * WORLD_EXTENT, 2.6, lz + copy * WORLD_EXTENT, 1, 5.2, 1)
          this.pools.lampHeads.place(lx - 0.9 + copy * WORLD_EXTENT, 5.1, lz + copy * WORLD_EXTENT, 1.9, 0.18, 0.34)
          // The pool sits under the head rather than the post, and reaches the
          // kerbs and stops. `place` scales the pre-rotated plane by (x, z), so
          // both numbers below are the same diameter.
          this.pools.lampPools.place(
            lx - 0.9 + copy * WORLD_EXTENT,
            0.03,
            lz + copy * WORLD_EXTENT,
            LAMP_POOL_DIAMETER,
            1,
            LAMP_POOL_DIAMETER,
          )
        }
        // one canonical record per lamp, for the light pool `world.js` drives
        this.lampPositions.push({ x: lx, z: lz })
      }
    }
  }

  // -------------------------------------------------------------------------
  // the objectives — §5.1 portals, §7.1 hammer, §10.3 exit
  // -------------------------------------------------------------------------

  _box(w, h, d, material, x, y, z, yaw = 0) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
    mesh.position.set(x, y, z)
    mesh.rotation.y = yaw
    return mesh
  }

  /**
   * The three portals, one per district, each in its own liminal structure.
   *
   * §5.1 names the three: a shed, a bus shelter, a phone box. They are built from
   * the same box primitive at three scales because the whole point of the list is
   * that they read as *different kinds of place* from the outside — a player who
   * has learned to recognise the phone box is steering by a memory (§4's portal
   * glow), and a silhouette that is the same shed three times teaches nothing.
   */
  _buildPortals() {
    this.portals = PORTAL_IDS.map((id, index) => {
      const anchor = this.objectives.portals[index]
      const frame = lotFrame(anchor.lot)
      const root = new THREE.Group()
      root.name = `portal-${id}`
      root.position.set(anchor.position.x, 0, anchor.position.z)
      root.rotation.y = frame.yaw
      const shell = new THREE.Group()
      if (index === 0) {
        // Shed: a back wall, two side walls, and a +X flank built as TWO panels
        // with a gap between them — the doorway the gate stands in.
        //
        // The gap is the whole point of this structure and it was missing. The
        // +X flank used to be one box 2.4 m deep, which is exactly the full
        // depth of the shed, so the panel sealed the opening it was named for
        // and the §16.5.5 view photographed a closed black box with the ring
        // sealed inside it. The apron on the ground and the light around the
        // roofline still measured, so the luma gate passed a picture of a wall:
        // the gate measures how much light is in the frame, not whether the
        // frame is of the thing it claims to be.
        //
        // 1.3 m of the 2.4 m flank is wall, 1.1 m is the doorway, and the disc
        // (1.44 m across at 0.72 m radius) is sized to be *wider* than the
        // opening — so from outside you see the cyan lip of a disc the doorway
        // is cropping, which is what a hole in a doorway actually looks like.
        // BEFORE pass 3 the ring here was 1.56 m across and stood 1.25 m further
        // in, at the middle of the shed, which is why the frame showed a hoop
        // *inside* a shed rather than a hole in its wall.
        shell.add(this._box(3.2, 2.4, 0.18, this._materials.shed, 0, 1.2, -1.3))
        shell.add(this._box(0.18, 2.4, 2.4, this._materials.shed, -1.5, 1.2, 0))
        // the two flank panels, each 0.65 m deep, leaving z in (-0.65, 0.65) open
        shell.add(this._box(0.9, 2.4, 0.65, this._materials.shed, 1.25, 1.2, -0.975))
        shell.add(this._box(0.9, 2.4, 0.65, this._materials.shed, 1.25, 1.2, 0.975))
        // a lintel over the opening, so the doorway reads as a built opening
        // rather than a missing wall, and the gap is not a hole in the shed
        shell.add(this._box(0.9, 0.5, 1.3, this._materials.shed, 1.25, 2.15, 0))
        shell.add(this._box(3.6, 0.16, 3.0, this._materials.roof, 0, 2.5, 0))
      } else if (index === 1) {
        // bus shelter: a back panel, a roof on two posts, and nothing else
        shell.add(this._box(3.8, 2.2, 0.16, this._materials.glass, 0, 1.4, -0.7))
        shell.add(this._box(4.2, 0.18, 1.8, this._materials.metal, 0, 2.6, 0))
        shell.add(this._box(0.14, 2.6, 0.14, this._materials.metal, -1.9, 1.3, 0.5))
        shell.add(this._box(0.14, 2.6, 0.14, this._materials.metal, 1.9, 1.3, 0.5))
        shell.add(this._box(3.4, 0.12, 0.5, this._materials.metal, 0, 0.6, -0.4))
      } else {
        // phone box: a lit-glass cube on a plinth, the most enclosed of the three
        shell.add(this._box(1.1, 2.4, 1.1, this._materials.metal, 0, 1.2, 0))
        shell.add(this._box(1.24, 0.14, 1.24, this._materials.roof, 0, 2.46, 0))
        shell.add(this._box(0.9, 1.5, 0.06, this._materials.glass, 0, 1.5, -0.58))
      }
      root.add(shell)

      // The gate: §12.2's only cold light, and iteration 2, pass 3's rebuild of
      // it from a halo into a doorway.
      //
      // BEFORE this block built one `TorusGeometry(0.78, 0.08, 10, 28)` standing
      // in the plane of the opening, at the middle of all three shells: a hoop
      // with the lit inside of the shed visible through the middle of it, which
      // is a halo, and — for the phone box — a hoop buried in a solid metal cube
      // and never seen at all. AFTER it builds a group of four things: a
      // near-black disc, a 5.6 cm lip of cyan on the disc's edge, and two
      // counter-rotating spiral layers turning inside the hole.
      //
      // The *group* is what the rest of this file addresses. The swell, the
      // shutdown and the gate raycast in `verify-world.mjs` all act on the gate
      // as one thing, so a future fourth piece of the opening is added inside
      // this block and inherits all three. A quarter turn about Y for the shells
      // that open on X, read from `PORTAL_OPEN_AXIS` rather than hardcoded per
      // structure: a `CircleGeometry` and a `TorusGeometry` both lie in the XY
      // plane and are seen edge-on — as a line, not a disc — by any camera
      // looking down its own Z, and the shed's `facing` side is exactly where
      // `capture.js` puts the §16.5.5 camera.
      const gate = new THREE.Group()
      gate.name = `portal-gate-${id}`
      // The gate stands in the *opening plane*, which is the root's own +X for
      // the shells that open on X and the root's +Z for the rest — and it is
      // read off `PORTAL_OPEN_AXIS` a second time here for a reason that cost a
      // capture to find: the quarter turn below rotates the gate's *children*,
      // not the gate, so an offset written on the gate's own Z is a root-local X
      // and puts the shed's gate 1.25 m to the side, inside a flank panel. A
      // camera then sees the panel and the gate is behind a wall.
      if (PORTAL_OPEN_AXIS[index] === 'x') {
        gate.position.set(PORTAL_GATE_OFFSET[index], PORTAL_CORE_Y, 0)
        gate.rotation.y = Math.PI / 2
      } else {
        gate.position.set(0, PORTAL_CORE_Y, PORTAL_GATE_OFFSET[index])
      }
      gate.scale.setScalar(PORTAL_GATE_SCALE[index])

      // The disc: the hole itself. Set back from the rim so the rim stands proud
      // of it in the frame, and cloned for the same reason the apron is cloned —
      // `setPortalShut` puts one portal's gate out at a time, and three portals
      // sharing a material could not be shut one at a time, which is the entire
      // rule of §5.3.
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(PORTAL_CORE_RADIUS, 48),
        this._materials.portalCore.clone(),
      )
      disc.name = `portal-core-${id}`
      disc.position.z = -PORTAL_CORE_INSET
      gate.add(disc)

      // The rim: the same circle as the disc's edge and 2.8 cm of tube on it, so
      // the cyan is a lip *on* the hole rather than a ring floating a radius away
      // from it. Same radius, not a derived one, for the reason above.
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(PORTAL_CORE_RADIUS, PORTAL_RIM_TUBE, 10, 40),
        this._materials.portal.clone(),
      )
      rim.name = `portal-rim-${id}`
      gate.add(rim)

      // The swirl: two layers of the same additive spiral at two scales and two
      // rates, both children of the gate so they inherit its quarter-turn, its
      // offset and its scale, and neither of those is re-derived per structure.
      const swirl = PORTAL_SWIRL_RADII.map((radius, layer) => {
        const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 40), this._materials.swirl)
        mesh.name = `portal-swirl-${id}-${layer}`
        mesh.position.z = PORTAL_SWIRL_DEPTHS[layer]
        gate.add(mesh)
        return mesh
      })
      root.add(gate)

      const light = new THREE.PointLight(PALETTE.portal, 9, 26, 2)
      light.position.set(0, 1.5, 0)
      root.add(light)

      // The apron the gate throws on the ground, and the reason the portal views
      // have anything in the bottom half of the frame to measure. Pre-rotated
      // flat for the same reason the sodium pools are: `place` composes yaw only
      // and a radial falloff needs nothing else. A cloned material rather than
      // the shared one, so `setPortalShut` can put this portal's apron out
      // individually — three portals sharing one material could not be shut one
      // at a time, which is the entire rule of §5.3.
      //
      // The height is 0.13 and not the sodium pools' 0.03, and that difference is
      // the whole bug this had on its first run: a portal stands in a *lot*, and
      // a lot's ground is a yard slab 0.1 m thick with its top face at 0.1, so an
      // apron laid at 0.03 is inside the slab and renders nothing. It measured
      // 0.33% lit — the sodium value, apparently, and no cyan in it at all. The
      // pools clear their own surface by 0.03; this clears the yard by the same.
      const apron = new THREE.Mesh(
        new THREE.PlaneGeometry(PORTAL_APRON_DIAMETER, PORTAL_APRON_DIAMETER).rotateX(-Math.PI / 2),
        this._materials.portalPool.clone(),
      )
      apron.position.set(0, YARD_TOP + 0.03, 0)
      root.add(apron)

      this.group.add(root)
      // The direction out of the opening, in world space, so a camera can be put
      // on the side the portal is actually readable from. `root.rotation.y` is
      // `frame.yaw`, and rotating a local axis by it about Y gives local +X ->
      // (cos, -sin) and local +Z -> (sin, cos). Stored as a unit vector rather
      // than a yaw because a stand-off is a direction and a distance, and every
      // caller wants exactly that.
      const sin = Math.sin(frame.yaw)
      const cos = Math.cos(frame.yaw)
      const facing = PORTAL_OPEN_AXIS[index] === 'x' ? { x: cos, z: -sin } : { x: sin, z: cos }
      const portal = {
        id,
        anchor,
        structure: PORTAL_STRUCTURES[index],
        root,
        // the gate, addressed as one thing: the disc and the rim are what §5.3
        // puts out, the swirl is what `update()` turns, and `gateScale` is the
        // structure's own factor, kept here because `update()` multiplies it by
        // the swell every frame and the per-structure number is not something to
        // re-read out of a frozen table in the render path
        gate,
        disc,
        rim,
        swirl,
        gateScale: PORTAL_GATE_SCALE[index],
        light,
        apron,
        facing,
        shut: false,
        position: { x: anchor.position.x, z: anchor.position.z },
      }
      this._collider(anchor.position.x, anchor.position.z, 2.4, 2.0, 'structure')
      this._occluder(anchor.position.x, anchor.position.z, 2.4, 2.0, 'structure')
      return portal
    })
  }

  /**
   * The hammer (§7.1) — the only object in the world that is also an event.
   *
   * §12.2's two light families do not cover it, so it is deliberately neither:
   * a warm brass body with a faint amber pool around it, sitting in the open on
   * its lot with nothing else lit. It is a *find*, and the design says so by
   * making it the only object in the game that glows without being a lamp.
   */
  _buildHammer() {
    const anchor = this.objectives.hammer
    const root = new THREE.Group()
    root.name = 'hammer'
    root.position.set(anchor.position.x, 0, anchor.position.z)
    const brass = this._material({ color: 0x8a6f3c, roughness: 0.45, metalness: 0.6 })
    const shaft = this._box(0.07, 0.62, 0.07, brass, 0, 1.02, 0)
    const head = this._box(0.34, 0.15, 0.15, brass, 0, 1.36, 0)
    const collar = this._box(0.12, 0.1, 0.12, this._materials.metal, 0, 0.72, 0)
    root.add(shaft, head, collar)
    const light = new THREE.PointLight(0xffc46a, 3.2, 12, 2)
    light.position.set(0, 1.2, 0)
    root.add(light)
    this.group.add(root)
    this.hammer = { anchor, root, light, taken: false, position: { x: anchor.position.x, z: anchor.position.z } }
  }

  /**
   * The exit car (§10.3) — present, dark, and easy to walk past.
   *
   * The whole finale rests on this object, and one detail decides whether the
   * finale is a destination or a coin flip: the car is parked *beside* its
   * anchor, never on it. `isInsideExit` is a 1.15 m radius test around the anchor
   * and the player's own collision radius is 0.36 m, so a car body centred on the
   * anchor would make the win condition geometrically unreachable — the player
   * would be pushed out of their own win trigger. Two and a half metres of
   * kerbside offset puts the anchor at the open driver's door instead.
   */
  _buildExitCar() {
    const anchor = this.objectives.exit
    const frame = lotFrame(anchor.lot)
    const root = new THREE.Group()
    root.name = 'exit-car'
    const along = frame.alongX ? { x: 1, z: 0 } : { x: 0, z: 1 }
    const centre = { x: anchor.position.x + along.x * 2.6, z: anchor.position.z + along.z * 2.6 }
    root.position.set(centre.x, 0, centre.z)
    // nose to the street: the yaw whose local -Z faces the frontage, so the
    // headlights throw their beam at the pavement the player arrives on
    root.rotation.y = frame.yaw
    const length = frame.alongX ? 4.2 : 1.85
    const width = frame.alongX ? 1.85 : 4.2
    root.add(this._box(length, 0.82, width, this._materials.car, 0, 0.62, 0))
    root.add(this._box(length * 0.5, 0.6, width * 0.92, this._materials.glass, -length * 0.05, 1.3, 0))
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        root.add(
          this._box(
            frame.alongX ? 0.7 : 0.24,
            0.66,
            frame.alongX ? 0.24 : 0.7,
            this._materials.metal,
            sx * length * 0.31,
            0.33,
            sz * width * 0.42,
          ),
        )
      }
    }
    // the headlights, pointing back at the street the player arrives from
    const lamps = []
    for (const side of [-1, 1]) {
      const lamp = this._box(0.16, 0.2, 0.42, this._materials.headlight.clone(), 0, 0, 0)
      lamp.position.set(frame.alongX ? length * 0.5 : side * width * 0.32, 0.72, frame.alongX ? side * width * 0.32 : length * 0.5)
      lamp.visible = false
      root.add(lamp)
      lamps.push(lamp)
    }
    // The beam, and §10.3's whole argument in one number: it has to *outlast the
    // fog*, or a lit surface in the finale is a glow twenty metres out and the
    // climax becomes a search. The gate asserts `beam.distance > fogVisibility` at
    // dusk 1, so the two numbers cannot drift apart.
    //
    // BEFORE 34, AFTER 56 (iteration 2, pass 2). Pass 2 thinned the fog (the whole
    // point of it: fog as a depth cue rather than a wall), which moved the
    // half-visibility at dusk 1 from 32.0 m to 47.6 m. A 34 m beam would have
    // fallen *inside* the fog it is supposed to be visible through, and the
    // assertion that has protected this since slice 13 would have started failing
    // for a reason that has nothing to do with the car.
    //
    // The intensity is unchanged at 26 and that is deliberate rather than an
    // oversight: `distance` is a cutoff, not a brightness, and this beam is decay
    // 2, so lengthening it does not dim the near field. What it changes is the
    // far field, which is exactly the half that was missing.
    const beam = new THREE.PointLight(PALETTE.headlight, 0, 56, 2)
    beam.position.set(frame.alongX ? length * 0.8 : 0, 1.1, frame.alongX ? 0 : length * 0.8)
    root.add(beam)
    this.group.add(root)
    this.exitCar = { anchor, root, lamps, beam, lit: false, centre, position: { x: anchor.position.x, z: anchor.position.z } }
    this._collider(centre.x, centre.z, length + 0.3, width + 0.2, 'car')
  }

  // -------------------------------------------------------------------------
  // fixtures — §3.6: per-loop, per-chunk, and a discrete event at reset
  // -------------------------------------------------------------------------

  /**
   * One pool per fixture kind, so a hedge is a long box and a cone is a cone.
   *
   * Capacity is derived from the generator's own bounds — 49 chunks x 4 lots x 3
   * slots x `FIXTURE_DENSITY`, split across two classes and five kinds, with
   * headroom for an unlucky seed — rather than typed, so a change to
   * `FIXTURE_DENSITY` cannot silently overflow a pool into a hole in the world.
   */
  _buildFixturePools() {
    const expected = CHUNKS * 4 * 3 * FIXTURE_DENSITY * 0.5 * 0.2
    const capacity = Math.ceil(expected * 3) + 32
    this.fixturePools = {}
    const geometryFor = (kind) => (kind === 'cone' ? new THREE.ConeGeometry(0.3, 1, 8) : new THREE.BoxGeometry(1, 1, 1))
    const materialFor = (kind) => {
      if (kind === 'hedge') return this._materials.hedge
      if (kind === 'fence') return this._materials.fence
      if (kind === 'car') return this._materials.car
      if (kind === 'shed') return this._materials.shed
      if (kind === 'bin') return this._materials.metal
      if (kind === 'window') return this._materials.windowLit
      if (kind === 'porchLight') return this._materials.sodium
      if (kind === 'cone') return this._material({ color: 0xa8552a })
      return this._materials.metal
    }
    for (const spec of [...STRUCTURAL_KINDS, ...DECORATIVE_KINDS]) {
      const pool = this._pool(`fixture-${spec.kind}`, geometryFor(spec.kind), materialFor(spec.kind), capacity)
      this.fixturePools[spec.kind] = pool
    }
  }

  /**
   * applyLoop — the per-loop fixture pass, and the collider rebuild with it.
   *
   * §3.6 calls this "a discrete event at reset rather than a per-frame cost", and
   * the split in this file is what makes that true: streets, lots and the
   * objective anchors are built once and never touched again, and everything that
   * churns lives in the fixture pools whose matrices are simply rewritten here.
   * A capture therefore permutes the world's dressing without moving a single
   * street, which is the entire "reshuffle on reset" decision from the log.
   *
   * @param {number} loopNumber 1-based
   * @returns {object[]} this loop's fixtures, in canonical coordinates
   */
  applyLoop(loopNumber) {
    this.loop = loopNumber
    const fixtures = []
    for (let cx = 0; cx < GRID; cx += 1) {
      for (let cz = 0; cz < GRID; cz += 1) fixtures.push(...chunkFixtures(this.seed, loopNumber, cx, cz, this.reserved))
    }
    for (const pool of Object.values(this.fixturePools)) pool.clear()
    // one `chunkAt` per chunk rather than one per fixture: the fixture pass emits
    // ~350 entries and a capture is a discrete event, but it should not be nine
    // times more expensive than it needs to be
    const lots = new Map()
    for (const fixture of fixtures) {
      const key = `${fixture.chunk.cx},${fixture.chunk.cz}`
      if (!lots.has(key)) lots.set(key, chunkAt(this.seed, fixture.chunk.cx, fixture.chunk.cz).lots)
      const lot = lots.get(key).find((entry) => entry.side === fixture.lot)
      for (const copy of WRAP_COPIES) {
        this._addFixture(fixture, lot, copy)
      }
    }
    for (const pool of Object.values(this.fixturePools)) pool.commit()
    this.fixtures = fixtures
    this.fixtureColliders = fixtures
      .filter((fixture) => fixture.collides)
      .map((fixture) => ({
        cx: fixture.x,
        cz: fixture.z,
        hx: fixture.w / 2,
        hz: fixture.d / 2,
        kind: fixture.kind,
      }))
    // §6.3: a structural fixture that is not a car or a bin blocks a sightline,
    // and the set of kinds that do is `creature.js`'s, not this file's
    this.fixtureOccluders = fixtures
      .filter((fixture) => fixture.collides && OCCLUDER_KINDS.includes(fixture.kind))
      .map((fixture) => ({ x: fixture.x, z: fixture.z, w: fixture.w, d: fixture.d, kind: fixture.kind }))
    this._dirty = true
    this.revision += 1
    return fixtures
  }

  /**
   * One fixture, three wrapped copies.
   *
   * `window` and `porchLight` are the kinds that decorate rather than occupy
   * ground, so they are placed against the house's front wall instead of on the
   * slot itself. The slot still decides which third of the wall they go on, so
   * the fixture pass keeps its say over the layout; only the depth is borrowed
   * from the lot. Floating panels in a yard would have read as a bug.
   */
  _addFixture(fixture, lot, copy) {
    const pool = this.fixturePools[fixture.kind]
    if (!pool) return
    const shape = FIXTURE_SHAPES[fixture.kind] ?? { h: 1, lift: 0 }
    const x = fixture.x + copy * WORLD_EXTENT
    const z = fixture.z + copy * WORLD_EXTENT
    if (fixture.kind === 'window' || fixture.kind === 'porchLight') {
      if (!lot) return
      const frame = lotFrame(lot)
      const face = atDepth(frame, frame.short - frame.short * 0.55, 0)
      const sign = frame.back >= frame.front ? 1 : -1
      // the wall is canonical, so the panel has to be carried into the copy with
      // everything else — otherwise the ±1 copies' windows all pile up on the
      // canonical block and the far side of the wrap lights up for no reason
      const proud = face + copy * WORLD_EXTENT - sign * 0.08
      const panel = fixture.kind === 'window' ? 1.1 : 0.3
      if (frame.alongX) pool.place(x, shape.lift, proud, panel, shape.h, 0.1)
      else pool.place(proud, shape.lift, z, 0.1, shape.h, panel)
      return
    }
    pool.place(x, shape.lift + shape.h / 2, z, fixture.w, shape.h, fixture.d)
  }

  // -------------------------------------------------------------------------
  // collision + sight — one canonical list, translated by the wrap origin
  // -------------------------------------------------------------------------

  _collider(cx, cz, w, d, kind) {
    this.staticColliders.push({ cx, cz, hx: w / 2, hz: d / 2, kind })
  }

  _occluder(cx, cz, w, d, kind) {
    this.staticOccluders.push({ x: cx, z: cz, w, d, kind })
  }

  /**
   * recentre — snap the world to the wrapped copy the player is standing in.
   *
   * The player never wraps; the world does, in whole periods, and only ever
   * behind them. `originFor` is what makes that true in both directions: at
   * x = -230 the nearest copy is -448, and at x = +230 it is +448, so walking off
   * the eastern edge and off the western edge put the player in the same
   * neighbourhood the same way round. A floor would leave the west edge one period
   * further out than the east, and the seam would be visible in exactly one
   * direction — which is the bug the manual check for this slice is looking for.
   *
   * @returns {boolean} true when the world moved, i.e. colliders need refreshing
   */
  recentre(x, z) {
    const ox = originFor(x)
    const oz = originFor(z)
    if (ox === this.origin.x && oz === this.origin.z) return false
    this.origin = { x: ox, z: oz }
    this.group.position.set(ox, 0, oz)
    this._dirty = true
    this.revision += 1
    return true
  }

  /**
   * A canonical anchor's position in the copy currently drawn around the player.
   *
   * The optional second argument is the point to fold around, for callers that are
   * *deciding* something about the world rather than reading where it is — see
   * `worldOfNear` for why that is a different question, and for the case where the
   * difference is the bug.
   */
  worldOf(position, near) {
    if (!near) return { x: position.x + this.origin.x, z: position.z + this.origin.z }
    return this.worldOfNear(position, near)
  }

  /**
   * worldOfNear — the same fold, into the copy that would be drawn around *this*
   * point rather than the one drawn around the player.
   *
   * `worldOf` answers "where does the player see this anchor?", and that is the
   * right question everywhere except when the caller is deciding where to *put*
   * something: a placement is a question about the world as it will be, not as it
   * currently is. Folding against a stale `origin` is how slice 14 found §6.1's
   * first sighting landing on top of the player — the player had walked two
   * periods east, so "the node in your view cone" was measured from the wrong
   * copy of the map and the cone came back empty.
   *
   * Non-mutating on purpose: asking where a thing would be is not the same as
   * moving the world there, and a placement query that slides the street under
   * the player would be a much worse bug than the one it fixed.
   *
   * @param {{x: number, z: number}} position canonical
   * @param {{x: number, z: number}} near the point to fold around
   * @returns {{x: number, z: number}} folded
   */
  worldOfNear(position, near) {
    return { x: position.x + originFor(near.x), z: position.z + originFor(near.z) }
  }

  _compose() {
    const { x, z } = this.origin
    const colliders = []
    const occluders = []
    for (const box of this.staticColliders) colliders.push({ cx: box.cx + x, cz: box.cz + z, hx: box.hx, hz: box.hz })
    for (const box of this.fixtureColliders) colliders.push({ cx: box.cx + x, cz: box.cz + z, hx: box.hx, hz: box.hz })
    for (const rect of this.staticOccluders) occluders.push({ x: rect.x + x, z: rect.z + z, w: rect.w, d: rect.d, kind: rect.kind })
    for (const rect of this.fixtureOccluders) occluders.push({ x: rect.x + x, z: rect.z + z, w: rect.w, d: rect.d, kind: rect.kind })
    this.colliderList = colliders
    this.occluderList = occluders
    this._dirty = false
  }

  /** Every solid in the copy the player is in, in `PlayerController.setColliders` shape. */
  colliders() {
    if (this._dirty) this._compose()
    return this.colliderList
  }

  /**
   * Everything that blocks a sightline, for `creature.js`'s §6.3 and §8.3.
   *
   * The kinds are `creature.js`'s `OCCLUDER_KINDS` — houses, garages, sheds,
   * hedges, fences — plus the three portal shells, which block sight in the world
   * and would be lies in the AI if they did not block it in `canSee` too.
   */
  occluders() {
    if (this._dirty) this._compose()
    return this.occluderList
  }

  /**
   * Everything that blocks a sightline, in the *folded* frame, for `world.js`.
   *
   * The distinction from `occluders()` is the same one the collider list draws
   * and it exists for the same reason: the creature's own position is canonical
   * (`reemergeNode` and `streetNodeToWorld` both speak the folded frame), so the
   * rects its sight tests run against have to be in that frame too. The world's
   * distance to the player goes through `creature.js`'s `wrapDelta` instead, which
   * is the seam §3.3's fold leaves open on purpose.
   */
  canonicalOccluders() {
    return [...this.staticOccluders, ...this.fixtureOccluders]
  }

  /** The nearest lamps, in world space, for the point-light pool `world.js` owns. */
  lampsNear(x, z, radius) {
    const found = []
    for (const lamp of this.lampPositions) {
      const world = this.worldOf(lamp)
      const distance = Math.hypot(world.x - x, world.z - z)
      if (distance <= radius) found.push({ x: world.x, y: 5.1, z: world.z, distance })
    }
    found.sort((a, b) => a.distance - b.distance)
    return found
  }

  // -------------------------------------------------------------------------
  // what the world asks about
  // -------------------------------------------------------------------------

  /**
   * The portal in reach, if any (§5.2's hold verb needs a target).
   *
   * Distance is measured against the *copy the player is standing in*, not the
   * canonical anchor — the same distinction the collider list makes, for the same
   * reason: a portal 448 m away around the torus is the portal you are standing
   * next to.
   */
  nearestPortal(position) {
    let best = null
    for (const portal of this.portals) {
      const world = this.worldOf(portal.position)
      const distance = Math.hypot(position.x - world.x, position.z - world.z)
      if (distance > this.portalRange) continue
      if (best && best.distance <= distance) continue
      best = { id: portal.id, portal, position: world, distance }
    }
    return best
  }

  /** The hammer in reach, if it has not been picked up. */
  nearestHammer(position) {
    if (this.hammer.taken) return null
    const world = this.worldOf(this.hammer.position)
    const distance = Math.hypot(position.x - world.x, position.z - world.z)
    if (distance > this.pickupRange) return null
    return { hammer: this.hammer, position: world, distance }
  }

  // -------------------------------------------------------------------------
  // state the world drives in
  // -------------------------------------------------------------------------

  /**
   * setPortalShut — §5.4's permanent record of progress.
   *
   * A shut portal stays dark for the rest of the run, across every capture, so
   * this is a one-way door with no counterpart anywhere else in the codebase. That
   * asymmetry is the point: §5.3 calls it "the single most important rule in the
   * original design", and a view layer that could un-light one would quietly undo
   * the only promise the run makes to the player.
   */
  setPortalShut(id, shut = true) {
    const portal = this.portals.find((entry) => entry.id === id)
    if (!portal) return false
    portal.shut = shut
    portal.rim.material = shut ? this._materials.portalDead : this._materials.portal
    // and the core, which is the bigger half of the gate after pass 3. A shut
    // portal's disc goes from near-black to *colder* near-black rather than to
    // transparent: the shape of the opening survives §5.3 and only the light in
    // it dies, which is what "cold, dim, inert" means as a picture. A removed
    // disc would be a hole in the hole and the player walking past would read
    // the missing thing rather than the dead thing.
    portal.disc.material = shut ? this._materials.portalCoreDead : this._materials.portalCore
    // and the swirl with them, in the same breath: BEFORE pass 3 nothing in the
    // opening turned, so there was nothing here to stop.
    for (const layer of portal.swirl) layer.visible = !shut
    portal.light.intensity = shut ? 0 : 9
    portal.light.visible = !shut
    // and the apron with them, in the same breath and for the same reason: a
    // shut portal that kept a cyan pool on the ground would be advertising an
    // objective the run has already spent
    portal.apron.visible = !shut
    return true
  }

  setHammerTaken(taken = true) {
    this.hammer.taken = taken
    this.hammer.root.visible = !taken
    this.hammer.light.visible = !taken
  }

  /**
   * setHeadlights — §10.3.
   *
   * The car is dark and unremarkable from Act I, and this is the only thing that
   * changes. It is a method rather than a derived property because the trigger is
   * slice 13's finale, and because an assertion like "the car does nothing until
   * asked" is only possible if something has to ask.
   */
  setHeadlights(on) {
    this.exitCar.lit = on === true
    for (const lamp of this.exitCar.lamps) lamp.visible = this.exitCar.lit
    this.exitCar.beam.intensity = this.exitCar.lit ? 26 : 0
  }

  /**
   * update — the two light families breathing.
   *
   * Sodium flicker sits on the shared lamp material, so all 49 lamps gutter
   * together, which is how a real grid behaves and is cheaper than per-instance
   * variation. The portal pulse is the cold family's tell: a slow swell visible
   * through a gap between two houses long before the player can see the gate
   * itself, which is §4's second navigation mechanism doing its job. The swirl
   * is on the same clock, which is what keeps pass 3's motion in one family with
   * pass 1's light rather than reading as a second, unrelated animation.
   */
  update(dt) {
    this._time += dt
    const t = this._time
    const flicker = 0.88 + (Math.sin(t * 7.3) + Math.sin(t * 2.9 + 1.1) + Math.sin(t * 17.7)) * 0.04
    this._materials.sodium.color.setHex(PALETTE.sodium).multiplyScalar(flicker)
    // The pool gutters with the head above it. They share one grid on purpose, and
    // a pool that stayed steady under a guttering lamp would be the one thing in
    // the sodium family giving the flicker away.
    this._materials.sodiumPool.color.setHex(PALETTE.sodium).multiplyScalar(flicker)
    const pulse = 0.86 + Math.sin(t * 1.9) * 0.1 + Math.sin(t * 0.61) * 0.04
    for (const portal of this.portals) {
      if (portal.shut) continue
      portal.light.intensity = 9 * pulse
      // BEFORE the ring alone swelled, on its own scale, with nothing else in
      // the opening to breathe with it. AFTER the whole gate swells, so the disc,
      // the rim and the swirl are one object breathing at one rate — and the
      // per-structure factor is folded in here rather than applied to the group's
      // scale at build time, because a scale written once is a scale the swell
      // overwrites on the first frame.
      const swell = (1 + Math.sin(t * 2.3) * 0.035) * portal.gateScale
      portal.gate.scale.set(swell, swell, swell)
      // The swirl turns on the same clock, one rate per layer, and only while
      // the portal is live: the `continue` above is the reason a shut portal's
      // disc is inert, and a spiral turning in a dead thing would be the one
      // piece of motion in §5.3's silence.
      for (let layer = 0; layer < portal.swirl.length; layer += 1) {
        portal.swirl[layer].rotation.z = t * PORTAL_SWIRL_RATES[layer]
      }
    }
    if (!this.hammer.taken) {
      this.hammer.light.intensity = 3.2 * pulse
      this.hammer.root.rotation.y = t * 0.35
    }
  }

  dispose() {
    this.scene.remove(this.group)
    for (const pool of this.pools) pool.dispose()
    for (const texture of this.textures) texture.dispose()
    for (const material of Object.values(this._materials)) {
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
      else material.dispose()
    }
    this.pools = []
    this.textures = []
  }
}

export default StreetView
