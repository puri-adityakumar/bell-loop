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
  districtOf,
  originFor,
  placeObjectives,
  reservedLots,
  roadAxisToWorld,
  streetNodeId,
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
//
// ITERATION 2, PASS 7 adds `hash32` beside it, and the reason is the one thing
// `streamAt` cannot do: a GENERATOR has state, so it cannot be re-read at an
// arbitrary point, and the vending machine's flicker is asked for the same tick
// twice in the same frame (once to build, once to measure) and has to give the
// same answer. `hash32` is the stateless half of the same mix.
import { flickerAt, hash32, streamAt } from './hash.js'
// ITERATION 2, PASS 12. The portal's own motion rules — the near field, the debris
// orbits, the collapse envelope and the lensing profile — are pure and live in
// `rules.js`, which is the same split passes 9/10/11 made for the creature. The
// reason it is not the other way round is that this file imports Three.js, so a
// gate cannot call anything in it: a number decided here is a number only a
// source regex can see. `rules.js` is imported whole because a namespace is the
// file's own convention (`creature.js` is imported by name only because it
// exports one class and nothing else).
import * as rules from './rules.js'

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
  // ITERATION 2, PASS 6 — STREET FURNITURE I
  // -----------------------------------------
  // BEFORE: nothing. There was no wire, no pole, no sign, no hydrant and no
  // grate anywhere in the world, so the sky above the street was a flat amber
  // field with a hard band at the horizon and nothing in it.
  //
  // AFTER, six entries. The rule every one of them obeys is D6 — the frame has
  // four saturated things in it and this pass is not allowed to add a fifth — and
  // the second rule is AESTHETIC-NOTES §4's: a surface is a *variation on a
  // dark*, not a palette, because §12.1's silhouette rule needs every one of
  // these to stay a dark shape against a sodium haze.
  //
  //   wire       0x14120f   luma 17.6  the darkest thing in the world after the
  //                              creature, and it has to be: a wire is a
  //                              silhouette and T8's whole argument is that a
  //                              wire which fades with distance reads as depth.
  //                              Against `skyStops[0]` (luma 89) that is a 5:1
  //                              contrast, which is what makes the span legible
  //                              against the amber rather than a smudge in it.
  //   pole       0x2a2620   luma 38.0  weathered timber, one step above `roof`
  //   poleArm    0x35302a   luma 47.5  the crossarm catches more sky than the
  //                              shaft does, which is the whole of mechanism 1
  //                              applied to a 9 m vertical
  //   sign       0x4a463f   luma 70.2  the brightest furniture value, and still
  //                              under half the sky: a sign face is painted
  //                              retroreflective white and reads pale, and a
  //                              *saturated* sign is the reference's habit that
  //                              D6 inverts
  //   hydrant    0x5a2a26   luma 55.6  the one warm accent here, and it is a
  //                              desaturated oxide rather than a red, because a
  //                              red hydrant is a fifth saturated thing
  //   drain      0x1a181d   luma 23.8  a grate is a hole in the kerb, and a hole
  //                              is darker than the surface around it
  wire: 0x14120f,
  pole: 0x2a2620,
  poleArm: 0x35302a,
  sign: 0x4a463f,
  hydrant: 0x5a2a26,
  drain: 0x1a181d,
  // ITERATION 2, PASS 7 — STREET FURNITURE II
  // ----------------------------------------
  // BEFORE: nothing. Pass 6 put hardware on the PAVEMENT — poles, wires, signs,
  // hydrants, grates — and the world had no object anywhere else: no bin, no bag,
  // no bicycle, no machine, no shelter, and not one thing on a wall. AESTHETIC-
  // NOTES §5 asks for exactly this list, and its reason is the one that applies to
  // every entry below: the reference reads as a place because of *a lot of small
  // interruptions at human scale*, and eight of them per block is not a lot.
  //
  // AFTER: seven surfaces and one light. Six of the seven obey pass 6's rule
  // verbatim — a surface here is a VARIATION ON A DARK, because §12.1's silhouette
  // rule needs all of them to stay dark shapes against a sodium haze — and the
  // seventh is T11's new rung, which is a light source and is ranked as one.
  //
  //   dumpster   0x2b3038   luma 47.5  a galvanised bin, one step above `pole` and
  //                                 two below `sign`. A dumpster is a big object
  //                                 and a big object has to be DARKER than the
  //                                 building it stands against or it becomes the
  //                                 subject of the frame, which a bin is not.
  //   trashBag   0x1c1b20   luma 27.6  black polythene, the second-darkest surface
  //                                 in the world after `wire` — a bag full of
  //                                 rubbish is a hole with a lid on it, and a hole
  //                                 is darker than the thing around it (`drain`
  //                                 makes the same argument for the same reason).
  //   bike       0x2a2f36   luma 46.4  a steel frame, and one value from the
  //                                 dumpster on purpose: a bicycle is a 1.75 m
  //                                 SCRIBBLE of thin tubes, and a scribble reads
  //                                 as a scribble only if it is one value.
  //   vending    0x353a42   luma 57.5  the cabinet, and the only new surface above
  //                                 `drain` and `sign` in this block.
  //   vendingGlow 0xc9b79a  luma 184.7 T11's FIFTH RUNG — see the ladder note. It
  //                                 sits between a lamp head (177.5) and a lit
  //                                 window (198.3), which is where AESTHETIC-NOTES
  //                                 §5 puts it: "portal cyan, sodium lamp head, the
  //                                 single lit vending machine, one or two lit
  //                                 windows, the exit car's plate". A lamp head is
  //                                 a reflector seen edge-on and a lit window is a
  //                                 source seen through glass, so the machine's
  //                                 backlit liner belongs BETWEEN them, not above
  //                                 either.
  //   shelter    0x2f343b   luma 51.4  a bus shelter's steel, deliberately the
  //                                 same family as the pole arm's 47.5: a shelter
  //                                 is a pole with a roof on it, and if the two
  //                                 disagree the street loses the family read.
  //   adPanel    0x4e4839   luma 72.2  the DIM bus-shelter ad panel the checklist
  //                                 asks for. It is a `_material`, not a `_glow`,
  //                                 which is the whole of "dim": a backlit panel
  //                                 that is a fifth emissive in the frame would
  //                                 break T11's closed ladder for the sake of a
  //                                 rectangle nobody reads at 40 m. As a lit
  //                                 surface it is the second-palest furniture
  //                                 value here and it stays below the sky.
  //   poster     0x5c5749   luma 87.1  paper, and the one value in this block
  //                                 close to the sky (89.9). That is deliberate and
  //                                 it is the ONLY exception to the "under half
  //                                 the sky" rule the other six obey: a fly-poster
  //                                 is a pale rectangle on a dark wall, and if it
  //                                 is not pale it is not a poster — it is a grey
  //                                 rectangle, which is worse than nothing. It
  //                                 cannot become a light source because it is a
  //                                 `_material`, so the 87.1 is an ALBEDO the
  //                                 sodium has to reach, not a brightness.
  dumpster: 0x2b3038,
  trashBag: 0x1c1b20,
  bike: 0x2a2f36,
  vending: 0x353a42,
  vendingGlow: 0xc9b79a,
  shelter: 0x2f343b,
  adPanel: 0x4e4839,
  poster: 0x5c5749,
  // ITERATION 2, PASS 8 — WATER & REFLECTIONS
  // ---------------------------------------
  // BEFORE: nothing. Seven passes had put hardware on the pavement, joinery on
  // the buildings and markings on the ground, and the ground itself was still one
  // flat asphalt plane at one value: `asphalt` 0x17151b, luma 22.3, under every
  // surface in the frame. AESTHETIC-NOTES §5 mechanism 6 is explicit that "the
  // ground is a designed surface, not a plane" and lists gutters, drainage
  // channels with grates and lids, and oil stains among the things the reference
  // draws — and this pass is the water half of that list.
  //
  // Four entries, and the ORDER OF THEM IS THE CLAIM. Three of the four are
  // darker than `asphalt` and the fourth is the only warm one, because a puddle
  // is a hole in the value structure and a reflection is the sodium family
  // coming back off it:
  //
  //   puddle     0x0d0e11   luma 13.6  the water SURFACE. Darker than the road it
  //                                  sits in, because a puddle is a hole where
  //                                  the diffuse bounce goes and only the
  //                                  specular survives. This is the number that
  //                                  makes standing water read as a *depth*
  //                                  rather than as a pale blue decal.
  //   wetSheen   0x0a0a0c   luma  9.8  the wet halo AROUND it, darker again: the
  //                                  road under a film of water loses its
  //                                  diffuse too, and the halo has to be
  //                                  subtler than the water or the puddle reads
  //                                  as a bright island on a *dry* road.
  //   canalBed   0x0c0c0e   luma 12.0  the channel floor, the darkest large
  //                                  surface in the world. It is in shadow by
  //                                  construction — a 100 mm channel with 100 mm
  //                                  lips on both sides is a slot, and a slot's
  //                                  floor never sees the sky.
  //   waterStreak 0xffb877  luma 197.8  THE REFLECTION, and the only warm value
  //                                  in the pass. Deliberately NOT `sodium`
  //                                  (0xffa54a, 181.5): a reflection in water is
  //                                  the source with a second interface in the
  //                                  way, so it is paler and less saturated, the
  //                                  same relationship `bounce` has to `sodium`.
  //                                  And it is the ONE number here that is
  //                                  checked against a threshold from another
  //                                  module — see `STREAK_PEAK` and the eye gate
  //                                  in `verify.mjs`. A blue reflection would be
  //                                  a second cold light family in a game whose
  //                                  §12.2 contract is that cyan belongs to the
  //                                  portals alone.
  puddle: 0x0d0e11,
  wetSheen: 0x0a0a0c,
  canalBed: 0x0c0c0e,
  waterStreak: 0xffb877,
  // ITERATION 2, PASS 9 — SKY & ATMOSPHERE
  // -------------------------------------
  // BEFORE: nothing. Nine passes had filled the lower two thirds of the frame —
  // the street, the façades, the furniture, the water — and the upper third was
  // still `scene.background`, which is one flat colour. It is the *fog* colour, so
  // it agrees with the horizon perfectly and is therefore invisible as a
  // background: a sodium haze with no structure in it reads as a flat wash, and a
  // flat wash is what §12.1's "lit horizon" is not.
  //
  // Four entries, and every one of them obeys two rules the pass is held to.
  //
  // RULE 1 — WARMTH, AND IT IS A MEASURED ONE. A sky is the one place a game
  // reaches for a cold colour, and §12.2's contract is that cyan belongs to the
  // portals alone. `skyMoon` is a *pale* moon and pale reads as white, which at
  // R=G=B would sit outside the amber ramp entirely; it is pulled to
  // R > G > B and its g/r is asserted against the same 0.1 spread §12.3's ramps
  // are held to, so it is a moon seen THROUGH sodium rather than through air.
  //
  // RULE 2 — EVERY ONE OF THEM IS A DIMMING OF SOMETHING ELSE, never a new
  // light. §12.1's silhouette rule needs a dark thing to be a hole in, and
  // T11's closed ladder has no rung above `windowLit` (198.3). So:
  //
  //   skyHaze      0x6a5a3a   luma 91.1  the band tint. Drawn ADDITIVE and at a
  //                                low peak, so what reaches the frame is a
  //                                fraction of this; the number is the ceiling,
  //                                not the contribution.
  //   skyMoon      0xb9a583   luma 166.8  also additive, and the ASTRONOMICAL
  //                                value would be absurd — the contribution is
  //                                `MOON_PEAK` of it, about 30 luma against a
  //                                90-luma sky, which is a 1.3x lift. The brief
  //                                asked for "dim, occluded by haze, NOT
  //                                bright", and 1.3x is the number that says so.
  //   horizonShape 0x231d16   luma 29.7  a silhouette, and it has to stay below
  //                                the DARKEST sky stop (52.2) or the towers
  //                                stop being shapes and become holes. It is the
  //                                same rule §12.1 states for the creature, and
  //                                it is asserted at all three dusk stops.
  //   skyAsh       0x6b5a3c   luma 91.1  the motes. Additive, tiny, and drawn
  //                                BEFORE the world, so the portal paints over
  //                                them — see `ASH_RENDER_ORDER` in skyView.js
  //                                for why that is a gate and not a preference.
  skyHaze: 0x6a5a3a,
  skyMoon: 0xb9a583,
  horizonShape: 0x231d16,
  skyAsh: 0x6b5a3c,
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

// ---------------------------------------------------------------------------
// the descent — iteration 2, pass 12
//
// FOUR NUMBERS AND THREE OBJECTS, and the split is the point.
//
// Every DECISION this pass makes — how near you must be, what a rock's orbit is,
// how long a collapse lasts, how dark the lensing overlay gets — lives in
// `rules.js`, which is pure, which `verify.mjs` imports, and which is therefore
// testable by CALLING it. What is left here is geometry: how big the ring's
// mesh is, how the collapse group is parented, and which of the two share a
// buffer. `verify.mjs` asserts that this file reads those numbers and does not
// redeclare any of them, so the seam is a gate rather than a habit.
//
// The three objects are the DEBRIS (one InstancedMesh per portal), the LENS (one
// plane per portal, behind the rim in draw order and in front of the disc), and
// the COLLAPSE (one group per portal, hidden until a shutdown arms it). All
// three are children of the gate, so they inherit its quarter-turn, its offset
// and its per-structure scale, and none of those is re-derived per structure.
// ---------------------------------------------------------------------------

/**
 * The debris flake's own size, and why it is NOT `PORTAL_DEBRIS_SIZE`.
 *
 * The pure module's 0.018-0.040 m is a per-ROCK range and this is a per-MESH one.
 * A `TetrahedronGeometry` is built once at its unit size and each instance is
 * scaled into the rock's own range, so the geometry carries a number the ring
 * already owns and the two cannot drift. It is a regular tetrahedron at detail
 * 0 — four faces, no subdivision — because a flake is 5-11 px on screen and
 * anything with more than four faces is four more faces nobody will ever see.
 */
const PORTAL_FLAKE_DETAIL = 0

/**
 * The debris ring's mesh, one per portal, and the ONE number that is a view
 * decision rather than a rule.
 *
 * BEFORE pass 12: no rock existed, so this is a count read from the pure module
 * with no local floor of its own. AFTER it is `rules.PORTAL_DEBRIS_COUNT`, and
 * the local assertion is the point: an `InstancedMesh` allocates its matrix
 * buffer at construction, so a count written here and a count written in
 * `rules.js` are two counts, and the one that allocates has to be the one that
 * cannot exceed the memory. `verify.mjs` asserts the two agree and that the
 * count is at or under `PORTAL_DEBRIS_MAX`.
 */
const PORTAL_DEBRIS_CAPACITY = rules.PORTAL_DEBRIS_MAX

/**
 * The lensing overlay's plane, one per portal.
 *
 * BEFORE n/a. AFTER a `CircleGeometry` at `PORTAL_LENS.outer` core radii, which
 * is 0.965 m on the 0.72 m disc — "just larger than the disc", so the darkening
 * is a 24 cm annulus of BACKGROUND around the lip and not a disc laid over the
 * hole. The alpha comes from `rules.portalLensAlpha` sampled per texel, which is
 * the whole safety argument in one line of wiring: the function is 0 at the
 * centre, so the hole is not darkened by one level, and it is 0 at the outer
 * edge, so the quad does not end on a visible seam.
 *
 * A CIRCLE and not a plane, and the reason is the fade. A plane's corners are at
 * 1.41x its half-width, so a gradient that has reached zero at the disc's radius
 * is already zero well before the corners — the shape costs nothing and the
 * corners are never drawn.
 */
const PORTAL_LENS_SEGMENTS = 48

/**
 * The lensing overlay's draw order, and why it is a number rather than nothing.
 *
 * BEFORE n/a. AFTER 0, written out. `renderOrder` defaults to 0 and the creature's
 * eye is at 1 (pass 6), so leaving the lens at the default would put it in the same
 * bucket as the aperture and rely on the depth sort to keep the two apart. They
 * are separated by 0.03 m of gate-local z, which the depth buffer resolves, so the
 * default would in fact work — and "would in fact work" is exactly the state
 * pass 6's review found the eye gate in before it wrote the number down. The gate
 * in verify-world.mjs asserts the lens is drawn at or below the swirl's, so a
 * future feature that lifts it has to say why it is allowed over the hole.
 */
const PORTAL_LENS_RENDER_ORDER = 0

/**
 * Where the lens sits in the gate's own Z, metres, NEGATIVE.
 *
 * BEFORE this constant the lens was at `z = 0` — in front of the swirl layers
 * (-0.008, -0.016) and level with the rim's tube, which spans -0.028 to +0.028.
 *
 * THAT BROKE A PASS-3 GATE, and the gate is right and the placement was wrong. §16.1's
 * raycast check puts a camera on the §16.5.5 stand-off and asserts the FIRST thing
 * it hits is the gate and not the shell in front of it. A 0.965 m disc at z = 0 is
 * a bigger, nearer, solid target than a 0.72 m disc at -0.03, so the lens became the
 * first hit and the check reported that "the shell is in front of its own opening".
 * Nothing about the lens's appearance changed; what changed is that a transparent
 * quad was standing in a doorway where a geometry test could see it.
 *
 * -0.034 is therefore `PORTAL_CORE_INSET` plus 4 mm: behind the hole, behind both
 * swirl layers, and still in front of the shell wall the annulus is darkening. And
 * behind the swirl is the RIGHT side of that, independently of the raycast — the
 * lens's alpha is 0 across the whole disc, so it does not dim the swirl, but an
 * element that does not dim it and can still be dimmed by a later retune is one
 * refactor away from doing so, and depth order is free to get right now.
 */
const PORTAL_LENS_DEPTH = -0.034

/**
 * The collapse's twist, rad/s at a spin multiplier of 1.
 *
 * BEFORE n/a. AFTER 0.9, and the number that makes `PORTAL_COLLAPSE.spin`'s 7
 * mean something: the aperture is turning at 0.9 x 7 = 6.3 rad/s by the end of
 * the collapse, which is a little under one full turn in the last third of a
 * second. That is FAST — deliberately, and for the same reason the 7 is: this is
 * the only motion in the game that is allowed to read as machinery, because it
 * lasts 0.8 s and ends with the hole gone.
 *
 * It is a separate constant rather than a literal at the call site for the reason
 * pass 7 moved every seeded value off its call site: a number written into a
 * rotation is a number two people will change differently, and this one has to be
 * read together with the 7 it multiplies.
 */
const PORTAL_COLLAPSE_TWIST = 0.9

/**
 * The lensing texture's resolution, texels per side.
 *
 * BEFORE n/a. AFTER 96. It is a smooth radial ramp with no features in it, so it
 * is the one texture in the file where resolution is nearly free to raise and
 * nearly free to lose: at 0.965 m across and about 550 px on the §16.5.5 frame,
 * 96 texels is 5.7 texels per 30 screen pixels, and a bilinear step across a
 * 5.7-texel ramp is invisible. It is per-pixel `createImageData` like every other
 * texture here for the reason `makeSwirlTexture` gives: the headless stub keeps
 * `putImageData` and the gate can read the alpha ramp straight back off the
 * built texture, which is what lets `verify-world.mjs` measure the pupil
 * contribution of the overlay on the REAL material rather than on a comment.
 */
const PORTAL_LENS_SIZE = 96

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
 *
 * ITERATION 2, PASS 7 — 40 to 52, moved in the same commit that spent the parts and
 * with the reason written here rather than in the diff. The worst lot was 31 before
 * this pass and is 46 after (mean 13.2 -> 17.0, measured by `partBudget()`), and the
 * fifteen is the honest cost of the content: a bin is four instances, three bags are
 * six, a machine is four, a bollard run is four, and the worst lot is the one that
 * drew all of them. 52 is 46 plus six parts of headroom, which is three more than
 * the four-part rule this gate was written with — deliberately, because the next
 * pass in this iteration is ground detail and ground detail is per-lot by
 * definition. A ceiling that has to be re-litigated on every pass is a ceiling that
 * stops being a budget; what the gate protects is the MAX, and the max is measured,
 * not asserted.
 */
const LOT_PART_BUDGET = 52


// ---------------------------------------------------------------------------
// ITERATION 2, PASS 6 — STREET FURNITURE I
//
// AESTHETIC-NOTES §5's pass-6 plan puts the wire ribbon FIRST, "before anything
// is placed on it", and gives the reason: "Poles without wires look like lamp
// posts, which we already have 49 of." So the order in this block is the order
// the pass was built in — the wire system (T7 spans, T8 ribbon), then the poles
// that carry it, then the three small things that go on the ground under it.
//
// WHAT IS HERE, AND WHY IT IS ONE FILE AND NOT FOUR
// -------------------------------------------------
// A pole is nineteen instances across three pools, a sign is two across two, a
// hydrant is four across one and a gully is six across two, and the wires are a
// single `BufferGeometry` with a custom shader — nine new draw calls for the
// whole pass (eight pools and the wire mesh), on a world that already spends 31.
// The alternative (a `Group` per pole, a `Line` per span) is the ~4,600-object
// scene graph the file header rules out, and a `LineSegments` per wire is worse
// still because line width is 1 px on every desktop GL driver since 2013, which
// is exactly the shimmer T8 exists to prevent.
// ---------------------------------------------------------------------------

/**
 * Pole height, metres.
 *
 * BEFORE: n/a. AFTER: 9.2, and the number is a real one rather than a taste —
 * `DESIGN.md` §4's scale table (quoted in AESTHETIC-NOTES mechanism 2) gives
 * utility poles as 10-12 m, and a distribution pole carrying three spans on a
 * 64 m block is at the low end of that. 9.2 rather than 10.0 because the tallest
 * thing the wires have to clear is a 5.2 m house wall with a 0.34 m parapet
 * (5.54 m) and a crossarm at 8.6 m leaves 3 m of sky under the top span, which
 * is what makes the wires read as *wires over a street* rather than as a
 * catenary in an empty field. `POLE_ARM_FRACTION` below is where the crossarm
 * goes and the difference between the two is the 0.6 m of bare shaft above it,
 * which is the silhouette detail mechanism 1 asks for.
 */
const POLE_HEIGHT = 9.2

/** Where the crossarm sits, as a fraction of `POLE_HEIGHT`. A real arm is at 88-94%. */
const POLE_ARM_FRACTION = 0.93

/** Crossarm length, metres. A Japanese low-voltage arm is 1.6-2.0 m. */
const POLE_ARM_LENGTH = 1.9

/** Crossarm section, metres. Square timber, and 90 mm is what a 1.9 m arm is. */
const POLE_ARM_THICKNESS = 0.09

/** How far the two trunk insulators sit either side of the shaft, metres. */
const POLE_INSULATOR_SPACING = 0.82

/** Insulator size, metres. A pin insulator on an LV arm is 100-150 mm. */
const POLE_INSURATOR_SIZE = 0.12

/**
 * How far a pole stands from the road centreline, metres.
 *
 * BEFORE: n/a. AFTER `STREET_HALF_WIDTH` (6) plus 1.0, which puts the shaft on
 * the pavement rather than in the carriageway: the kerb face is at 6.4 and the
 * walk runs to 9.4, so 7.0 is 600 mm in from the kerb — which is where a pole
 * actually goes, because the kerb is where a van parks and the pole is the one
 * thing on the corner that must not be hit. Deriving it as
 * `STREET_HALF_WIDTH + POLE_KERB_SETBACK` rather than typing 7.0 is what keeps
 * it correct if the street is ever widened.
 */
const POLE_KERB_SETBACK = 1.0

/**
 * Where a pole stands from the road centreline, in metres.
 *
 * BEFORE: n/a. AFTER `STREET_HALF_WIDTH` (6) + `POLE_KERB_SETBACK` (1.0) = 7.0,
 * derived rather than typed so that widening the carriageway moves the poles with
 * it. The kerb FACE is at 6.4 and the walk runs to 9.4, so 7.0 is 600 mm in from
 * the kerb with 2.4 m of pavement behind it — which is where a pole actually
 * stands, because the kerb line is where a van parks and the pole is the one
 * thing on the corner that must not be hit.
 */
const POLE_STANDOFF = STREET_HALF_WIDTH + POLE_KERB_SETBACK

/** Pole shaft diameter, metres. 190-250 mm for a distribution pole. */
const POLE_DIAMETER = 0.22

/**
 * The two lower tiers' hardware, in metres.
 *
 * BEFORE: n/a — the pass had a crossarm and nothing under it. AFTER a shorter
 * bracket carrying the secondary conductors and a stub hook for the telecom
 * bundle, so the second and third tiers hang off SOMETHING. A wire that leaves a
 * pole from mid-air is the tell that gives a wireframe away, and the bracket is
 * two more instances per axis to not be it.
 *
 * The bracket is 1.1 m against the arm's 1.9 m, which is the real proportion: the
 * secondary circuit drops to two conductors, so its bar is shorter, and a bar of
 * the same length carrying fewer insulators is a bar with a gap in it.
 */
const POLE_BRACKET_LENGTH = 1.1
const POLE_HOOK_LENGTH = 0.16

/**
 * Where the small furniture stands, in metres from the road centreline.
 *
 * The pavement runs from the kerb face (6.4) to the lot line (9.4), and its
 * middle is 7.9. BEFORE: n/a. AFTER a sign at 7.3 and a hydrant at 8.5 — the sign
 * at the kerb because a sign is read from a car, the hydrant at the back because
 * a hydrant is not, and because two objects on the same corner at the same offset
 * read as a set rather than as two things that happen to be there. AESTHETIC-NOTES
 * §4's "a surface is a variation on a dark" is a placement rule here as much as a
 * colour one: furniture in a row is a row.
 */
const FURNITURE_WALK_OFFSET = STREET_HALF_WIDTH + KERB_WIDTH + SIDEWALK_WIDTH / 2
const SIGN_WALK_OFFSET = FURNITURE_WALK_OFFSET - 0.6
const HYDRANT_WALK_OFFSET = FURNITURE_WALK_OFFSET + 0.6

/**
 * How far along the kerb a gully sits from the intersection, metres.
 *
 * BEFORE: n/a. AFTER 2.5 — a gully is at the kerb LOW POINT, which is never
 * exactly in the corner because that is where the crossfall is highest.
 */
const DRAIN_ALONG = 2.5

// ---------------------------------------------------------------------------
// T7 — CATENARY SPANS
// ---------------------------------------------------------------------------

/**
 * Samples per span, and the reason it is twelve.
 *
 * BEFORE: n/a — the wires were straight lines between poles, which is the one
 * thing T7 says reads as a mistake: "a straight line between two poles reads as
 * a mistake, and a sagging one reads as a span that has been there for thirty
 * years." AFTER: a parabola, `p.y -= sag * 4t(1 - t)`, zero at both ends and
 * `sag` at the midpoint.
 *
 * Twelve and not the reference's "~14 segments per span" because ours are 64 m
 * apart and the reference's are about 20, and a parabola's faceting error goes
 * as the cube of the step over the span — three samples fewer on a span three
 * times as long is still finer curvature than the reference ever drew. Twelve
 * is also the vertex multiplier below, because the number of vertices in the
 * one buffer is `spans * (segments + 1) * 2` and every one of them is a corner
 * of a ribbon quad.
 */
const CATENARY_SEGMENTS = 12

/**
 * THE THREE TIERS, in draw order — T7's three heights and three sag amounts.
 *
 * `sag` IS A FRACTION OF THE HORIZONTAL SPAN, not a metre count, and that is the
 * load-bearing choice: it is what makes one number correct on a 64 m block edge
 * and on the 49-79 m span the seam-crossing corners produce. 0.018 of 64 m is
 * 1.15 m of drop and 0.018 of 30 m is 0.54 m. A fixed metre count is a wire that
 * droops to the pavement on the short spans and barely bends on the long ones,
 * which is the failure a fixed count produces and the reason the reference's own
 * `sag` argument is a function of span length too. The base figure the pass was
 * tuned against is the secondary row's 0.018 — BEFORE this pass there was no sag
 * at all, and a wire with no sag is the one thing T7 says reads as a mistake.
 *
 * BEFORE: one wire at one height. AFTER: three, and they are not three copies
 * of one line at three heights. They are three *circuits* with different
 * physical behaviour, which is what "heavier trunk cables sag more than telecom"
 * means:
 *
 *   trunk      8.51 m  sag 0.024  3 conductors on the crossarm: the heaviest
 *                                   cable on the pole, and the one that droops
 *                                   furthest
 *   secondary   7.91 m  sag 0.018  2 conductors on a bracket below the arm
 *   telecom     7.36 m  sag 0.011  1 bundle on its own hook: the lightest cable
 *                                   and the straightest
 *
 * The heights step down 0.6 m and 0.55 m, which is a real arm-to-bracket
 * spacing on a Japanese pole and is enough for the eye to separate three lines
 * at 30 m through fog. The sags are strictly ordered trunk > secondary >
 * telecom and `verify.mjs` asserts that ORDER out of the table rather than
 * trusting this comment — it is the claim T7 actually makes, and a table whose
 * ordering is only in prose is a table nothing checks.
 *
 * `arms` is the crossarm offset each conductor hangs at, in half-spacings of
 * `POLE_INSULATOR_SPACING`: three trunk conductors on the arm at -1/0/+1, two
 * secondary on a narrower bracket, one telecom on its own hook at the centre.
 * Six wires per pole, and the count is asserted so a tier cannot quietly lose
 * one.
 */
const WIRE_TIERS = Object.freeze([
  Object.freeze({ name: 'trunk', y: 8.51, sag: 0.024, width: 0.052, arms: Object.freeze([-1, 0, 1]) }),
  Object.freeze({ name: 'secondary', y: 7.91, sag: 0.018, width: 0.034, arms: Object.freeze([-1, 1]) }),
  Object.freeze({ name: 'telecom', y: 7.36, sag: 0.011, width: 0.021, arms: Object.freeze([0]) }),
])

/**
 * T7's last clause: "one span in five should be noticeably lower than its
 * neighbours."
 *
 * BEFORE: every span identical. AFTER: a stream test per span, and the 1-in-5
 * spans get `LOW_SPAN_SAG_MULT` times the drop. Without it the wires are a ruled
 * grid, and a ruled grid is the most legible tell that a street was generated
 * rather than built: real spans vary because the poles went up at different
 * times and the ground under them has settled.
 */
const LOW_SPAN_ONE_IN = 5
const LOW_SPAN_SAG_MULT = 1.7


// ---------------------------------------------------------------------------
// T8 — THE SCREEN-SPACE WIRE RIBBON
// ---------------------------------------------------------------------------

/**
 * `WIRE_MIN_PX` and `WIRE_COVERAGE_FLOOR` — the minimum screen width, and the
 * opacity floor for a wire too thin to reach it.
 *
 * BEFORE: n/a, there was no ribbon. AFTER 1.25 px and 0.18, and the reference
 * gives "~1.15 px" and `clamp(pxWorld / uMinPx, 0.18, 1.0)`, so both are the
 * reference's numbers with the width nudged a tenth of a pixel for a 72° field
 * on a 1.5x-pixel-ratio buffer: at 1.0 px a wire is one sample wide and shimmers
 * as the camera moves, and 1.25 px is the smallest width that still gets two
 * samples on an axis-aligned span.
 *
 * This is a *screen-space* quantity and that is the whole of T8: "thin geometry
 * is the classic way wires disappear at distance and shimmer up close; the
 * reference's answer is to make width a screen-space quantity and let opacity
 * carry sub-pixel geometry." A wire 200 m away is one pixel wide whatever its
 * real diameter, a wire 2 m away is one pixel wide too, and neither aliases.
 * The coverage fade is the other half of the trick: a wire whose real width is
 * under the minimum is still drawn AT the minimum, but at partial opacity, so
 * the amount of dark ink on the sky is right even when the geometry is not.
 */
const WIRE_MIN_PX = 1.25
const WIRE_COVERAGE_FLOOR = 0.18

/**
 * `WIRE_MAX_PX` — the width cap, and the line the whole pass turns on.
 *
 * The wire vertex shader turns a wire's real diameter into a pixel width. It
 * must divide by **clip-space `p.w`**, which in a perspective projection IS the
 * view depth, and it must NOT divide by `-p.z`.
 *
 * `-p.z` is clip-space Z, and clip Z is a *non-linear* function of depth: it is
 * the NDC depth rescaled by `w`, so dividing a world size by it divides by
 * `depth * (a + b/depth)`. Worse, it goes NEGATIVE for any geometry nearer than
 * the near plane's z-midpoint, and a negative divisor yields a negative pixel
 * width, which `clamp()` then pins to this cap. Every wire in the world becomes
 * a 13-28 px black band at coverage 1.0 — not a subtle artefact but a black
 * grid ruled across the sky.
 *
 * The two halves of the fix are the two halves of ONE contract, and both are in
 * the shader:
 *
 *   1. divide the pixel width by `p.w` (view depth), and
 *   2. clip each segment against the near plane *before* projecting it, so a
 *      wire behind the camera is removed rather than projected through it.
 *
 * The second is not optional once the first is done. A segment straddling the
 * near plane has a `p.w` approaching zero at one end, so the width goes to
 * infinity and the quad covers the screen; a segment entirely behind has a
 * `p.w` that is *negative*, which is the same pinning bug from the other
 * direction. Clipping first makes `p.w >= near > 0` for every vertex that
 * survives, and the division is then safe by construction rather than by a
 * second clamp.
 *
 * 3.4 px rather than a reference number, because a 0.05 m trunk conductor seen
 * from the 0.05 m near plane is enormous and the cap is doing real work at the
 * near end — wide enough to read as a cable up close, far short of the banding
 * the wrong divisor produces.
 *
 * `verify.mjs` reads this file as text and pins both halves. The contract check
 * is named 'the wire shader clips against the near plane', and the width
 * computation is asserted to divide by `p.w` and never by `-p.z`.
 */
const WIRE_MAX_PX = 3.4

/**
 * Traffic sign, in metres — post, plate, and where the plate sits.
 *
 * BEFORE: n/a. AFTER a 2.55 m post carrying a 600 x 400 mm plate at 2.05 m.
 * Both are real: a Japanese intersection sign goes on a 2.2-2.6 m post with the
 * face at 1.9-2.2 m, sized to be readable from a car and not from a pedestrian's
 * eyeline. The plate is one flat box and its face is `PALETTE.sign`, which is
 * *paint* and not an emissive: a sign is a retroreflective surface that catches
 * the sodium and returns it, and making it a light source would put it on T11's
 * ladder, which has four rungs and no room for a fifth (D6).
 */
const SIGN_POST_HEIGHT = 2.55
const SIGN_PLATE_Y = 2.05
const SIGN_PLATE_W = 0.6
const SIGN_PLATE_H = 0.4
const SIGN_PLATE_T = 0.05
const SIGN_POST_RADIUS = 0.045

/**
 * How many corners of each intersection carry a sign, a hydrant and a grate.
 *
 * BEFORE: n/a. AFTER two signs, a hydrant on roughly a third of corners and a
 * gully on half — all three drawn from each intersection's own stream, so which
 * corners are furnished is a property of the world rather than of build order.
 *
 * Two signs and not four because a sign on every corner of every intersection is
 * a picket fence: D6 and §5's pass-7 note both say uniformity is what makes a
 * generated street read as generated, and half the corners bare is what a real
 * street looks like. The hydrant and the grate run at *different* rates on
 * purpose — a gully is wherever the kerb has a low point, a hydrant is wherever
 * the main is, and a street where both appear at the same frequency on the same
 * corner reads as a set.
 */
const SIGNS_PER_INTERSECTION = 2
const HYDRANT_ONE_IN = 3
const DRAIN_ONE_IN = 2

/**
 * Hydrant, in metres.
 *
 * BEFORE: n/a. AFTER a 0.62 m barrel, a 0.16 m bonnet and two 0.1 m side caps. A
 * Japanese above-ground hydrant is 0.5-0.7 m to the top of the bonnet, which is
 * deliberately knee-height: it is street furniture you can see over, not
 * something that blocks a sightline, and §6.3's occluder list is deliberately
 * not extended to include it. `PALETTE.hydrant` is a desaturated oxide rather
 * than a red, for the reason in the palette comment.
 */
const HYDRANT_BODY_H = 0.62
const HYDRANT_BONNET_H = 0.16
const HYDRANT_CAP_SIZE = 0.1
const HYDRANT_BODY_RADIUS = 0.11

/**
 * Drain grate, in metres, and how far from the kerb face it sits.
 *
 * BEFORE: n/a. AFTER a 0.5 x 0.36 m frame with five bars, set into the gutter
 * 0.2 m from the kerb face. A gully grating in Japan is 300-500 mm across the
 * gully and sits at the low point, which is against the kerb; the bars are five
 * because a grate with two bars is a slot and a grate with five is a grate. It
 * is lifted `DRAIN_LIFT` above the road rather than the portal apron's 2 cm: a
 * grate is *meant* to be flush, and a 2 cm proud grate is exactly the "floating
 * object" the reference's own failure list names.
 */
const DRAIN_W = 0.5
const DRAIN_D = 0.36
const DRAIN_SETBACK = 0.2
const DRAIN_BAR_COUNT = 5
const DRAIN_BAR_T = 0.05
const DRAIN_LIFT = 0.005
/**
 * The rim, as a FRACTION of the grate — and the reason the bars are cut to the
 * rim's inner hole rather than laid across it.
 *
 * BEFORE: n/a (the grate was going to be a solid plate with bars on top, which
 * is a biscuit tin). AFTER a real annulus — `makeFrameGeometry` again, the same
 * one shape that is a window frame, a door surround, a parapet and now a gully
 * rim — and the bars are `DRAIN_W * (1 - 2 * DRAIN_FRAME_BAR)` long so they seat
 * inside it. A bar that overlapped the rim would be coplanar with it, and two
 * coplanar faces 5 mm apart z-fight on a road that is the darkest surface in
 * the frame.
 */
const DRAIN_FRAME_BAR = 0.1

/**
 * The four corners of an intersection, as (x, z) sign pairs.
 *
 * Ordered NW, NE, SE, SW so the three furniture kinds can each take a
 * different corner and never fight for the same patch of pavement. This is the
 * reference's `res` discipline (mechanism 5, "placement by reservation") in
 * its smallest form: a corner is a resource, and this pass is the only thing in
 * the codebase spending it.
 */
const CORNER_SIGNS = Object.freeze([
  Object.freeze([-1, -1]), // 0 NW
  Object.freeze([1, -1]), // 1 NE
  Object.freeze([1, 1]), // 2 SE
  Object.freeze([-1, 1]), // 3 SW
])


// ---------------------------------------------------------------------------
// ITERATION 2, PASS 7 — STREET FURNITURE II
//
// AESTHETIC-NOTES §5's pass-7 line is "Dumpsters, bollards, trash bags,
// bus-shelter ad panels (dim), and the one lit vending machine. Per-district
// placement rules, because uniformity is what makes a generated street read as
// generated." This block is the numbers, the per-district table, and the two
// exclusion rules the supervisor named for this pass.
//
// WHAT IS HERE AND WHY IT IS ONE BLOCK
// ------------------------------------
// Six families, in the order they are placed: the bins (dumpster + bags), the
// machines (cabinet + lit liner), the shelter (frame + ad panel), the bollards,
// the posters, and the bicycles — which are the odd one out, because a bicycle is
// chained to a POLE and the poles are pass 6's, so the bikes are placed from
// `_buildStreetFurniture` where the pole already is and not from the per-lot
// builder that owns everything else.
//
// A dumpster is FIVE instances, a machine four, a shelter seven, a bollard one, a
// poster one, a bicycle seven. Per lot that is at most 5 + 7 + 3 = 15 extra parts
// on the 588 lot-instances T5 pays three times over, which is why
// `LOT_PART_BUDGET` moves in this pass and the pin moves with it.
// ---------------------------------------------------------------------------

/**
 * DUMPSTER — a 240-litre commercial bin, in metres.
 *
 * BEFORE: n/a. AFTER a 1.30 x 0.78 x 1.05 body with the lid `DUMPSTER_LID_PROUD`
 * overhanging on every side. `DESIGN.md` §4 (quoted in AESTHETIC-NOTES mechanism 2)
 * prints no bin, so the number is a real one from the same family as the vending
 * machine it sits next to in this list: a 240 L wheelie bin is 0.55 x 0.72 x 1.00
 * and the 660 L commercial one it is modelled on is 1.30 x 0.78 x 1.20. 1.05 rather
 * than 1.20 because a lidded commercial bin stands on castors and the lid is what
 * a camera at 40 m actually resolves.
 */
const DUMPSTER_W = 1.3
const DUMPSTER_D = 0.78
const DUMPSTER_H = 1.05

/**
 * The lid, and why it overhangs.
 *
 * BEFORE: n/a. AFTER `DUMPSTER_LID_PROUD` proud of the body on all four sides and
 * `DUMPSTER_LID_T` thick. This is mechanism 1 (silhouette first) applied to one
 * object: a bin with a flush lid is a BOX, and a box is the thing the pass exists
 * to stop adding. 40 mm is a real cill and it is the same figure the parapet uses
 * for the same reason — a horizontal edge flush with the wall below it catches no
 * light and changes no outline.
 */
const DUMPSTER_LID_PROUD = 0.04
const DUMPSTER_LID_T = 0.06

/**
 * The castors, and the `DUMPSTER_FOOT` that lifts the body onto them.
 *
 * BEFORE: n/a. AFTER two 0.13 blocks under the front third, raising the body
 * `DUMPSTER_FOOT` (0.1) off the ground. The reason is the reference's own failure
 * list ("floating/sunken objects"): a bin whose body starts at y = 0 has no
 * contact patch, and at 40 m a floating box reads as a bug even when it is not
 * one. 0.1 m is the real clearance of a 125 mm castor.
 */
const DUMPSTER_FOOT = 0.1
const DUMPSTER_CASTOR = 0.13

/**
 * TRASH_BAG — one tied 45-litre bag, in metres.
 *
 * BEFORE: n/a. AFTER 0.52 x 0.40 x 0.58. A 45 L bag is about 0.55 m across and
 * 0.6 m tall once it is full and tied, and the numbers are deliberately not round
 * because a bag is a squashed lump and a 0.5 x 0.5 x 0.5 cube is a box. The bag
 * is placed with its own yaw off the lot's, which is the only thing in this pass
 * that makes a lump read as a lump.
 */
const TRASH_BAG_W = 0.52
const TRASH_BAG_D = 0.4
const TRASH_BAG_H = 0.58

/**
 * DISTRICT_DRESSING — how often each family appears, per DISTRICT, as `one in N`.
 *
 * BEFORE: n/a — pass 6 places one pole, two signs and maybe a hydrant per
 * intersection and nothing anywhere else, so every block in the world is the same
 * block. AFTER: four rows, four different mixes, and **three kinds are absent from
 * at least one district each** — `vending` and `bike` from district 0 (the
 * north-west), `shelter` from district 3 (the south-east). That absence is the
 * load-bearing part. AESTHETIC-NOTES §5's sentence is about uniformity making a
 * street read as generated, and a rate that is the same in four districts satisfies
 * the letter of "per district rules" and none of the intent; a kind that is missing
 * from a whole quadrant is what a player notices.
 *
 * THE COMPASS NAMES ARE MEASURED, NOT ASSUMED, and the first draft of this table
 * got two of the four wrong. `districtOf` is `(cx < half ? 0 : 1) * 2 + (cz < half
 * ? 0 : 1)`, chunk 0 is the HIGH-x, HIGH-z corner, and an N lot faces -z — so 0 is
 * north-west, 1 is SOUTH-west, 2 is north-east and 3 is south-east. (Note that this
 * is not the same numbering as `CORNER_SIGNS`, whose comments label which CORNER of
 * the junction each district's pole stands on, not which quadrant the district is;
 * the two are a permutation of each other and only the corners have to be distinct.)
 * `verify-world.mjs` derives each district's quadrant from the built lots rather
 * than from a comment, which is how the two errors were found.
 *
 * The numbers are also a COST statement. `DISTRICT_DRESSING` is the table the
 * pools' capacities are derived from, so a rate of 12 is not "rare", it is
 * "twelve lots in twelve get one" and the capacity arithmetic can be checked
 * against it rather than estimated.
 */
const DISTRICT_DRESSING = Object.freeze([
  // 0, NORTH-WEST (cx < half, cz < half): the commercial edge. Bins and bollards, and
  // no machine and no bike anywhere in the quadrant.
  Object.freeze({ dumpster: 4, bags: 3, poster: 2, vending: 0, shelter: 9, bollard: 2, bike: 0 }),
  // 1, SOUTH-WEST (cx < half, cz >= half): the residential run. Shelters, one machine
  // in seven.
  Object.freeze({ dumpster: 6, bags: 5, poster: 1, vending: 7, shelter: 4, bollard: 3, bike: 5 }),
  // 2, NORTH-EAST (cx >= half, cz < half): the transit corner. Both machines and
  // shelters, few bins.
  Object.freeze({ dumpster: 9, bags: 6, poster: 3, vending: 4, shelter: 3, bollard: 2, bike: 2 }),
  // 3, SOUTH-EAST (cx >= half, cz >= half): the back of the map. Bare — no shelter at
  // all, and on the default seed no bicycle either.
  Object.freeze({ dumpster: 12, bags: 8, poster: 4, vending: 9, shelter: 0, bollard: 5, bike: 6 }),
])

/**
 * The keys `DISTRICT_DRESSING` must carry, so a forgotten one is a failed build
 * rather than a `undefined` rate that silently places nothing.
 */
const DRESSING_KINDS = Object.freeze(['dumpster', 'bags', 'poster', 'vending', 'shelter', 'bollard', 'bike'])

/**
 * VENDING — the machine, in metres, from the scale table.
 *
 * BEFORE: n/a. AFTER 1.00 wide x 0.75 deep x 1.83 tall, which is `DESIGN.md` §4's
 * own figure ("vending machine 1.83 x 1.0 x 0.75 m", quoted verbatim in
 * AESTHETIC-NOTES mechanism 2). It is the only number in this pass that is a
 * citation rather than a judgement, and it is the tallest new object in the
 * world — which is why the carriageway set-back below, and not a height test, is
 * what keeps it out of the creature's sightline.
 */
const VENDING_W = 1
const VENDING_D = 0.75
const VENDING_H = 1.83

/**
 * The lit liner and the unlit one.
 *
 * BEFORE: n/a. AFTER a `VENDING_FACE_W` x `VENDING_FACE_H` panel set
 * `VENDING_FACE_INSET` INTO the cabinet's front, and `VENDING_RAIL_COUNT` product
 * rails across it. "Set into" rather than "on" is T3's depth rule applied to a
 * machine: a panel lying on the face is a sticker, and the reveal is the only
 * thing that makes a 1.83 m box read as a machine at 30 m. The rails are what
 * stop the lit face being a single flat rectangle, which is the exact defect
 * pass 3's swirl gate was written to catch on a portal — a lit panel with no
 * structure in it averages out to one value and stops being a machine.
 */
const VENDING_FACE_INSET = 0.05
const VENDING_FACE_W = 0.76
const VENDING_FACE_H = 1.1
const VENDING_FACE_Y = 1.12
const VENDING_RAIL_COUNT = 2
const VENDING_RAIL_T = 0.05
const VENDING_RAIL_INSET = 0.03

/**
 * VENDING_LIT_ONE_IN — how many machines have a lit liner at all.
 *
 * BEFORE: n/a. AFTER one in two. D6 caps a FRAME at four saturated things and the
 * lit machine is one of the four, so the question is not "are they lit" but "can
 * two of them be in the same shot". One in two, spread over a 1-in-4 to 1-in-9
 * per-district machine rate, keeps the lit machines APART: `verify-world.mjs`
 * measures the nearest PAIR of lit liners on the real buffers and requires 12 m
 * between them, and it is 16.8 m on the default seed.
 *
 * 12 m and not 60 m, and the reason is that the honest claim is weaker than the one
 * this paragraph first made. The fog (40-80 m of visibility) is not enough to
 * guarantee that two lit machines are never both in a frame from 16.8 m apart, so
 * the gate measures the thing that IS true — no two lit liners are within a
 * block-and-a-half of each other — and the gallery is the check for the rest. A
 * constant whose comment claims a frame-level guarantee no measurement supports is
 * worse than a smaller true claim.
 */
const VENDING_LIT_ONE_IN = 2

/**
 * VENDING_FLICKER_SEED — the documented seed for the one machine that misbehaves.
 *
 * BEFORE: n/a — the only flicker in the world was the sodium's, and it is a sum of
 * three sines with no seed at all, so it is the same in every run and could not be
 * moved by changing anything but the three numbers. AFTER: a named 32-bit seed,
 * mixed per TICK by `hash32`, so the bad machine's gutter is a pure function of
 * (seed, tick) and can be re-derived by anyone who reads the constant. D7 is the
 * reason the pass has one at all: "if a fidelity pass makes the lamps look calmer,
 * that is a regression." A vending machine's ballast is the one fitting on a
 * street that misbehaves on a different clock from the lamps, and mixing the tick
 * through `hash32` rather than reusing the lamp's three sines is what stops the
 * two families beating against each other in a way a player could learn.
 */
const VENDING_FLICKER_SEED = 0x56454e44

/**
 * The flicker's clock and its three numbers, in `vendingFlicker`.
 *
 * BEFORE: n/a. AFTER 11 Hz, a floor of 0.30 and a depth of 0.42, so the tube holds
 * somewhere in 0.58-1.00 and drops to 0.30 on a dropout. 11 Hz is deliberate
 * rather than a
 * round 10 or 12: the sodium's three sines run at 7.3 / 2.9 / 17.7 Hz, and a
 * flicker at 11 quantises against all three of them without ever landing on one,
 * which is what makes the two misbehaviours read as unrelated rather than as a
 * shared metronome. The floor is 0.30 and not 0 because a fluorescent tube that
 * goes fully out is a different tell — a dead machine — and this one is failing,
 * not dead, and a failing tube is the one that is scarier.
 *
 * `VENDING_FLICKER_DROPOUT_ONE_IN` is 8, and it is a figure rather than a fraction
 * of a period for the same reason 11 is: at 11 Hz it is one event every 0.73 s,
 * which is faster than a person can stop looking and slower than the eye stops
 * noticing it. A rarer dropout (one in twenty) reads as a single dead moment the
 * player files and forgets; a common one (one in three) reads as a disco.
 */
const VENDING_FLICKER_HZ = 11
const VENDING_FLICKER_FLOOR = 0.3
const VENDING_FLICKER_DEPTH = 0.42
const VENDING_FLICKER_DROPOUT_ONE_IN = 8

/**
 * The lit liner's own brightness, and the lift that keeps it off the cabinet's
 * front plane.
 *
 * BEFORE: n/a. AFTER `VENDING_FACE_EMISSIVE` 1.25, which is the ONE emissive
 * intensity in the file and is therefore a constant rather than a literal: it is
 * the rung T11's ladder puts between a lamp head and a lit window, and a rung that
 * is typed into a material is a rung the next pass cannot find. `VENDING_FACE_LIFT`
 * is 6 mm — the liner is set INTO the cabinet (`VENDING_FACE_INSET`) and lifted 6 mm
 * proud of the front plane so it is visible at all; the recess the eye reads at
 * 30 m is made by the two product rails standing 30 mm proud of the LINER, not by
 * sinking the liner into a box it would never be seen inside.
 */
const VENDING_FACE_EMISSIVE = 1.25
const VENDING_FACE_LIFT = 0.006

/**
 * `POSTER_ALPHA_TEST` — the torn sheet's cut-off.
 *
 * BEFORE: n/a. AFTER 0.5, and NOT 0.5 in a `transparent` material. The torn poster
 * is a hole in the sheet, and a hole is either there or it is not: an alpha BLEND
 * gives a 30 m poster a second transparent surface to sort against the house wall
 * behind it, which is a depth-sorted edge that changes with the camera and reads as
 * a shimmer. `alphaTest` is a discard, the fragment is either drawn or it is not,
 * and the torn edge stays razor sharp at every distance for free. 0.5 rather than
 * 0.1 because the print's own ink density goes down to 0.42 in the dark blocks —
 * a test at 0.1 would punch holes in the artwork, not just at the tear.
 */
const POSTER_ALPHA_TEST = 0.5

/**
 * SHELTER — a bus shelter, in metres, and the reason it is not a phone box.
 *
 * BEFORE: n/a. AFTER 3.20 long x 1.50 deep x 2.30 tall, with a
 * `SHELTER_ROOF_OVERHANG` of 0.35 m. A shelter's dimensions are fixed by its bench:
 * `DESIGN.md` §4 gives a bench seat at 0.44 m and a shelter is a roof over one, so
 * the roof is at 2.30, the bench seat is at 0.44, and the back panel is 1.85 of it.
 *
 * AND NOT A PHONE BOX, which is a decision rather than an omission. §5.1 already
 * spends two of the world's three liminal structures on exactly this silhouette —
 * `PORTAL_STRUCTURES` is `['shed', 'busShelter', 'phoneBox']` — and §4's promise is
 * that "a player who has learned to recognise the phone box is steering by a
 * memory". A second, unlit, identical box on a street corner spends that memory for
 * nothing, and the portal would then be the third bus shelter in its district
 * rather than the only one. So the checklist's "phone booths or bus shelters" is
 * answered with the shelter, which is the one of the two that is NOT already a
 * portal, and `verify.mjs` asserts that no pass-7 pool carries the portal colour
 * so the two can never be confused in a frame.
 */
const SHELTER_W = 3.2
const SHELTER_D = 1.5
const SHELTER_H = 2.3
const SHELTER_ROOF_OVERHANG = 0.35
const SHELTER_ROOF_T = 0.09
const SHELTER_POST = 0.09
const SHELTER_BACK_H = 1.85
const SHELTER_BENCH_Y = 0.44
const SHELTER_BENCH_H = 0.08
const SHELTER_BENCH_D = 0.4
const SHELTER_AD_W = 1.1
const SHELTER_AD_H = 1.7
const SHELTER_AD_Y = 1.25

/**
 * Where on a corner a shelter stands, in metres from the intersection, PER AXIS.
 *
 * BEFORE: n/a. AFTER `SHELTER_CORNER_X` 7.9 and `SHELTER_CORNER_Z` 8.0, both
 * derived rather than typed, and derived differently on purpose. The corner is where
 * two walks meet, and the only way to fit a 3.20 x 1.50 box on a 3.0 m walk is to
 * turn it: `SHELTER_CORNER_X` is the walk's own midline
 * (`STREET_HALF_WIDTH` + `KERB_WIDTH` + `SIDEWALK_WIDTH / 2`) and the shelter is
 * 1.50 deep across it, so it spans 7.15-8.65 with 0.75 m of walk on either side.
 * `SHELTER_CORNER_Z` is the KERB face plus half the shelter's LENGTH, so its front
 * post finishes on the kerb and its back panel 0.2 m behind the frontage line —
 * which is inside the 0.5 m hedge run and is what a shelter standing against a
 * boundary actually looks like. The first draft of this paragraph claimed the back
 * was flush and it was not; the 0.2 m is the real number and it is harmless, since
 * the only thing at the frontage is a 1.3 m hedge.
 *
 * Both are at least `STREET_HALF_WIDTH + KERB_WIDTH` (6.4) from their own road's
 * centreline, which is the number `verify-world.mjs` measures every pass-7 instance
 * against: the creature walks the carriageway, so furniture inside 6.0 m of a
 * centreline is furniture in its eye line, and 6.4 is the kerb face between the two.
 */
const SHELTER_CORNER_X = STREET_HALF_WIDTH + KERB_WIDTH + SIDEWALK_WIDTH / 2
const SHELTER_CORNER_Z = STREET_HALF_WIDTH + KERB_WIDTH + SHELTER_W / 2

/**
 * BOLLARD — a kerb bollard, in metres.
 *
 * BEFORE: n/a. AFTER 0.90 tall, 0.11 across, with a `BOLLARD_CAP_H` retroreflective
 * band. Real Japanese kerb bollards are 0.8-1.0 m and 80-120 mm, and the band is
 * the strip that makes one visible in a headlight — which is the whole reason a
 * bollard is a bollard and not a short post. It is placed in `painted`, the same
 * material as the signs and the pole insulators, so it costs no new material and
 * no new draw call, which is T1's "one material serves every colour" taken
 * literally rather than as a comment.
 */
const BOLLARD_H = 0.9
const BOLLARD_R = 0.055
const BOLLARD_CAP_H = 0.1
const BOLLARDS_PER_RUN = 2
const BOLLARD_RUN_SPACING = 2.2

/**
 * POSTER — a fly-poster, in metres, and how far off the wall it is.
 *
 * BEFORE: n/a. AFTER a 0.42 x 0.60 sheet standing `POSTER_LIFT` (6 mm) proud of the
 * siding at `POSTER_Y` (1.55 m). The lift is T10's decal discipline verbatim: a
 * poster flush with the wall z-fights, and a z-fight in a still capture is a
 * defect a reader finds instantly. 1.55 m is chest height, which is where a
 * fly-poster goes and where a player walking past reads it; 0.42 x 0.60 is an A2
 * sheet with the corners left on. `POSTER_U` is 0.3 of the wall's own width, which
 * is the same inset fraction as `WINDOW_INSET` and for the same reason — a sheet
 * hard against a corner reads as a crack.
 */
const POSTER_W = 0.42
const POSTER_H = 0.6
const POSTER_LIFT = 0.006
const POSTER_Y = 1.55
const POSTER_U = 0.3
const POSTER_TORN_ONE_IN = 3

/**
 * BIKE — a bicycle, in metres, and the reason it is built from seven parts.
 *
 * BEFORE: n/a. AFTER a 1.75 m machine on a 1.05 m wheelbase with 0.67 m wheels,
 * which is `DESIGN.md` §4's bicycle again and a real 700c. Seven instances: two
 * wheels, a main triangle in two bars, a saddle, a handlebar, and the chain. A
 * bicycle is silhouette-thin (AESTHETIC-NOTES §0: "each interruption is 8-40
 * triangles") and at 40 m what resolves is two discs and a diagonal, so the frame
 * is two bars rather than eight tubes.
 *
 * `BIKE_WHEEL_R` is 0.335, not 0.34: a 700c wheel with a 25 mm tyre is 0.67 m across
 * the tyre and 0.69 across the rim, and 0.335 is the tyre radius.
 */
const BIKE_WHEEL_R = 0.335
const BIKE_WHEEL_T = 0.04
const BIKE_WHEELBASE = 1.05
const BIKE_FRAME_T = 0.05
const BIKE_LOWER_Y = 0.42
const BIKE_UPPER_Y = 0.86
const BIKE_SADDLE_Y = 0.98
const BIKE_BAR_Y = 1.04
const BIKE_BAR_W = 0.44
const BIKE_SADDLE_W = 0.24
const BIKE_CHAIN_R = 0.11
const BIKE_CHAIN_T = 0.02
const BIKE_PARK_OFFSET = 0.62
const BIKE_PARK_SPACING = 1.1

/**
 * PORTAL_FURNITURE_CLEAR — the exclusion zone the supervisor named for this pass.
 *
 * BEFORE: n/a, and that is the interesting part. There was no exclusion because
 * there was nothing to exclude: pass 6's furniture stands on the PAVEMENT and a
 * portal stands in a LOT behind the frontage, so the two had never met. This pass
 * puts objects on the pavement in front of a lot AND in the lot's side yard, which
 * is the first time a piece of street furniture can be anywhere near a portal's
 * stand-off.
 *
 * AFTER: 12 m, and the number is derived rather than chosen. §16.5.5 photographs
 * portal A from 4.5 m out on the structure's own `facing`; a 2.30 m shelter standing
 * between that camera and a 1.18 m gate is the one new object in the world that
 * could put something other than the portal in the middle of `portal-located.png`,
 * and the pupil luma the pass-3 gate measures (luma <= 20) is a measurement OF THE
 * HOLE — so a foreground object does not merely look wrong there, it invalidates
 * the gate. 12 m is 2.7x the stand-off, which keeps the whole frontage run of a
 * portal's own lot clear; that is also the right thing for a player walking up to
 * one, which is the other reason the number is generous rather than minimal.
 *
 * It is checked rather than commented. `verify-world.mjs` reads every pass-7
 * instance back out of the matrix buffers and requires its distance to all three
 * portal anchors to be at least this, AND requires the filter to have REJECTED
 * something: a rule that never fires is the "filter, not a spatial test" the
 * pass-6 review left as residual risk, and this is the pass that closes it.
 */
const PORTAL_FURNITURE_CLEAR = 12

/**
 * The two set-backs that keep the new pavement objects off the carriageway, in
 * metres in front of a lot's frontage line.
 *
 * BEFORE: n/a. AFTER `VENDING_SETBACK` 1.1 and `BOLLARD_SETBACK` 2.4. (This block
 * also carried a `SHELTER_SETBACK` until the shelter moved to being an INTERSECTION
 * object — see `SHELTER_CORNER_X`, which derives the same intent from the kerb face
 * and the shelter's own length. A constant with no caller is a comment that has
 * drifted out of the code, so it is deleted rather than kept "for symmetry".)
 *
 * The arithmetic that matters is the lot's: the walk runs from `STREET_HALF_WIDTH` 6
 * + `KERB_WIDTH` 0.4 out to 9.4, so a set-back `s` measured in front of the frontage
 * stands `9.4 - s` from the centreline. A machine is therefore at 8.3 m and a
 * bollard at 7.0 m — both on the walk, and clear of the kerb face at 6.4 m by 1.9
 * and 0.6 m. (The first draft of this paragraph claimed 7.9 and 6.6 and was wrong by
 * the same half-metre twice, which is what a comment nobody recomputed looks like;
 * `verify-world.mjs` now measures the real distance instead of trusting it.)
 *
 * `BOLLARD_SETBACK` is the one that is not decoration: a bollard at the kerb is then
 * at 7.0 m, and `verify-world.mjs` requires EVERY pass-7 instance
 * to be more than `STREET_HALF_WIDTH + KERB_WIDTH` (6.4) from every road
 * centreline. That single number is what keeps this pass's furniture out of the
 * creature's eye line, because the creature walks the carriageway and its eye is
 * the one mark `creatureContrast` anchors on. It is the structural form of "the eye
 * gate must still pass", as `PORTAL_FURNITURE_CLEAR` is the structural form of
 * "the pupil must stay luma <= 20".
 */
const VENDING_SETBACK = 1.1
const BOLLARD_SETBACK = 2.4

/**
 * DUMPSTER_INWARD and DUMPSTER_ALONG — where a bin goes, and WHY IT IS THERE.
 *
 * BEFORE: n/a. AFTER `DUMPSTER_INWARD` 0.72 of the lot's depth (7.2 m of 10) and
 * `DUMPSTER_ALONG` 0.425 of its length (11.05 m of 26), which puts it in the SIDE
 * YARD at the back of the lot.
 *
 * The brief says "behind buildings" and this is the only honest place for that in
 * this world, and the reason is a property of the lot geometry rather than a
 * choice: `_addLot` places the house at `atDepth(frame, frame.short - depth, depth)`,
 * whose back face lands on the lot's BACK EDGE exactly. There is no rear yard to
 * put a bin in. What there is, on a 26 x 10 m lot carrying a 0.7 x 26 m house, is
 * 3.9 m of side gap either side of the building running the full depth — and the
 * back 5.5 m of that gap is behind the frontage, invisible from the street, which is
 * where a real bin is. 0.425 of the length is the middle of that gap: 0.5 would be
 * the lot's own edge, 0.35 the house's flank, and 0.425 clears both by a metre.
 */
const DUMPSTER_INWARD = 0.72
const DUMPSTER_ALONG = 0.425
const TRASH_BAG_ONE_IN = 2
const TRASH_BAGS_MAX = 3
const TRASH_BAG_JITTER = 0.34

/**
 * `DRESSING_SALT` and the three salts that are not a region.
 *
 * BEFORE: n/a. AFTER four offsets into `hash32`'s 32-bit mix. The salts are what
 * stop this pass from moving pass 5's lit windows or pass 6's poles when it adds a
 * draw to a shared stream: `hash32` adds its arguments before mixing, so two
 * streams whose coordinate pairs differ are unrelated, and a stream that differed
 * only in its *consumption order* would move every draw after it.
 * `DRESSING_SALT` is the per-lot region's own seed and `VENDING_SALT` is a second,
 * independent region for the machine roll, so a pass that added a bin could not
 * re-roll a machine. The two flicker salts are the tick and the phase, neither of
 * which is a coordinate.
 */
const DRESSING_SALT = 0x44524553
const VENDING_SALT = 0x56454e53
const VENDING_FLICKER_TICK_SALT = 0x5449434b
const VENDING_FLICKER_PHASE_SALT = 0x50484153


// ---------------------------------------------------------------------------
// ITERATION 2, PASS 8 — WATER & REFLECTIONS
//
// AESTHETIC-NOTES §5 mechanism 6: "The ground is a designed surface, not a
// plane. Gutters, drainage channels with grates and lids, manhole covers,
// repair patches, trenches, seals, oil stains, worn tyre paths, centre dashes,
// stop lines, crossings, tactile paving."
//
// The ground already had pass 6's grates and pass 7's furniture on it. What it
// had never had was WATER, and water is the cheapest way to make an asphalt
// plane read as a surface: a dry road is a colour, a wet one is a MIRROR, and a
// mirror is the only thing in this world that gives the sodium back to the
// player as a shape rather than as a wash.
//
// THE TECHNIQUE, AND WHY IT IS NOT A RENDER TARGET
// ------------------------------------------------
// A real reflection needs a second camera and a render target. This pass uses
// the trick every real-time game used before render targets were cheap: the
// reflection is DRAWN, as a stretched additive quad lying on the ground with
// its long axis pointing away from the viewer along the line between the lamp
// and the eye. At 11 m that is a 9 x 1.3 m streak of `waterStreak` and it
// reads as a sodium lamp smeared down a wet road. It costs two triangles and
// no second pass, and `verify-world.mjs` asserts there is no render target and
// no second render pass anywhere in the world.
// ---------------------------------------------------------------------------

/**
 * Puddles and where they are allowed to be.
 *
 * BEFORE: n/a — there was no water. AFTER three named bands, and the bands are
 * the claim: a puddle is only ever in one of them, because water on a cambered
 * street runs to the low points and nowhere else.
 *
 *   GUTTER   `STREET_HALF_WIDTH - PUDDLE_GUTTER_INSET` from a road centreline,
 *            i.e. in the 200 mm channel between the kerb face and the tarmac.
 *            The gutter is the lowest line on the road by construction: the
 *            camber is 2.5% and the kerb is 150 mm proud, so the water has
 *            exactly one place to go and that place is against the kerb.
 *   CROSSING the carriageway of the avenue, in the wheel tracks. Water stands
 *            in a dip, and a cambered road has two of them across its width.
 *   CANAL    beside the drainage channel, which is a trough and therefore the
 *            one place on the street already below the water table.
 *
 * The three are the WHOLE list. A puddle in the middle of a lane on a cambered
 * road is a rendering artefact, and `verify-world.mjs` measures every instance
 * against all three bands rather than trusting this comment.
 */
const PUDDLE_GUTTER_INSET = 0.7
const PUDDLE_CROSSING_OFFSET = 2.1
const PUDDLE_CANAL_SETBACK = 0.85

/**
 * Puddle sizes, in metres, as a radius on the short axis.
 *
 * BEFORE: n/a. AFTER 0.55 to 2.4 m, which is the real range for a puddle in a
 * gutter after rain: a 1.1 m disc is a full stop across a 0.4 m gutter, and
 * 2.4 m is a sheet that has found the low point of a whole intersection. The
 * LONG axis is `radius * PUDDLE_ELONGATION` because every one of these is
 * stretched by the thing that made it — a gutter puddle is a stripe, a
 * crossing one a long oval across the road, and a circular puddle against a
 * straight kerb is a painted disc.
 *
 * `PUDDLE_ELONGATION` 1.9 and NOT a big number, for the reason the reference
 * gives its own stretched gutters: "stretched gutters (to stop mip bleed)". A
 * circle scaled 1.9x is an ellipse, and an ellipse in a gutter is what water
 * does. 4x would be a lens.
 *
 * THERE IS NO `PUDDLE_R_MAX`, and there was one until this pass was measured.
 * The radius used to be drawn from `[PUDDLE_R_MIN, 2.4]` for every band, which
 * is fine for the crossing band (which has 2.1 m of road either side of its
 * centre) and absurd for the gutter band (which has 0.7 m) — a third of the
 * world's puddles were lying on the pavement. Rather than shrink the global
 * number, which would have made the crossing puddles small to compensate for a
 * mistake the crossing band was not making, each band now draws into the room it
 * was GIVEN, and those three constants are the whole of the size story:
 *
 *     gutter   PUDDLE_GUTTER_INSET      0.70 m
 *     canal    PUDDLE_CANAL_SETBACK    0.85 m
 *     crossing PUDDLE_CROSSING_OFFSET  2.10 m   (the largest, and the only one
 *                                                    that is a puddle a person
 *                                                    would call a puddle)
 *
 * One fewer constant, three named bounds, and a band moved further out from the
 * kerb gets more room with no edit here. `verify.mjs` asserts each is in a real
 * range and `verify-world.mjs` measures what was placed.
 */
const PUDDLE_R_MIN = 0.55
const PUDDLE_ELONGATION = 1.9

/**
 * `PUDDLE_SEGMENTS` and `PUDDLE_CANDIDATES_PER_NODE` — the disc's resolution
 * and the size of the candidate list.
 *
 * BEFORE: n/a. AFTER 10 segments (20 triangles) and 8 candidates per node.
 *
 * `PUDDLE_SEGMENTS` 10 and not 32, and the reason is the same one that puts
 * `BOLLARD_SETBACK` at 2.4 rather than 1.2: a puddle is at most 2.4 m and is
 * seen at 11-60 m, where 2.4 m is 105 px across and a 10-gon's edge subtends
 * about 1.7 px. A 32-segment disc would spend 64 triangles to move that edge
 * inside a pixel, on a surface whose value differs from the asphalt around it
 * by less than the eye resolves there anyway. 10 is the number at which the
 * silhouette stops being a polygon, and `verify-world.mjs` asserts it has not
 * been raised without the triangle budget moving with it.
 *
 * `PUDDLE_CANDIDATES_PER_NODE` 8 is 2 per gutter line (one each side of both
 * roads) and is the denominator `PUDDLE_ONE_IN` draws against. It is a MAXIMUM
 * and the capacity multiplies it out, so a seed that hits 0 on all eight draws
 * 8 puddles at a node and loses nothing. The alternative — sizing the pool to
 * the 190 this seed actually places — is the pass-5 window-frame bug with the
 * serial numbers filed off.
 */
const PUDDLE_SEGMENTS = 10
const PUDDLE_CANDIDATES_PER_NODE = 8

/**
 * `PUDDLE_ONE_IN` — how many of a node's candidate spots actually get water.
 *
 * BEFORE: n/a. AFTER 3, so roughly a third of the candidates. This is the
 * number that decides whether a street reads as WET or as DECORATED, and the
 * reference is unambiguous that it is the second: it draws drainage because the
 * street drains, not because puddles are a feature. One in three across a 49
 * node map is about 190 puddles over three wrapped copies — one every 2.3 m of
 * kerb, enough that a player walking a block meets water, few enough that the
 * road is still mostly road.
 */
const PUDDLE_ONE_IN = 3

/**
 * The wet halo: how far the darkened road reaches past the water, and how dark.
 *
 * BEFORE: n/a — `asphalt` is one flat value everywhere. AFTER a second, LARGER,
 * DARKER disc under every puddle, and the brief's "wet-road darkening near the
 * puddles (roughness modulation via a blended darker overlay disc)" is this
 * constant pair.
 *
 * `PUDDLE_HALO_SPREAD` 1.75 and NOT 1.0, and the reason is that a halo the same
 * size as the water is invisible: the eye reads such a pair as one shape. The
 * halo has to extend past the puddle on every side, because what a viewer
 * actually notices is the DARKENING of the road, not the puddle — a wet road
 * goes dark for a metre either side of the water and that gradient is the whole
 * read. 1.75 puts the visible edge of the damp at 0.75 of a radius beyond the
 * water, which on the mean puddle is about 0.7 m of visible damp.
 *
 * `PUDDLE_HALO_OPACITY` 0.55: the halo is a BLEND over the asphalt, not a
 * replacement for it, and the number is a fraction rather than a colour because
 * the asphalt underneath is already textured and lit. At 1.0 the halo would be
 * a painted disc of `wetSheen`; at 0.55 the road is still asphalt under a film
 * of water, and the sodium pool still lands on it.
 */
const PUDDLE_HALO_SPREAD = 1.75
const PUDDLE_HALO_OPACITY = 0.55

/**
 * The two LIFTS, in metres, and the reason they are 10 mm apart.
 *
 * BEFORE: n/a. AFTER the halo at `PUDDLE_HALO_LIFT` and the water at
 * `PUDDLE_HALO_LIFT + PUDDLE_LIFT_GAP`, both above the road plane at y = 0.
 *
 * The pass-6 review's residual risk was z-fighting: "a 2 cm proud grate is
 * exactly the 'floating object' the reference's own failure list names", and
 * the drain grate answered it with `DRAIN_LIFT` 0.005. Water cannot use 5 mm,
 * because a puddle at 5 mm and its halo at 3 mm are 2 mm apart over a 4 m disc
 * and a 1280x720 buffer with a 0.05-260 m near/far range resolves that at
 * grazing angles — which is the ONLY angle a puddle is ever seen from. So:
 *
 *  - `PUDDLE_HALO_LIFT` 0.010 — twice the grate's, and still 6 mm below the
 *    0.016 the drain's own kerb sits at, so nothing in this pass rises above
 *    pass 6's hardware.
 *  - `PUDDLE_LIFT_GAP` 0.004 — the separation between the halo and the water.
 *    Four millimetres at a 0.05 m near plane is 8% of the near plane, which is
 *    well outside the depth buffer's error at any distance a player stands.
 *
 * And the halo's own disc is `PUDDLE_HALO_SPREAD` larger than the water, so
 * even where the two are coplanar in screen space the halo's edge is 0.75 of a
 * radius outside the water and the overlap is a broad annulus rather than a
 * seam.
 */
const PUDDLE_HALO_LIFT = 0.01
const PUDDLE_LIFT_GAP = 0.004

/**
 * `STREAK_RIM` — the reflection streak's falloff floor.
 *
 * BEFORE: n/a (the streak did not exist). AFTER 0.45, i.e. the streak is built
 * from `makePoolTexture` with the SAME `rim + (1 - rim)(1 - r²)²` curve pass 2
 * gave the sodium pools, at 45% of that rim.
 *
 * Why a shared curve rather than a new one: a reflection and the light it
 * reflects have the same angular falloff, because both are the same lamp seen
 * through the same air. Giving the streak its own profile would be inventing a
 * second law of optics for one quad, and `verify.mjs` asserts the two share
 * `makePoolTexture` so a future edit to one cannot leave the other behind.
 *
 * Why 0.45 and not `LAMP_POOL_RIM`'s 0.82: the pool's rim was raised in pass 2
 * so an 18 m disc would read as a pool rather than a smudge. A streak is a
 * streak — a bright head and a long tail is the entire phenomenon — and a high
 * rim on a 9 x 1.3 m quad turns the tail into a second, brighter, parallel
 * streak. 0.45 keeps the tail visibly dimmer than the head, which is what makes
 * the eye read it as one object receding.
 */
const STREAK_RIM = 0.45

/**
 * `CANAL_SHIMMER_TILES` — how many times the shimmer map repeats along the
 * channel, and `CANAL_LIP_*` the concrete that contains the water.
 *
 * BEFORE: n/a. AFTER 7 tiles over 26 m (3.7 m per tile) and a 100 mm lip on
 * each side of a 90 mm-deep, 1.1 m-wide channel.
 *
 * `CANAL_SHIMMER_TILES` 7 is derived from the band count rather than picked:
 * `makeShimmerTexture` puts 1, 2 and 4 cycles across the channel's WIDTH, which
 * is 1.1 m, so the three bands repeat every 1.1 m across it and a 3.7 m tile
 * carries two full cycles of the along-channel swell — enough structure to read
 * as moving water at 11 m (48 px). The frequencies are whole numbers BECAUSE a
 * sine meets its own tile edge only at an integer cycle, and `RepeatWrapping` on
 * a map that does not meet itself draws that discontinuity as a hard seam once
 * per tile. The honest cost is that the pattern DOES repeat, every 3.71 m,
 * where the previous version of this comment claimed it did not; at the
 * 5.6-31.6 m the canal is actually read from, that repeat is below the
 * threshold at which the eye resolves one. A seam every 3.7 m is the
 * smaller artefact.
 *
 * `update()` scrolls `offset.x` by `CANAL_SHIMMER_MPS * dt /
 * (CANAL_LEN / CANAL_SHIMMER_TILES)`, so the metres-per-second on the constant
 * is metres per second ON THE GROUND only if the map's U axis runs ALONG the
 * 26 m channel. It did not, and this paragraph used to assert that it did. The
 * water plane was laid down with `rotateX(-PI/2)` alone, which leaves U on the
 * local X that `place()` scales by `CANAL_W` — so the scroll crossed the 1.1 m
 * WIDTH at 0.0025 m/s, 23.6x slow and 90 degrees from the flow. The divisor was
 * right and the axis was not, and a delta check that recomputes this same
 * formula cannot see which. The pool's geometry now also carries
 * `rotateY(PI/2)`, and `verify-world.mjs` measures the U axis off the BUILT
 * geometry and converts it to metres-per-second rather than re-deriving it.
 *
 * `CANAL_LIP_H` 0.1 and `CANAL_DEPTH` 0.09: a 100 mm upstand with the water
 * 10 mm below its top. A real 側溝 is a precast concrete U — a 450-900 mm
 * channel in a 300 mm wall — and the lip is what makes it a CHANNEL rather than
 * a dark stripe painted on the road. It is also the cheapest possible depth cue:
 * two 100 mm edges with a 90 mm gap between them parallax against each other the
 * moment the camera moves, and that parallax is the entire difference between
 * "water" and "a dark line".
 */
const CANAL_SHIMMER_TILES = 7
const CANAL_LIP_T = 0.12

/**
 * Where the canal's candidates and the streak sit, in metres from the node.
 *
 * BEFORE: n/a. AFTER a gutter range of 9-26 m along the block, a crossing
 * 14 m out, a canal 21 m out, and a streak 1.2 m from the lamp.
 *
 * `PUDDLE_GUTTER_ALONG_MIN` 9 and `MAX` 26 is a RANGE and not a fixed distance
 * for the reason `DRAIN_ALONG` is fixed at 2.5: a gully is at the kerb's low
 * point, which is a fixed offset, but a PUDDLE is wherever the water happened to
 * stop, and a street where every puddle is 15 m from every corner is a street
 * with a rule instead of a puddle. 9-26 m puts them in the middle two thirds of
 * a 64 m block, which is where a viewer walking the block meets them.
 *
 * `PUDDLE_CROSSING_ALONG` 14: the crossing candidates sit 14 m up the avenue
 * from the junction, clear of the 12 m carriageway box, so they are in the road
 * a player drives along rather than standing in the middle of an intersection.
 *
 * `CANAL_CANAL_OFFSET` 9: the channel is 9 m along the east-west street from
 * the junction, so it CROSSES that street's carriageway (which ends 6 m either
 * side of the node) and then runs 7 m into the block on each side. That is the
 * "crossing a street segment" the brief asks for, and 9 is clear of the 6 m
 * carriageway box so the channel is not lying across the middle of an
 * intersection. A channel that crosses a road runs PERPENDICULAR to it, so this
 * one runs in z — the first version ran it in x, which put 26 m of standing
 * water 21 m from the nearest road centreline, in the middle of a block.
 *
 * `CANAL_CANAL_PUDDLE_ALONG` 4: the canal band's own two puddles sit 4 m along
 * the channel from the node, INSIDE the 12 m of carriageway the channel crosses
 * (which is `STREET_HALF_WIDTH` = 6 either side). The first version used 8, on
 * the reasoning that "further along the channel" read as more clearly part of
 * the channel — and 8 is 2 m past the kerb, so both puddles sat on the pavement
 * of the block the channel runs into. The measurement is what caught it: the
 * band is 2 candidates wide, so being entirely off the road reads as "the canal
 * has no water in it" and is easy to mistake for a counting error. Water
 * standing against a channel is standing in the road, where a viewer at the
 * §16.5 node is looking.
 *
 * `STREAK_LIFT` 0.026 — the streak is the TOPMOST thing on the road, above the
 * puddle at 0.014 and the halo at 0.010, because it is additive and additive
 * geometry that is occluded by its own puddle is a reflection you cannot see
 * from any angle but directly above.
 */
const PUDDLE_GUTTER_ALONG_MIN = 9
const PUDDLE_GUTTER_ALONG_MAX = 26
const PUDDLE_CROSSING_ALONG = 14
const CANAL_CANAL_OFFSET = 9
const CANAL_CANAL_PUDDLE_ALONG = 4
const STREAK_LIFT = 0.026

/**
 * The reflection streak, in metres: length along the lamp-to-eye line, width
 * across it, and how far out from the lamp's own ground point it starts.
 *
 * BEFORE: n/a. AFTER 9.0 x 1.3, starting 1.2 m out from under the lamp head.
 *
 * This is the whole "elongated vertical streak" the brief asks for, and the
 * three numbers are one geometric fact rather than three tunings:
 *
 *  - The streak is LONG (9.0 m) and NARROW (1.3 m) because the specular
 *    reflection of a point source in a rough horizontal surface is a streak
 *    ALONG the view line, not a disc. A disc would be a mirror, and the world
 *    has four point lights for 49 lamps, so a mirror is not available — and a
 *    streak is more truthful besides, because real asphalt is not a mirror.
 *  - The width is 1.3 m because that is a 1.9 m sodium head smeared by the
 *    surface roughness of asphalt, and not less: a sub-metre streak on an 18 m
 *    light pool is a thread, and a thread reads as an artefact, not a
 *    reflection.
 *  - It starts at the KERB FACE and not at the lamp's own ground point. The lamp
 *    stands `STREET_HALF_WIDTH + 1.6` = 7.6 m off the centreline and the kerb
 *    face is at `STREET_HALF_WIDTH + KERB_WIDTH` = 6.4, so a head placed under
 *    the lamp is 1.2 m OUTSIDE the carriageway — on the pavement, which is
 *    where the first version of this pass put the entire streak. A reflection of
 *    a streetlight appears in the road, not on the footway beside it, and the
 *    error is invisible to every structural check: the geometry is well formed,
 *    the count is right, and only a screenshot shows a bright smear on the
 *    concrete. `verify-world.mjs` measures every streak against the kerb face
 *    now, from the side the pass-6 furniture check does not look at.
 *
 * `STREAK_ROAD_INSET` 1.5 and not 0: the streak lies 1.5 m in from the kerb face
 * rather than on it, because the outermost 0.4 m of a carriageway is where the
 * camber is steepest and where a gutter puddle already is. Putting the
 * reflection in the same band as the puddles is what makes the two read as one
 * phenomenon — wet road with standing water in it — rather than as a lit strip
 * and some unrelated puddles.
 *
 * `STREAK_PEAK` is the one number here checked against a threshold owned by
 * another module. `tools/png-luma.mjs` finds the creature's eye by flood-filling
 * blobs at or above `EYE_MIN` (150) and rejecting anything wider or taller than
 * `EYE_MAX_SPAN` (14 px). A reflection streak is a WARM, ADDITIVE, unfogged-
 * bright quad on the ground, and if it can reach 150 luma in a patch compact
 * enough it becomes a candidate eye — and a candidate eye out-brighter than the
 * real one makes `creatureContrast` measure the body of nothing and report no
 * creature in a frame that has one.
 *
 * So the ceiling is derived, not guessed: `waterStreak` is luma 197.8 and
 * `STREAK_PEAK` 0.55 puts the peak contribution at 108.8, which is 27% below the
 * 150 the eye finder starts at — before the ACES curve at `EXPOSURE_BASE` and
 * the fog at 11 m have taken any of it. `verify.mjs` asserts the product stays
 * under `EYE_MIN` and `verify-world.mjs` asserts the material really is
 * additive and really is warm, so the arithmetic cannot quietly stop holding.
 */
const STREAK_LEN = 9.0
const STREAK_W = 1.3
const STREAK_ROAD_INSET = 1.5
const STREAK_PEAK = 0.55

/**
 * The drainage canal — the one long piece of standing water in the world.
 *
 * BEFORE: n/a. AFTER a 26 m channel crossing the carriageway at `CANAL_NODE`,
 * with `CANAL_W` of standing water between two 100 mm lips.
 *
 * It is placed at ONE node rather than scattered, and that is the brief's own
 * wording: "one long drainage canal or flooded gutter crossing a street
 * segment". A drainage channel is infrastructure — it follows the low gradient
 * of a real street, and infrastructure is singular. A puddle field is the
 * opposite: water is everywhere after rain, and everywhere is not a feature.
 *
 * `CANAL_NODE` is the §16.5 node, and the reason is stated rather than hidden:
 * the fourteen photographs stand on that intersection, so a canal anywhere else
 * is a canal no gate and no reviewer ever sees. Pass 7's review made exactly
 * this point about furniture — "the whole gallery photographs a single corner of
 * a 448 m world" — and this is the first pass to act on it.
 *
 * `CANAL_W` 1.1 m: a real roadside drainage channel (側溝) is 300-600 mm of
 * water in a 450-900 mm concrete U, and 1.1 m is the outside of that U. Wide
 * enough to read as a channel at 11 m (1.1 m is 48 px there) and narrow enough
 * that a player walks across it rather than around it, which matters because it
 * is in the carriageway.
 */
const CANAL_NODE = Object.freeze({ ax: 1, az: 1 })
const CANAL_LEN = 26
const CANAL_W = 1.1
const CANAL_LIP_H = 0.1
const CANAL_DEPTH = 0.09

/**
 * The shimmer: how fast the canal's surface texture scrolls, along its axis.
 *
 * BEFORE: n/a. AFTER 0.06 m/s.
 *
 * "Slow" is the load-bearing word and the number is derived from it rather than
 * picked: 26 m of channel at 0.06 m/s takes 433 s to move its own length, so
 * the water never visibly loops and no player can catch it starting over. A fast
 * shimmer is a swimming pool; a still canal is a drain with a texture on it. The
 * reference's own water barely moves — it is a town canal, not a fountain — and
 * the brief says "slow moving water shimmer" for the same reason: the motion has
 * to sit below the threshold at which a viewer starts looking FOR it, because a
 * first-person horror frame with a moving highlight in the middle of the road is
 * a frame the eye goes to instead of down.
 *
 * The scroll is a TEXTURE OFFSET on the canal's own map, not a geometry
 * animation, so it costs nothing per frame and needs no second material. It is
 * driven from `this._time` in `update()`, the same clock as the sodium, so a
 * capture that steps to a given time gets a given shimmer and
 * `verify-world.mjs` can drive the world to the same time twice and require the
 * offset back bit-identical.
 */
const CANAL_SHIMMER_MPS = 0.06

/**
 * `WATER_SALT` — this pass's own region of the mix.
 *
 * BEFORE: n/a. AFTER 0x57415445, `WATR`. Same argument as `DRESSING_SALT` and
 * `VENDING_SALT`: water placement reads a stream, and a stream an earlier pass
 * already spends would move every puddle the moment this pass added a draw to
 * it. It is read as `streamAt(hash32(this.seed, ax, az + WATER_SALT), 0, 0)` —
 * the shape `_addCornerDressing` uses, and for the same reason: one PRNG, one
 * contract, and a shuffled `buildChunks` still produces the same puddles.
 */
const WATER_SALT = 0x57415445


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
 * `makeShimmerTexture` — the canal's moving surface (iteration 2, pass 8).
 *
 * BEFORE: n/a. AFTER a tileable banded caustic, written per-pixel through
 * `createImageData` for the reason every other texture in this file is: the
 * `verify-world.mjs` 2D stub implements exactly the data members and nothing
 * else, so a texture written with a gradient primitive is a texture the gate
 * cannot construct.
 *
 * WHY BANDS AND NOT NOISE. `noiseField` is the right primitive for a surface
 * (asphalt, siding, hedge) because those surfaces are *isotropic* — the grain of
 * tarmac has no direction. Water in a channel is emphatically not: it is
 * stretched along the flow, so a noise field on it reads as a dirty concrete
 * trough and not as water at all. Three sine bands at 1, 2 and 4 cycles across
 * the channel's width, multiplied and lifted, give the interference pattern
 * that moving water actually has — a few bright crests, wide dark troughs — and
 * because the tile is SEAMLESS the pattern is periodic, repeating every
 * `CANAL_LEN / CANAL_SHIMMER_TILES` = 3.71 m rather than once over the whole
 * channel. The review corrected that trade: a non-periodic pattern cannot tile,
 * and a non-tiling pattern on a scrolled `RepeatWrapping` map is a hard seam
 * once per tile. A seam every 3.7 m is a far smaller artefact than seven hard
 * lines travelling down the water, and 3.71 m at the 11-30 m the canal is
 * actually read from is under the threshold at which the eye resolves a repeat.
 *
 * The value is written to RGB and 255 to alpha, and this is the opposite
 * convention to `makePoolTexture` on purpose: this is a MAP on a lit surface,
 * not an alpha mask on an additive quad, so it has to be a multiplier in the
 * colour channels. `verify-world.mjs` asserts the two conventions stay
 * different, because a texture whose channels are swapped between the two uses
 * is a texture that is invisible in one of them.
 *
 * `wrapS/T` are RepeatWrapping and `repeat` is set here, because `update()`
 * scrolls `offset` along the channel and a clamped edge would show as a hard
 * seam travelling down the canal.
 *
 * @param {object} [options]
 * @param {number} [options.size] texture edge in pixels
 * @param {number} [options.seed] the documented seed for this fitting
 * @param {number} [options.base] the mid value, 0-1
 * @param {number} [options.contrast] the crest-to-trough spread
 * @param {number} [options.repeat] tiles across the channel's width
 * @returns {THREE.CanvasTexture}
 */
function makeShimmerTexture({ size = 64, seed = 1, base = 0.5, contrast = 0.42, repeat = 3 } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(size, size)
  const data = image.data
  // `phase` shifts all three bands together, so the pattern is a function of
  // the seed and not of the band numbers — two fittings differing only in
  // `phase` are two different pieces of water, not the same water twice.
  const phase = ((seed % 97) / 97) * Math.PI * 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size
      const v = y / size
      // v ACROSS the channel, u ALONG it. The bands vary across and are
      // near-constant along, which is what "stretched along the flow" means.
      //
      // EVERY FREQUENCY IS AN INTEGER, and that is the second thing this
      // function has to get right. The bands and the swell are sines, and a sine
      // tiles seamlessly only when its frequency is a whole number of cycles
      // across the tile: at 2.3 and 4.1 cycles the tile does not meet itself,
      // and at `SURFACE_SEEDS.water` the wrap steps 70/255 on U against a 7/255
      // interior step and 38/255 on V against 20. `update()` scrolls
      // `offset.x` and the map is `RepeatWrapping`, which is precisely the
      // configuration in which a non-tiling texture shows its discontinuity as
      // a hard seam once per tile — seven hard lines down a 26 m channel,
      // sliding at 0.06 m/s. That is the artefact the wrap mode exists to
      // prevent, and the pass-8 review found it by measuring the generated
      // pixels rather than by looking at the frame, where a step on a 1.1 m
      // strip at 11 m is a few pixels of a dark trough.
      //
      // 1, 2 and 4 are still incommensurate ENOUGH: their sum has a period of
      // one tile and the interference pattern is not a simple comb, so the
      // channel reads as water rather than as a grating. What is given up is
      // only the claim that the pattern does not visibly repeat over 26 m —
      // with a seamless tile it repeats every 3.71 m by construction, and the
      // honest version of that sentence is in the comment below.
      const bands =
        Math.sin(v * Math.PI * 2 * 1.0 + phase) * 0.5 +
        Math.sin(v * Math.PI * 2 * 2.0 + phase * 1.7) * 0.32 +
        Math.sin(v * Math.PI * 2 * 4.0 + phase * 0.6) * 0.18
      // A slow swell along the length, so a scrolled frame is not a rigid
      // translation of a static stripe pattern. Integer cycles, for the reason
      // above: this is the band that scrolls past the seam seven times.
      const swell = Math.sin(u * Math.PI * 2 * 2.0 + phase * 2.3) * 0.16
      const value = Math.max(0, Math.min(255, Math.round((base + bands * contrast + swell) * 255)))
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
  texture.repeat.set(repeat, 1)
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

/**
 * `makeLensTexture` — the gravitational-lensing hint, as an alpha ramp
 * (iteration 2, pass 12).
 *
 * WHAT IT IS NOT, and the order matters because the first version of this pass
 * was going to be the wrong thing. It is not a refraction, not a displaced
 * background, and not a second copy of the scene drawn through a shader. It is
 * ONE quad, a little larger than the disc, painted with a radial alpha ramp in
 * near-black, normal-blended, which darkens the background in a band around the
 * lip. That is the whole cheat, and the brief asks for it by name ("no real
 * refraction").
 *
 * WHY A CHEAP VERSION IS THE RIGHT ONE HERE rather than a compromise. Real
 * lensing would need the background sampled at a deflected offset, which is a
 * second render pass, a second set of materials, and a different silhouette for
 * every pixel of sky — and §12.2's rule is that the portal is the only cold light
 * in the game, so a *refracting* disc would bend the sodium grid around itself
 * and the one warm thing in the frame would start smearing through a cyan
 * doorway. The darkening says the same thing ("something here is pulling the
 * light") for one transparent quad.
 *
 * THE ALPHA IS `rules.portalLensAlpha` SAMPLED, not reimplemented, and that is the
 * most important line in the function. The pass-3 pupil gate reads the luma at the
 * centre of the rim and requires it to stay at or under 20, and the reason this
 * overlay cannot break it is that the profile it samples is EXACTLY ZERO at the
 * centre. A second copy of the ramp here would be a second definition of where
 * the darkening starts, and the day somebody widened it to 0.2 the pupil would
 * take a one-level cut and no gate would have said anything.
 *
 * White in RGB and the ramp in alpha, for the reason `makeSwirlTexture` gives:
 * the material's own colour is the darkness, so the texture is a profile and not
 * a picture, and the two can be reasoned about separately.
 *
 * @returns {THREE.CanvasTexture}
 */
function makeLensTexture() {
  const size = PORTAL_LENS_SIZE
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(size, size)
  const data = image.data
  const half = (size - 1) / 2
  // THE DENOMINATOR IS THE QUAD'S RADIUS, and getting that wrong is what the first
  // version of this function did, with a consequence that is worth writing down.
  //
  // `portalLensAlpha`'s parameter is a fraction of the CORE radius, and the quad is
  // `PORTAL_LENS.outer` (1.34) core radii across. So a texel at offset `d` from the
  // centre sits at core-ratio `d / half * 1.34`, and the profile has to be sampled
  // at THAT. The first version divided by `half` alone, which makes the largest
  // ratio anywhere on the canvas exactly 1.0 — the LIP. Everything the lens exists
  // to do, which is darken the background between ratio 1.0 and 1.34, was therefore
  // sampled at no texel at all along the axes, and only the four CORNERS of the
  // square ever reached into the annulus. The feature was four faint corner
  // patches.
  //
  // The world check found it by reading the built texture and finding a fully
  // transparent column through the centre: alpha exists in the buffer, but not
  // anywhere along the axes, and "the deepest row is near the rim" is a check no
  // point sample at the centre can make.
  //
  // THE DIRECTION OF THAT FACTOR IS THE THIRD VERSION OF THIS LINE, and the two
  // before it were both wrong in opposite directions. `CircleGeometry` maps its
  // RIM to the edge of the texture square — its UVs are `(x / radius + 1) / 2` — so
  // a texel at offset `d` from the centre of a quad of `PORTAL_LENS.outer` core
  // radii sits at core-ratio `d * outer / half`, which is 1.34 at the edge and 1.0
  // (the lip) at `half / outer`. The profile therefore has to be sampled with a
  // MULTIPLY by `outer / half`; the version before this one divided by it, which put
  // the lip at the edge of the canvas and the crest off the canvas entirely, and
  // the version before THAT divided by nothing, which did the same thing by a
  // different route. Two wrong answers, one correct one, and a check that reads
  // the built bytes rather than the formula is what distinguishes them.
  const scale = rules.PORTAL_LENS.outer / half
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const ratio = Math.hypot(x - half, y - half) * scale
      const i = (y * size + x) * 4
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      // The clamp is `portalLensAlpha`'s own bound restated as a byte, and a byte
      // cannot be negative — the profile is a function of a radius and a radius is
      // never negative, so this is defensive rather than load-bearing.
      data[i + 3] = Math.round(Math.min(1, Math.max(0, rules.portalLensAlpha(ratio))) * 255)
    }
  }
  ctx.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * `makePosterTexture` — a fly-poster, and the torn variant, as ONE texture with an
 * alpha channel rather than as two.
 *
 * BEFORE: n/a — `makeSurfaceTexture` is the only texture primitive in the file and
 * it is greyscale-with-opaque-alpha, which cannot express a tear. AFTER: a 64²
 * sheet whose alpha is 1 everywhere except a torn lower corner, and it is TWO
 * textures from TWO seeds rather than one texture with a torn half, because the
 * whole point of the torn variant is that it looks like a DIFFERENT sheet.
 *
 * WHY ALPHA AND NOT A SHORTER BOX, which is the version this pass tried first and
 * which is wrong in a way a screenshot would not show. A torn poster drawn as a
 * 0.42 x 0.4 box is a *smaller rectangle*, and a smaller rectangle is a different
 * size of the same object, not a damaged one. The tear has to be a ragged EDGE, and
 * an edge is what alpha is for. What is cheap here and not elsewhere: the material
 * is `alphaTest`, not `transparent`, so the torn corner is a discarded fragment
 * rather than a blended one — the sheet stays in the OPAQUE queue, which is the
 * same reason the creature's eye is safe from it (see `EYE_RENDER_ORDER`).
 *
 * Written per-pixel through `createImageData` / `putImageData` for the reason
 * every other texture in this file is, and one member more: the stub in
 * `verify-world.mjs` hands back a real `Uint8ClampedArray` for the alpha channel,
 * so a torn sheet constructs in the harness where a path-drawn one would rot.
 *
 * @param {object} options
 * @param {number} options.seed noise seed, its own per variant
 * @param {boolean} [options.torn] cut the lower-left corner away
 * @returns {THREE.CanvasTexture}
 */
function makePosterTexture({ size = 64, seed = 1, torn = false }) {
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
      // The print: a block of tone at the top third, a rule, then a smaller block
      // — a fly-poster is mostly paper with a few rectangles of ink on it, and the
      // rectangles are what stop it being a beige square at 40 m.
      const head = v < 0.3 ? 0.42 : 0
      const rule = v > 0.36 && v < 0.4 ? 0.55 : 0
      const body = v > 0.46 && v < 0.66 && u > 0.12 && u < 0.88 ? 0.3 : 0
      let tone = 0.86 - head - rule - body
      tone += (noise(u, v) - 0.5) * 0.1
      const value = Math.max(0, Math.min(255, Math.round(tone * 255)))
      const i = (y * size + x) * 4
      data[i] = value
      data[i + 1] = value
      data[i + 2] = value
      // The tear: a diagonal cut across the lower-left, jittered by the same
      // noise field so the edge is ragged rather than a clean triangle. The
      // jitter amplitude is 0.22 of the sheet, which is about 90 mm on an A2 —
      // the width of a torn corner on a sheet that has been rained on.
      let alpha = 255
      if (torn) {
        const edge = 0.34 + (1 - v) * 0.42 + (noise(u * 2.3, v * 2.3) - 0.5) * 0.22
        if (u < edge) alpha = 0
      }
      data[i + 3] = alpha
    }
  }
  ctx.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  // Clamped rather than repeated: a poster is ONE sheet with one print on it, and
  // `RepeatWrapping` on a texture that is mapped 1:1 onto a quad is a promise
  // about a second use that does not exist.
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
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
  // ITERATION 2, PASS 7 — two more, for the same reason and one more reason on
  // top: a WHOLE poster and a TORN poster are two textures, and a torn sheet
  // built from the whole one's noise would tear the same way every time, which
  // is a texture a player learns. `0x50f1` and `0x5047` are `P1` and `PG`.
  poster: 0x50f1,
  posterTorn: 0x5047,
  // ITERATION 2, PASS 8 — one more, and it is the only texture in the file whose
  // OFFSET is animated rather than whose pattern is rotated. `makeShimmerTexture`
  // is a tileable banded caustic written per-pixel; `update()` scrolls it along
  // the canal at `CANAL_SHIMMER_MPS`, which is the whole of the "slow moving
  // water shimmer" and costs one texture-offset write a frame. `0x5741` is `WA`.
  water: 0x5741,
})


/**
 * `vendingFlicker` — the world's one badly-behaved ballast, on the world's clock.
 *
 * BEFORE: n/a. The only flicker in the game was `update()`'s
 * `0.88 + (sin(7.3t) + sin(2.9t + 1.1) + sin(17.7t)) * 0.04`, which is a continuous
 * sum of sines with no seed: it is identical in every run, it has no irregular
 * term, and there is nothing to vary but the three coefficients. AFTER a stepped,
 * quantised, seeded level — and the three differences are each a deliberate
 * property rather than a stylistic one.
 *
 * **Stepped, not smooth.** A failing ballast does not breathe; it holds, and then
 * it drops for a tick, and then it holds again. The world clock is quantised into
 * `VENDING_FLICKER_HZ` ticks and the whole value is a function of the TICK INDEX,
 * which is what makes a dropout an EVENT rather than a dip a renderer can
 * interpolate away. It is also what makes it re-derivable: given `t` and the seed,
 * anyone can print the next ten ticks and see the pattern.
 *
 * **Hashed, not summed.** The level comes out of `flickerAt` — and therefore out of
 * `hash32` — rather than out of trigonometry, so it does not share a period with
 * the sodium's three sines. Two sines and an avalanche are incommensurate, and a
 * player who watched the lamps for a minute could predict a sine but cannot
 * predict a 32-bit mix.
 *
 * **Seeded, and only seeded.** `VENDING_FLICKER_SEED` is a named constant, the two
 * salts keep the tick and the phase in different regions of the mix, and there is
 * no `Math.random` and no clock read anywhere in this function. That is D10 — "any
 * technique whose output depends on iteration order or unseeded randomness is out" —
 * and it is also what lets `verify-world.mjs` drive the world to the same time
 * twice and require the material's emissive to come back bit-identical, which is
 * the only honest way to test a flicker.
 *
 * The band is `[VENDING_FLICKER_FLOOR, 1]`: a failing tube that never goes dark,
 * because a dark one is a DEAD machine and a dead machine is furniture, and a
 * failing one is a thing that might work.
 *
 * @param {number} t seconds on the world's own clock
 * @param {number} [seed] `VENDING_FLICKER_SEED`, or a test's own
 * @returns {number} a multiplier in `[VENDING_FLICKER_FLOOR, 1]`
 */
function vendingFlicker(t, seed = VENDING_FLICKER_SEED) {
  return flickerAt(seed, Math.floor(t * VENDING_FLICKER_HZ), VENDING_FLICKER_TICK_SALT, {
    phaseSalt: VENDING_FLICKER_PHASE_SALT,
    floor: VENDING_FLICKER_FLOOR,
    depth: VENDING_FLICKER_DEPTH,
    oneIn: VENDING_FLICKER_DROPOUT_ONE_IN,
  })
}


// ---------------------------------------------------------------------------
// T7 + T8 — the catenary and the screen-space wire ribbon
// ---------------------------------------------------------------------------

/**
 * `catenary` — T7's span, sampled.
 *
 * A parabola, `p.y -= sag * 4t(1 - t)`, which is the reference's own curve
 * (`geo.js` `catenary(a, b, sag, segments)`, "a parabola") and the reason a
 * span reads as a span: it leaves both poles horizontally, which a straight line
 * does not, and it hangs lowest in the middle, which nothing else on the pole
 * does.
 *
 * `sag` is passed in METRES by the caller, which derives it from the tier's
 * fraction times the horizontal distance, so the droop is proportional to the
 * span rather than fixed. That derivation is why this function takes a number
 * and not a fraction: the fraction is a property of the wire, the number is a
 * property of the span, and conflating them is how a wire ends up dragging on
 * the pavement at one end of a block and flying straight at the other.
 *
 * One array of `segments + 1` plain objects, allocated `spans * tiers` times at
 * build time — a few thousand small objects for the whole world, once, before
 * the first frame. A `Vector3` per sample would be the same count in a heavier
 * type, and a reusable scratch vector would save nothing because the samples are
 * consumed immediately and the caller needs the whole array.
 *
 * @param {{x:number,y:number,z:number}} a one end, world
 * @param {{x:number,y:number,z:number}} b the other end, world
 * @param {number} sag drop at the midpoint, metres (positive = hangs down)
 * @param {number} [segments] samples; `CATENARY_SEGMENTS` by default
 * @returns {{x:number,y:number,z:number}[]} `segments + 1` points, `a` to `b`
 */
function catenary(a, b, sag, segments = CATENARY_SEGMENTS) {
  const points = []
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments
    points.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t),
      z: a.z + (b.z - a.z) * t,
    })
  }
  return points
}

/**
 * `makeWireGeometry` — EVERY SPAN IN THE WORLD, IN ONE BUFFER, ONE DRAW CALL.
 *
 * This is the load-bearing function of the pass. T8's cost note is "one shader,
 * one draw call, 50-ish spans' worth of vertices", and the reason it can be one
 * call is that a wire is not an object: it is a *strip* of quads, and a strip
 * has no per-span state. 84 spans per wrapped copy (49 intersections, one span
 * east and one south from each of the 42 that has a partner — the wrap is
 * diagonal, so the last row and column have none) x 6 conductors x 12 segments
 * is 1,008 quads, and all three copies is 3,024 quads — 6,048 triangles in ONE
 * indexed `BufferGeometry` and ONE draw call, where a `LineSegments` per span
 * would be 252 calls at a width of one pixel, and a `Group` per pole closer to
 * the ~4,600-object scene graph the file header rules out. The `windowGlass`
 * pool alone already draws 28k triangles.
 *
 * THE VERTEX LAYOUT, and why it is four attributes and not three
 * -------------------------------------------------------------
 * Each quad corner carries:
 *
 *   - `position` — the WORLD position of the catenary sample it belongs to, so
 *     `modelViewMatrix` and the near-plane clip have something real to act on.
 *   - `aEnd` — the world position of the OTHER sample of the same segment.
 *   - `aSide` — `-1` or `+1`, which side of the ribbon this corner is. The
 *     shader offsets it perpendicular to `position -> aEnd`.
 *   - `aWidth` — the conductor's real diameter in METRES, carried per corner so
 *     the three tiers have three thicknesses out of one draw call.
 *
 * `aEnd` and `aSide` are the whole trick. A ribbon built in world space has its
 * thickness in METRES, and that is the thing T8 says is wrong: a 2 cm cable is
 * a tenth of a pixel wide at 40 m and vanishes, and 400 px wide at 2 cm from the
 * lens. By carrying the segment's other end and expanding perpendicular to it IN
 * SCREEN SPACE, the width becomes a function of depth at the vertex, and one
 * buffer built once at startup is correct from every camera position forever.
 *
 * The width is deliberately NOT baked into `position`. `position` says WHERE
 * the wire is; the shader says how thick to draw it. That split is the difference
 * between a ribbon and a mesh.
 *
 * @param {Array<{a: object, b: object, sag: number, width: number}>} spans
 * @param {number} [segments] samples per span; `CATENARY_SEGMENTS` by default
 * @returns {THREE.BufferGeometry} indexed, with `position` and the three ribbon
 *   attributes, and a bounding sphere so anything that asks for one gets an
 *   answer rather than reading a zero-radius sphere at the origin
 */
function makeWireGeometry(spans, segments = CATENARY_SEGMENTS) {
  // Sized from the span list rather than grown by pushing, which is what keeps
  // this one allocation per attribute instead of a doubling per push — and it is
  // also how an empty world produces an empty buffer rather than a null one.
  const quads = spans.length * segments
  const corners = quads * 4
  const positions = new Float32Array(corners * 3)
  const ends = new Float32Array(corners * 3)
  const sides = new Float32Array(corners)
  const widths = new Float32Array(corners)
  const index = new Uint32Array(quads * 6)

  let corner = 0
  let face = 0
  for (const span of spans) {
    const points = catenary(span.a, span.b, span.sag, segments)
    for (let s = 0; s < segments; s += 1) {
      const p = points[s]
      const q = points[s + 1]
      // Two triangles wound a-b-b and a-b-a, which puts the two `p` corners on
      // one side and the two `q` corners on the other, so `aSide` alone is
      // enough to open the ribbon and no second attribute is needed for it.
      //
      // The corner order is a RING around the quad — p, q, q, p — not an
      // alternation, and the ring is what makes the index pairs below a fan of
      // the quad's own diagonal rather than a stitch between two spans.
      const quad = [p, q, q, p]
      const quadSide = [-1, -1, 1, 1]
      // ...so the "other sample" is NOT `k < 2 ? q : p`. That test reads the ring
      // as an alternation and hands k=1 (a `q` corner) the point `q` and k=3 (a
      // `p` corner) the point `p` — a zero-length segment on HALF the corners,
      // 36,288 of 72,576 in this world. A zero-length segment has no direction,
      // so the shader's `dir` falls back to a hardcoded `(1, 0)` and the ribbon
      // is extruded along the screen's y axis rather than perpendicular to the
      // wire: the edges tilt, the quads stop abutting, and neighbouring segments
      // overlap. The pairing is written out as its own table, beside the corner
      // order it belongs to, because these two arrays are one invariant and
      // deriving one from the other's length is how they drift apart.
      const quadOther = [q, p, p, q]
      for (let k = 0; k < 4; k += 1) {
        const at = corner * 3
        positions[at] = quad[k].x
        positions[at + 1] = quad[k].y
        positions[at + 2] = quad[k].z
        // `aEnd` is the OTHER sample of this segment: a corner on `p` carries
        // `q`, a corner on `q` carries `p`. A per-corner lookup rather than a
        // second pass, because the quad's ends do not alternate and a separate
        // pass would have to remember which half of the quad it was in.
        const other = quadOther[k]
        ends[at] = other.x
        ends[at + 1] = other.y
        ends[at + 2] = other.z
        sides[corner] = quadSide[k]
        widths[corner] = span.width
        corner += 1
      }
      // The vertex base of THIS quad — the value of `corner` before the four
      // corners above were written, which is `corner - 4` after they were. It is
      // NOT `face`: `face` counts INDICES (six per quad) and `corner` counts
      // VERTICES (four per quad), so the two drift apart by two per quad and a
      // base read off `face` points into a later quad's corners. Every triangle
      // then spans three unrelated world positions and the buffer rasterises as
      // a handful of screen-filling wedges rather than a wire — which is exactly
      // what a wrong base looks like, and why this is a vertex cursor and not a
      // shared counter with `face`.
      const base = corner - 4
      index[face] = base
      index[face + 1] = base + 1
      index[face + 2] = base + 2
      index[face + 3] = base
      index[face + 4] = base + 2
      index[face + 5] = base + 3
      face += 6
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 3))
  geometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1))
  geometry.setAttribute('aWidth', new THREE.BufferAttribute(widths, 1))
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  // `frustumCulled` is off on the mesh, so nothing reads this sphere at runtime —
  // but it is still computed, so that anything which DOES ask (a future raycast
  // check, three.js's own diagnostics) has a real answer.
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * `WIRE_VERTEX_SHADER` — T8's screen-space expansion, and THE line the pass turns
 * on.
 *
 * The contract, stated once here and asserted by name in `verify.mjs` as
 * 'the wire shader clips against the near plane':
 *
 *   The pixel width divides by **clip-space `p.w`**, which in a perspective
 *   projection is the view depth. It does NOT divide by `-p.z`.
 *
 * `-p.z` is clip-space Z, a non-linear function of depth, and it goes NEGATIVE
 * for geometry in front of the near plane's z-midpoint. A negative divisor gives
 * a negative pixel width, `clamp()` pins that to `uMaxPx`, and every wire in the
 * world becomes a 13-28 px black band at coverage 1.0 — a ruled grid across the
 * amber sky rather than a wire in it.
 *
 * The near-plane clip is the OTHER half of the same contract and is not optional
 * once the divisor is right. A segment straddling the near plane has a `w`
 * approaching zero at one end (the width goes to infinity and the quad covers
 * the screen); a segment wholly behind has a `w` that is *negative* (the same
 * pinning bug from the other direction). Clipping first makes `w >= near > 0`
 * for every vertex that survives, so the division is safe by construction rather
 * than by a second `clamp` papering over it.
 *
 * The near plane itself is RECOVERED from the projection matrix rather than
 * restated as a literal. `world.js` owns the camera and its 0.05 m near plane;
 * duplicating that number here is a second place for it to be wrong, and the
 * camera is the thing being clipped against. For a standard perspective matrix
 * `c = m[2][2] = -(f+n)/(f-n)` and `d = m[3][2] = -2fn/(f-n)`, so `d / (c - 1)`
 * is exactly `n` — verified against a 72-degree, 0.05-to-260 camera.
 */
const WIRE_VERTEX_SHADER = /* glsl */`
  attribute vec3 aEnd;
  attribute float aSide;
  attribute float aWidth;

  uniform vec2 uResolution;
  uniform float uMinPx;
  uniform float uMaxPx;
  uniform float uCovFloor;

  varying float vCoverage;
  #include <fog_pars_vertex>

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vec4 mvEnd = modelViewMatrix * vec4(aEnd, 1.0);

    // Recover the camera's own near plane, then CLIP AGAINST IT, in view space,
    // before anything is projected. A point is in front of the camera when its
    // view z is below -near.
    float near = projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);

    // Wholly behind the near plane: collapse to a point. It has no area, so it
    // rasterises nothing, and the wire cannot smear through the camera.
    if (mvPosition.z > -near && mvEnd.z > -near) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      vCoverage = 0.0;
      return;
    }
    // Straddling the near plane: shorten to the crossing point so BOTH ends
    // finish in front of the camera. After this, every surviving vertex below has
    // w >= near > 0, which is what makes the division safe.
    if (mvPosition.z > -near) {
      mvPosition.xyz = mix(mvPosition.xyz, mvEnd.xyz, (-near - mvPosition.z) / (mvEnd.z - mvPosition.z));
    } else if (mvEnd.z > -near) {
      mvEnd.xyz = mix(mvEnd.xyz, mvPosition.xyz, (-near - mvEnd.z) / (mvPosition.z - mvEnd.z));
    }

    vec4 clip = projectionMatrix * mvPosition;
    vec4 clipEnd = projectionMatrix * mvEnd;

    // THE LINE. Depth is clip.w — the view depth — and never -p.z.
    float depth = clip.w;
    vec2 ndc = clip.xy / depth;
    vec2 ndcEnd = clipEnd.xy / clipEnd.w;
    // Aspect-corrected through uResolution: without it a wire running along the
    // street is 1.7x fatter on screen than one running across it at 16:9.
    vec2 dir = (ndcEnd - ndc) * uResolution;
    float len = length(dir);
    dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);

    // The conductor's real width in pixels at THIS depth: a 52 mm trunk cable is
    // 32 px wide at 1 m, 1.6 px at 20 m and 0.3 px at 100 m, which is the whole
    // reason width has to be a screen-space quantity. Clamped up to the minimum
    // so a distant wire does not vanish, and the shortfall is carried in
    // coverage so it fades rather than aliases.
    float worldPx = aWidth * uResolution.y * projectionMatrix[1][1] / (2.0 * depth);
    float px = clamp(worldPx, uMinPx, uMaxPx);
    vCoverage = clamp(worldPx / max(uMinPx, 1e-6), uCovFloor, 1.0);

    // Pixel offset back into clip space. NDC spans a half-extent per axis, so
    // one pixel is 2/resolution, and multiplying by w is what makes the offset
    // depth-independent — the same w as the divisor above.
    gl_Position = clip + vec4(normal * px * aSide * 2.0 / uResolution * depth, 0.0, 0.0);
    #include <fog_vertex>
  }
`

/**
 * `WIRE_FRAGMENT_SHADER` — a wire is a silhouette, and nothing else.
 *
 * No lighting term, and that is the design rather than an omission. `PALETTE.wire`
 * is luma 17.6 against a sky at 89, and that 5:1 contrast is the entire reason a
 * span reads against the amber rather than as a smudge in it. A lit wire would
 * put a fifth saturated thing in a frame D6 caps at four, and would stop being a
 * silhouette, which is the only thing it is for.
 *
 * The fog mix is T8's depth argument: a wire that fades with distance is a wire
 * that reads as depth, so the far spans dissolve into the haze rather than
 * hanging over it at full strength.
 */
const WIRE_FRAGMENT_SHADER = /* glsl */`
  uniform vec3 uColor;
  varying float vCoverage;
  #include <fog_pars_fragment>

  void main() {
    vec3 color = uColor;
    float alpha = vCoverage;
    #include <fog_fragment>
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

/**
 * `makeWireMaterial` — T8's one shader, and the file's known-failure site.
 *
 * The two load-bearing lines are called out in the GLSL itself and not only in
 * `WIRE_MAX_PX`'s comment:
 *
 *   1. `float depth = clip.w;` — the pixel width divides by **clip-space w**,
 *      which in a perspective projection IS the view depth. It does NOT divide
 *      by `-p.z`.
 *   2. the near-plane clip, which is what makes (1) safe: the segment is
 *      shortened against `z = -near` in VIEW space before it is projected, so
 *      every surviving vertex has `w >= near > 0`.
 *
 * Everything else is T8's own recipe: expand perpendicular to the segment in
 * screen space, clamp to a minimum pixel width, and carry the shortfall in
 * coverage rather than letting a sub-pixel wire alias.
 *
 * Fog is on, and that is T8's other half — "in our fog this matters more, not
 * less: a wire that fades with distance is a wire that reads as depth, and a
 * wire that shimmers is a wire that reads as a bug." The `FogExp2` chunks are
 * included by hand because this is a `ShaderMaterial` and would otherwise get no
 * fog at all, which would leave the far wires hanging in the amber at full
 * strength and make the sky look like a wireframe.
 *
 * @param {number} resolutionX drawing-buffer width in DEVICE pixels, which is
 *   not the CSS width: `world.js` caps the pixel ratio at 1.5, so a 1067 px
 *   window is a 1600 px buffer and a shader given the CSS width draws every wire
 *   a third too thin
 * @param {number} resolutionY drawing-buffer height in device pixels
 * @returns {THREE.ShaderMaterial} transparent, depth-tested, fogged, unlit
 */
function makeWireMaterial(resolutionX, resolutionY) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uResolution: { value: new THREE.Vector2(resolutionX, resolutionY) },
        uMinPx: { value: WIRE_MIN_PX },
        uMaxPx: { value: WIRE_MAX_PX },
        uCovFloor: { value: WIRE_COVERAGE_FLOOR },
        uColor: { value: new THREE.Color(PALETTE.wire) },
      },
    ]),
    vertexShader: WIRE_VERTEX_SHADER,
    fragmentShader: WIRE_FRAGMENT_SHADER,
    transparent: true,
    // A ribbon is a strip of quads, and which way a given quad faces depends on
    // which side of the wire the camera is. DoubleSide is one flag rather than
    // two buffers, and the wire is one-sided-symmetric by construction.
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: true,
  })
}

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
/**
 * `byDistance` — the one comparator `lampsNear` sorts with, at module scope.
 *
 * PASS 17. It was an inline arrow inside the method, so it was a fresh closure on
 * every call — one per frame, sixty a second, for a comparison of two numbers.
 * Hoisting it is the ordinary fix and the reason is worth writing down: this file
 * runs its lamp query every frame from `world.js`, and the three other sorts in
 * the codebase that are NOT on the frame path are left as arrows on purpose,
 * because a comparator that could be hoisted everywhere is an argument for
 * hoisting it nowhere.
 *
 * Ties are left to `Array.prototype.sort`, which has been stable since ES2019, so
 * two lamps at the same distance keep the order `lampPositions` gave them. That
 * is the same order the old code produced and the gate below is what holds it
 * there, because a light pool that swaps which of two equally-distant lamps it
 * aims at would be a visible flicker.
 *
 * @param {{distance: number}} a
 * @param {{distance: number}} b
 * @returns {number}
 */
function byDistance(a, b) {
  return a.distance - b.distance
}

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

/**
 * Fixture kinds that are still emitted by the pure module and no longer drawn.
 *
 * `window` and `porchLight` are the two, and they were the pass-5 review's one
 * real finding. Both predate the facade system and both were superseded by it:
 * `_addFacadeWindows` builds a window stack out of a pane, a frame, a sill and a
 * rare lit pane, and `_addEntrance` builds a recessed door under a canopy with a
 * dim entry lamp on it. While the old two kinds kept drawing, the world carried
 * a SECOND, parallel set of windows and door lights that no pass-5 check could
 * see, because every one of those checks counts the facade pools.
 *
 * The damage was not a duplicate-looking window. It was that the retired set
 * drew the wrong rung of T11's emissive ladder: `window` fixtures are
 * unconditionally `windowLit`, the brightest of the four rungs, so they added 132
 * always-lit windows to a world whose lit-window rate the pass had just argued is
 * an event; and `porchLight` fixtures are `sodium`, the lamp-head rung, so they
 * put 132 fittings that are BRIGHTER than every entry lamp in the world above the
 * doors the pass had deliberately fitted with the dimmest rung. Both claims —
 * "lit windows are rare" and "the entry lamp is the lowest rung" — were true of
 * the constants and false of the render, and no gate in either file could tell,
 * because the gate for the ladder reads `PALETTE` and the gate for the lit rate
 * counts `pools.windowLit`.
 *
 * The 132 is PLACED instances: 44 slots per kind in the loop-1 fixture pass, each
 * placed into all three of `WRAP_COPIES`. So the two kinds were 88 of the 346
 * canonical loop-1 slots and 264 of the 1,038 placed ones — re-derivable from
 * `chunkFixtures(seed, 1, cx, cz, reserved)` over the 7x7 grid, and from
 * `fixturePools[kind].used` on the pre-review file, which reports exactly 132.
 *
 * The kinds stay in `DECORATIVE_KINDS` on purpose. `neighborhood.js` is the pure
 * module and its emitted set is part of the loop's determinism contract; dropping
 * two kinds from it would re-roll every fixture slot in the world and change
 * captures that have nothing to do with this. They are retired at the POOL, which
 * is where drawing actually happens, so a retired kind costs one array entry and
 * draws nothing.
 */
const RETIRED_FIXTURE_KINDS = Object.freeze(['window', 'porchLight'])

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
 * `inLot` — a point in a lot's OWN frame, returned in world, in one call.
 *
 * ITERATION 2, PASS 7. T6's `facadeFrame` made wall-mounted placement a two-line
 * call, and this is the same trade for the other half of a lot: `along` is metres
 * from the lot's CENTRE along the frontage and `inward` is metres BEHIND the
 * frontage line, so a negative `inward` walks out onto the pavement. Every pass-7
 * placement is written in those two numbers, which is why none of them mentions
 * whether the lot is long in x or long in z.
 *
 * The sign is derived from the lot rather than from the side name, and it is
 * `atDepth`'s sign: the frontage is nearer the road, the back is nearer the block's
 * middle, and a lot on the far side of an avenue has its back at a SMALLER world
 * coordinate. A caller that guessed `-1` for an N lot would put a dumpster in the
 * next street.
 *
 * @param {object} frame `lotFrame`'s output
 * @param {object} lot the lot itself, for its centre
 * @param {number} copy the wrapped copy, one of `WRAP_COPIES`
 * @param {number} along metres along the frontage from the lot's centre
 * @param {number} inward metres behind the frontage; negative is on the pavement
 * @returns {{x: number, z: number}} the point, in the drawn copy
 */
function inLot(frame, lot, copy, along, inward) {
  const back = frame.back >= frame.front ? 1 : -1
  const shift = copy * WORLD_EXTENT
  const alongAxis = (frame.alongX ? lot.x : lot.z) + along + shift
  const inwardAxis = frame.front + back * inward + shift
  return frame.alongX ? { x: alongAxis, z: inwardAxis } : { x: inwardAxis, z: alongAxis }
}

/**
 * `onWall` — place one QUAD against a wall, facing out of it, in wall coordinates.
 *
 * The box sibling of `onFacade`, and it exists because a poster is a plane: a
 * `PlaneGeometry` faces its local +z, so placing one needs a YAW as well as a
 * position, and `onFacade` composes no yaw at all (every part it places is a box,
 * and a box has no face to point anywhere). The yaw is derived from the wall's own
 * `face` and `sign` in the one place, so a caller still never has to know which
 * world axis the wall points along.
 *
 * `proud` is signed exactly as in `onFacade` — positive stands the sheet out of
 * the wall — and the sheet is placed 10 mm thick along the wall's normal so it has
 * a measurable depth in the matrix buffer. A zero-thickness plane would still draw,
 * but a gate that reads depth out of an instance buffer would have nothing to read.
 *
 * @param {InstancePool} pool a pool whose geometry is a unit plane in XY
 * @param {object} wall from `facadeFrame`
 * @param {number} u metres along the wall from its midpoint
 * @param {number} y height above the lot
 * @param {number} proud metres out of the wall
 * @param {number} w extent along the wall
 * @param {number} h height
 * @param {THREE.Color|null} [color] per-instance colour
 */
function onWall(pool, wall, u, y, proud, w, h, color = null) {
  // The wall's outward normal in world (x, z), as the yaw that turns a plane's own
  // +z onto it: `place` yaws about Y, and a yaw of `t` sends (0, 0, 1) to
  // (sin t, 0, cos t).
  const yaw = wall.face === 'z'
    ? (wall.sign > 0 ? 0 : Math.PI)
    : (wall.sign > 0 ? Math.PI / 2 : -Math.PI / 2)
  if (wall.face === 'z') pool.place(wall.along + u, y, wall.plane + wall.sign * proud, w, h, 0.01, yaw, color)
  else pool.place(wall.plane + wall.sign * proud, y, wall.along + u, 0.01, h, w, yaw, color)
}

/**
 * `dressingStream` — this pass's own stream for one lot, and NOT pass 5's.
 *
 * `DRESSING_SALT` is folded into the chunk's x BEFORE the mix rather than
 * multiplied into the seed afterwards, because `hash32` is additive and a salt
 * added to the seed region would be indistinguishable from a neighbouring chunk's
 * coordinates. The result is four streams per chunk that are as unrelated to each
 * other, and to `streamAt(this.seed, cx, cz)` which pass 5's lit windows and pass
 * 6's poles read, as those are to each other — so this pass spends draws without
 * moving a single thing that came before it.
 *
 * @param {number} seed the run seed
 * @param {number} cx chunk x
 * @param {number} cz chunk z
 * @param {number} sideIndex index into `SIDE_NAMES`
 * @returns {() => number} a private generator
 */
function dressingStream(seed, cx, cz, sideIndex) {
  return streamAt(hash32(seed, cx + DRESSING_SALT, cz), sideIndex, 0)
}

/**
 * `vendingDraw` — whether this lot carries a machine, and whether it is lit.
 *
 * PURE, and on a stream of its own rather than on `dressingStream`, which is the
 * whole reason the world's ONE flickering machine can be found before the world is
 * built. If the machine's roll came out of the shared dressing stream it would sit
 * at a different position depending on how many bins had already been rolled for
 * that lot, and a pass that added a dumpster would silently re-roll every machine
 * in the map. So this is `VENDING_SALT`'s own region, and the two callers — the
 * pre-pass that picks the flickering lot and the placement in `_addLotDressing` —
 * are guaranteed the same answer because they are the same function.
 *
 * A district whose rate is 0 returns `null` rather than a `{ lit: false }`, because
 * "this district has no machines" and "this lot drew no machine" are different
 * facts and only one of them is a draw.
 *
 * @param {number} seed the run seed
 * @param {number} cx chunk x
 * @param {number} cz chunk z
 * @param {number} sideIndex index into `SIDE_NAMES`
 * @returns {{lit: boolean, rates: object}|null} the draw, or null for no machine
 */
function vendingDraw(seed, cx, cz, sideIndex) {
  const rates = DISTRICT_DRESSING[districtOf(cx, cz)]
  if (rates.vending === 0) return null
  const rng = streamAt(hash32(seed + VENDING_SALT, cx, cz), sideIndex, 0)
  if (Math.floor(rng() * rates.vending) !== 0) return null
  return { lit: Math.floor(rng() * VENDING_LIT_ONE_IN) === 0, rates }
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

    // ITERATION 2, PASS 12 — the near field needs to know where the viewer is, and
    // the view has no camera: `world.js` owns the `PerspectiveCamera` and the
    // player's yaw, and neither of those is a thing this file has ever been handed.
    // So the world hands it a plain record instead, once per frame, and this file
    // reads it. `null` until then, and a null viewer is nearness 0 — the hole turns
    // at its own rate, which is what a title screen and a headless test both want.
    //
    // The forward vector is stored PRE-ROTATED (`dx`, `dz`, already unit) rather
    // than as a yaw, because the two consumers here (`_portalNear`'s sibling
    // `_portalFacing`) want a dot product and a dot product against a yaw is a
    // cosine in everyone's way.
    this.viewer = null
    // The two per-frame scratch objects, allocated ONCE. `_writeDebris` composes
    // 42 matrices a frame and `_collapsePortal` runs for every dying portal, and
    // `new THREE.Object3D()` / `new THREE.Color()` inside either would be the only
    // allocations in a method that has none — which is the sort of thing that shows
    // up as a GC hitch on exactly the frame a player is holding a key down.
    this._debrisMatrix = new THREE.Object3D()
    this._deadCore = new THREE.Color(PALETTE.portalCoreDead)
    // PASS 17. The destination `rules.portalDebrisPose` writes through, one per
    // frame-path call rather than one per flake. `_debrisMatrix` above is the same
    // idea for the matrix; this is the same idea for the four numbers that go into
    // it, and both are here because `_writeDebris` runs fourteen times a frame on
    // each of three live portals.
    this._debrisPose = { x: 0, y: 0, angle: 0, size: 0 }

    // ITERATION 2, PASS 6. The wire's width is a SCREEN-SPACE quantity, so the
    // shader has to be told how many pixels the buffer has. It is the DEVICE
    // buffer, not the CSS one: `world.js` caps the pixel ratio at 1.5, so a
    // 1067 px window is a 1600 px buffer and a wire given the CSS width is drawn
    // a third too thin — which is a third too thin at every distance, so it never
    // reads as a deliberate width. `world.js` owns the number and hands it over
    // here; `setResolution` takes it again on every resize, because a wire that
    // keeps the resolution it was built with is a wire that is the wrong width in
    // a resized window, and no shader can recover that.
    this.resolution = {
      x: options.resolution?.x ?? 1280,
      y: options.resolution?.y ?? 720,
    }

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

  /**
   * `_posterTexture` — a sheet of paper with a print on it, registered for teardown.
   *
   * `makePosterTexture` is not `makeSurfaceTexture` and so does not go through
   * `_texture`, which means it needs registering by hand or §15's teardown check
   * counts a texture the world still holds. A poster is two 64² canvases for the
   * whole map, so this is the smallest reason in the file to get right and the one
   * most likely to be missed: a leak here is 16 kB a hot reload, which never shows
   * up as a bug and is exactly the kind of debt pass 19 exists to sweep.
   */
  _posterTexture(seed, torn) {
    const texture = makePosterTexture({ size: 64, seed, torn })
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
    // ITERATION 2, PASS 12. The lensing ramp is registered here for the reason the
    // swirl is: it is built by hand, it does not go through `_texture`, and a
    // sixth unregistered texture would survive `dispose()` and leak a canvas per
    // mount — which §15's teardown check counts and would fail.
    const lens = makeLensTexture()
    this.textures.push(lens)
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
      // -----------------------------------------------------------------------
      // ITERATION 2, PASS 12 — the descent
      //
      // Three materials, and each one is the OPPOSITE of the two above it in the
      // way that matters for the pass-3 pupil gate.
      //
      // `portalLens` NORMAL-blends a near-black over the background. That is the
      // safety property and not a stylistic choice: an additive material can only
      // add light, so an additive lens could brighten the exact pixel the pupil
      // gate measures, and a normal-blended dark one can only subtract. The gate
      // that proves it is in verify.mjs and it reads `blending` off this line.
      //
      // `portalDebris` is a LIT material and the only one of the three, because the
      // brief asks for rocks that "catch the rim light" and `_glow` is
      // `MeshBasicMaterial` — unlit, which cannot catch anything. The portal's own
      // PointLight is the light they catch, which is why the debris has to be
      // inside the gate's parent rather than out in the world: it inherits the
      // gate's transform and the light is 1.5 m below the lot at the root.
      //
      // `portalFlash` is additive, and that is the ONE place this pass adds light
      // to a portal. It is only ever visible on the collapse group's core disc
      // during the 0.18 s around `PORTAL_COLLAPSE.flash`, at which point the disc
      // behind it has already begun to close, and it is a CLONE per portal (see
      // `_buildPortals`) so three simultaneous collapses cannot share one opacity.
      portalLens: this._glow(0x000000, {
        map: lens,
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
      portalDebris: this._material({
        color: rules.PORTAL_DEBRIS_COLOUR,
        roughness: 0.92,
        metalness: 0.05,
      }),
      portalFlash: this._glow(PALETTE.portal, {
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

      // ITERATION 2, PASS 6 — five surfaces and one shader, and the six palette
      // entries at the top of the file are what they are all built from.
      //
      // `pole` is the only large new surface in the world (147 shafts, 9.2 m
      // each) and it is deliberately the second-darkest thing after the wire: a
      // pole is a silhouette against the amber and the moment it is lighter than
      // the buildings it stops being a pole and starts being a pillar.
      pole: this._material({ color: PALETTE.pole, roughness: 0.95 }),
      // The arm, a third of a step up the shaft, because it is the only part of
      // the hardware with a top face and a top face is what the sodium reaches.
      poleArm: this._material({ color: PALETTE.poleArm, roughness: 0.9 }),
      // The pale furniture value, shared by the sign faces and the pin
      // insulators, which are the same paint: a sign is retroreflective white
      // and an insulator is white porcelain, and both are the lightest thing on
      // the pole by a wide margin. One material for both, because they are one
      // colour and a second material would be a second draw call for a value the
      // palette already names.
      painted: this._material({ color: PALETTE.sign, roughness: 0.62 }),
      // The one warm note in the pass, and it is an oxide rather than a red
      // because a saturated red hydrant would be a fifth saturated thing in a
      // frame D6 caps at four.
      hydrant: this._material({ color: PALETTE.hydrant, roughness: 0.7, metalness: 0.2 }),
      // A gully rim is a hole in the kerb, and a hole is darker than the surface
      // around it — so this is darker than the asphalt it is set into, not
      // lighter, which is the opposite of what "metal grate" wants to be and the
      // reason a grate reads at 40 m at all.
      drain: this._material({ color: PALETTE.drain, roughness: 0.8, metalness: 0.25 }),
      // ITERATION 2, PASS 7 — the eight new surfaces. Six are `_material` and
      // follow pass 6's rule verbatim (a variation on a dark, so §12.1's silhouette
      // rule holds); the vending liner is the seventh and the only one here that
      // emits, and the reason it is a `_material` and NOT a `_glow` is the whole of
      // the next paragraph.
      dumpster: this._material({ color: PALETTE.dumpster, roughness: 0.78, metalness: 0.34 }),
      trashBag: this._material({ color: PALETTE.trashBag, roughness: 0.52, metalness: 0.04 }),
      bike: this._material({ color: PALETTE.bike, roughness: 0.55, metalness: 0.5 }),
      vending: this._material({ color: PALETTE.vending, roughness: 0.46, metalness: 0.36 }),
      // THE DEAD LINER, and it is `drain` rather than a ninth palette entry on
      // purpose: an unlit machine's product window is a hole with a lit edge, and a
      // hole is the same value as every other hole in this world (see the gully).
      vendingFaceDead: this._material({ color: PALETTE.drain, roughness: 0.34, metalness: 0.1 }),
      // THE LIT LINER, and the one material in this file that has to carry fog
      // while behaving like a light. `_glow` is `MeshBasicMaterial` with
      // `fog: false`, which is correct for a portal rim and a lamp head — they are
      // SOURCES seen against the sky — and catastrophically wrong here: an unfogged
      // emissive panel 40 m down a street punches a hole in the amber haze and is
      // visible from the far end of an avenue, straight through the corridor the
      // creature is supposed to be the only thing moving in. A `MeshStandardMaterial`
      // with an `emissive` and fog left on is the fix, and it costs the machine
      // nothing: `emissiveIntensity` is the same knob either way.
      vendingFaceLit: this._material({
        color: 0x0b0d11,
        emissive: PALETTE.vendingGlow,
        emissiveIntensity: VENDING_FACE_EMISSIVE,
        roughness: 0.3,
      }),
      // ...and the bad one is a SEPARATE material instance for the reason pass 5
      // split the siding: one slot per pool, and a flicker written into the shared
      // material would gutter every lit machine in the district at once. Two draw
      // calls for "one machine misbehaves" is the price, and it is a price worth
      // naming rather than hiding.
      vendingFaceFlicker: this._material({
        color: 0x0b0d11,
        emissive: PALETTE.vendingGlow,
        emissiveIntensity: VENDING_FACE_EMISSIVE,
        roughness: 0.3,
      }),
      shelter: this._material({ color: PALETTE.shelter, roughness: 0.72, metalness: 0.34 }),
      // The ad panel is DIM, and "dim" here means "not emissive" rather than "a
      // small emissive": a backlit panel bright enough to read as a light source
      // would be a fifth rung on T11's ladder, spent on a rectangle no player can
      // read at 40 m. A `_material` at `adPanel`'s 72.2 luma is lit BY the sodium
      // like everything else, which is what "dim" means in a world with four lights.
      adPanel: this._material({ color: PALETTE.adPanel, roughness: 0.82, metalness: 0.02 }),
      // The poster: the paper is `PALETTE.poster` and the print is a greyscale
      // multiplier on top of it — so the rendered albedo is 0.72-0.86 of 87.1 luma,
      // which is 63-75 and still the palest furniture value in the block.
      // `alphaTest` and not `transparent`, for the reason `POSTER_ALPHA_TEST`
      // gives.
      poster: this._material({
        color: PALETTE.poster,
        map: this._posterTexture(SURFACE_SEEDS.poster, false),
        alphaTest: POSTER_ALPHA_TEST,
        roughness: 0.9,
      }),
      posterTorn: this._material({
        color: PALETTE.poster,
        map: this._posterTexture(SURFACE_SEEDS.posterTorn, true),
        alphaTest: POSTER_ALPHA_TEST,
        roughness: 0.9,
      }),
      // The wire, and the only material in this file that is not a
      // `MeshStandardMaterial`. T8 owns it because the width is computed in the
      // vertex shader, and a `ShaderMaterial` therefore gets no fog unless the
      // chunks are included by hand — which is the second half of the pass and
      // the half that is easy to leave out.
      wire: makeWireMaterial(this.resolution.x, this.resolution.y),

      // -----------------------------------------------------------------------
      // ITERATION 2, PASS 8 — WATER & REFLECTIONS
      //
      // Four materials, and the load-bearing property is that THREE of them are
      // `transparent` over the SAME ground plane and the fourth is not. That is a
      // sorting problem, and it is the whole reason the pass has this shape rather
      // than one clever shader.
      //
      // The order on the road, from the asphalt up:
      //
      //   1. `wetSheen`   blended DARK, no depth write, renderOrder 1. The damp.
      //   2. `puddle`     the water surface, opaque-ish, renderOrder 2. The hole.
      //   3. `canalWater` the channel, lit and mapped, renderOrder 3.
      //   4. `streak`     ADDITIVE, no depth write, renderOrder 4. The reflection.
      //
      // `renderOrder` is set explicitly on every one of them because three.js
      // sorts transparent objects back-to-front by distance from the camera, and
      // at 11 m all four of these are within 2 m of each other in depth. Left to
      // the automatic sort, the additive streak lands UNDER the dark halo on
      // roughly half the frames — which is a reflection that disappears when the
      // camera moves, and a bug nobody finds by looking at one screenshot.
      // `verify-world.mjs` reads all four back off the built scene and requires
      // the order above, so the fix cannot be undone by a re-sort.
      //
      // WHY FOUR AND NOT ONE. A single blended material cannot be both the dark
      // halo and the additive reflection: one has to multiply the road down and
      // the other has to add light to it, and they are opposite operations. It
      // also cannot be both the still puddle and the moving canal, because one
      // scrolls its map and the other must not. Four materials, four draw calls,
      // and every one of them a distinct physical effect.
      // -----------------------------------------------------------------------

      // 1. The wet halo. `depthWrite: false` so it never occludes the puddle
      //    above it, and `polygonOffset` is NOT used because this is a plane at a
      //    fixed lift and a z-fight would need them to be coplanar — the whole
      //    point of `PUDDLE_HALO_LIFT` is that they are not.
      wetSheen: this._material({
        color: PALETTE.wetSheen,
        transparent: true,
        opacity: PUDDLE_HALO_OPACITY,
        depthWrite: false,
      }),
      // 2. The puddle. Low roughness and a real `metalness` so the four point
      //    lights put a specular highlight on it — this is the ONE thing in the
      //    pass that is genuinely lit rather than drawn, and it is what separates
      //    a puddle from a dark disc when the camera is low. `depthWrite: true`
      //    (the default, stated) because the water is opaque enough to occlude
      //    the road and a puddle that does not occlude is a sticker.
      puddle: this._material({ color: PALETTE.puddle, roughness: 0.08, metalness: 0.62 }),
      // 3. The canal. A `_material` and not a `_glow`, for the same reason
      //    `vendingFaceLit` is: it is a SURFACE, it is in the road where the fog
      //    is, and an unfogged water surface would be visible from the far end of
      //    the avenue. The map is the shimmer, and `roughness` is low enough that
      //    the crests catch the sodium and the troughs do not — which is the
      //    whole of what "shimmer" means without moving a vertex.
      canalWater: this._material({
        color: PALETTE.canalBed,
        map: this._shimmerTexture(),
        roughness: 0.14,
        metalness: 0.55,
      }),
      // 4. The reflection streak. Additive, unlit, and `fog: true` — the same
      //    combination as `sodiumPool`, and for the same reason: it is ON the
      //    ground, so it is a depth cue and it has to recede. It is drawn at
      //    `STREAK_PEAK` of `waterStreak` so its peak contribution sits under the
      //    eye finder's `EYE_MIN`; see the constant for that arithmetic.
      streak: this._glow(PALETTE.waterStreak, {
        map: makePoolTexture({ rim: STREAK_RIM, peak: STREAK_PEAK }),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: true,
      }),
    }
  }

  /**
   * `_shimmerTexture` — the canal's map, registered for teardown.
   *
   * `makeShimmerTexture` is not `makeSurfaceTexture` and so does not go through
   * `_texture`, which means it needs registering by hand or §15's teardown check
   * counts a texture the world still holds — a 16 kB leak per mount, which never
   * shows up as a bug and is exactly the debt pass 19 exists to sweep. The swirl
   * above sets the same precedent for the same reason.
   */
  _shimmerTexture() {
    const texture = makeShimmerTexture({ seed: SURFACE_SEEDS.water, repeat: CANAL_SHIMMER_TILES })
    this.textures.push(texture)
    return texture
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

    // ITERATION 2, PASS 6 — the street furniture, and the capacities are T5's rule
    // applied to something that is not per-lot: every number below is the MAXIMUM
    // this pass can place, multiplied out, not the number it happens to place on
    // this seed. 49 intersections x 3 copies = 147 poles; a pole is one shaft, two
    // axes x (an arm, a bracket and a hook) and two axes x 6 insulators.
    const nodes = GRID * GRID
    const poles = nodes * WRAP_COPIES.length
    // A pole is a POLE, not a lamp post: a round shaft, 190-250 mm across, which
    // is the same primitive the lamp uses and the reason the two never get
    // confused at 40 m. Eight sides, because a hexagon reads faceted against the
    // sky and a cylinder reads as a pipe.
    this.pools.poleShafts = this._streetPool(
      names, 'poleShafts', new THREE.CylinderGeometry(0.5, 0.5, 1, 8), this._materials.pole, poles + 8,
    )
    // The arm, the secondary bracket and the telecom hook are one pool of one
    // material for the same reason the frontage was split by KIND and not by
    // size: they are the same colour, so splitting them would buy nothing and
    // cost a draw call each. Three per axis, two axes.
    this.pools.poleArms = this._streetPool(
      names, 'poleArms', box(), this._materials.poleArm, poles * 6 + 8,
    )
    // Six conductors per arm (3 trunk + 2 secondary + 1 telecom), on both axes.
    this.pools.poleInsulators = this._streetPool(
      names, 'poleInsulators', box(), this._materials.painted, poles * 12 + 8,
    )
    // A sign is a post and a plate and the plate is a different material from the
    // post — a sign is retroreflective paint and a post is galvanised steel, and
    // that difference is the whole reason a sign is legible at 40 m.
    this.pools.signPosts = this._streetPool(
      names, 'signPosts', new THREE.CylinderGeometry(0.5, 0.5, 1, 6), this._materials.metal,
      nodes * SIGNS_PER_INTERSECTION * WRAP_COPIES.length + 8,
    )
    this.pools.signPlates = this._streetPool(
      names, 'signPlates', box(), this._materials.painted,
      nodes * SIGNS_PER_INTERSECTION * WRAP_COPIES.length + 8,
    )
    // A hydrant is a barrel, a bonnet and two side caps: four instances of one
    // cylinder, one pool, one draw call. A hydrant built out of boxes is a hydrant
    // with the corners of a shipping crate.
    this.pools.hydrants = this._streetPool(
      names, 'hydrants', new THREE.CylinderGeometry(0.5, 0.5, 1, 8), this._materials.hydrant,
      poles * 4 + 8,
    )
    // The gully: an annulus rim (the same `makeFrameGeometry` the window frame and
    // the parapet use) and five bars, in two pools because the rim is a hole and
    // the bars are cast iron.
    this.pools.drainFrames = this._streetPool(
      names, 'drainFrames', makeFrameGeometry(DRAIN_FRAME_BAR).rotateX(-Math.PI / 2),
      this._materials.drain, poles + 8,
    )
    this.pools.drainBars = this._streetPool(
      names, 'drainBars', box(), this._materials.metal, poles * DRAIN_BAR_COUNT + 8,
    )

    // ITERATION 2, PASS 7 — fifteen pools, and T5's rule is the reason every
    // capacity below is a MAXIMUM multiplied out rather than the number this seed
    // happens to place. `DISTRICT_DRESSING`'s fastest rate is 1, so a chunk can put
    // a bin, three bags, a machine, a poster and a bollard run on every one of its
    // four lots, and a capacity sized for the seed's actual draw silently drops the
    // extras — the exact failure the pass-5 review found in the window frames, and
    // the only symptom would be `pool.overflow`, which nothing counts but
    // `verify-world.mjs`.
    //
    // FIFTEEN POOLS FOR EIGHT KINDS, and the count is the point rather than an
    // accident: an `InstancedMesh` has ONE material slot, so a bin and a bag cannot
    // share a pool, and a lit liner and a dead liner cannot either. The merges that
    // ARE available have been taken — a dumpster's body, lid and castors are one
    // pool, a bag and its knot are one pool, a bike's five frame bars are one pool,
    // a shelter's posts, back and roof are one pool — so fifteen is the floor for
    // this content and not a first draft.
    //
    // `nodes * WRAP_COPIES.length` is 147, the most shelters or bikes the map can
    // hold: one per intersection per copy.
    const dressed = nodes * WRAP_COPIES.length
    // A bin is four instances (two castors, a body, a lid) and there is at most one
    // per lot; the fastest district rate is 4, so `lot` is the honest maximum.
    this.pools.dumpsters = this._streetPool(names, 'dumpsters', box(), this._materials.dumpster, lot * 4 + 8)
    // Three bags at two instances each.
    this.pools.trashBags = this._streetPool(names, 'trashBags', box(), this._materials.trashBag, lot * 6 + 8)
    // One machine per lot, one liner, and `VENDING_RAIL_COUNT` rails.
    this.pools.vendingBodies = this._streetPool(names, 'vendingBodies', box(), this._materials.vending, lot + 8)
    this.pools.vendingFaces = this._streetPool(names, 'vendingFaces', box(), this._materials.vendingFaceDead, lot + 8)
    this.pools.vendingLitFaces = this._streetPool(names, 'vendingLitFaces', box(), this._materials.vendingFaceLit, lot + 8)
    // ONE in the world, so three — one per wrapped copy — and eight for the same
    // reason every other pool carries slack: a capacity of 1 would turn a future
    // pass's second machine into a silent hole rather than an `overflow` count.
    this.pools.vendingFlickerFaces = this._streetPool(names, 'vendingFlickerFaces', box(), this._materials.vendingFaceFlicker, WRAP_COPIES.length + 1)
    this.pools.vendingRails = this._streetPool(names, 'vendingRails', box(), this._materials.painted, lot * VENDING_RAIL_COUNT + 8)
    // A shelter is a roof, a back, two posts and a bench; the ad panel is its own
    // pool because it is the one DIM surface and shares no material with the steel.
    this.pools.shelterSteel = this._streetPool(names, 'shelterSteel', box(), this._materials.shelter, dressed * 4 + 8)
    this.pools.shelterBenches = this._streetPool(names, 'shelterBenches', box(), this._materials.trim, dressed + 8)
    this.pools.shelterAds = this._streetPool(names, 'shelterAds', box(), this._materials.adPanel, dressed + 8)
    // A bollard is a shaft and a retroreflective band, and a run is two of them.
    this.pools.bollards = this._streetPool(
      names, 'bollards', new THREE.CylinderGeometry(0.5, 0.5, 1, 6), this._materials.painted,
      lot * BOLLARDS_PER_RUN * 2 + 8,
    )
    // A bike is five frame bars and two wheels, and the wheels are a TORUS rather
    // than a cylinder for the reason `BIKE_WHEEL_R` gives: a cylinder seen edge-on
    // is a rectangle and a bicycle has no rectangles in it. 16x8 segments is 256
    // triangles a wheel, which is inside AESTHETIC-NOTES §0's 8-40-per-interruption
    // budget for a pair and is the only geometry in this pass that is not a box.
    this.pools.bikeFrames = this._streetPool(names, 'bikeFrames', box(), this._materials.bike, dressed * 5 + 8)
    this.pools.bikeWheels = this._streetPool(
      names, 'bikeWheels', new THREE.TorusGeometry(0.5, (BIKE_WHEEL_T / 2) / (BIKE_WHEEL_R * 2), 6, 16),
      this._materials.bike, dressed * 2 + 8,
    )
    // Two poster pools, whole and torn, because the tear is in the ALPHA and a
    // pool's material is where alpha lives. `POSTER_U` is the sheet's own aspect:
    // 0.42 x 0.60 is A2 and a square texture on it stretches the print by 1.43.
    this.pools.posters = this._streetPool(
      names, 'posters', new THREE.PlaneGeometry(POSTER_U, 1), this._materials.poster, lot + 8,
    )
    this.pools.postersTorn = this._streetPool(
      names, 'postersTorn', new THREE.PlaneGeometry(POSTER_U, 1), this._materials.posterTorn, lot + 8,
    )

    // -----------------------------------------------------------------------
    // ITERATION 2, PASS 8 — FIVE POOLS, and the geometry is the argument
    //
    // Four of the five are a 10x10-segment DISC lying flat, and the fifth is a
    // 1x1 plane. That is the whole budget: 20 triangles for a puddle, 20 for its
    // halo, 2 for a reflection streak, 12 for the canal's box walls. A pass that
    // wanted 40 puddles at 200 triangles each would cost 8000 triangles for
    // something the eye reads as a dark ellipse, and `verify-world.mjs` measures
    // the count and the segment number so the trade cannot be re-made silently.
    //
    // WHY A DISC AND NOT A PLANE. A square puddle with a soft alpha edge is the
    // obvious cheaper choice and it is wrong: the corner of a square never fades
    // (the falloff is radial from the centre, so the corners stay at full
    // strength) and a square of standing water is instantly a decal. A 10-segment
    // disc at 1.75x is an ellipse, and an ellipse is what a puddle is.
    //
    // The halo and the water SHARE one geometry instance — `disc()` is called
    // once and handed to both pools — because they are the same shape at two
    // scales, and two 10x10 discs cost 40 triangles instead of 20. Three.js
    // uploads geometry per `BufferGeometry`, and two pools holding the SAME
    // object is one upload and one VRAM copy.
    // -----------------------------------------------------------------------
    const disc = () => new THREE.CircleGeometry(0.5, PUDDLE_SEGMENTS).rotateX(-Math.PI / 2)
    const wetDisc = disc()
    // The MAXIMUM, per T5's rule, not this seed's draw: 49 nodes x 3 copies x
    // `PUDDLE_CANDIDATES_PER_NODE` candidates, and every candidate is eligible on
    // a seed where `PUDDLE_ONE_IN` lands on 0 every time. The one-in-three rate is
    // a roll, not a cap, so a capacity sized for the observed count drops the
    // extras silently — which is the pass-5 window-frame bug, and the overflow
    // counter is the only symptom.
    const water = nodes * PUDDLE_CANDIDATES_PER_NODE * WRAP_COPIES.length
    this.pools.wetSheen = this._streetPool(names, 'wetSheen', wetDisc, this._materials.wetSheen, water + 8)
    this.pools.puddles = this._streetPool(names, 'puddles', wetDisc, this._materials.puddle, water + 8)
    // The streak is ONE per lamp, not one per puddle: the reflection belongs to
    // the light, and a street with three puddles under one lamp has one streak in
    // it, not three. 49 lamps x 3 copies, plus the canal's own.
    this.pools.streaks = this._streetPool(
      names, 'streaks', new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this._materials.streak,
      nodes * WRAP_COPIES.length + 8,
    )
    // The canal: a box for the two lips (they are 100 mm tall, so a plane is
    // not enough — a lip with no height has no top face and catches no light) and
    // a plane for the water. Three instances, one per copy.
    this.pools.canalLips = this._streetPool(names, 'canalLips', box(), this._materials.kerb, 6)
    // The canal's water plane is Yawed as well as laid flat, and the yaw is the
    // whole of the shimmer. `update()` scrolls `map.offset.x`, and a texture's
    // U axis is its X axis, so the scroll runs along whichever LOCAL axis the
    // plane's U happens to follow. `rotateX(-PI/2)` alone lays the plane down
    // with U on the local X — the 1.1 m ACROSS the channel — so the water was
    // scrolling sideways across a 1.1 m trough at 1/23.6th of the speed
    // `CANAL_SHIMMER_MPS` promises (the divisor is `CANAL_LEN /
    // CANAL_SHIMMER_TILES` = 3.71 m, a length that only exists along the
    // channel, so the constant was doing its arithmetic on an axis 23.6x
    // shorter than the one it names). `rotateY(PI/2)` after the lay-down moves U
    // onto the local Z, which `place()` scales by `CANAL_LEN`, and the scroll
    // then runs down the channel at the documented 0.06 m/s.
    //
    // Nothing else in the file uses this pool, so the yaw costs one rotation and
    // no layout change: `place()` is still called with `(CANAL_W, 1, CANAL_LEN)`
    // and the world still spans 1.1 m across and 26 m along. `verify-world.mjs`
    // measures the U axis back off the built geometry and requires it to be the
    // long one, so this cannot be undone by re-flattening the plane.
    this.pools.canalWater = this._streetPool(
      names, 'canalWater', new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).rotateY(Math.PI / 2), this._materials.canalWater, 6,
    )
    // ...and the four water render orders, read back by `verify-world.mjs`.
    // Set HERE rather than in `_buildWater` because a pool that is not created
    // cannot be ordered, and this is the one place in the file where every pool
    // exists.
    this.pools.wetSheen.mesh.renderOrder = 1
    this.pools.puddles.mesh.renderOrder = 2
    this.pools.canalWater.mesh.renderOrder = 3
    this.pools.streaks.mesh.renderOrder = 4

    // The world's ONE flickering machine, chosen BEFORE any lot is built.
    //
    // It could have been a 1-in-20 roll on each machine's own stream, and that
    // version cannot promise "one": with ~30 machines the expected count is 1.5
    // and the seed decides whether the pass delivered zero or three. Instead this
    // is a MINIMUM over the map: every lot whose `vendingDraw` says it carries a
    // LIT machine is a candidate, the one with the lowest `hash32` wins, and the
    // answer is the same on every machine, in every build order, for every run of
    // this seed. Anchor lots are excluded because a machine inside
    // `PORTAL_FURNITURE_CLEAR` would be filtered away and the world would then
    // have a flickering machine that is not there.
    this.dressingRejected = 0
    // `dressingLog` — one entry per placed object, published rather than discarded,
    // for the same reason `wireSpans` and `polePositions` are: the claim "no machine
    // exists in the district whose rate is zero" is a claim about ADDRESSING, and a
    // check cannot recover the addressing from world coordinates. The wrap is the
    // reason this is not derivable in the harness either: `canonicalCoord` is a fold
    // of a LINE onto a 448 m window, it is not order-preserving, and a machine at
    // world x = 248 folds to -7.9 — so a quadrant derived in the folded frame calls
    // the easternmost machine in the world a western one. Two earlier versions of the
    // district check got that wrong in opposite directions before the log existed.
    // `district` is `districtOf(chunk.cx, chunk.cz)`, the same value the rate lookup
    // reads, which is what makes "a rate of zero placed nothing" a real assertion.
    this.dressingLog = []
    this.flickerLot = this._pickFlickerLot()

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
    // ...and the same rule, one pass later: the poles, the signs, the hydrants and
    // the grates are instanced into the pools above and committed by the loop
    // under this line, and the wires go into a geometry that is built here and
    // therefore cannot be committed late. Eight pools and one mesh, all of it
    // before the loop below — which is the whole of the pass's "nine draw calls"
    // claim, and the reason it is a claim about POOLS rather than about objects.
    this._buildStreetFurniture()
    this._buildLamps()
    // ITERATION 2, PASS 8 — the water, and it is here for the same reason the
    // lamps are: `InstancePool.commit()` is the only thing that publishes
    // instances, and this pass added five pools. A puddle written after this
    // loop is a puddle in a buffer that is never uploaded, and the symptom is a
    // road that is merely dark rather than a visible error.
    this._buildWater()
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

    // The lot's own ground: a yard slab, so a driveway reads as a driveway.
    // `YARD_TOP - 0.1` is the same 0.1 the slab is thick, written so the apron's
    // `YARD_TOP` and this placement cannot drift apart into a buried decal
    this.pools.yards.place(x, YARD_TOP - 0.1, z, frame.long, 0.1, frame.short)

    // The building's box, hoisted out of the branch below and computed whether or
    // not there IS a building. BEFORE it was four `const`s inside `if (!isAnchor)`,
    // which is exactly the shape that makes a later pass re-derive them: pass 7
    // hangs a poster on this wall and needed the same four numbers, and copying
    // them into a second place is how a poster ends up 4.5 m out in the yard —
    // the bug `houseFaces` documents at length. One computation, one owner, and an
    // anchor lot simply gets `house === null` where a poster can be skipped.
    const wall = lot.kind === 'house' ? WALL_HEIGHT : lot.kind === 'garage' ? 2.7 : 2.2
    const depth = frame.short * (lot.kind === 'house' ? 0.55 : 0.5)
    const width = frame.long * (lot.kind === 'house' ? 0.7 : lot.kind === 'garage' ? 0.34 : 0.2)
    const centre = atDepth(frame, frame.short - depth, depth)
    const house = {
      cx: frame.alongX ? x : x + (centre - lot.x),
      cz: frame.alongX ? z + (centre - lot.z) : z,
      w: frame.alongX ? width : depth,
      d: frame.alongX ? depth : width,
      kind: lot.kind,
    }

    if (!isAnchor) {
      const { cx, cz, w, d } = house
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

    // ITERATION 2, PASS 7 — the lot's own furniture, and it goes in BEFORE the part
    // count below so the budget in T5 is a budget for the whole lot. A pass that
    // dressed its lots outside the measurement would be reporting a number that
    // does not describe the thing the number is about, and the pin in
    // `verify.mjs` would be moving for a lie.
    this._addLotDressing(chunk, lot, frame, isAnchor, copy, isAnchor ? null : house)

    // ...and the lot's part count, recorded last so it covers the yard, the
    // building, the façade, the frontage and this pass's dressing. A DIFF, not a
    // tally: see the note on
    // `partsBefore` at the top of this method. The fixture pass is deliberately
    // NOT counted here — §3.6's dressing is per-loop and the budget is about the
    // static street, which is what "a per-lot part" means in T5.
    this.lotParts.push(this._partsUsed() - partsBefore)
  }

  /**
   * `_pickFlickerLot` — which lot carries the world's one failing ballast.
   *
   * A MINIMUM, not a roll, and the difference is the whole claim. A 1-in-N draw per
   * machine gives an expected count, and on a seed that lands on 0 the pass has
   * quietly delivered no flicker at all while every comment in the file still
   * claims one — the class of defect this benchmark's whole verify layer exists to
   * catch, arrived at by a shorter road. Taking the lowest `hash32` over every
   * candidate is order-independent (it is a function of the seed and nothing else),
   * build-order-independent (nothing is drawn while it is chosen), and EXACTLY one
   * whenever at least one candidate exists.
   *
   * Anchor lots are skipped, and not for tidiness: a machine inside
   * `PORTAL_FURNITURE_CLEAR` is filtered out at placement, so a flickering lot
   * that is an anchor lot is a flickering machine that does not exist.
   *
   * @returns {string|null} the `cx,cz,side` key, or null if the seed has no lit
   *   machine at all — in which case `update()` has nothing to drive and says so
   */
  _pickFlickerLot() {
    let best = null
    let rank = Infinity
    for (let cx = 0; cx < GRID; cx += 1) {
      for (let cz = 0; cz < GRID; cz += 1) {
        for (let side = 0; side < SIDE_NAMES.length; side += 1) {
          const key = `${cx},${cz},${SIDE_NAMES[side]}`
          if (this.anchorLots.has(key)) continue
          const draw = vendingDraw(this.seed, cx, cz, side)
          if (!draw || !draw.lit) continue
          const candidate = hash32(this.seed + VENDING_SALT, cx, cz * SIDE_NAMES.length + side)
          if (candidate < rank) {
            rank = candidate
            best = key
          }
        }
      }
    }
    return best
  }

  /**
   * `_portalClear` — is this spot far enough from every portal to keep it?
   *
   * The structural form of "the pupil must stay luma <= 20". §16.5.5 photographs a
   * portal from 4.5 m out and the pass-3 gate measures the luma of the HOLE in that
   * frame, so anything standing between that camera and the gate does not merely
   * look wrong in a screenshot — it invalidates the gate that the rest of the
   * iteration is measured against. `PORTAL_FURNITURE_CLEAR` is 12 m, 2.7x the
   * stand-off, which clears the whole frontage run of a portal's own lot.
   *
   * A FILTER, and the distinction matters: it is a predicate applied at placement
   * and counted, not a spatial test run afterwards. `dressingRejected` is published
   * so `verify-world.mjs` can require that this fired at least once — a rule that
   * never rejects is indistinguishable from a rule that is not there, which is the
   * residual risk the pass-6 review left behind.
   *
   * FOLDED TO CANONICAL, which is the half that matters. The caller has already
   * added `copy * WORLD_EXTENT` and this subtracts it again, because a portal's
   * drawn position is translated by `recentre` by that same amount and the drawn
   * distance between two things is the canonical distance between them. Without
   * the fold, copies -1 and +1 would each sit 448 m from every portal, pass
   * trivially, and the exclusion would silently exist in one ninth of the world.
   * `verify-world.mjs` reads the instances back in canonical coordinates and
   * measures the same number this predicate decided on.
   *
   * @param {number} x world x, in the drawn copy
   * @param {number} z world z, in the drawn copy
   * @param {number} copy the wrapped copy the caller is placing into
   * @returns {boolean} true if the spot may be dressed
   */
  _portalClear(x, z, copy) {
    const shift = copy * WORLD_EXTENT
    for (const anchor of this.objectives.portals) {
      if (Math.hypot(x - shift - anchor.position.x, z - shift - anchor.position.z) < PORTAL_FURNITURE_CLEAR) {
        this.dressingRejected += 1
        return false
      }
    }
    return true
  }

  /**
   * `_addLotDressing` — everything on this lot that is not the lot.
   *
   * Four families and a rate table, and the table is the pass: AESTHETIC-NOTES §5
   * asks for "per-district placement rules, because uniformity is what makes a
   * generated street read as generated", which is a claim about DIFFERENCE. A rate
   * that is the same in four districts satisfies the words and none of the idea, so
   * two kinds are absent from a whole quadrant (`vending` and `bike` from the
   * north-west, `shelter` from the south-east) and `verify-world.mjs` measures the
   * absence out of the built world rather than reading this comment.
   *
   * THE STREAM IS THIS PASS'S OWN, and that is load-bearing rather than tidy. Pass
   * 5 spends `streamAt(this.seed, cx, cz)` on lit windows and pass 6 spends another
   * on spans; if this method drew from either, every draw added below would shift
   * every draw after it and a dumpster would silently un-light a window three lots
   * away. `dressingStream` is a different region of the same mix, so this pass is
   * additive to the world and invisible to everything already in it.
   *
   * `copy === 0` guards every collider, for the reason the pole's does: the wrapped
   * copies exist to be seen, never walked into, and the player is always within half
   * a period of the canonical one.
   *
   * @param {object} chunk the chunk this lot belongs to
   * @param {object} lot the lot
   * @param {object} frame `lotFrame`'s output
   * @param {boolean} isAnchor an objective's lot
   * @param {number} copy the wrapped copy
   * @param {object|null} house the building's box, or null on an anchor lot
   * @returns {void}
   */
  _addLotDressing(chunk, lot, frame, isAnchor, copy, house) {
    const rates = DISTRICT_DRESSING[districtOf(chunk.cx, chunk.cz)]
    for (const kind of DRESSING_KINDS) {
      if (rates[kind] === undefined) throw new Error(`DISTRICT_DRESSING has no ${kind} rate`)
    }
    const rng = dressingStream(this.seed, chunk.cx, chunk.cz, SIDE_NAMES.indexOf(lot.side))
    const district = districtOf(chunk.cx, chunk.cz)
    const record = (kind, x, z) => this.dressingLog.push({ kind, district, copy, x, z })
    // ---- the bin, and the bags beside it, in the SIDE YARD --------------------
    //
    // A bin needs the gap between the house's flank and the lot's own boundary,
    // which is 3.9 m of nothing on a 26 x 10 m lot, so an anchor lot (no house) has
    // nowhere to put one and does not get one. That is a property of the world, not
    // a special case: there is no rear yard in this geometry at all — the house's
    // back face lands on the lot's back edge — and the brief's "behind buildings"
    // resolves to the back third of the side gap or it does not resolve at all.
    if (house && rates.dumpster > 0 && Math.floor(rng() * rates.dumpster) === 0) {
      const side = rng() < 0.5 ? -1 : 1
      const spot = inLot(frame, lot, copy, side * DUMPSTER_ALONG * frame.long, DUMPSTER_INWARD * frame.short)
      if (this._portalClear(spot.x, spot.z, copy)) {
        record('dumpster', spot.x, spot.z)
        this._addDumpster(spot.x, spot.z, frame.yaw, copy)
        // The bags, at their own rate, capped, and each with its OWN yaw off the
        // lot's. A bag's yaw is the only thing here that makes a lump read as a
        // lump: three identical boxes at one angle is a stack of crates, and
        // jittering only the POSITION leaves the parallelism that gives it away.
        for (let bag = 0; bag < TRASH_BAGS_MAX; bag += 1) {
          if (Math.floor(rng() * TRASH_BAG_ONE_IN) !== 0) break
          const jx = (rng() * 2 - 1) * TRASH_BAG_JITTER
          const jz = (rng() * 2 - 1) * TRASH_BAG_JITTER
          const bagX = spot.x + (frame.alongX ? jx : jz)
          const bagZ = spot.z + (frame.alongX ? jz : jx)
          this._addTrashBag(bagX, bagZ, frame.yaw + (rng() * 2 - 1) * 1.2)
          record('bag', bagX, bagZ)
        }
      }
    }
    // ---- the machine, on the pavement in front of the frontage ----------------
    //
    // `vendingDraw` and not a roll from `rng`: the machine is the one thing here
    // that another method has to be able to ask about BEFORE the world exists
    // (`_pickFlickerLot`), and a draw that depended on how many bags had been rolled
    // first could not be asked twice. A negative `inward` is the pavement.
    const machine = vendingDraw(this.seed, chunk.cx, chunk.cz, SIDE_NAMES.indexOf(lot.side))
    if (machine) {
      const along = (rng() * 2 - 1) * (frame.long / 2 - 1.6)
      const spot = inLot(frame, lot, copy, along, -VENDING_SETBACK)
      if (this._portalClear(spot.x, spot.z, copy)) {
        record('vending', spot.x, spot.z)
        this._addVendingMachine(spot.x, spot.z, frame.yaw, machine.lit, `${chunk.cx},${chunk.cz},${lot.side}` === this.flickerLot, copy)
      }
    }

    // ---- the poster, on the street wall --------------------------------------
    //
    // Wall-mounted, so it needs a wall: an anchor lot's objective has no building to
    // paste anything on. The house's OWN street face, not the lot's frontage line —
    // `houseFaces` calls that distinction the bug it was written around, and a
    // poster placed against the lot rather than the house is 4.5 m out in the yard,
    // hanging in mid-air.
    if (house && rates.poster > 0 && Math.floor(rng() * rates.poster) === 0) {
      const wall = houseFaces(frame, house.cx, house.cz, house.w, house.d).street
      const u = (rng() * 2 - 1) * (wall.size / 2 - 0.45)
      // The exclusion runs on the WALL'S OWN PLANE, and this line is here because the
      // first version of the pass did not run it at all: a poster 6 mm off a siding is
      // 2.5 m from one portal on the default seed, and it is a poster — flat, pale,
      // and 0.42 x 0.60 — directly in the stand-off of a gate whose pupil luma is the
      // pass-3 measurement. A wall decal needs the filter more than a bollard does,
      // because it is the only thing in this pass that is ON a wall rather than ON the
      // ground, and the wall is the one surface a portal's own lot always has.
      const px = wall.face === 'z' ? wall.along + u : wall.plane + wall.sign * POSTER_LIFT
      const pz = wall.face === 'z' ? wall.plane + wall.sign * POSTER_LIFT : wall.along + u
      if (this._portalClear(px, pz, copy)) {
        const torn = Math.floor(rng() * POSTER_TORN_ONE_IN) === 0
        onWall(torn ? this.pools.postersTorn : this.pools.posters, wall, u, POSTER_Y, POSTER_LIFT, POSTER_W, POSTER_H)
        record(torn ? 'posterTorn' : 'poster', px, pz)
      }
    }
    // ---- the bollard run, at the kerb ----------------------------------------
    //
    // A RUN and not a bollard: two posts `BOLLARD_RUN_SPACING` apart is a gate
    // marking a driveway, and a single post in the middle of a pavement is a thing
    // with no reason to be there. Both sit `BOLLARD_SETBACK` in front of the
    // frontage, which is the number the creature's eye line is measured against.
    if (rates.bollard > 0 && Math.floor(rng() * rates.bollard) === 0) {
      const along = (rng() * 2 - 1) * (frame.long / 2 - 3)
      for (let index = 0; index < BOLLARDS_PER_RUN; index += 1) {
        const spot = inLot(frame, lot, copy, along + (index - 0.5) * BOLLARD_RUN_SPACING, -BOLLARD_SETBACK)
        if (!this._portalClear(spot.x, spot.z, copy)) continue
        this.pools.bollards.place(spot.x, (BOLLARD_H - BOLLARD_CAP_H) / 2, spot.z, BOLLARD_R * 2, BOLLARD_H - BOLLARD_CAP_H, BOLLARD_R * 2)
        // The retroreflective band at the very top, in the same pool: same colour,
        // same material, and a bollard whose band is a different value is a bollard
        // wearing a hat.
        this.pools.bollards.place(spot.x, BOLLARD_H - BOLLARD_CAP_H / 2, spot.z, BOLLARD_R * 2.1, BOLLARD_CAP_H, BOLLARD_R * 2.1)
        record('bollard', spot.x, spot.z)
        if (copy === 0) this._collider(spot.x, spot.z, BOLLARD_R * 2, BOLLARD_R * 2, 'bollard')
      }
    }
  }

  /**
   * `_addDumpster` — a 660-litre bin: two castors, a body, and a lid that overhangs.
   *
   * FOUR instances in one pool, and the two that matter for the silhouette are the
   * castors and the lid. The lid is `DUMPSTER_LID_PROUD` proud on all four sides
   * because a flush lid is a BOX, and mechanism 1 (silhouette first) is the reason
   * this pass exists. The castors are `DUMPSTER_FOOT` of clearance because a bin
   * whose body starts at y = 0 has no contact patch, and the reference's own failure
   * list names floating objects as the thing that reads as a bug at 40 m even when
   * it is not one.
   *
   * @param {number} x the bin's centre
   * @param {number} z the bin's centre
   * @param {number} yaw the lot's own yaw, so the long axis runs along the gap
   * @param {number} copy the wrapped copy
   * @returns {void}
   */
  _addDumpster(x, z, yaw, copy) {
    const castor = DUMPSTER_CASTOR
    for (const end of [-1, 1]) {
      const along = end * (DUMPSTER_W / 2 - castor)
      this.pools.dumpsters.place(
        x + (yaw === 0 ? along : 0), castor / 2, z + (yaw === 0 ? 0 : along),
        castor, castor, castor, yaw,
      )
    }
    this.pools.dumpsters.place(x, DUMPSTER_FOOT + DUMPSTER_H / 2, z, DUMPSTER_W, DUMPSTER_H, DUMPSTER_D, yaw)
    this.pools.dumpsters.place(
      x, DUMPSTER_FOOT + DUMPSTER_H + DUMPSTER_LID_T / 2, z,
      DUMPSTER_W + 2 * DUMPSTER_LID_PROUD, DUMPSTER_LID_T, DUMPSTER_D + 2 * DUMPSTER_LID_PROUD, yaw,
    )
    if (copy === 0) this._collider(x, z, DUMPSTER_W, DUMPSTER_D, 'dumpster')
  }

  /**
   * `_addTrashBag` — one tied bag and its knot, in two instances of one material.
   *
   * The knot is 0.12 m of the same polythene on top of a 0.58 m lump, and it is the
   * whole difference between a bag and a box: a bag is a thing that was filled and
   * twisted, and the twist is the only part of that a silhouette can show. Two
   * instances rather than a second geometry, because the material is the same and
   * `place` is the only thing that differs.
   *
   * @param {number} x the bag's centre
   * @param {number} z the bag's centre
   * @param {number} yaw this bag's own yaw, deliberately NOT the lot's
   * @returns {void}
   */
  _addTrashBag(x, z, yaw) {
    this.pools.trashBags.place(x, TRASH_BAG_H / 2, z, TRASH_BAG_W, TRASH_BAG_H, TRASH_BAG_D, yaw)
    this.pools.trashBags.place(x, TRASH_BAG_H + 0.06, z, 0.14, 0.12, 0.14, yaw)
  }

  /**
   * `_addVendingMachine` — a cabinet, a liner, and the rails that make the liner a
   * machine rather than a rectangle of light.
   *
   * FOUR instances, and which POOL the liner lands in is the pass's headline. The
   * dead liner and the lit liner cannot share a pool because an `InstancedMesh` has
   * one material slot, and the flickering liner cannot share the lit one for the
   * reason pass 5 split the siding: `update()` writes `emissiveIntensity`, and a
   * shared material is a shared flicker. Three pools, three draw calls, and exactly
   * one machine in the world that misbehaves.
   *
   * THE RAILS ARE NOT DECORATION. A lit panel with nothing in it averages to a
   * single value at 30 m and stops being a machine — the same defect pass 3's swirl
   * gate was written to catch on a portal. Two bars standing `VENDING_RAIL_INSET`
   * proud of a liner set `VENDING_FACE_INSET` into the cabinet is the depth stack T3
   * asks for on a window, at the scale of a drinks machine.
   *
   * @param {number} x the cabinet's centre
   * @param {number} z the cabinet's centre
   * @param {number} yaw the lot's own yaw, so the liner faces the street
   * @param {boolean} lit whether this is one of the lit machines
   * @param {boolean} flicker whether this is THE machine that misbehaves
   * @param {number} copy the wrapped copy
   * @returns {void}
   */
  _addVendingMachine(x, z, yaw, lit, flicker, copy) {
    this.pools.vendingBodies.place(x, VENDING_H / 2, z, VENDING_W, VENDING_H, VENDING_D, yaw)
    // The liner sits on the cabinet's front plane, `VENDING_FACE_LIFT` proud of it,
    // offset along the cabinet's own forward — `sin(yaw), cos(yaw)` is the unit
    // vector `place` turns local +z into, so the same expression places the face
    // and the rails and cannot disagree about which way the machine faces.
    const face = flicker
      ? this.pools.vendingFlickerFaces
      : lit ? this.pools.vendingLitFaces : this.pools.vendingFaces
    const fx = x + Math.sin(yaw) * (VENDING_D / 2 + VENDING_FACE_LIFT)
    const fz = z + Math.cos(yaw) * (VENDING_D / 2 + VENDING_FACE_LIFT)
    face.place(fx, VENDING_FACE_Y, fz, VENDING_FACE_W, VENDING_FACE_H, 0.01, yaw)
    for (let rail = 0; rail < VENDING_RAIL_COUNT; rail += 1) {
      const y = VENDING_FACE_Y - VENDING_FACE_H / 2 + (VENDING_FACE_H * (rail + 1)) / (VENDING_RAIL_COUNT + 1)
      this.pools.vendingRails.place(
        x + Math.sin(yaw) * (VENDING_D / 2 + VENDING_FACE_INSET),
        y,
        z + Math.cos(yaw) * (VENDING_D / 2 + VENDING_FACE_INSET),
        VENDING_FACE_W, VENDING_RAIL_T, VENDING_RAIL_INSET, yaw,
      )
    }
    if (copy === 0) this._collider(x, z, VENDING_W, VENDING_D, 'vending')
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
  // ITERATION 2, PASS 8 — WATER & REFLECTIONS
  //
  // Four methods: the driver, the puddles, the streaks and the canal. The order
  // they run in is the order the world reads in — wet road, then water, then
  // the light coming off it — and it is also the order of the render orders set
  // in `_buildChunkGeometry`.
  // -------------------------------------------------------------------------

  /**
   * `_buildWater` — every puddle, every halo, every streak and the canal.
   *
   * The driver, and it is deliberately the smallest method in the pass: it owns
   * the two counters (`waterLog`, `waterRejected`) that the gate reads and
   * nothing else, so that "what the pass claims" and "what the pass does" are
   * two different places in the file and a check cannot confuse them.
   *
   * `waterLog` is published for the reason `dressingLog` and `wireSpans` are:
   * the claim "every puddle is in a gutter, a crossing or the canal" is a claim
   * about ADDRESSING — which of the three bands a puddle was placed into is not
   * recoverable from its coordinates, because all three are legal positions and
   * the only difference between them is which rule ran. A check that measured
   * the geometry alone would be asking "is this puddle near a kerb", which is
   * true of all three bands and therefore says nothing.
   *
   * The streaks are placed here rather than in `_buildLamps` because a streak
   * needs the lamp's own ground point, and reading it back out of
   * `lampPositions` would be re-deriving a number the caller already has.
   */
  _buildWater() {
    this.waterLog = []
    this.waterRejected = 0
    for (let ax = 0; ax < GRID; ax += 1) {
      for (let az = 0; az < GRID; az += 1) {
        this._addPuddles(ax, az)
        this._addStreak(ax, az)
      }
    }
    this._addCanal()
  }

  /**
   * `_addPuddles` — the gutter, the crossing and the canal-band candidates at
   * one intersection, for all three wrapped copies.
   *
   * EIGHT candidates, drawn in a FIXED order, and the order is load-bearing for
   * the same reason pass 7's corner order is: the stream is consumed in a fixed
   * sequence, so adding a candidate at the end cannot silently move the roll
   * that decides whether an existing one gets water.
   *
   *   0-3  the four GUTTER candidates — one per (road, side) pair, each
   *         `STREET_HALF_WIDTH - PUDDLE_GUTTER_INSET` from its own centreline,
   *         i.e. in the channel between the kerb face and the tarmac, and
   *         `PUDDLE_GUTTER_ALONG` out from the corner so it is in the middle of
   *         the block rather than on the junction box.
   *   4-5  the two CROSSING candidates — in the carriageway of the avenue, at
   *         `PUDDLE_CROSSING_OFFSET` either side of the centreline, which is
   *         where a cambered road's two wheel ruts are.
   *   6-7  the two CANAL-BAND candidates — but only at `CANAL_NODE`, where the
   *         channel actually is. Everywhere else the roll is consumed and
   *         discarded, so the stream stays in step across every node.
   *
   * The GUTTER long axis is ALONG the road and the CROSSING long axis is ACROSS
   * it, and that is not a stylistic choice: the gutter puddle is a stripe
   * because the gutter is a line, and the crossing one a long oval because the
   * rut is. A puddle whose elongation does not match the feature that made it
   * reads as a drop of paint.
   *
   * EACH BAND'S RADIUS IS BOUNDED BY THE ROOM THAT BAND HAS, and this is the
   * second bug the first version of this pass had, found by measuring rather
   * than by looking. A gutter candidate sits `STREET_HALF_WIDTH -
   * PUDDLE_GUTTER_INSET` = 5.3 m from the centreline, so a 2.4 m radius reaches
   * 7.7 m — and the kerb face is at 6.4. A third of the world's puddles were
   * lying on the pavement, in the gutter band's own name. The fix is not a
   * smaller global radius, which would shrink the crossing band where there IS
   * room; it is to give each band the room it was given, and the room is the
   * SAME constant that positioned it, so the two cannot drift apart:
   *
   *     gutter   PUDDLE_GUTTER_INSET      0.70 m  to the tarmac edge
   *     crossing PUDDLE_CROSSING_OFFSET  2.10 m  to the centreline
   *     canal    PUDDLE_CANAL_SETBACK    0.85 m  to the channel's outer lip
   *
   * The draw is scaled into `[PUDDLE_R_MIN, room]` rather than clamped to it, so
   * the distribution stays uniform inside the band instead of piling up against
   * the ceiling — a clamp would make every large crossing puddle exactly 2.1 m
   * and a street of identical puddles. `verify-world.mjs` measures every
   * instance's outer edge against the kerb face, which is the claim neither the
   * clamp nor the scale can hide.
   *
   * @param {number} ax avenue axis
   * @param {number} az street axis
   * @returns {void}
   */
  _addPuddles(ax, az) {
    const node = streetNodeToWorld(streetNodeId(ax, az))
    const rng = streamAt(hash32(this.seed, ax, az + WATER_SALT), 0, 0)
    const gutter = STREET_HALF_WIDTH - PUDDLE_GUTTER_INSET
    // Each candidate is `[x, z, yaw, band, room]`, and `room` is the distance
    // from the candidate's own centre to the edge it must not cross.
    const candidates = []
    // 0-3: one per (road, side). `alongX` says which road the gutter belongs
    // to, and the yaw follows it: a gutter on the east-west street runs in x,
    // so its puddle is stretched in x, and the pair are one decision.
    for (const alongX of [true, false]) {
      for (const side of [-1, 1]) {
        const along = PUDDLE_GUTTER_ALONG_MIN + rng() * (PUDDLE_GUTTER_ALONG_MAX - PUDDLE_GUTTER_ALONG_MIN)
        candidates.push([
          node.x + (alongX ? along : side * gutter),
          node.z + (alongX ? side * gutter : along),
          alongX ? 0 : Math.PI / 2,
          'gutter',
          PUDDLE_GUTTER_INSET,
        ])
      }
    }
    // 4-5: the crossing, in the two ruts either side of the avenue's centreline
    // and pushed along the street so it is not on the junction box itself.
    for (const side of [-1, 1]) {
      candidates.push([
        node.x + side * PUDDLE_CROSSING_OFFSET,
        node.z + PUDDLE_CROSSING_ALONG,
        Math.PI / 2,
        'crossing',
        PUDDLE_CROSSING_OFFSET,
      ])
    }
    // 6-7: the canal band, at the one node that has a canal. The room is the
    // setback measured from the channel's OUTER lip, so the puddle's near edge
    // just brushes the concrete — which is what water sitting against a channel
    // looks like, and a puddle overlapping a 100 mm lip is a puddle through a
    // wall. The X offset is the channel's own (`CANAL_CANAL_OFFSET` from the
    // node) and the Z is pushed along the channel so the pair sits on the road
    // it crosses rather than on the junction box.
    const isCanalNode = ax === CANAL_NODE.ax && az === CANAL_NODE.az
    for (const side of [-1, 1]) {
      candidates.push([
        node.x + CANAL_CANAL_OFFSET + side * (CANAL_W / 2 + CANAL_LIP_T + PUDDLE_CANAL_SETBACK),
        node.z + CANAL_CANAL_PUDDLE_ALONG,
        Math.PI / 2,
        'canal',
        PUDDLE_CANAL_SETBACK,
      ])
    }
    for (const [cx, cz, yaw, band, room] of candidates) {
      // One roll per candidate, consumed even where the candidate cannot be
      // placed, so the stream is a function of the NODE and not of which
      // candidates survived the filter.
      const accept = Math.floor(rng() * PUDDLE_ONE_IN) === 0
      // The canal band only exists at `CANAL_NODE`; everywhere else it would
      // be water in the middle of a road with no channel to justify it, and the
      // gate requires every puddle to be in a band that is really there.
      if (band === 'canal' && !isCanalNode) continue
      // ...and at the canal node it is NOT optional. The brief asks for puddles
      // in the drainage channel, and a 1-in-3 roll on two candidates has a 4 in
      // 9 chance of placing neither — which is exactly what happened on the
      // first run of this pass, and it left the canal band with no water in it
      // at all while every other check stayed green. Water standing against a
      // channel is not decoration to be sprinkled: it is the one place on the
      // street where the low point is BELOW the surrounding road by
      // construction, so if the channel holds no water the whole feature reads
      // as a painted line. The roll is still consumed, so the stream stays in
      // step with every other node.
      if (!accept && band !== 'canal') continue
      // The radius is drawn AFTER the accept roll, so a second roll here could
      // never move the accept decisions of the candidates around it, and it is
      // SCALED into the band's room rather than clamped to it.
      const span = Math.max(0, room - PUDDLE_R_MIN)
      const radius = PUDDLE_R_MIN + rng() * span
      for (const copy of WRAP_COPIES) {
        const x = cx + copy * WORLD_EXTENT
        const z = cz + copy * WORLD_EXTENT
        // THE FILTER, and not as a nicety. Pass 3's gate measures the luma of
        // the hole in the middle of a portal from 4.5 m away and requires it at
        // or under 20, and a bright additive streak on the road between that
        // camera and the gate does not merely look wrong — it invalidates the
        // gate the whole iteration is measured against. This is the structural
        // form of `PORTAL_FURNITURE_CLEAR`.
        if (!this._waterClear(x, z, copy)) continue
        this._addPuddle(x, z, yaw, radius, band, ax, az, copy)
      }
    }
  }

  /**
   * `_addPuddle` — one puddle and its halo: two instances across two pools.
   *
   * The halo is placed FIRST and the water SECOND, and both are written in the
   * same call, so the two cannot get out of step: a puddle whose halo was lost
   * to an over-capacity pool would be a bright disc on dry road, which is the
   * exact failure the halo exists to prevent. `verify-world.mjs` asserts
   * `puddles.used === wetSheen.used` on the built world, which is the only way
   * to catch a version where the two are placed in separate loops.
   *
   * @param {number} x world x, in the drawn copy
   * @param {number} z world z, in the drawn copy
   * @param {number} yaw the long axis, 0 for along x
   * @param {number} radius the SHORT axis, metres
   * @param {string} band `gutter`, `crossing` or `canal`
   * @param {number} ax avenue axis, for the log
   * @param {number} az street axis, for the log
   * @param {number} copy the wrapped copy, for the log
   * @returns {void}
   */
  _addPuddle(x, z, yaw, radius, band, ax, az, copy) {
    const long = radius * PUDDLE_ELONGATION
    // `place` takes (w, h, d) and yaws about Y, so on a yaw of 0 the long axis
    // is `w` and on a quarter turn it is `d` — the same convention the lamp
    // pool uses for its two diameters.
    const across = yaw === 0
    this.pools.wetSheen.place(
      x, PUDDLE_HALO_LIFT, z,
      (across ? long : radius) * PUDDLE_HALO_SPREAD, 1, (across ? radius : long) * PUDDLE_HALO_SPREAD, yaw,
    )
    this.pools.puddles.place(
      x, PUDDLE_HALO_LIFT + PUDDLE_LIFT_GAP, z,
      across ? long : radius, 1, across ? radius : long, yaw,
    )
    this.waterLog.push({ kind: 'puddle', band, ax, az, copy, x, z, yaw, radius })
  }

  /**
   * `_addStreak` — one reflection streak per lamp, for all three wrapped copies.
   *
   * This is the "elongated vertical streak" the brief asks for, and it is ONE
   * QUAD PER LAMP: 147 instances of a 1x1 plane, two triangles each, 294
   * triangles for every reflection in the world.
   *
   * WHY A QUAD AND NOT A RENDER TARGET. A real reflection needs a second camera,
   * a second pass and a texture to sample. The world has ONE camera, one render
   * pass and no `WebGLRenderTarget` anywhere, and `verify-world.mjs` asserts
   * that. What makes the cheat work is that a reflection of a LIGHT in a
   * horizontal surface is not a picture of the world — it is a single elongated
   * smear along the line from the light to the eye. That shape is a quad, and
   * the quad's orientation is the only thing that has to be right.
   *
   * WHICH WAY IT POINTS, and this is the one decision in the pass:
   *
   * The streak lies in the CARRIAGEWAY, `STREAK_ROAD_INSET` in from the kerb on
   * the lamp's own side of the road, with its bright head at the kerb face and
   * its tail running `STREAK_LEN` further along the road. It does NOT point at
   * the camera, and it cannot: the pools are built once and the player walks a
   * 448 m world, so a streak that tracked the eye would be a per-frame rewrite
   * of 147 instance matrices. Instead it points DOWN THE ROAD, which is the
   * direction the player is looking in 13 of the 14 §16.5 views (they all stand
   * at a lamp and look along the avenue), and a smear that runs away from the
   * viewer along the road is what a wet road actually looks like from a
   * first-person camera. Seen side-on, across the road, it reads as a bright
   * bar on the tarmac — which is also correct.
   *
   * WHY IT IS INSIDE THE KERB AND NOT UNDER THE LAMP. The first version put the
   * head at the lamp's own ground point, which is `STREET_HALF_WIDTH + 1.6 -
   * 0.9` = 6.7 m from the centreline — and `STREET_HALF_WIDTH + KERB_WIDTH` is
   * 6.4, so the entire streak was lying on the PAVEMENT, 1.4 m outside the
   * carriageway it is supposed to be a reflection in. Nothing failed: the
   * geometry was well formed, the count was right, and the screenshot would have
   * shown a bright smear on the concrete beside the road, which a reader would
   * have called a bug in a way no number in the report would have located. The
   * fix is the inset below, and `verify-world.mjs` now measures every streak's
   * distance to the nearest road centreline and requires it to be INSIDE
   * `STREET_HALF_WIDTH` — the same test pass 6 applies to furniture from the
   * other side, and the reason it is worth having in both directions is that
   * "not in the middle of the road" and "not on the pavement" are different
   * claims and a puddle needs the second one.
   *
   * WHICH AXIS, and the two are not the same claim. A lamp stands on a corner
   * and lights two roads, so a streak may run along either. The axis is a
   * per-node hash rather than a constant, because a world where every lamp
   * streaks the same way down the same axis is a pattern, and AESTHETIC-NOTES
   * §5's whole argument is that uniformity is what makes a generated street
   * read as generated. The hash is `hash32` on the node's own coordinates, so it
   * is the same on every build and in every wrapped copy.
   *
   * WHY ONE PER LAMP AND NOT ONE PER PUDDLE. The reflection belongs to the
   * LIGHT, not to the water: a street with three puddles under one lamp has one
   * lamp's reflection in it, drawn three times over, and a per-puddle scheme
   * would triple the count to sell the same picture. It also makes the count a
   * function of the lamp grid — 49 x 3, exactly — and `verify-world.mjs`
   * asserts `streaks.used === 49 * 3`, which no puddle-driven scheme could
   * satisfy.
   *
   * The filter is `_waterClear`, and it is on the streak and not only on the
   * puddle that matters: the streak is the ADDITIVE element, so it is the one
   * that can raise the luma of a portal's pupil past 20.
   *
   * @param {number} ax avenue axis
   * @param {number} az street axis
   * @returns {void}
   */
  _addStreak(ax, az) {
    const node = streetNodeToWorld(streetNodeId(ax, az))
    // Which of the node's two roads this lamp streaks along. `hash32` on the
    // node's own coordinates, and NOT on the seed: the lamps are on a fixed grid
    // whatever the seed, and a streetlight's reflection should not permute when
    // the fixture seed does.
    const alongX = hash32(0x5354524b, ax, az) % 2 === 0
    // The head at the kerb face and the tail running away from the junction, so
    // the streak lies in the block the player is looking down rather than across
    // the junction box.
    const head = STREET_HALF_WIDTH
    const cross = STREET_HALF_WIDTH - STREAK_ROAD_INSET
    for (const copy of WRAP_COPIES) {
      const x = node.x + (alongX ? head + STREAK_LEN / 2 : cross) + copy * WORLD_EXTENT
      const z = node.z + (alongX ? cross : head + STREAK_LEN / 2) + copy * WORLD_EXTENT
      if (!this._waterClear(x, z, copy)) continue
      // The long axis is the one the streak RUNS along, so the scale is
      // `(STREAK_LEN, 1, STREAK_W)` on a yaw of 0 and `(STREAK_W, 1, STREAK_LEN)`
      // on a quarter turn — the same convention the lamp pool uses for its two
      // diameters and the puddle uses for its elongation.
      const across = !alongX
      this.pools.streaks.place(
        x, STREAK_LIFT, z,
        across ? STREAK_W : STREAK_LEN, 1, across ? STREAK_LEN : STREAK_W,
      )
      this.waterLog.push({ kind: 'streak', ax, az, copy, x, z, yaw: across ? Math.PI / 2 : 0 })
    }
  }

  /**
   * `_addCanal` — the world's one drainage channel, in all three wrapped copies.
   *
   * SIX instances: two lips, one water surface, per copy. It runs
   * `CANAL_LEN` along the east-west street at `CANAL_NODE`, and it CROSSES the
   * carriageway of the avenue that street meets — which is the brief's "one long
   * drainage canal or flooded gutter crossing a street segment", and the
   * crossing is the point: a channel that stops at the kerb is a gully, and
   * pass 6 already has gullies.
   *
   * WHY IT IS BUILT AS A BOX AND NOT A RECESS IN THE ROAD. The carriageway is a
   * single `PlaneGeometry` 1,344 m across, so there is no hole to cut and no
   * CSG in this file. A channel therefore has to be ASSEMBLED from things that
   * stand on the road, and the assembly is the two lips: two 120 x 100 mm
   * kerb-section bars with the water plane between them, 90 mm down. The lips
   * are `PALETTE.kerb` rather than a new colour because a drainage channel's
   * walls ARE kerb — it is the same precast concrete, and a separate value would
   * be inventing a material the reference does not have.
   *
   * The water surface sits `CANAL_LIP_H - CANAL_DEPTH` up inside the lips —
   * 10 mm below their top on the numbers above — and NOT at the bottom of the
   * channel, because the bottom is not visible: at 11 m and a 1.75 m eye height a
   * 90 mm slot is seen at a 3 degree grazing angle, and at that angle the water
   * and the floor of the channel project to the same few pixels. Writing the
   * lift as the lip height MINUS the channel depth rather than as a third
   * independent number is what makes the two agree: the first version wrote
   * `0.01` literally, `CANAL_DEPTH` went unused, and a later edit to either the
   * lip or the depth would have left the water floating in or sunk through the
   * channel with nothing failing. `verify-world.mjs` reads the built lifts back
   * and requires the water to be BELOW both lips and ABOVE the road.
   *
   * The lips get their own pool rather than joining `kerbs`, because `kerbs` is
   * sized at `4 * GRID + 8` and is committed by `_buildRoad` before the water
   * exists; a canal added to it would have to be placed from here into a pool
   * that is already full, and the overflow would be silent.
   *
   * @returns {void}
   */
  _addCanal() {
    const node = streetNodeToWorld(streetNodeId(CANAL_NODE.ax, CANAL_NODE.az))
    // THE CHANNEL RUNS ALONG Z AND CROSSES THE EAST-WEST STREET. This is the
    // whole of "crossing a street segment" and the first version of this pass got
    // it wrong in a way no structural check could see: it ran the channel along
    // X at `CANAL_CANAL_OFFSET` north of the node, which put a 26 m strip of
    // standing water in the middle of a BLOCK — 21 m from the nearest road
    // centreline, between two houses, where it is not a drainage channel at all
    // but a decorative pond in someone's back yard. The counts were right, the
    // geometry was well formed, and the water was in the scene.
    //
    // A channel that crosses a road runs PERPENDICULAR to it, so this one runs in
    // z and crosses the east-west street at the node. `CANAL_CANAL_OFFSET` is
    // therefore an X offset, not a Z one: 9 m along the street from the junction
    // — clear of the 6 m carriageway box, so the channel is not lying across the
    // middle of the intersection, and 26 m long, so it spans the 12 m of road
    // plus 7 m of block on either side.
    const cx = node.x + CANAL_CANAL_OFFSET
    // The derived lift, named once so the placement below and the gate's
    // arithmetic read the same expression.
    const waterY = CANAL_LIP_H - CANAL_DEPTH
    for (const copy of WRAP_COPIES) {
      const x = cx + copy * WORLD_EXTENT
      for (const side of [-1, 1]) {
        // The lip: a `CANAL_LIP_T`-thick bar of `CANAL_LIP_H` height standing
        // `CANAL_W / 2 + CANAL_LIP_T / 2` off the centre line, so its INNER
        // face is exactly `CANAL_W / 2` out. The arithmetic is written as a
        // face-offset rather than a centre offset so the two lips cannot end up
        // a `CANAL_LIP_T` apart from each other, which is the off-by-one that
        // makes a channel narrower than its own water.
        this.pools.canalLips.place(
          x + side * (CANAL_W / 2 + CANAL_LIP_T / 2), CANAL_LIP_H / 2, node.z,
          CANAL_LIP_T, CANAL_LIP_H, CANAL_LEN,
        )
      }
      this.pools.canalWater.place(
        x, waterY, node.z, CANAL_W, 1, CANAL_LEN,
      )
      this.waterLog.push({ kind: 'canal', copy, x, z: node.z, yaw: Math.PI / 2, y: waterY })
    }
  }

  /**
   * `_waterClear` — is this spot far enough from every portal to put water on it?
   *
   * The same predicate `_portalClear` applies to furniture, with its own
   * counter, and the reason it is a SEPARATE method rather than a call to
   * `_portalClear` is bookkeeping: `dressingRejected` counts rejected *objects*
   * and `verify-world.mjs` asserts on that number, and letting ~200 rejected
   * puddles inflate it would make a pass-7 assertion about pass 6's filter a
   * pass-8 assertion too.
   *
   * The distance is `PORTAL_FURNITURE_CLEAR` (12 m) and not a tighter water
   * radius, for the same reason that constant is 12 and not 2.7: the §16.5.5
   * stand-off is 4.5 m and the gate measures the pupil in that frame, so the
   * exclusion has to clear the whole frontage run of a portal's own lot, not
   * just the doorway. A 1.1 m channel 8 m from a gate would still put a
   * 26 m-long additive smear across the bottom of the frame the gate is read
   * from, and 12 m is the distance at which it does not.
   *
   * FOLDED TO CANONICAL, exactly as `_portalClear` folds: the caller has added
   * `copy * WORLD_EXTENT` and this subtracts it again, or the exclusion would
   * silently exist in one ninth of the world.
   *
   * @param {number} x world x, in the drawn copy
   * @param {number} z world z, in the drawn copy
   * @param {number} copy the wrapped copy the caller is placing into
   * @returns {boolean} true if the spot may carry water
   */
  _waterClear(x, z, copy) {
    const shift = copy * WORLD_EXTENT
    for (const anchor of this.objectives.portals) {
      if (Math.hypot(x - shift - anchor.position.x, z - shift - anchor.position.z) < PORTAL_FURNITURE_CLEAR) {
        this.waterRejected += 1
        return false
      }
    }
    return true
  }
  // -------------------------------------------------------------------------
  // ITERATION 2, PASS 6 — street furniture I
  //
  // AESTHETIC-NOTES §5's plan builds the wire ribbon FIRST ("before anything is
  // placed on it") and gives the reason: "Poles without wires look like lamp
  // posts, which we already have 49 of." So the order in this block is the order
  // the pass was built in, and it is also the order the methods are in.
  // -------------------------------------------------------------------------

  /**
   * `_buildStreetFurniture` — every pole, wire, sign, hydrant and gully in the
   * world, in that order, for all three wrapped copies.
   *
   * THE SEAM, and why no span crosses it
   * -----------------------------------
   * The obvious thing is to close the torus the way the poles do: the easternmost
   * node's span goes to the next copy's node 0. The first version of this method
   * did that and produced 438 m spans hanging 17 m into the road, because §3.1's
   * wrap is a DIAGONAL one. The three copies are translated by `(±448, ±448)`
   * together, not tiled, so the neighbour east of node 6 at x = +192 is node 0 of
   * the next copy at x = +256 **and z + 448** — a span from there is a 438 m
   * diagonal wire whose sag drops its middle 9.4 m BELOW the tarmac. The same is
   * true of the z seam, where the neighbour is 448 m away in x. There is no
   * third option, because the world is not a 3x3 tile and never was: `WRAP_COPIES`
   * is a diagonal band, and the lot builder, the road strips and the lamp grid
   * all accept that.
   *
   * So the run of wire stops at each copy's boundary, 64 m short of the
   * intersection it would have reached, and at 64 m the fog has already taken it
   * (visibility is 40-80 m across the dusk curve). A visible wire ending in a
   * band 64 m away would be a bug; a wire dragging on the pavement in plain
   * sight is worse, and one span in five is deliberately sagging 1.7x as low.
   *
   * `this.wireSpans` is published rather than discarded: `verify-world.mjs` reads
   * the sag of every span out of it and re-derives the tiers, and a check that
   * could only read the geometry back would be a tautology.
   *
   * @returns {void}
   */
  _buildStreetFurniture() {
    this.wireSpans = []
    this.polePositions = []
    for (const copy of WRAP_COPIES) {
      for (let ax = 0; ax < GRID; ax += 1) {
        for (let az = 0; az < GRID; az += 1) {
          const pole = this._poleAt(ax, az, copy)
          this._addPole(pole)
          if (copy === 0) {
            this.polePositions.push({ x: pole.x, z: pole.z, ax, az })
            // A collider, and no occluder. A 220 mm shaft is something the player
            // walks into; it is NOT something that hides a creature, because a
            // sightline broken by a pole is a sightline broken by a fence. One
            // canonical copy, like every other collider in this file.
            this._collider(pole.x, pole.z, POLE_DIAMETER, POLE_DIAMETER, 'pole')
          }
          // One span east and one south per node, and the last row and column of
          // nodes have no partner — see the header. The arm axis is 1 for the
          // east span and 0 for the south one, so the conductors are offset
          // PERPENDICULAR to their own run and a span's three wires stay
          // parallel instead of fanning.
          if (ax < GRID - 1) this._addSpan(pole, this._poleAt(ax + 1, az, copy), 1, this._isLowSpan(ax, az, 0))
          if (az < GRID - 1) this._addSpan(pole, this._poleAt(ax, az + 1, copy), 0, this._isLowSpan(ax, az, 1))
          this._addIntersectionFurniture(ax, az, copy)
          // ITERATION 2, PASS 7 — the two intersection families, on the same corner
          // and the same loop, so a shelter and a pole cannot disagree about which
          // corner of the junction they are on.
          this._addCornerDressing(ax, az, copy)
        }
      }
    }
    const wire = new THREE.Mesh(makeWireGeometry(this.wireSpans), this._materials.wire)
    wire.name = 'wires'
    // T8 says so, and the reasoning is worth keeping: the geometry is a
    // screen-space expansion, its world-space bounds are the bounds of the whole
    // 1,344 m world, and the camera is essentially always inside them — so
    // per-frame culling work buys nothing and a stale sphere is a way to lose
    // the entire wire system in one frame.
    wire.frustumCulled = false
    this.group.add(wire)
    this.wireMesh = wire
  }

  /**
   * `_poleAt` — where the pole on one corner of one intersection stands, in the
   * drawn copy.
   *
   * WHICH corner is the district's decision and not the seed's: `districtOf`
   * splits the map four ways and the pole corner walks the four corners in the
   * order the districts are numbered. It is "per district" in the literal sense
   * the checklist asks for, and it has to be a function of the district rather
   * than of a stream, because a pole that moved when the run's fixture seed
   * moved would put 9.2 m of overhead geometry somewhere new on every reset —
   * and nothing in this pass except the fixtures is allowed to move between
   * loops.
   *
   * @param {number} ax avenue axis, wrapped
   * @param {number} az street axis, wrapped
   * @param {number} copy the wrapped copy, one of `WRAP_COPIES`
   * @returns {{x: number, z: number}} the pole's foot, in the drawn copy
   */
  _poleAt(ax, az, copy) {
    const [sx, sz] = CORNER_SIGNS[districtOf(ax, az)]
    const node = streetNodeToWorld(streetNodeId(ax, az))
    return {
      x: node.x + sx * POLE_STANDOFF + copy * WORLD_EXTENT,
      z: node.z + sz * POLE_STANDOFF + copy * WORLD_EXTENT,
    }
  }

  /**
   * `_addPole` — one shaft, two axes of hardware, and nothing else.
   *
   * TWO arms rather than the one the plan asks for, and the reason is a wire
   * leaving from mid-air. Every node carries a span east and a span south, and a
   * single arm can only be perpendicular to ONE of them: the conductors of the
   * other run would leave the insulators on the same side of the arm, so the
   * three trunk wires of an avenue span would be staggered ALONG the span by
   * 0.82 m each rather than side by side across it. At 64 m that is nearly
   * invisible — but "nearly" is the definition of a wireframe tell, and a second
   * bar per axis is three more instances on a pole that already has eighteen.
   *
   * The arm sits at `POLE_HEIGHT * POLE_ARM_FRACTION` = 8.556, whose underside is
   * 8.511, and the top tier's conductors are at 8.51. Those numbers meeting there
   * is not a coincidence to be maintained by hand: the tier table is written to
   * that arm, which is why the arm is at 93% of the shaft and not at a round 90%.
   *
   * @param {{x: number, z: number}} pole the pole's foot, in the drawn copy
   * @returns {void}
   */
  _addPole(pole) {
    this.pools.poleShafts.place(pole.x, POLE_HEIGHT / 2, pole.z, POLE_DIAMETER, POLE_HEIGHT, POLE_DIAMETER)
    const armY = POLE_HEIGHT * POLE_ARM_FRACTION
    for (let axis = 0; axis < 2; axis += 1) {
      // `yaw` is the only rotation `place` composes, so an arm along z is the
      // same box turned 90 degrees rather than a second geometry.
      const yaw = axis === 0 ? 0 : Math.PI / 2
      this.pools.poleArms.place(pole.x, armY, pole.z, POLE_ARM_LENGTH, POLE_ARM_THICKNESS, POLE_ARM_THICKNESS, yaw)
      // The bracket and the hook hang UNDER their own conductors rather than
      // being folded into the arm above them, because the tiers are 0.6 m and
      // 0.55 m apart and nothing 9 m up reads as one fitting.
      for (const [tier, length] of [[WIRE_TIERS[1], POLE_BRACKET_LENGTH], [WIRE_TIERS[2], POLE_HOOK_LENGTH]]) {
        const y = tier.y - POLE_INSURATOR_SIZE / 2 - POLE_ARM_THICKNESS / 2
        this.pools.poleArms.place(pole.x, y, pole.z, length, POLE_ARM_THICKNESS, POLE_ARM_THICKNESS, yaw)
      }
      // Six insulators per arm, three of them carrying the trunk tier. They hang
      // BELOW the conductor by their own size, so the wire leaves the TOP of the
      // insulator and the insulator's top is the arm's underside — which is what
      // makes `WIRE_TIERS`' heights and `POLE_ARM_FRACTION` one fact rather than
      // three numbers that have to be kept in agreement by hand.
      for (const tier of WIRE_TIERS) {
        for (const step of tier.arms) {
          const off = step * POLE_INSULATOR_SPACING
          this.pools.poleInsulators.place(
            pole.x + (axis === 0 ? off : 0),
            tier.y - POLE_INSURATOR_SIZE / 2,
            pole.z + (axis === 0 ? 0 : off),
            POLE_INSURATOR_SIZE, POLE_INSURATOR_SIZE, POLE_INSURATOR_SIZE,
          )
        }
      }
    }
  }

  /**
   * `_addSpan` — the six conductors hanging between two poles, as spans.
   *
   * T7's rule that the sags are NOT all equal is two rules deep: the three tiers
   * each carry their own fraction of the span (`WIRE_TIERS[].sag`, strictly
   * ordered trunk > secondary > telecom), and this span is itself one of the
   * 1-in-`LOW_SPAN_ONE_IN` that hangs `LOW_SPAN_SAG_MULT` times lower. The second
   * rule is the one that stops a ruled grid: three tiers at three heights is
   * already a grid, and a grid with no variation in it is the most legible tell
   * that a street was generated rather than built.
   *
   * The sag is derived from the HORIZONTAL distance rather than typed in metres,
   * which is what makes one number correct on a 64 m block edge and on the
   * 49-79 m span the seam-crossing corner offsets produce. `CATENARY_SAG` is the
   * middle tier's figure and it lives on the table; the fraction here is per tier.
   *
   * @param {{x: number, z: number}} from this pole's foot
   * @param {{x: number, z: number}} to the far pole's foot
   * @param {number} armAxis 0 for an arm along x (a span running north-south),
   *   1 for an arm along z (a span running east-west) — the conductors are
   *   offset along the arm and therefore PERPENDICULAR to their own run, so a
   *   span's three wires stay parallel instead of fanning
   * @param {boolean} low this span is the 1-in-5 that hangs lower
   * @returns {void}
   */
  _addSpan(from, to, armAxis, low) {
    const run = Math.hypot(to.x - from.x, to.z - from.z)
    for (const tier of WIRE_TIERS) {
      for (const step of tier.arms) {
        const off = step * POLE_INSULATOR_SPACING
        const ox = armAxis === 0 ? off : 0
        const oz = armAxis === 0 ? 0 : off
        this.wireSpans.push({
          a: { x: from.x + ox, y: tier.y, z: from.z + oz },
          b: { x: to.x + ox, y: tier.y, z: to.z + oz },
          sag: tier.sag * run * (low ? LOW_SPAN_SAG_MULT : 1),
          width: tier.width,
          tier: tier.name,
        })
      }
    }
  }

  /**
   * `_isLowSpan` — T7's "one span in five should be noticeably lower than its
   * neighbours", as a roll on a stream of its own.
   *
   * THREE streams and not one: the corner furniture, the east spans and the south
   * spans each open a different region of the 32-bit mix, so consuming a draw
   * here cannot shift which corners carry a sign. `streamAt` takes chunk
   * coordinates and the offsets are `GRID` apart, so the three regions cannot
   * collide for any `GRID >= 2`.
   *
   * @param {number} ax avenue axis
   * @param {number} az street axis
   * @param {number} axis 0 for the east span, 1 for the south one
   * @returns {boolean} true for the 1-in-`LOW_SPAN_ONE_IN`
   */
  _isLowSpan(ax, az, axis) {
    const rng = streamAt(this.seed, ax, az + (axis + 1) * GRID)
    return Math.floor(rng() * LOW_SPAN_ONE_IN) === 0
  }


  /**
   * `_addIntersectionFurniture` — two signs, maybe a hydrant, maybe a gully, on
   * the corners the pole did not take.
   *
   * `CORNER_SIGNS` is a reservation table and this is the reservation: a corner
   * is a resource, the pole has first call on one, and the rest are dealt out in
   * a fixed order to the sign, the sign, the hydrant and — outside the corner
   * entirely, because a gully is in the road — the gully. `SIGNS_PER_INTERSECTION`
   * is two and not four because a sign on every corner of every intersection is a
   * picket fence, and half the corners bare is what a real street looks like.
   *
   * The hydrant and the grate run at DIFFERENT rates (`HYDRANT_ONE_IN` 3,
   * `DRAIN_ONE_IN` 2) on purpose: a gully is wherever the kerb has a low point and
   * a hydrant is wherever the main is, and a street where both appear at the same
   * frequency on the same corner reads as a set.
   *
   * The stream is consumed in a fixed order — two signs (which consume no
   * draws), then the hydrant, then the gully, then the gully's kerb — so
   * changing what sits on a corner cannot silently move the next thing along.
   *
   * @param {number} ax avenue axis
   * @param {number} az street axis
   * @param {number} copy the wrapped copy, one of `WRAP_COPIES`
   * @returns {void}
   */
  _addIntersectionFurniture(ax, az, copy) {
    const [px, pz] = CORNER_SIGNS[districtOf(ax, az)]
    const node = streetNodeToWorld(streetNodeId(ax, az))
    const rng = streamAt(this.seed, ax, az)
    const free = CORNER_SIGNS.filter(([sx, sz]) => sx !== px || sz !== pz)
    let corner = 0
    const at = (offset) => {
      const [sx, sz] = free[corner % free.length]
      corner += 1
      return {
        x: node.x + sx * offset + copy * WORLD_EXTENT,
        z: node.z + sz * offset + copy * WORLD_EXTENT,
      }
    }
    for (let sign = 0; sign < SIGNS_PER_INTERSECTION; sign += 1) {
      const spot = at(SIGN_WALK_OFFSET)
      this.pools.signPosts.place(spot.x, SIGN_POST_HEIGHT / 2, spot.z, SIGN_POST_RADIUS * 2, SIGN_POST_HEIGHT, SIGN_POST_RADIUS * 2)
      // The plate faces the INTERSECTION, not the street: a sign readable only
      // from a car is a sign a player on the pavement never sees, and a corner's
      // sign is at an angle to both streets by construction. `atan2(dx, dz)`
      // because `place` yaws the plate about Y with its face along local +z.
      this.pools.signPlates.place(
        spot.x, SIGN_PLATE_Y, spot.z,
        SIGN_PLATE_W, SIGN_PLATE_H, SIGN_PLATE_T,
        Math.atan2(node.x - spot.x, node.z - spot.z),
      )
      if (copy === 0) this._collider(spot.x, spot.z, SIGN_POST_RADIUS * 2, SIGN_POST_RADIUS * 2, 'sign')
    }
    // The hydrant goes at the BACK of the walk, on the last free corner: a
    // sign is read from a car at the kerb and a hydrant is not read at all.
    if (Math.floor(rng() * HYDRANT_ONE_IN) === 0) {
      const [hx, hz] = free[free.length - 1]
      const x = node.x + hx * HYDRANT_WALK_OFFSET + copy * WORLD_EXTENT
      const z = node.z + hz * HYDRANT_WALK_OFFSET + copy * WORLD_EXTENT
      this.pools.hydrants.place(x, HYDRANT_BODY_H / 2, z, HYDRANT_BODY_RADIUS * 2, HYDRANT_BODY_H, HYDRANT_BODY_RADIUS * 2)
      this.pools.hydrants.place(x, HYDRANT_BODY_H + HYDRANT_BONNET_H / 2, z, HYDRANT_BODY_RADIUS * 1.7, HYDRANT_BONNET_H, HYDRANT_BODY_RADIUS * 1.7)
      // Two side caps, on the corner's own x, so they point along the pavement
      // rather than into the road.
      for (const side of [-1, 1]) {
        this.pools.hydrants.place(
          x + side * (HYDRANT_BODY_RADIUS + HYDRANT_CAP_SIZE), HYDRANT_BODY_H * 0.7, z,
          HYDRANT_CAP_SIZE, HYDRANT_CAP_SIZE, HYDRANT_CAP_SIZE * 1.6,
        )
      }
      if (copy === 0) this._collider(x, z, HYDRANT_BODY_RADIUS * 2, HYDRANT_BODY_RADIUS * 2, 'hydrant')
    }
    // The gully, in the road against one of the two kerbs and `DRAIN_ALONG` from
    // the corner — a gully is at the kerb's low point and the corner is where the
    // crossfall is highest, so it is never exactly in the corner. The rim's
    // centre is BELOW the road so its top face finishes flush: a gully that sits
    // proud is the floating-object failure the reference's own list names.
    if (Math.floor(rng() * DRAIN_ONE_IN) === 0) {
      const [sx, sz] = CORNER_SIGNS[(districtOf(ax, az) + 1) % CORNER_SIGNS.length]
      const alongZ = Math.floor(rng() * 2) === 0
      const gutter = STREET_HALF_WIDTH + KERB_WIDTH - DRAIN_SETBACK
      const x = node.x + sx * (alongZ ? gutter : DRAIN_ALONG) + copy * WORLD_EXTENT
      const z = node.z + sz * (alongZ ? DRAIN_ALONG : gutter) + copy * WORLD_EXTENT
      const yaw = alongZ ? Math.PI / 2 : 0
      this.pools.drainFrames.place(x, DRAIN_LIFT - 0.03, z, DRAIN_W, 0.06, DRAIN_D, yaw)
      // Five bars, cut to the rim's inner hole so they seat inside it instead of
      // lying across it — see `DRAIN_FRAME_BAR`.
      const inner = DRAIN_D * (1 - 2 * DRAIN_FRAME_BAR)
      const pitch = inner / DRAIN_BAR_COUNT
      const length = DRAIN_W * (1 - 2 * DRAIN_FRAME_BAR)
      for (let bar = 0; bar < DRAIN_BAR_COUNT; bar += 1) {
        const across = -inner / 2 + pitch * (bar + 0.5)
        this.pools.drainBars.place(
          x + (yaw === 0 ? 0 : across), DRAIN_LIFT - 0.02, z + (yaw === 0 ? across : 0),
          length, 0.04, DRAIN_BAR_T,
        )
      }
    }
  }

  /**
   * `_addCornerDressing` — the two families that belong to an INTERSECTION rather
   * than to a lot: a bus shelter and a bicycle locked to the pole.
   *
   * Neither could go in `_addLotDressing`. A shelter is 3.2 m long and a corner is
   * where two 26 m lots meet, so a lot-addressed shelter can only ever be a
   * rectangle floating in the middle of a frontage; and a bicycle is defined by its
   * relationship to a POLE, which is an intersection object. So this method takes
   * the same `DISTRICT_DRESSING` rates, in the same `one in N` sense, and addresses
   * the same corner the district's pole is on — which is also what makes a shelter
   * and a pole agree about which corner of the junction they are standing at.
   *
   * The stream is `hash32(this.seed, ax, az + DRESSING_SALT)` — a different region
   * again from the per-lot one and from pass 6's two, so this pass moves nothing
   * that came before it.
   *
   * @param {number} ax avenue axis
   * @param {number} az street axis
   * @param {number} copy the wrapped copy
   * @returns {void}
   */
  _addCornerDressing(ax, az, copy) {
    const district = districtOf(ax, az)
    const rates = DISTRICT_DRESSING[district]
    const node = streetNodeToWorld(streetNodeId(ax, az))
    const [sx, sz] = CORNER_SIGNS[district]
    const rng = streamAt(hash32(this.seed, ax, az + DRESSING_SALT), 0, 0)
    // A rate of 0 is the district that does not get this family at all — the
    // south-east has no shelter anywhere on it, and that absence is the point.
    if (rates.shelter > 0 && Math.floor(rng() * rates.shelter) === 0) {
      const x = node.x + sx * SHELTER_CORNER_X + copy * WORLD_EXTENT
      const z = node.z + sz * SHELTER_CORNER_Z + copy * WORLD_EXTENT
      if (this._portalClear(x, z, copy)) {
        // Facing the avenue: `place` turns local +z by the yaw and the shelter's
        // front is its local +z, so the yaw that points it back at the centreline
        // is the one whose `sin` is `-sx`.
        this._addShelter(x, z, sx > 0 ? -Math.PI / 2 : Math.PI / 2, copy)
        this.dressingLog.push({ kind: 'shelter', district, copy, x, z })
      }
    }
    if (rates.bike > 0 && Math.floor(rng() * rates.bike) === 0) {
      // `BIKE_PARK_OFFSET` out from the pole towards the walk and
      // `BIKE_PARK_SPACING` along the kerb, which is the geometry of a bike locked
      // to a pole: the frame is parallel to the kerb, not radiating from the pole,
      // and at 0.62 m out the bars clear the 0.22 m shaft.
      const x = node.x + sx * (POLE_STANDOFF + BIKE_PARK_OFFSET) + copy * WORLD_EXTENT
      const z = node.z + sz * (POLE_STANDOFF + BIKE_PARK_SPACING) + copy * WORLD_EXTENT
      if (this._portalClear(x, z, copy)) {
        this._addBike(x, z)
        this.dressingLog.push({ kind: 'bike', district, copy, x, z })
      }
    }
  }



  /**
   * `_addShelter` — a roof, a back, two posts, a bench and the ad panel.
   *
   * SIX instances across three pools, and the split is the ad panel: it is the one
   * DIM surface in the pass and it shares no material with the steel, so it sits in
   * its own pool rather than the shelter's. A backlit panel bright enough to read as
   * a light would be a fifth rung on T11's ladder, spent on a rectangle nobody reads
   * at 40 m.
   *
   * The back is at the far end from the street and the two posts at the near end, so
   * the shelter has a front and a back — a panel between two symmetric posts reads
   * as a phone box, which is the silhouette §5.1 already spends two of the world's
   * three liminal structures on.
   *
   * @param {number} x the shelter's centre
   * @param {number} z the shelter's centre
   * @param {number} yaw facing the street
   * @param {number} copy the wrapped copy
   * @returns {void}
   */
  _addShelter(x, z, yaw, copy) {
    const postH = SHELTER_H - SHELTER_ROOF_T
    // `sin(yaw), cos(yaw)` is the unit vector `place` sends the shelter's own local
    // +z to, so every offset below is written once and the whole method is
    // orientation-free.
    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    const bx = x - fx * (SHELTER_D / 2)
    const bz = z - fz * (SHELTER_D / 2)
    this.pools.shelterSteel.place(bx, SHELTER_BACK_H / 2, bz, SHELTER_W, SHELTER_BACK_H, 0.1, yaw)
    for (const end of [-1, 1]) {
      this.pools.shelterSteel.place(
        x + fx * (SHELTER_D / 2 - SHELTER_POST) + fz * end * (SHELTER_W / 2 - SHELTER_POST),
        postH / 2,
        z + fz * (SHELTER_D / 2 - SHELTER_POST) - fx * end * (SHELTER_W / 2 - SHELTER_POST),
        SHELTER_POST, postH, SHELTER_POST, yaw,
      )
    }
    this.pools.shelterSteel.place(
      x, SHELTER_H - SHELTER_ROOF_T / 2, z,
      SHELTER_W + 2 * SHELTER_ROOF_OVERHANG, SHELTER_ROOF_T, SHELTER_D + 2 * SHELTER_ROOF_OVERHANG, yaw,
    )
    this.pools.shelterBenches.place(
      x - fx * (SHELTER_D / 2 - SHELTER_BENCH_D / 2 - 0.1), SHELTER_BENCH_Y,
      z - fz * (SHELTER_D / 2 - SHELTER_BENCH_D / 2 - 0.1),
      SHELTER_W - 0.4, SHELTER_BENCH_H, SHELTER_BENCH_D, yaw,
    )
    // The ad panel, on the STREET side of the back panel — a poster inside a shelter
    // is a poster nobody can see.
    this.pools.shelterAds.place(bx + fx * 0.07, SHELTER_AD_Y, bz + fz * 0.07, SHELTER_AD_W, SHELTER_AD_H, 0.04, yaw)
    if (copy === 0) this._collider(x, z, SHELTER_D, SHELTER_W, 'shelter')
  }

  /**
   * `_addBike` — a bicycle, upright, in seven instances across two pools.
   *
   * UPRIGHT AND NOT LEANED, which is a decision and not a simplification. A real
   * parked bike leans 5-15 degrees onto whatever is holding it, and a lean is a
   * rotation about an axis ALONG the ground plane, which `place` cannot compose —
   * it composes yaw about Y and nothing else. Leaning properly would mean either a
   * second geometry per lean angle or a per-instance quaternion, and both are a whole
   * mechanism for a 6 degree tilt on an object whose silhouette is 0.7 m of frame.
   * Standing it against a pole reads identically at every distance the player will
   * see it from, and it costs one axis.
   *
   * TWO POOLS, and the wheels are a `TorusGeometry` in the second one: a cylinder
   * seen edge-on is a rectangle, and a bicycle has no rectangles in it. Both wheels
   * are yawed 90 degrees, so the torus's own axis — its local z — lies ACROSS the
   * direction of travel, which is the only orientation in which a ring reads as a
   * wheel on a bicycle rather than a hoop on a cart.
   *
   * @param {number} x the bike's centre
   * @param {number} z the bike's centre
   * @returns {void}
   */
  _addBike(x, z) {
    const half = BIKE_WHEELBASE / 2
    for (const end of [-1, 1]) {
      this.pools.bikeWheels.place(
        x, BIKE_WHEEL_R, z + end * half,
        BIKE_WHEEL_R * 2, BIKE_WHEEL_R * 2, BIKE_WHEEL_R * 2, Math.PI / 2,
      )
    }
    // The main triangle as TWO bars rather than eight tubes, which is what
    // `BIKE_LOWER_Y` and `BIKE_UPPER_Y` are for: at 40 m what resolves is two discs
    // and a diagonal, and AESTHETIC-NOTES §0's budget is 8-40 triangles per
    // interruption, which eight tubes per bike would not fit inside.
    this.pools.bikeFrames.place(x, BIKE_LOWER_Y, z, BIKE_FRAME_T, BIKE_FRAME_T, BIKE_WHEELBASE)
    this.pools.bikeFrames.place(x, BIKE_UPPER_Y, z + 0.1, BIKE_FRAME_T, BIKE_FRAME_T, BIKE_WHEELBASE * 0.8)
    this.pools.bikeFrames.place(x, BIKE_SADDLE_Y, z - half + 0.24, BIKE_SADDLE_W, 0.06, 0.22)
    this.pools.bikeFrames.place(x, BIKE_BAR_Y, z + half - 0.08, BIKE_BAR_W, BIKE_FRAME_T, BIKE_FRAME_T)
    this.pools.bikeFrames.place(x, BIKE_LOWER_Y + 0.06, z + 0.06, BIKE_CHAIN_R * 2, BIKE_CHAIN_R * 2, BIKE_CHAIN_T)
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

      // ---------------------------------------------------------------------
      // ITERATION 2, PASS 12 — the descent. Three objects, all children of the
      // gate so they inherit its quarter-turn, its offset and its per-structure
      // scale, and none of those is re-derived here. This is the same sentence the
      // pass-3 block above makes about "a future fourth piece of the opening",
      // and it has now been taken up three times.
      // ---------------------------------------------------------------------

      // (a) THE LENS — the lensing hint. It sits BEHIND the disc and behind both
      // swirl layers (`PORTAL_LENS_DEPTH`, -0.034) and the position is the reason,
      // not an accident. The lens is 1.34 core radii across and the disc is 1.0, so
      // the 24 cm of the lens that lies OUTSIDE the disc is the annulus the brief
      // asks to be darkened — and that annulus is exactly the background visible
      // around the lip. The part of the lens that overlaps the disc is where
      // `portalLensAlpha` is 0 (it is 0 for every ratio under 1.0, and the disc's
      // own radius is 1.0), so the hole is not darkened at all and the pass-3 pupil
      // gate cannot see this object.
      //
      // BEHIND THE SWIRL, and that is a second decision rather than a restatement of
      // the first. `PORTAL_LENS_DEPTH` has its own docblock and the short version is
      // that a transparent quad standing in front of the brightest thing in the
      // aperture is a refactor away from dimming it, and depth order costs nothing
      // to get right now. It is also what keeps §16.1's raycast check green: at
      // z = 0 the lens was a larger and nearer solid target than the disc and became
      // the first thing a stand-off camera hit.
      //
      // `renderOrder` is written out rather than left at 0 for the same reason
      // pass 6 lifted the creature's eye to 1: a transparent element with no
      // explicit order is one `renderOrder = 3` on some other feature away from
      // being drawn over the hole.
      const lens = new THREE.Mesh(
        new THREE.CircleGeometry(PORTAL_CORE_RADIUS * rules.PORTAL_LENS.outer, PORTAL_LENS_SEGMENTS),
        this._materials.portalLens,
      )
      lens.name = `portal-lens-${id}`
      lens.position.z = PORTAL_LENS_DEPTH
      lens.renderOrder = PORTAL_LENS_RENDER_ORDER
      gate.add(lens)

      // (b) THE DEBRIS — fourteen dark flakes on deterministic orbits, one
      // `InstancedMesh` per portal. One mesh and not fourteen is the whole cost
      // claim: an `InstancedMesh` is one draw call whatever is in it, which is the
      // same argument pass 5 made for the houses and pass 10 had to make again for
      // the trail. `count` is set from the pure module's own count so a rock is
      // never in the table and not in the buffer.
      //
      // `frustumCulled = false` for the reason the wire and the pools set it: the
      // ring's bounding sphere is computed once at construction from a geometry
      // whose instances are all at the origin, so a culled instance pool is a
      // pool that vanishes when the camera looks at the doorway from an angle.
      const debris = new THREE.InstancedMesh(
        new THREE.TetrahedronGeometry(1, PORTAL_FLAKE_DETAIL),
        this._materials.portalDebris,
        PORTAL_DEBRIS_CAPACITY,
      )
      debris.name = `portal-debris-${id}`
      debris.count = rules.PORTAL_DEBRIS_COUNT
      debris.frustumCulled = false
      debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      gate.add(debris)

      // (c) THE COLLAPSE — a group holding a COPY of the aperture, hidden until a
      // shutdown arms it. A copy and not the gate itself, and that is the single
      // most important structural decision in the pass: §5.3's rule is that a shut
      // portal is dark INSTANTLY and for ever, so the live gate has to be dead on
      // the frame the hold completes (and `verify-world.mjs` asserts the live
      // material and the swirl's invisibility on that exact frame). The 0.8 s
      // animation therefore cannot be the live gate, or the rule would be a lie
      // for eight tenths of a second.
      //
      // So the collapse is a second aperture that is shown for 0.8 s, scaled to
      // nothing, and hidden again — and the live gate underneath it is already
      // dark, so what the player sees is a bright hole closing over a dead one.
      // `flash` is a CLONE of the shared material because its opacity is written
      // every frame and three portals cannot share one.
      const collapse = new THREE.Group()
      collapse.name = `portal-collapse-${id}`
      const collapseCore = new THREE.Mesh(
        new THREE.CircleGeometry(PORTAL_CORE_RADIUS, 24),
        this._materials.portalCore.clone(),
      )
      collapseCore.name = `portal-collapse-core-${id}`
      const collapseFlash = new THREE.Mesh(
        new THREE.CircleGeometry(PORTAL_CORE_RADIUS, 24),
        this._materials.portalFlash.clone(),
      )
      collapseFlash.name = `portal-collapse-flash-${id}`
      collapseFlash.position.z = -0.004
      collapse.add(collapseCore, collapseFlash)
      collapse.visible = false
      gate.add(collapse)

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
        // PASS 12. The three new children of the gate, on the record for the same
        // reason the four above are: a check, a capture or a future §5.3 has to be
        // able to reach them without walking the scene graph, and the pass-3
        // section's own first mutation (`gate.add(disc)` deleted, every geometry
        // check green) is the proof that "reachable from the record" and "actually
        // in the world" are two different claims.
        lens,
        debris,
        collapse,
        collapseCore,
        collapseFlash,
        // The rock table, built ONCE at construction and never rebuilt. It is a
        // pure function of (seed, index) so it could be recomputed every frame, and
        // it is not, for the reason the gate's `gateScale` is kept on the record:
        // the render path reads a value rather than re-deriving one, and the two
        // ways of getting it wrong are a per-frame allocation and a per-frame
        // disagreement.
        rocks: rules.portalDebrisRing(this.seed, index),
        // The collapse clock: null while nothing is collapsing, and a number of
        // seconds once `setPortalShut` has armed it. NULL rather than 0 because
        // "0 s into a collapse" and "not collapsing" are different states — the
        // first draws a full-size bright aperture, the second draws nothing — and
        // a zero-initialised field would make them the same value.
        collapseAt: null,
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
      if (kind === 'cone') return this._material({ color: 0xa8552a })
      return this._materials.metal
    }
    for (const spec of [...STRUCTURAL_KINDS, ...DECORATIVE_KINDS]) {
      // `window` and `porchLight` are RETIRED — see `RETIRED_FIXTURE_KINDS`. They
      // get no pool, and `_addFixture` returns on a missing pool, so a retired
      // kind is dead by construction rather than by a branch that has to be
      // remembered.
      if (RETIRED_FIXTURE_KINDS.includes(spec.kind)) continue
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
    // No per-chunk `lot` lookup here any more. It existed for exactly one reason:
    // `window` and `porchLight` were placed against their lot's house wall rather
    // than on their slot, and finding that wall meant reading the lot back. Both
    // kinds are retired (see `RETIRED_FIXTURE_KINDS` and `_addFixture`), so the
    // map, the `chunkAt` call that filled it and the `find` that read it are all
    // gone — a fixture no longer needs to know which lot it is near.
    for (const fixture of fixtures) {
      for (const copy of WRAP_COPIES) {
        this._addFixture(fixture, copy)
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
   * `window` and `porchLight` — the kinds that used to decorate rather than
   * occupy ground, and that were placed against the house's front wall — are
   * RETIRED. They are the pass-5 review's finding, and the reason is that the
   * facade system now owns both jobs: `_addFacadeWindows` owns the lit-window
   * ladder and `_addEntrance` owns the entry lamp. Both kinds were still being
   * drawn, and both were drawing the WRONG RUNG of T11's ladder: a `window`
   * fixture is unconditionally `windowLit` (the brightest of the four rungs), so
   * 132 of them were lit windows at a 100% rate, and a `porchLight` fixture is
   * `sodium` — brighter than every entry lamp in the world — so 132 of them sat
   * above doors the pass had just fitted with a deliberately dim lamp. The
   * "lit windows are rare" and "the entry lamp is the lowest rung" claims were
   * both false on screen while all 268 checks stayed green, because the checks
   * counted the facade pools and never the fixture pools.
   *
   * A missing pool is how a kind is retired: `_addFixture` returns on one, so
   * there is no branch here to forget.
   *
   * @param {object} fixture a `chunkFixtures` entry
   * @param {number} copy the wrapped copy, one of `WRAP_COPIES`
   */
  _addFixture(fixture, copy) {
    const pool = this.fixturePools[fixture.kind]
    if (!pool) return
    const shape = FIXTURE_SHAPES[fixture.kind] ?? { h: 1, lift: 0 }
    const x = fixture.x + copy * WORLD_EXTENT
    const z = fixture.z + copy * WORLD_EXTENT
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
   * `clearOfPortals` — is this DRAWN spot far enough from every portal to draw on?
   *
   * ITERATION 2, PASS 10, and the third reader of `PORTAL_FURNITURE_CLEAR`: the
   * creature's viscous trail lays marks on the road at runtime, and a mark inside the
   * stand-off is a dark decal between the gate and the camera §16.5.5 photographs it
   * from — the same reason passes 6, 7 and 8 all filter their own families through
   * the same radius.
   *
   * IT DOES NOT COUNT, and that is the difference from `_portalClear` above. That one
   * is a placement filter and its `dressingRejected` counter is a statistic about the
   * BUILD, which `verify-world.mjs` requires to have fired at least once so the rule
   * cannot be a rule that never rejects. A mark laid sixty times a second at runtime
   * would put that counter out of the build's hands and the check would stop meaning
   * what it says. This one answers a question and nothing else, and the count of what
   * the trail lost lives in `dripStep`'s own `suppressed`.
   *
   * FOLDED, PER AXIS, and the per-axis part is the bug this would otherwise have.
   * `_portalClear` folds with a single `copy` because a lot's copies are diagonal —
   * one index applied to both coordinates — while `origin` is `originFor(x)` and
   * `originFor(z)` INDEPENDENTLY. A player at (230, 0) is in copy +1 on x and copy 0
   * on z, so a single shift would put the query 448 m from every portal on one axis
   * and the exclusion would silently exist in a third of the world. Taking the origin
   * out per axis is the same arithmetic `_compose` uses for the colliders.
   *
   * @param {number} x world x, in the drawn copy
   * @param {number} z world z, in the drawn copy
   * @returns {boolean} true if a mark may be laid here
   */
  clearOfPortals(x, z) {
    const cx = x - this.origin.x
    const cz = z - this.origin.z
    for (const anchor of this.objectives.portals) {
      if (Math.hypot(cx - anchor.position.x, cz - anchor.position.z) < PORTAL_FURNITURE_CLEAR) return false
    }
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

  /**
   * The nearest lamps, in world space, for the point-light pool `world.js` owns.
   *
   * ITERATION 2, PASS 17 — this is the single largest per-frame allocation in the
   * project and it is here.
   *
   * BEFORE: one pass over all 49 lamp anchors that called `worldOf` on every one
   * of them. `worldOf` is `{ x: position.x + this.origin.x, z: ... }` — a fresh
   * two-field object per call — so standing still in the street threw away
   * forty-nine small objects a frame, 2940 a second, to answer a question whose
   * answer had not changed since the player last walked a metre. The fold is two
   * additions and the array that received the answers was discarded by the
   * caller's early-out on all but the frames where the aim actually moved.
   *
   * AFTER: the same 49 folds, with no object per fold. The distance test is
   * squared — no `Math.hypot` for a lamp that is going to be rejected, and no
   * allocation for one that is going to be kept.
   *
   * THE `into` ARGUMENT, and it is the part that makes this safe. `world.js` keeps
   * the returned list in `this._lampAimed` and reads it every frame from
   * `_writeLampDread`, so the list has to SURVIVE this call. Reusing one buffer
   * would have been a bug waiting for a wrap: the frame that re-aimed the lights
   * would have overwritten the very record the dread is measured against. So the
   * list is still allocated per call — one array, not forty-nine objects — and
   * `into` is an OPTIONAL escape hatch for a caller that can prove it does not
   * retain the result. `world.js` does not use it, and the reason it does not is
   * worth more than the one array it would have saved.
   *
   * THE COMPARATOR is a module-level function rather than an inline arrow, so the
   * sort does not allocate a closure per call either. It is the same
   * `distance`-then-`distance` comparison either way; `Array.prototype.sort` has
   * been stable since ES2019, so the ORDER of equal-distance lamps is unchanged
   * and the light pool cannot flicker differently than it did.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} radius metres
   * @param {object[]} [into] a list to fill instead of allocating a new one
   * @returns {{x: number, y: number, z: number, distance: number}[]} nearest first
   */
  lampsNear(x, z, radius, into) {
    const found = into ?? []
    found.length = 0
    // PASS 17. The fold is INLINED rather than calling `worldOf`, and that is the
    // whole of the change: `worldOf` hands back a fresh `{x, z}` and this loop
    // wanted the two numbers, forty-nine times, sixty times a second. The
    // arithmetic is `worldOf`'s, copied, and the gate below is what keeps the two
    // from drifting: `verify-world.mjs` asserts that the inlined fold and
    // `worldOf` agree on every lamp for a set of positions.
    const originX = this.origin.x
    const originZ = this.origin.z
    for (const lamp of this.lampPositions) {
      // `Math.hypot` AND NOT `Math.sqrt(dx * dx + dz * dz)`, and this is the one
      // "optimisation" pass 17 declined. The squared form skips `hypot` for the
      // forty-odd lamps that are about to be rejected, which reads like free money,
      // and it was written and measured before it was dropped:
      //
      //   - over 16 000 queries the two found the SAME SET of lamps, every time;
      //   - the `distance` VALUES disagreed by one ULP — 72.00222218792972 against
      //     72.00222218792973.
      //
      // One ULP is not nothing here, and this is the reasoning. `found.sort` is
      // stable, so two lamps at the same true distance keep the order
      // `lampPositions` gave them. But the tie is decided on the COMPUTED distance,
      // and if the two computations differ by a ULP then what used to be a tie is
      // now an ordering, and the order flips. The light pool is aimed from
      // `lamps[0]` and the dread is measured from `lamps[i]`, so a flipped tie is a
      // different lamp under a different light for a frame. `verify-world.mjs`'s
      // pass-11 strobe check stands a creature under the nearest lamp and asserts
      // the light recovers, which is exactly the check that would notice.
      //
      // WHAT THAT FIRST FAILURE WAS NOT, recorded because the comment above it
      // nearly said otherwise. While the squared form was in place, that check
      // failed with "the strobe never comes back up (best 87%)" — and on this
      // two-core box it also failed on the PRISTINE tree under load, and passed on
      // the changed tree at load 0.9. It was the machine, exactly as
      // REVIEW-pass-16 recorded for a different check on this same harness. So the
      // justification for keeping `hypot` is NOT a reproduced failure; it is that
      // `hypot` is bit-identical to the code this pass inherited, which makes the
      // change provably zero-risk on the one hot path that feeds a world gate, and
      // `Math.hypot` on two numbers is a handful of nanoseconds against a 16.7 ms
      // frame. Paying a rounding difference for a call we cannot measure is the
      // wrong trade on a path that aims the light.
      const dx = lamp.x + originX - x
      const dz = lamp.z + originZ - z
      const distance = Math.hypot(dx, dz)
      if (distance <= radius) found.push({ x: lamp.x + originX, y: 5.1, z: lamp.z + originZ, distance })
    }
    found.sort(byDistance)
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
    // ITERATION 2, PASS 12 — arm the collapse, and the three new children with it.
    //
    // THE ORDER OF THESE FOUR LINES IS THE PASS. `shut` first (so anything that
    // reads the record this frame sees the truth), then the two materials and the
    // swirl (so the live gate is dead and inert on THIS frame, which is §5.3's
    // promise and which the world check reads on the exact frame the hold
    // completes), and only then the collapse, which is a *second* aperture drawn
    // over a dead one for 0.8 s. Arming the collapse before the materials would
    // put a lit hole over a lit hole for one frame, and nothing would have caught
    // it except a screenshot nobody re-examined.
    //
    // The lens and the debris go out with everything else, and the reason is §5.3's
    // wording rather than taste: a dead portal is a cold dim inert disc, and a
    // ring of lit flakes orbiting a dead hole is neither cold nor inert. They are
    // also the only two things in the aperture that are BRIGHT, so leaving them up
    // would leave the shutdown visibly unfinished for ever.
    portal.lens.visible = !shut
    portal.debris.visible = !shut
    // `collapseAt` is stamped from `this._time` and not from 0, so the animation is
    // a function of the view's own clock and a capture that steps to a given time
    // gets a given frame — the same contract the canal shimmer and the swirl
    // already keep. Un-shutting resets it to null rather than to 0, for the reason
    // the field is null-initialised: the two are different states.
    portal.collapseAt = shut ? this._time : null
    portal.collapse.visible = shut
    return true
  }

  /**
   * `resetMotion` — put every clock-driven transform back to zero.
   *
   * §9.1's loop wipe is the place run state goes, and the swirl's accumulated
   * angle is run state: it is the integral of a rate over everything that has
   * happened since the view was built, so a portal photographed in the third view
   * of a capture session and the same portal photographed in the first are at
   * different rotations for no reason a player could name.
   *
   * **PASS 12 IS WHY THIS METHOD EXISTS, and it is worth being precise about what
   * it fixes and what it does not.** Before this pass the swirl's angle was
   * `t * rate` — a pure function of the view's clock, so it was already
   * history-dependent, and §16.5's re-take property was already only true for a
   * session that ran the views in the same order. After this pass it is an
   * INTEGRAL, which has the same property and a worse one: an integral is
   * unbounded, so a long session drifts in the last digits of a double and the
   * drift is not the same on two machines that took different numbers of frames.
   * Resetting on wipe bounds it to one loop, which is the only span anybody
   * photographs.
   *
   * WHAT IT DELIBERATELY DOES NOT RESET is `this._time`. The sodium flicker, the
   * vending ballast and the canal shimmer are all functions of it, and pass 11's
   * review already recorded the consequence of that being wall-clock-dependent —
   * a lamp in a capture landing on whichever tick the shutter caught. Moving that
   * is a capture-harness change with a whole gallery to re-derive behind it, and
   * it is recorded as a pass of its own rather than smuggled in here. This method
   * resets the things THIS pass made unbounded, which is the honest scope.
   *
   * @returns {void}
   */
  resetMotion() {
    for (const portal of this.portals) {
      for (const layer of portal.swirl) layer.rotation.z = 0
      portal.collapse.rotation.z = 0
      portal.collapse.scale.setScalar(1)
      // ...and the collapse clock goes back to null, not to zero, for the reason
      // the field is null-initialised: "0 s into a collapse" and "not collapsing"
      // draw different things, and a loop wipe must not leave the second looking
      // like the first. The GROUP goes down with it, because `scale.setScalar(1)`
      // on its own would put a full-size bright aperture back into a doorway a
      // wipe had just emptied — the group has two ways to be off and both are used.
      portal.collapseAt = null
      portal.collapse.visible = false
      // AND THE TWO PER-FRAME MATERIAL WRITES GO BACK TO THEIR BUILT VALUES. Both
      // of them are run state for the same reason the angle is — `_collapsePortal`
      // writes a colour and an opacity every frame it runs, and neither is ever put
      // back. The world check found this by comparing the collapse core's colour
      // against the two materials it is supposed to be between and getting a value
      // that was neither: a run that had collapsed a portal in an earlier check
      // left the next run's collapse core half-way to the dead colour, so the
      // first frame of the NEXT collapse was already a fifth of the way shut in
      // colour while being at full size in scale. An animation that inherits its
      // start from whatever the last one ended on is not an animation.
      portal.collapseCore.material.color.setHex(PALETTE.portalCore)
      portal.collapseFlash.material.opacity = 0
      this._writeDebris(portal, this._time)
    }
  }

  setHammerTaken(taken = true) {
    this.hammer.taken = taken
    this.hammer.root.visible = !taken
    this.hammer.light.visible = !taken
  }

  /**
   * `setResolution` — the wire shader's `uResolution`, in DEVICE pixels.
   *
   * A public method rather than a property because a resize is a *thing that
   * happens*, and T8's whole claim is that a wire's width is a screen-space
   * quantity: a buffer that is 1,280 px wide and a buffer that is 2,560 px wide
   * want different pixel offsets for the same cable, and a wire that keeps the
   * resolution it was built with is half a pixel wide in the second one and
   * twice as wide in the first. `world.js` owns the number, passes it at
   * construction, and passes it again here.
   *
   * @param {number} x drawing-buffer width, device pixels
   * @param {number} y drawing-buffer height, device pixels
   * @returns {void}
   */
  setResolution(x, y) {
    this.resolution = { x, y }
    this._materials.wire.uniforms.uResolution.value.set(x, y)
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
   * `setViewer` — where the eye is and which way it is looking, once a frame.
   *
   * A method rather than a constructor argument, and that is the whole of the
   * contract: the eye MOVES. Handing the view a camera at construction would
   * freeze the near field at wherever the player spawned, and the effect this
   * pass adds — arms that turn faster when you are standing at them — is
   * precisely an effect that is wrong at every other moment. `world.js` owns the
   * `PerspectiveCamera` and the yaw; neither has ever been handed to this file,
   * so the world hands the two NUMBERS this file needs instead of the object.
   *
   * WHY THE FORWARD VECTOR AND NOT A YAW, again: `_portalFacing` needs a dot
   * product against a direction in the same frame as the folded portal position,
   * and `root.rotation.y` has already been applied to the scene graph but not to
   * anything stored. A yaw is the one quantity in this pair that would have to be
   * rotated by hand on the way in, and a hand-rotation that is forgotten is a
   * near field that works on one of the three structures.
   *
   * THE OBJECT IS REUSED, not reallocated. This is called once a frame for the
   * whole run, and a fresh `{x, z, dx, dz}` literal every frame is 60 short-lived
   * objects a second in the one method that exists so the render path can stop
   * allocating. The fields are written in place and the same object is handed
   * back, so a caller that stashed a reference sees the current values.
   *
   * Non-finite inputs fall back to the last good frame rather than to a NaN
   * position, for the reason `portalNearness` is null-safe: a bad number must
   * leave the hole looking like a hole, not poison `_portalNear` with a
   * `Math.hypot` of NaN and silently spin it at its own rate for ever.
   *
   * @param {number} x eye position, unwrapped world metres
   * @param {number} z eye position, unwrapped world metres
   * @param {number} yaw the camera's yaw, radians, three.js `YXZ`
   * @returns {void}
   */
  setViewer(x, z, yaw) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return
    if (this.viewer === null) this.viewer = { x: 0, z: 0, dx: 0, dz: -1 }
    this.viewer.x = x
    this.viewer.z = z
    // The camera's forward in XZ. `player.forwardXZ()`'s convention, restated
    // rather than imported: `player.js` is a pure module this file does not
    // depend on, and the one-line duplication is smaller than the dependency
    // and than a comment about the dependency. `verify-world.mjs` asserts the two
    // agree, so the duplication cannot drift without failing a gate.
    this.viewer.dx = -Math.sin(yaw)
    this.viewer.dz = -Math.cos(yaw)
  }

  /**
   * `_portalNear` — how far the viewer is from one portal, in the FOLDED frame.
   *
   * `worldOf` and not `portal.position`, for the reason `nearestPortal` folds: the
   * portal record holds CANONICAL metres and the player holds unwrapped ones, so a
   * portal 448 m away around the torus is the portal you are standing next to.
   * The same fold and the same helper, and the reason a portal's near field cannot
   * go off when the player crosses a seam.
   *
   * @param {object} portal a portal record
   * @returns {number} metres, or Infinity when there is no viewer
   */
  _portalNear(portal) {
    const viewer = this.viewer
    if (!viewer) return Infinity
    const world = this.worldOf(portal.position)
    return Math.hypot(world.x - viewer.x, world.z - viewer.z)
  }

  /**
   * `_portalFacing` — how squarely the viewer is looking at one portal, -1..1.
   *
   * The dot of the viewer's forward vector with the direction from the viewer to
   * the gate. It is a DOT and not a yaw difference because the two quantities live
   * in different frames — the viewer's forward is already rotated by
   * `root.rotation.y`, and the gate's axis is stored as a world-space unit vector
   * for the reason `nearestPortal`'s stand-off comment gives. Rotating one into the
   * other by hand is the step that gets forgotten, and forgetting it produces a
   * near field that works on one of the three structures.
   *
   * The zero-length case returns -1 rather than 0: standing exactly on the gate's
   * axis with a zero-length forward vector is not a thing a player can do, and -1
   * is the "not looking at it" answer, which is the safe one.
   *
   * @param {object} portal a portal record
   * @returns {number} the dot, -1 (away) to 1 (square on)
   */
  _portalFacing(portal) {
    const viewer = this.viewer
    if (!viewer) return -1
    const world = this.worldOf(portal.position)
    const dx = world.x - viewer.x
    const dz = world.z - viewer.z
    const length = Math.hypot(dx, dz)
    if (length < 1e-6) return -1
    return (dx / length) * viewer.dx + (dz / length) * viewer.dz
  }

  /**
   * `_writeDebris` — compose this portal's fourteen instance matrices for time `t`.
   *
   * The pose is `rules.portalDebrisPose(rock, t)` and nothing else, so the ring is
   * a pure function of the view clock: drive the world to the same `t` twice and
   * this writes the same sixteen floats both times, which is what
   * `verify-world.mjs` asserts to the bit. The rotation is on Z and the position in
   * the gate's own XY, so a flake keeps its shape from every bearing — a flake that
   * turned to face the camera would be a billboard, and billboards are the thing
   * AESTHETIC-NOTES §6 tells this project not to reach for.
   *
   * The `visible` guard is worth the branch: a shut portal's debris is hidden by
   * `setPortalShut`, and composing matrices for a mesh that is not drawn is 42
   * wasted matrix composes a frame for the rest of the run.
   *
   * @param {object} portal a portal record
   * @param {number} t seconds on the view's own clock
   * @returns {void}
   */
  _writeDebris(portal, t) {
    if (!portal.debris.visible) return
    const dummy = this._debrisMatrix
    // PASS 17. `portalDebrisPose` is a PURE function in `rules.js` and is gated
    // for purity, so it still hands back a value; what changed is that the value
    // goes into `this._debrisPose` instead of into a fresh object, forty-two times
    // a frame (fourteen flakes on each of three live portals). The four fields are
    // read out of it on the next line and never stored, so there is nothing for
    // the reuse to invalidate — and the pure module is untouched, which is the
    // point: the allocation was in the VIEW's use of a pure function, not in the
    // function.
    const pose = this._debrisPose
    for (let i = 0; i < portal.rocks.length; i += 1) {
      rules.portalDebrisPose(portal.rocks[i], t, pose)
      // The unit tetrahedron is built at radius 1 and scaled to the rock's own size
      // here, so `PORTAL_DEBRIS_SIZE` is a per-rock range applied to a shared
      // geometry rather than a geometry per rock. A uniform scale on all three axes
      // keeps it a REGULAR tetrahedron, which is why one was chosen.
      dummy.position.set(pose.x, pose.y, 0)
      dummy.rotation.set(0, 0, pose.angle)
      dummy.scale.setScalar(pose.size)
      dummy.updateMatrix()
      portal.debris.setMatrixAt(i, dummy.matrix)
    }
    // One upload flag for the whole ring. `setMatrixAt` alone leaves every flake
    // rendering at the first one's matrix, which is the same bug pass 5 closed for
    // `setColorAt` and the reason the flag is written out rather than assumed.
    portal.debris.instanceMatrix.needsUpdate = true
  }

  /**
   * `_collapsePortal` — one frame of a dying portal's 0.8 s collapse.
   *
   * Everything is `rules.portalCollapse(t - portal.collapseAt)`: the scale, the
   * flash and the spin multiplier. This method applies them and owns exactly two
   * decisions of its own, both about the SCENE GRAPH rather than about the numbers.
   *
   * THE FIRST is `collapse.scale`. A group scaled to zero still has a
   * non-degenerate world matrix, and three.js will happily draw a zero-scale mesh
   * as a degenerate triangle at the origin — which, for a portal standing in a
   * doorway, is a flicker on the road. Hiding the group at `scale === 0` is what
   * actually ends the animation, and `portalCollapse` returning exactly 0 at
   * `u === 1` is what makes that a single condition rather than a second clock.
   *
   * THE SECOND is the flash's opacity, and it is written to the CLONE. The shared
   * `portalFlash` material is the one three portals would share if it were shared,
   * and two portals collapsing a quarter of a second apart would otherwise dim each
   * other's flash — a bug with no visual, only a wrong number.
   *
   * THE SPIN has no spiral in it, and that is the interesting part. §5.3's rule is
   * that a shut portal's swirl is invisible on the frame the hold completes, and
   * `verify-world.mjs` reads exactly that. A collapse spiral would be arms turning
   * in a dead thing, which is the one piece of motion §5.3's silence forbids — so
   * the acceleration is expressed as the whole APERTURE spinning down rather than
   * as the arms turning faster, which is also the more frightening read: a hole
   * that twists shut rather than one that whirls.
   *
   * @param {object} portal a portal record
   * @param {number} t seconds on the view's own clock
   * @returns {void}
   */
  _collapsePortal(portal, t) {
    const elapsed = t - portal.collapseAt
    const collapse = rules.portalCollapse(elapsed)
    portal.collapseFlash.material.opacity = Math.min(1, collapse.flash)
    // The core behind the flash is the LIVE core colour, lerped toward the dead one
    // as it closes, so the thing that vanishes is recognisably the same hole and not
    // a second disc that happened to be in the doorway. Lerped on `u` and not on
    // `scale` so the colour and the size cannot be at different stages, and toward a
    // CACHED colour object because `new THREE.Color` in a render loop is a
    // per-frame allocation in the one method that runs for all three portals.
    portal.collapseCore.material.color
      .setHex(PALETTE.portalCore)
      .lerp(this._deadCore, collapse.u)
    // The spin is a PRODUCT of elapsed and the multiplier, never an accumulator,
    // for the same reason the swirl is a product: a rate written onto a clock is
    // frame-rate independent and an accumulator is not.
    portal.collapse.rotation.z = elapsed * collapse.spin * PORTAL_COLLAPSE_TWIST
    portal.collapse.scale.setScalar(collapse.scale)
    if (collapse.scale === 0) portal.collapse.visible = false
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
    // ITERATION 2, PASS 7 — the world's one failing ballast, and the only reason
    // this pass needed a function from `hash.js` rather than a fourth sine.
    //
    // It is written to `emissiveIntensity` and NOT to `color`: a lit liner is an
    // EMISSIVE surface, and multiplying its colour would darken the panel's own
    // albedo at the same time, which is a different and much less legible fault —
    // the machine would look like a dirty one rather than a failing one. The floor
    // of 0.30 means the panel never goes black, which is the difference between a
    // machine with a bad ballast and a dead machine.
    //
    // Driven on `this._time`, the same clock as the sodium, so a capture that steps
    // to a given time gets the same flicker — and `verify-world.mjs` drives it to
    // the same time twice and requires the value back bit-identical, which is the
    // only way to test a seeded flicker honestly.
    if (this.flickerLot) {
      this._materials.vendingFaceFlicker.emissiveIntensity = VENDING_FACE_EMISSIVE * vendingFlicker(t)
    }
    // ITERATION 2, PASS 12 — the collapse, and it is a SEPARATE loop above the live
    // one, for a reason that is not tidiness. The live loop below opens with
    // `if (portal.shut) continue`, and that `continue` is §5.3: a shut portal has
    // nothing animated in it. Putting the collapse inside that loop would mean
    // either running the collapse for a portal that is not shut (nonsense) or
    // moving the `continue` (which is the pass-3 gate's own assertion, and moving
    // it is how a dead portal starts turning again). Two loops, one for the dying
    // and one for the living, is the honest shape: the two sets are disjoint and
    // the code says so.
    for (const portal of this.portals) {
      if (portal.collapseAt === null) continue
      this._collapsePortal(portal, t)
    }
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
      // ITERATION 2, PASS 12 — the near field. The rate is the layer's OWN rate
      // scaled by how near and how squarely-attended this portal is, and both
      // factors are decided in `rules.js`; the only thing decided here is how the
      // answer is turned into an angle.
      //
      // **AND THAT IS AN INTEGRAL, NOT A PRODUCT — and the first version of this
      // pass wrote a product and shipped a bug the world check found in one run.**
      //
      // The product form is `rotation.z = t * rate`, which is what pass 3 wanted and
      // what this looked like at first. It is correct while `rate` is constant and
      // catastrophically wrong the moment it is not. `rate` here is
      // `PORTAL_SWIRL_RATES[layer] * (1 + (SPIN - 1) * near)`, so walking toward
      // the door changes `near` continuously — and `t * rate` turns that continuous
      // change into a DISCONTINUITY of `t * d(rate)`. At the 143 s mark of a run,
      // crossing the 8 m boundary moves the arms by eighteen radians: the swirl
      // does not speed up, it TELEPORTS. Every earlier observation in this pass —
      // the pure function's C1 ramp, the multiplicative form, the frame-rate
      // argument — was about the wrong quantity, and the ramp being C1 made it worse
      // rather than better, because a gentle ramp multiplied by a large `t` is a
      // large jump.
      //
      // The fix is to integrate, and the argument that integration is safe is the
      // one pass 3's own comment already contains, read more carefully than it was
      // written: `t * rate` and `+= rate * dt` are the SAME animation when `rate` is
      // constant, to first order and to any precision this file needs. What pass 3
      // forbade — and what its gate still forbids — is an increment that does not
      // carry `dt` at all, which is frame-count-dependent in the real sense. So the
      // gate was always right about the thing it named and wrong about the thing it
      // forbade, and this pass is the one that made the difference matter.
      //
      // The cost is stated rather than hidden: an integral sampled at 12 Hz and one
      // sampled at 60 Hz differ by O(dt) at the same wall-clock time, where a
      // product is exact. `capture.js` steps at a fixed `SIM_DT` on every machine, so
      // the fourteen PNGs are still reproducible twice, and the difference between
      // two frame rates is a fraction of a degree on an arm turning once in 19 s.
      // Against that: a product that jumps eighteen radians when you cross a
      // threshold. There is no contest.
      //
      // `this.viewer` is null until the world hands one over, and a null viewer is
      // nearness 0: before the first `setViewer` the hole is a hole at its own
      // rate, which is the safe direction for a title screen and for any test that
      // drives the view without a camera.
      const near = rules.portalNearness(this._portalNear(portal), this._portalFacing(portal))
      for (let layer = 0; layer < portal.swirl.length; layer += 1) {
        const rate = rules.portalSwirlRate(PORTAL_SWIRL_RATES[layer], near)
        portal.swirl[layer].rotation.z += rate * dt
      }
      // The debris, and this is the only per-frame instance write in the file.
      // Fourteen matrices composed and uploaded for three portals is 42 — one
      // `setMatrixAt` and one `needsUpdate` per portal, not per rock, which is the
      // reason the ring is an `InstancedMesh` and not fourteen `Mesh`es.
      this._writeDebris(portal, t)
    }
    if (!this.hammer.taken) {
      this.hammer.light.intensity = 3.2 * pulse
      this.hammer.root.rotation.y = t * 0.35
    }
    // ITERATION 2, PASS 8 — the canal's shimmer, and it is the only thing in this
    // method that is a function of the wall clock rather than of the two light
    // families.
    //
    // The scroll is in METRES per second on the GROUND, divided by the length of
    // one tile, which is the step that is easy to get wrong: writing
    // `offset.x += CANAL_SHIMMER_MPS * dt` scrolls the texture 0.06 *units* a
    // second, and a unit here is `CANAL_LEN / CANAL_SHIMMER_TILES` = 3.71 m, so
    // that version moves the water at 0.22 m/s — 3.7x too fast, and fast enough
    // that a player watching the canal for four seconds sees it move a tile and
    // knows the loop. Dividing by the tile length is what makes the constant on
    // the constant block mean what it says.
    //
    // It is driven off `this._time` and not off an accumulated `dt`, for the same
    // reason the vending flicker is: the value has to be a pure function of the
    // clock, so a capture that steps to a given time gets a given shimmer and
    // `verify-world.mjs` can drive the world to the same time twice and require
    // the offset back bit-identical. An accumulator that summed `dt` would drift
    // against `this._time` by a different amount every run and that check could
    // not exist.
    const shimmer = (t * CANAL_SHIMMER_MPS) / (CANAL_LEN / CANAL_SHIMMER_TILES)
    this._materials.canalWater.map.offset.x = shimmer % 1
  }

  dispose() {
    this.scene.remove(this.group)
    for (const pool of this.pools) pool.dispose()
    for (const texture of this.textures) texture.dispose()
    for (const material of Object.values(this._materials)) {
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
      else material.dispose()
    }
    // The wire mesh is not a pool — it is one geometry built by hand — so it is
    // the one thing in this method the loop above cannot reach. Without this line
    // a hot reload leaks a 3 MB buffer per mount, and §15's teardown check counts
    // `this.textures` rather than the wire because the wire arrived later.
    if (this.wireMesh) this.wireMesh.geometry.dispose()
    this.pools = []
    this.textures = []
  }
}

export default StreetView
