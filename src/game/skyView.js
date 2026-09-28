/**
 * skyView.js — the sky beyond the fog: haze bands, a pale moon, a horizon of
 * industrial silhouettes, and ash drifting past the lens (iteration 2, pass 9).
 *
 * WHAT THIS IS
 * -----------
 * Pass 1 turned `scene.background` into a sodium ochre and `scene.fog` into the
 * same ochre, and the comment on `_applyDusk` calls matching them "the whole
 * trick of a fogged outdoor scene". It is true, and it is also the *whole* of
 * what the upper half of every frame was for eight passes: one flat colour. A
 * sodium overcast is not flat. It has strata, it has a disc behind the strata,
 * and it has a skyline under it, and all three are what a player reads as
 * "outside at dusk" rather than "in a void".
 *
 * The brief is four things — drifting haze bands, a barely-visible moon, distant
 * horizon silhouettes, occasional ash — and every one is deliberately
 * SUBORDINATE. Nothing here is a light source except the moon at a fifth of the
 * `EYE_MIN` threshold, and §12.1's silhouette rule is why: a frame needs dark
 * shapes against a haze to have depth, and this pass adds a whole layer of them.
 *
 * WHY A SEPARATE FILE
 * -------------------
 * The two coordinate frames, and this is the whole of the pass's architecture.
 * `streetView`'s geometry is WRAPPED: it lives under a group that snaps to a
 * whole 448 m period so the player never wraps (§3.1). A sky that wrapped would
 * swim. So every object here is placed at a FIXED OFFSET from the camera and
 * the root is moved to the camera's position once a frame — camera-relative,
 * never world-relative — which is the idiom the portal gate's "position copied
 * from the camera each frame" note already established for a thing at infinity.
 *
 * And that construction is the pass's load-bearing safety property, which the
 * brief asked for by name: the horizon ring stands at a CONSTANT radius from
 * the camera, so it cannot wander into the street grid and cannot obstruct a
 * portal or a creature sightline no matter where the player walks.
 * `HORIZON_RADIUS` is not a tuning number, it is a guarantee, and
 * `verify-world.mjs` measures the ring's radius off the built matrices rather
 * than trusting this comment.
 *
 * WHY NO POOL
 * -----------
 * The horizon is fourteen silhouettes at a constant radius and the ash is a single
 * `Points`. A pool would add a capacity to get wrong and a `commit()` to forget.
 * The world's instancing exists because 588 lots are drawn three times over, and
 * fourteen silhouettes once is not that.
 * `verify-world.mjs` asserts the counts directly instead.
 *
 * ITERATION 2, PASS 17 REVERSED THE INSTANCING HALF OF THIS PARAGRAPH, and it is
 * worth saying what changed and what did not. The paragraph used to read "WHY NO
 * INSTANCING AND NO POOL" and argued from "fourteen silhouettes once is not that"
 * — an argument that was right about the POOL and wrong about the INSTANCING, and
 * wrong in the direction that costs the most. The fourteen silhouettes are
 * forty-two boxes, and forty-two `Mesh` objects with forty-two cached geometries
 * were 23% of the scene's objects to draw a 542-triangle backdrop. They are now
 * one `InstancedMesh` over a unit box. The pool half of the sentence above is
 * still true and is why; the instancing half was not, and `_buildHorizon` carries
 * the arithmetic of what replaced it.
 *
 * DETERMINISM
 * -----------
 * Every animated value is a pure function of `this._time` and the mote's own
 * index — no accumulator, no `Math.random`, no frame counter — for exactly the
 * reason pass 8's canal shimmer is: a capture that steps to a given time gets a
 * given sky, and the gate can drive the world to the same time twice and require
 * the values back bit-identical.
 */
import * as THREE from 'three'
import { PALETTE } from './streetView.js'
import { hash32 } from './hash.js'

/**
 * HORIZON_RADIUS — how far out the silhouette ring stands, in metres.
 *
 * BEFORE: n/a, there was no ring. AFTER 232, bounded from three sides rather
 * than chosen, which is the only honest way to pick it.
 *
 *  - **Past the fog, or it is not a horizon.** §3.7's tightest fog is 0.0175
 *    and `rules.fogVisibility` puts its half-opacity at 47.6 m; at 232 m the fog
 *    is 99.9997% opaque. The ring is therefore drawn `fog: false` — the same
 *    decision the portal rim, the lamp heads and the creature's eyes make, and
 *    for the same reason: a shape that fades into the fog is not a silhouette,
 *    it is a smudge. What replaces the fog is `HORIZON_HAZE`, a hand-set mix
 *    toward the sky, so the shapes sit IN the haze rather than on top of it.
 *  - **Inside the far plane.** `world.js` builds a 260 m camera whose comment
 *    says the far plane "has to outlast the fog". 232 < 260 with 28 m of margin,
 *    and `verify-world.mjs` reads the camera's own `far` rather than restating
 *    260.
 *  - **Past the built world.** The outermost lot geometry is
 *    `(GRID - 1) / 2 * BLOCK + SETBACK + LOT_DEPTH` = 192 + 9 + 10 = 211 m from
 *    the canonical origin, so 232 m is 21 m beyond the last thing the street can
 *    build. This is the "outside the street grid" the brief asked for, and it
 *    is arithmetic rather than a hope.
 *
 * The margin is 21 m and not 2 m on purpose: the ring is the only thing in the
 * game allowed to be at the horizon, and a horizon that clipped into a roofline
 * would be worse than no horizon.
 */
const HORIZON_RADIUS = 232

/**
 * HORIZON_HAZE — how far the silhouette colour is pulled toward the sky.
 *
 * BEFORE: n/a. AFTER 0.42, and this decides whether the ring reads as DISTANT
 * rather than as fourteen black cardboard cut-outs taped to the sky.
 *
 * A shape drawn `fog: false` at 232 m is mechanically at full contrast, and full
 * contrast at that distance is the tell: the eye reads contrast as nearness, so
 * an unhazed silhouette at the horizon reads as a thing 20 m away that happens
 * to be enormous, and the frame gains a depth cue pointing the wrong way.
 * Pulling the colour 42% toward the sky is the cheap version of aerial
 * perspective, and it is the mechanism AESTHETIC-NOTES §2 gives the reference's
 * ridge rings ("haze colour", "haze floor").
 *
 * Not 0.5: above about 0.45 the shapes stop being silhouettes and become a
 * slightly-darker band of sky, and a horizon that cannot be individually
 * resolved is not a horizon. `verify-world.mjs` measures the rendered mix
 * against the live sky colour and requires a dark shape still distinguishable
 * from it.
 */
const HORIZON_HAZE = 0.42

/**
 * The silhouette kinds and their recipes, in metres.
 *
 * BEFORE: n/a. AFTER three kinds on a fourteen-object ring. The brief asked for
 * water towers, radio masts and cranes; the count is 14 because the ring is a
 * full 360° and 14 is the smallest number that puts two of something in every
 * quadrant. A ring with one tower in it reads as a bug; one in each quadrant
 * reads as four landmarks the player has already learned.
 *
 * The three kinds differ in PROFILE rather than in size, because profile is what
 * reads at this distance: a tank on a stalk is a rectangle on a stalk, a mast is
 * a vertical line with a bulge, a crane is an L. A ring of one profile is a
 * fence, and a fence on the horizon reads as a wall the player cannot leave.
 */
const HORIZON_KINDS = Object.freeze(['tower', 'mast', 'crane'])

/**
 * HORIZON_COUNT — silhouettes around the ring.
 *
 * BEFORE: n/a. AFTER 14, and the number is the ring's rather than the kinds':
 * 14 / 3 is 4.67, so rotating the three kinds through fourteen slots gives
 * 5/5/4 and no quadrant is left with a single silhouette. Eleven would give
 * 4/4/3 and two adjacent bearings of the same kind; a ring where two silhouettes
 * share a bearing is a ring with twelve silhouettes.
 */
const HORIZON_COUNT = 14

const HORIZON_SHAPES = Object.freeze({
  tower: Object.freeze({ bodyH: 7.5, bodyW: 9.5, legH: 13, legW: 1.1 }),
  mast: Object.freeze({ bodyH: 31, bodyW: 1.5, bulgeH: 2.2, bulgeW: 4.4, bulgeAt: 0.66 }),
  crane: Object.freeze({ bodyH: 24, bodyW: 1.7, jib: 15, jibH: 1.2, jibAt: 0.92 }),
})

/**
 * The silhouette kinds and their recipes, in metres.
 *

/**
 * MOON_PEAK — how bright the moon may be, as a fraction of its own colour.
 *
 * BEFORE: n/a, there was no moon. AFTER 0.02, and the brief's own words are the
 * constraint: "dim, occluded by haze, NOT bright".
 *
 * THE ARITHMETIC, AND IT IS NOT THE OBVIOUS ONE
 * ---------------------------------------------
 *   PALETTE.skyMoon 0xb9a583   ->  Rec. 709 luma 166.8 in sRGB
 *   0.02 of that in LINEAR      ->  21.4 luma of ADDED light
 *
 * The second line is not `166.8 x 0.02 = 3.3`, and the difference is the whole
 * reason this number is 0.02 and not 0.18. A `THREE.Color` holds LINEAR
 * components and `multiplyScalar` scales them there, so the peak is applied to a
 * linear value and only then encoded to sRGB — and sRGB encoding is steep near
 * black, so a 2% linear cut is a 13% sRGB cut. The first version of this comment
 * did the multiplication in sRGB, wrote "30 luma" in it, and shipped 0.18; the
 * built world then measured 60.7 luma against a 75 luma budget for the WHOLE
 * pass. `verify-world.mjs` found it by measuring the built `THREE.Color` instead
 * of the palette, which is exactly why that check reads the scene and this one
 * reads the source.
 *
 * 21.4 luma against a `skyStops[0]` of 89.6 is a 1.24x lift: visible on a dark
 * frame, easy to miss on a lit one, and **an order of magnitude under `EYE_MIN`
 * 150**, so `png-luma.mjs`'s eye finder can never resolve it as the creature's
 * eye. A moon that could be mistaken for a 2.80 m figure's eye is not atmosphere,
 * it is a false positive in the one gate that measures whether the player can
 * survive being hunted.
 *
 * Also well under `windowLit` (198.3), so T11's closed emissive ladder is
 * untouched: the moon is not a rung on it, it is a dimming.
 */
const MOON_PEAK = 0.02

/**
 * MOON_DISTANCE, MOON_ELEVATION and MOON_RADIUS — where the disc hangs.
 *
 * BEFORE: n/a. AFTER 236 m out, 0.62 rad (35.5°) up, 5.2 m across.
 *
 * All three are derived from the frame rather than picked. The camera's vertical
 * FOV is 72°, so 35.5° is just inside the top of the frame at a level
 * look-down pitch — any higher and the moon is off-screen in a level capture,
 * which makes it a thing that exists rather than a thing that is seen. And 236 m
 * puts it BEYOND `HORIZON_RADIUS`, so a tower is always in front of it when the
 * two line up, which is the only arrangement in which a moon reads as far away.
 *
 * 5.2 m at 236 m is 2.5° of arc, about five times the real moon and about 0.7%
 * of the frame height. A true-scale moon is 0.25° and would be 3 px: a rounding
 * artefact. The brief asked for a "pale disc" and a disc has to be resolvable
 * to be a disc. What it must NOT become is a second sun, and the constraint that
 * keeps it honest is the arc — past about 6° it stops reading as a moon and
 * starts reading as a light, which is the one thing §12.1's silhouette rule
 * forbids in a frame this pass is filling with dark shapes.
 */
const MOON_DISTANCE = 236
const MOON_ELEVATION = 0.62
const MOON_RADIUS = 5.2

/** The bearing the moon sits on: a constant, so it is in the same place nightly. */
const MOON_BEARING = 1.94

/**
 * The three haze bands, in draw order: radius, height, width, horizontal aspect,
 * drift rate in rad/s, and peak.
 *
 * BEFORE: n/a — `scene.background` was one flat colour. AFTER three bands.
 *
 * WHY THREE, AND WHY AT THREE RADII
 * ---------------------------------
 * A single haze band is a smear and three concentric ones are a fog bank; the
 * brief's "2-3 large soft quads" is a budget, and what the budget buys is
 * LAYERING. All three are camera-relative at fixed offsets, so they do not
 * parallax against each other by construction — the one thing this construction
 * cannot give — and the substitute is three different radii with three different
 * drift rates, so they slide across each other slowly enough to read as separate
 * layers of moving air.
 *
 * The radii (52 / 68 / 86 m) sit inside the fog's readable range, which is the
 * point: at dusk 0 the fog is 18% opaque at 52 m and 34% at 86 m, and at dusk 3
 * it is 56% and 78%. So the bands are VISIBLY EATEN as the world closes, which
 * is `fog: true` doing the one job it is uniquely good at. The alternative —
 * `fog: false`, so they stay crisp to the end — was rejected because a haze band
 * that does not thicken with the dusk is a texture pasted over the sky, and the
 * dusk clock loses a limb.
 *
 * THE PEAKS ARE SMALL ON PURPOSE, and they are small in LINEAR space for the
 * reason `MOON_PEAK` gives. `skyHaze` is 91.1 luma in sRGB; the three peaks of
 * 0.02 / 0.015 / 0.01 applied to its linear components and re-encoded give
 * 7.0 / 5.3 / 3.5 luma of added light. All three overlapping is 15.8. With the
 * moon's 21.4 and the ash's 7.1 that is **44.3 luma for the entire sky pass** —
 * 0.30 of `EYE_MIN` 150 and 0.49 of the sky itself. The gate measures this on
 * the built materials and requires under half of `EYE_MIN`, so the budget is a
 * ceiling the whole pass is held to rather than a sum recomputed by hand.
 * cannot manufacture a creature's eye. `verify.mjs` asserts that sum
 * arithmetically and `verify-world.mjs` measures the built materials.
 */
const HAZE_BANDS = Object.freeze([
  Object.freeze({ radius: 52, height: 26, width: 150, aspect: 0.34, drift: 0.0072, peak: 0.02 }),
  Object.freeze({ radius: 68, height: 41, width: 210, aspect: 0.28, drift: -0.0049, peak: 0.015 }),
  Object.freeze({ radius: 86, height: 58, width: 280, aspect: 0.22, drift: 0.0031, peak: 0.01 }),
])

/**
 * HAZE_AUDIO_CYCLE — how much faster than its own drift a band is counted as
 * moving when the AUDIO asks how much haze there is.
 *
 * BEFORE: n/a — nothing outside this file had ever asked. AFTER: 24.
 *
 * The three drifts are 0.0072 / -0.0049 / 0.0031 rad/s, so a band returns to where
 * it started every 873 / 1282 / 2027 seconds. That is the right rate for a thing
 * you look at and hopeless for a thing you hear: a wind bed that took a quarter of
 * an hour to breathe would read as a fault rather than as air. 24 puts the
 * shortest band's audible cycle at about 36 s and the longest at about 84, which
 * is the range a player will actually hear as weather, and it is a MULTIPLIER on
 * numbers this file already owns rather than a fourth drift rate nobody can trace
 * back to a band.
 *
 * The claim being bought is *coupling*, not realism: the same three numbers, the
 * same clock, the same seed. Whether 24 is the prettiest multiplier in the world
 * is not a question this pass can answer; that the wind cannot be moving when the
 * bands are not is.
 */
export const HAZE_AUDIO_CYCLE = 24

/**
 * hazeIntensityAt — how much haze is in the air, as `[0, 1]`, at a point in time.
 *
 * ITERATION 2, PASS 13. The three bands above are the sky's only moving air, and
 * pass 13's wind layer needs a number to follow rather than a clock of its own —
 * a second LFO in `audio.js` would drift against these within a minute and the
 * two would be visibly unrelated to anyone who went looking.
 *
 * The model is one line: each band is a slab of haze sweeping past the eye, and a
 * slab is at its thickest when its bearing is the reference bearing, so its
 * contribution is `0.5 + 0.5·cos(phase)`, weighted by the same `peak` the renderer
 * uses and normalised by the sum of the peaks. What comes out is a weighted mean
 * of three slow cosines, which is bounded in `[0, 1]` by construction — not by a
 * clamp applied afterwards, which would be a claim the function does not make.
 *
 * `phase` is `time · drift · HAZE_AUDIO_CYCLE + a per-band offset hashed from the
 * seed`, so two runs of different seeds are not breathing in step, and a run is
 * bit-identical to itself. Pure: no Three.js, no clock, no accumulator, exactly
 * like every other animated value in this file, and `verify-world.mjs` drives it
 * over an hour of clock to check the bound rather than trusting the algebra.
 *
 * @param {number} time seconds since the sky was built
 * @param {number} seed the run's seed
 * @returns {number} `[0, 1]`
 */
export function hazeIntensityAt(time, seed) {
  if (!Number.isFinite(time)) return 0
  let sum = 0
  let total = 0
  for (let index = 0; index < HAZE_BANDS.length; index += 1) {
    const band = HAZE_BANDS[index]
    // the same avalanche mix `ashDrift` uses, on a different salt, so a band's
    // audio phase cannot correlate with where its own motes happen to be
    const offset = (hash32(seed, index, 0x51a2b3c4) / 4294967296) * Math.PI * 2
    const coverage = 0.5 + 0.5 * Math.cos(time * band.drift * HAZE_AUDIO_CYCLE + offset)
    sum += band.peak * coverage
    total += band.peak
  }
  return total > 0 ? sum / total : 0
}

/**
 * ASH_COUNT, ASH_BOX and ASH_MIN_Y — the near-camera motes.
 *
 * BEFORE: n/a. AFTER 90 motes in a 15 m box whose floor is 2.2 m ABOVE the eye.
 *
 * `ASH_MIN_Y` is the number that makes this safe, and it is worth being precise
 * about why. The §16.5.5 pupil gate measures the luma at the exact centre of a
 * portal's rim bounding box, from 4.5 m away, and requires it at or under 20; the
 * committed frame measures 9, so there is 11 luma of headroom. An additive mote
 * drifting between that camera and that gate would add to the pupil, and a mote
 * bright enough to be worth drawing is brighter than 11 luma. So the ash is
 * confined ABOVE the eye: a ray from a 1.60 m eye to a gate centred at 1.18 m
 * DESCENDS, and a box whose floor sits at 3.80 m world cannot intersect it.
 *
 * That is a geometric exclusion rather than a brightness budget, which is why it
 * holds however the ash is retuned — and it is asserted in both harnesses,
 * because the obvious future edit (drop the ash to knee height, where dust
 * actually settles) is exactly the edit that would invalidate the pupil gate
 * without invalidating anything anyone could see.
 */
const ASH_COUNT = 90
const ASH_BOX = 15
const ASH_MIN_Y = 2.2

/**
 * ASH_PEAK, ASH_SIZE and ASH_FALL — the motes' brightness, radius and fall.
 *
 * BEFORE: n/a. AFTER peak 0.02 (linear, as `MOON_PEAK` explains) = 7.1 luma of
 * added light, radius 0.055 m, falling 3.2 m and wrapping.
 *
 * 7.1 luma is under the pupil's 11 luma of headroom, which is the SECOND line of
 * defence and not the first: `ASH_MIN_Y` is what keeps a mote out of the
 * stand-off, and this is what keeps one out of the number. Both are asserted
 * because either alone is a promise about a future retune — the height is a
 * geometric exclusion and survives a brighter ash, the brightness is a budget
 * and does not.
 *
 * The size is 0.055 m so a mote at 4 m is about 3 px — at 20 px a mote is a
 * floating blob, and at 1 px it is the film grain the frame already has.
 */
const ASH_PEAK = 0.02
const ASH_SIZE = 0.055
const ASH_FALL = 3.2

/**
 * The render orders, and the ORDER OF THEM is the whole of the pass's
 * compositing, so all four are named and all four are read back by the gate.
 *
 * BEFORE: n/a. The world's own lowest order is 1 (`wetSheen`), set by pass 8.
 *
 * Six DISTINCT negative slots, allocated in the order the eye should meet them:
 *
 *   -100 `moon`      the disc.
 *    -99 `horizon`   the silhouettes, in front of the disc.
 *    -98..-96 bands  the three haze strata, near to far.
 *    -95 `ash`       the motes, nearest the camera and last of the sky.
 *
 * WHY SIX SLOTS AND NOT FOUR
 * --------------------------
 * Because a TIE is not an order. The first version of this block computed the
 * bands as `BAND_RENDER_ORDER_BASE - index` and allocated -98 / -99 / -100 — the
 * last of which is the MOON's slot, so the far band and the moon tied and
 * three.js fell back to material id to order them. A tie is a claim that two
 * things have a relationship the renderer does not read. `verify-world.mjs`
 * found it by printing the orders (`-98/-99/-100` against a moon at `-100`) and
 * this is the fix: six values, each used once, allocated top-down.
 *
 * WHAT THE ORDER DOES AND DOES NOT BUY
 * ------------------------------------
 * The sky's own elements are ADDITIVE, and additive blending is commutative —
 * swapping any two of them changes nothing in the frame. So the run above is NOT
 * a sorting rule for the strata, and a comment claiming the bands must be drawn
 * near-to-far "so the layering is unambiguous" would be false.
 *
 * What the negative values DO buy is the one thing that matters, and it is
 * structural rather than aesthetic: three.js draws the opaque queue in
 * renderOrder order, so the entire sky is drawn before the first street surface
 * and the world therefore paints over it wherever the world exists. No sky
 * element can appear in front of a portal, a creature or a lamp — not because it
 * was placed carefully, but because it was drawn first. That is a different kind
 * of guarantee from `PORTAL_FURNITURE_CLEAR`, and it is the one this pass wanted:
 * a filter that has to be re-applied every time something is added, versus a
 * render order that cannot be forgotten.
 *
 * And the brief's "occluded by haze" is real without an ordering claim at all: a
 * band drawn across the disc ADDS to it while adding far more to the sky around
 * it, so the moon's CONTRAST against the sky behind it falls. That is what
 * veiling is, it needs no order, and it is why the moon is drawn before the
 * bands anyway — so that on a renderer with depth-write side effects it still
 * behaves.
 */
const MOON_RENDER_ORDER = -100
const HORIZON_RENDER_ORDER = -99
const BAND_RENDER_ORDER_BASE = -98
const ASH_RENDER_ORDER = -95

/**
 * HORIZON_DEPTH — how deep every silhouette box is, in metres.
 *
 * 0.6 for every part, and it was a literal inside the deleted `_horizonGeometry`
 * before this pass. It is named now because the instanced write needs it as a
 * per-instance scale component, and a scale component that is a bare `0.6` in the
 * middle of a `Vector3.set` is a number nobody can check.
 *
 * The reason it is 0.6 and not more is unchanged and is worth keeping: at 232 m
 * under 72° of FOV the ring is seen from every bearing, so depth is only ever
 * read as the silhouette's own width, and a deeper box costs triangles for
 * nothing. It is also the one number the unit-box substitution turns on — see
 * `_buildHorizon`'s header, where the old `BoxGeometry(qw, qh, 0.6)` and the new
 * `scale.set(w, h, HORIZON_DEPTH)` are shown to be the same box to within
 * float32 quantisation, which is the strength of claim the arithmetic supports.
 * The pass-17 review measured that it is 0.6 of a PART that is held to: change
 * it and the ring's depth changes with it, which is why `verify.mjs` pins the
 * literal and not the name.
 */
const HORIZON_DEPTH = 0.6

/**
 * `ashDrift` — one mote's position at time `t`, in the camera-relative box.
 *
 * A PURE FUNCTION of `(index, t, seed)`, and this doc block is the gate's
 * argument for why: the harness drives the world to `t = 4` twice from two
 * different starting states and requires the arrays back bit-identical. An
 * accumulator (`this.y += v * dt`) cannot satisfy that, because the sum depends
 * on the frame history and two runs that reach the same time by different routes
 * leave different residues.
 *
 * So every mote is three sines of `t` at three incommensurate rates with
 * per-mote phases drawn from `hash32` — the same construction `hash.js` already
 * gives the vending flicker, and for the same reason: a player who watched for a
 * minute could predict a sum of sines and cannot predict a 32-bit mix.
 *
 * @param {number} index the mote's own index, 0..ASH_COUNT-1
 * @param {number} t seconds on the world's clock
 * @param {number} seed the world's seed
 * @param {{x: number, y: number, z: number}} [into] written instead of a fresh
 *   object. PASS 17: this is called ninety times per frame from `update`, and a
 *   function that cannot write through a caller's buffer will allocate a return
 *   value every time. The object is not frozen and not returned-to by anyone —
 *   `update` reads the three fields and drops it on the next iteration — so
 *   reusing one is safe, and the signature keeps working for a caller that wants
 *   a value rather than a destination.
 * @returns {{x: number, y: number, z: number}} metres, camera-relative — `into`
 *   when one is given, and a fresh object otherwise
 */
function ashDrift(index, t, seed, into) {
  const mix = hash32(seed, index, 0x5f3a)
  // Three rates, none a multiple of another, so the paths never re-align.
  const ax = 0.021 + ((mix & 0xff) / 255) * 0.017
  const ay = 0.013 + (((mix >>> 8) & 0xff) / 255) * 0.011
  const az = 0.017 + (((mix >>> 16) & 0xff) / 255) * 0.015
  const phase = ((mix >>> 24) & 0xff) / 255 * Math.PI * 2
  const half = ASH_BOX / 2
  // The fall wraps, so the ash reads as DRIFTING DOWN endlessly rather than as
  // dust on a shelf that stops. A mote's height is its phase, never its history,
  // which is what keeps the function pure.
  const fallen = (t * ay * 4.4 + phase) % ASH_FALL
  const at = into ?? { x: 0, y: 0, z: 0 }
  at.x = Math.sin(t * ax + phase) * half
  at.y = ASH_MIN_Y + 1.6 + (ASH_FALL - fallen)
  at.z = Math.cos(t * az + phase * 1.7) * half
  return at
}


/**
 * `makeSoftDisc` — a soft radial falloff, written per-pixel via
 * `createImageData`.
 *
 * The same construction and the same reason as `makePoolTexture` in
 * `streetView.js`: the `verify-world.mjs` 2D stub implements exactly the raster
 * members and nothing else, so a texture drawn with a gradient primitive is a
 * texture the gate cannot construct. White in RGB and the falloff in ALPHA,
 * which is the additive-quad convention — a mask, not a colour.
 *
 * @param {object} [options]
 * @param {number} [options.size] texture edge in pixels
 * @param {number} [options.peak] the value at the centre, 0-1
 * @param {number} [options.power] falloff exponent; higher is a tighter core
 * @returns {THREE.CanvasTexture}
 */
function makeSoftDisc({ size = 64, peak = 1, power = 1.9 } = {}) {
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
      const r = Math.min(1, Math.hypot(dx, dy))
      const value = Math.round(peak * (1 - r) ** power * 255)
      const i = (y * size + x) * 4
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
 * `makeSoftBand` — a soft horizontal stratum, the same construction with the
 * falloff on one axis only.
 *
 * A band is a quad whose texture falls off top and bottom and is flat along its
 * length, which is what makes it read as a stratum rather than as a disc. The
 * vertical envelope is `sin^2` of the normalised height: 0 at both edges, 1 in
 * the middle, and no derivative discontinuity at either. A linear ramp leaves a
 * visible crease where it meets the quad's edge, and the crease MOVES, so a
 * drifting band would carry a hard line with it.
 *
 * @param {object} [options]
 * @param {number} [options.size] texture edge in pixels
 * @param {number} [options.peak] the value along the flat middle, 0-1
 * @returns {THREE.CanvasTexture}
 */
function makeSoftBand({ size = 64, peak = 1 } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(size, size)
  const data = image.data
  for (let y = 0; y < size; y += 1) {
    // `v` runs 0 at the bottom row to 1 at the top.
    const v = y / (size - 1)
    const envelope = Math.sin(Math.PI * v) ** 2
    for (let x = 0; x < size; x += 1) {
      // Flat along the length: a column of one value repeated `size` times. The
      // horizontal resolution buys nothing, which is why `size` stays small and
      // why the horizontal axis exists at all — `PlaneGeometry`'s UVs need it.
      const value = Math.round(peak * envelope * 255)
      const i = (y * size + x) * 4
      data[i + 3] = value
    }
  }
  ctx.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * SkyView — the whole pass, constructed once and updated once a frame.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera the world camera; this view reads its position
 * @param {{ seed?: number }} [options]
 */
export class SkyView {
  constructor(scene, camera, options = {}) {
    this.scene = scene
    this.camera = camera
    this.seed = options.seed ?? 1337
    this.disposed = false
    /** The world's clock, accumulated in `update` exactly as `streetView` does. */
    this._time = 0

    this.root = new THREE.Group()
    this.root.name = 'sky'
    this.scene.add(this.root)

    this.textures = []
    this._geometries = []
    // Empty by construction — every material here is owned by exactly one mesh,
    // and those meshes are under `this.root`, which `dispose` clears. It is kept
    // as a list anyway so a future SHARED material has somewhere to register
    // rather than being disposed twice by two owners; `creatureView.js` keeps the
    // same list for the same reason. It MUST be initialised here: `dispose()`
    // iterates it, and the §15 teardown check is the first thing to reach it.
    this._materials = []
    // ONE shared texture for the bands and ONE for the discs. Three identical
    // 64x64 band canvases would be three 16 kB uploads and three chances to
    // generate a different band, and the bands must match each other or the
    // layering reads as three unrelated smears rather than as one fog bank.
    this.bandTexture = makeSoftBand({ peak: 1 })
    this.discTexture = makeSoftDisc({ peak: 1, power: 1.9 })
    this.textures.push(this.bandTexture, this.discTexture)

    this._buildMoon()
    this._buildHorizon()
    this._buildBands()
    this._buildAsh()
    // PASS 17. The one object the ash loop writes through, and the only reason
    // this field exists: `update` places ninety motes a frame and `ashDrift` takes
    // a destination so that none of the ninety is a fresh object. Allocated here
    // with the rest of the view's state rather than in `update`, so the frame path
    // allocates nothing at all — which is the claim `verify.mjs`'s source contract
    // now checks about this method.
    this._ashAt = { x: 0, y: 0, z: 0 }
  }

  /**
   * `_buildMoon` — one additive disc, and one only.
   *
   * `fog: false`, because the moon is 236 m out where the fog is opaque and a
   * fogged moon is a moon you cannot see. The veiling is done instead by the
   * bands that pass in FRONT of it, which is what makes the result read as haze
   * crossing a moon rather than as a moon blinking.
   *
   * `depthWrite: false` for the same reason the portal's `portalPool` sets it:
   * this is an additive element, it must not occlude what is drawn after it.
   */
  _buildMoon() {
    const geometry = new THREE.PlaneGeometry(1, 1)
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.skyMoon),
      map: this.discTexture,
      transparent: true,
      opacity: MOON_PEAK,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
    this._geometries.push(geometry)
    this.moon = new THREE.Mesh(geometry, material)
    this.moon.name = 'skyMoon'
    this.moon.renderOrder = MOON_RENDER_ORDER
    // A quad has a normal, and the fixed bearing means the camera can end up
    // behind it. `frustumCulled = false` for the same reason every pool in
    // `streetView` sets it: the object is camera-relative and its bounding
    // sphere is in the wrong frame for the frustum test.
    this.moon.frustumCulled = false
    this.root.add(this.moon)
  }

  /**
   * `_buildHorizon` — fourteen silhouettes on a ring of `HORIZON_RADIUS`.
   *
   * The ring is at a CONSTANT radius from the camera, which is the pass's central
   * safety property and the reason this method has no placement filter at all:
   * nothing here consults the objectives, the lots or the wrap, so there is no
   * input that could put a tower beside a portal. Compare `_waterClear`, which
   * exists precisely because puddles ARE placed in world space and needed a
   * filter; the horizon is not placed anywhere, so it needs none.
   *
   * All fourteen share ONE material, hazed toward the sky at build time. A
   * per-object material would be fourteen materials for fourteen objects and would
   * make the dusk retune fourteen writes instead of one.
   *
   * ITERATION 2, PASS 17 — FORTY-TWO MESHES BECAME ONE, and the argument is
   * arithmetic rather than taste, because the whole claim of this pass is that
   * nothing about the picture moved.
   *
   * BEFORE: forty-two `THREE.Mesh` objects, one per box, each with its own
   * `BoxGeometry` drawn from a cache keyed on a 2 m grid. `tools/perf-census.mjs`
   * measured 46 meshes and 0 instanced meshes in `skyView.root` — 47 of the
   * scene's 113 culling-exempt objects — for a pure backdrop of 542 triangles.
   * Nearly a quarter of the world's draw calls for two thousandths of its
   * geometry. AFTER: one `InstancedMesh` over a unit box, one draw call, one
   * geometry, forty-two instances.
   *
   * WHY IT IS THE SAME PICTURE, and this is the part that matters. The old code
   * built `BoxGeometry(qw, qh, HORIZON_DEPTH)` from the 2 m-quantised cache and
   * then scaled the MESH by `(w / qw, h / qh, 1)`. A box of full width `qw` scaled
   * by `w / qw` has full width `qw * w/qw`, which is `w` in real arithmetic — so
   * the mesh's world-space box was ALREADY `w x h x HORIZON_DEPTH` and the
   * quantisation cancelled itself out in the product. It was nothing but a device
   * for sharing buffers. A unit box scaled by `(w, h, HORIZON_DEPTH)` is
   * therefore the same box, and `compose` applies T·R·S in both versions with the
   * same rotation, so the two are the same matrix written a different way round.
   *
   * AND THE HONEST LIMIT OF "THE SAME", which pass 17's first version of this
   * comment did not have and which the pass-17 review measured. The two are the
   * same box to about one part in 10^8, NOT "to the last bit", and the word was
   * wrong in a way that mattered because this file's whole convention is that a
   * number in a comment is a number somebody checked. Two independent sources of
   * the last bit, both measured over the built ring's own 42 parts at seed 1337:
   *
   *  - `qw * (w / qw) === w` is FALSE for 5 of the 84 part axes. IEEE-754
   *    division then multiplication is not the identity; the residual is one ULP.
   *  - The GPU never saw float64 anyway. `InstancedMesh.instanceMatrix` is a
   *    `Float32Array`, so the new path's scale is float32-quantised on the way
   *    in, while the old path's scale rode a float64 `Matrix4`. Comparing the
   *    world half-extents the vertex shader actually computes, 1 part in `x` and
   *    4 parts in `y` differ, worst relative error 9.2e-8 (a quarter of a float32
   *    ULP). The depth is identical in all 42, because `0.6 * 0.5` and
   *    `0.3 * 1` happen to agree after the round trip.
   *
   * At 232 m under 72° of FOV across 1280 px, one pixel is about 0.26 m, so
   * 9.2e-8 of a 14 m part is roughly 5 nanometres — five millionths of a pixel.
   * It cannot be seen, and the triangle count is identical because the unit box
   * and the cached box are both 12 triangles: 504 either way, and the sky is 542
   * at both trees (`node tools/perf-census.mjs` against `e476ee9^`, which is the
   * number to re-run rather than the number to believe). The claim is
   * "unchanged to within float32 quantisation", and that is the strongest one
   * the instrument can support.
   *
   * The material is a `MeshBasicMaterial` with a colour, no map and no
   * `vertexColors`, so the UVs the unit box carries differently are read by
   * nothing, and `MeshBasicMaterial` does not light, so the normals are read by
   * nothing either. Both are load-bearing for that claim, and they are why this
   * could not have been done to a `MeshStandardMaterial` part.
   *
   * WHAT IT COSTS. The cache is gone — `_horizonGeometry` and
   * `horizonGeometryKeys` are deleted rather than left behind, because a geometry
   * cache for a geometry nothing builds is a comment that has stopped being true.
   * `horizonCount` still means "how many boxes are on the ring" and is still 42,
   * because the picture is what the gate is about; the new `horizonParts` carries
   * each box's `kind`/`w`/`h`/`y` for the gates that used to reach into
   * `children[i].geometry.parameters`, and those now read the INSTANCE MATRICES
   * instead — a stronger check, because they ask what is drawn rather than what
   * the builder intended.
   */
  _buildHorizon() {
    this.horizon = new THREE.Group()
    this.horizon.name = 'skyHorizon'
    this.horizon.frustumCulled = false
    this.horizon.renderOrder = HORIZON_RENDER_ORDER
    this.root.add(this.horizon)

    this.horizonMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.horizonShape).lerp(
        new THREE.Color(PALETTE.skyStops[0]),
        HORIZON_HAZE,
      ),
      fog: false,
    })

    // PASS 17. The parts are COLLECTED first and drawn second. The old loop built
    // and placed each box as it produced it, which is why the instance count was
    // not known until the loop had finished — and an `InstancedMesh` needs its
    // capacity before its first matrix is written. Two passes over fourteen
    // silhouettes, both trivial, and the alternative is a resize.
    const parts = []
    for (let index = 0; index < HORIZON_COUNT; index += 1) {
      // The kind rotates through the three, so the ring cannot contain four of a
      // kind by accident: 14 / 3 is 4.67, and starting at 0 makes the
      // wrap-around 5/5/4 rather than 6/4/4.
      const kind = HORIZON_KINDS[index % HORIZON_KINDS.length]
      // An even split of the circle offset by half a step, so no two silhouettes
      // share a bearing — at 232 m two on one bearing are one silhouette.
      const bearing = ((index + 0.5) / HORIZON_COUNT) * Math.PI * 2
      // A per-object scale, so the ring is not fourteen identical stamps. This
      // is the same lesson pass 5's lit windows carry: variety is a property of
      // the draw, and a uniform set reads as generated.
      //
      // PASS 17. The `& 15 / 15` quantisation is RETAINED and is no longer
      // required. It used to exist so sixteen distinct scale steps would land on
      // few enough sizes for `_horizonGeometry`'s cache to hit — "ten steps from
      // 0.82 to 1.32 is still ten visibly different towers on a ring" — and with
      // the ring on one unit box there is nothing left to collide with. It is kept
      // because this pass's rule is that nothing about the picture moves, and a
      // continuous scale would give fourteen towers a subtly different outline.
      // Sixteen steps is sixteen steps; a reader who wants the quantisation gone
      // for its own sake is deleting a line that now costs nothing either way.
      const scale = 0.82 + ((hash32(this.seed, index, 0x4b1d) & 15) / 15) * 0.5
      for (const part of this._horizonParts(kind, index, scale)) {
        parts.push({ kind, w: part.w, h: part.h, y: part.y, bearing })
      }
    }
    this.horizonCount = parts.length
    this.horizonParts = parts
    this._buildHorizonInstances(parts)
  }

  /**
   * `_buildHorizonInstances` — the collected boxes as ONE instanced draw.
   *
   * Split out from `_buildHorizon` so the collection loop reads as what it is —
   * the shape table, fourteen silhouettes and nothing else — and the three.js
   * mechanics live in one place. The header's arithmetic is the argument for the
   * scale this writes; this method is only where it happens.
   *
   * @param {{kind: string, w: number, h: number, y: number, bearing: number}[]} parts
   */
  _buildHorizonInstances(parts) {
    // ONE unit box, and the four scratch objects the write loop needs, allocated
    // here rather than per part. `InstancePool` in `streetView.js` hoists the same
    // four for the same reason; a build-time loop would not notice it, and a
    // per-frame one would.
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    this._geometries.push(geometry)
    this.horizonMesh = new THREE.InstancedMesh(geometry, this.horizonMaterial, parts.length)
    this.horizonMesh.name = 'skyHorizon_ring'
    this.horizonMesh.renderOrder = HORIZON_RENDER_ORDER
    // The same reason every pool in `streetView.js` sets it, and the reason
    // `_buildMoon` gives for itself: the ring is camera-relative, so its bounding
    // sphere is in the wrong frame for a frustum test.
    this.horizonMesh.frustumCulled = false
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale3 = new THREE.Vector3()
    const euler = new THREE.Euler()
    for (let slot = 0; slot < parts.length; slot += 1) {
      const part = parts[slot]
      position.set(Math.cos(part.bearing) * HORIZON_RADIUS, part.y, Math.sin(part.bearing) * HORIZON_RADIUS)
      // Yawed to face the origin, so a tower's flat side is broadside to the
      // player and reads as a tank rather than as a line.
      euler.set(0, -part.bearing, 0)
      quaternion.setFromEuler(euler)
      // `(w, h, HORIZON_DEPTH)` and NOT the old mesh's `(w/qw, h/qh, 1)`: on a unit
      // box those are the same world-space extents, and this is the form that does
      // not need a cache to be right. See `_buildHorizon`'s header for the
      // arithmetic.
      scale3.set(part.w, part.h, HORIZON_DEPTH)
      matrix.compose(position, quaternion, scale3)
      this.horizonMesh.setMatrixAt(slot, matrix)
    }
    this.horizonMesh.instanceMatrix.needsUpdate = true
    this.horizon.add(this.horizonMesh)
  }

  /**
   * `_horizonParts` — one silhouette's boxes, in metres, camera-relative.
   *
   * Returned as data rather than drawn here, so the shapes stay a table the gate
   * can read and this method stays a loop. `y` is each box's CENTRE height above
   * the ground, which is what keeps a tower's tank sitting ON its stalk rather
   * than centred on it.
   *
   * @param {string} kind one of `HORIZON_KINDS`
   * @param {number} index the silhouette's index, for per-object jitter
   * @param {number} scale a 0.82-1.32 multiplier on the kind's dimensions
   * @returns {{w: number, h: number, y: number}[]}
   */
  _horizonParts(kind, index, scale) {
    const shape = HORIZON_SHAPES[kind]
    // QUANTISED, and the gate is why. The first version jittered continuously
    // (0.94..1.06), which made all forty-two parts distinct sizes and therefore
    // forty-two distinct `BoxGeometry` objects — so `_horizonGeometry`'s cache
    // never hit and the "shared geometry" claim was false while reading true.
    // `verify-world.mjs` counts the distinct geometries off the built group and
    // found 42 of 42. The variety the pass wants comes from WHICH of a small set
    // of sizes a part is, not from every part having its own, so the multiplier is
    // quantised to eight steps: still visibly varied at 232 m, and the cache works.
    const step = (hash32(this.seed, index, 0x77c3) & 7) / 7
    const s = scale * (0.9 + step * 0.2)
    if (kind === 'tower') {
      // A tank on a stalk. The stalk is ONE narrow box rather than four legs:
      // four legs at 232 m are four 1-px verticals with gaps between them, which
      // is a moire mess, and the silhouette the eye wants is the GAP, which one
      // box under a wide tank gives exactly.
      const legH = shape.legH * s
      const tankH = shape.bodyH * s
      const tankW = shape.bodyW * s
      return [
        { w: shape.legW * s, h: legH, y: legH / 2 },
        { w: tankW, h: tankH, y: legH + tankH / 2 },
        // A cap narrower than the tank, so the top edge is not a bare
        // rectangle. A rectangle with a flat top reads as a box; a rectangle
        // with a step reads as a tank.
        { w: tankW * 0.55, h: tankH * 0.16, y: legH + tankH * 1.08 },
      ]
    }
    if (kind === 'mast') {
      const bodyH = shape.bodyH * s
      const bodyW = shape.bodyW * s
      return [
        { w: bodyW, h: bodyH, y: bodyH / 2 },
        { w: shape.bulgeW * s, h: shape.bulgeH * s, y: bodyH * shape.bulgeAt },
        { w: bodyW * 2.6, h: bodyW * 0.8, y: bodyH * 0.985 },
      ]
    }
    // A crane: a mast, a jib out to one side, and a short counter-jib. The
    // counter-jib is what stops it reading as a streetlight, and it is one extra
    // box out of forty-six in the whole ring.
    //
    // BEFORE: this was the method's FALL-THROUGH, so `tower` and `mast` had
    // branches and `crane` was "whatever is left". That is a latent bug wearing a
    // working disguise: add a fourth kind to `HORIZON_KINDS` and it renders as a
    // crane with no complaint from anything — a kind whose shape is decided by
    // the absence of a name. `verify.mjs` now requires a branch per kind, which
    // is what makes the table above the whole of the shape vocabulary.
    if (kind !== 'crane') {
      throw new Error(`no horizon shape for kind ${kind}, so the ring would draw it as a crane`)
    }
    const bodyH = shape.bodyH * s
    const bodyW = shape.bodyW * s
    return [
      { w: bodyW, h: bodyH, y: bodyH / 2 },
      { w: shape.jib * s, h: shape.jibH * s, y: bodyH * shape.jibAt },
      { w: shape.jib * 0.34 * s, h: shape.jibH * s, y: bodyH * shape.jibAt - bodyH * 0.012 },
    ]
  }

  /**
   * `_horizonGeometry` — DELETED IN PASS 17, and this is the tombstone.
   *
   * It built `BoxGeometry(qw, qh, 0.6)` from a 2 m-quantised cache so that
   * forty-two parts shared about a dozen buffers, and its own history is the
   * clearest statement of why that was never enough:
   *
   *  - The first version keyed on `w.toFixed(3)`, which is unique per part, so
   *    the cache never hit: 42 parts, 42 geometries, and a doc comment claiming
   *    they shared. `verify-world.mjs` counted the distinct geometries off the
   *    built group and found 42 of 42 — which is how a comment that reads true
   *    and is false gets found.
   *  - Quantising the SCALE was not enough either, because the shape tables
   *    multiply three different numbers (scale, jitter, and a per-kind constant)
   *    and the product is still unique per part. So the cache was keyed on a
   *    coarse grid and the MESH carried the remainder.
   *  - And then the quantisation turned out to be unnecessary, because the mesh
   *    scale cancelled it: `BoxGeometry(qw, qh, d)` scaled by `(w/qw, h/qh, 1)`
   *    IS a `w x h x d` box, to within the float32 rounding the instanced path
   *    adds and the cached one did not. Twenty lines of cache were buying a
   *    sharing that one `InstancedMesh` over a unit box buys outright, and were
   *    paying 42 draw calls for it.
   *
   * The method is gone rather than left uncalled, because an uncalled method with
   * a fifteen-line justification of itself is precisely the thing this pass's own
   * source contract would flag. `HORIZON_DEPTH` took the `0.6` with it, and
   * `_buildHorizon`'s header carries the arithmetic that replaced all of it.
   */

  /**
   * `_buildBands` — the three strata.
   *
   * `fog: true` with `AdditiveBlending`, and the PAIRING is the argument for why
   * the bands thin as the world closes. Three.js mixes the fragment toward
   * `fog.color` by the fog factor and THEN adds it, so a band at 86 m is 78% fog
   * colour at dusk 3 and contributes almost nothing, while the same band at dusk
   * 0 is 34% fogged and clearly there. The dusk clock does the work, and the
   * work is a property of the fog model rather than of a keyframe — which is why
   * nothing in this pass has to be told when the world gets dark.
   *
   * A band is a plane scaled to `width x width * aspect`, hence `aspect` rather
   * than a height: the texture is 1:1 with 0-1 UVs on both axes, and scaling one
   * axis is what turns a disc into a stratum.
   */
  _buildBands() {
    this.bands = []
    const geometry = new THREE.PlaneGeometry(1, 1)
    this._geometries.push(geometry)
    HAZE_BANDS.forEach((band, index) => {
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(PALETTE.skyHaze).multiplyScalar(band.peak),
        map: this.bandTexture,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: true,
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.name = `skyHazeBand${index}`
      mesh.scale.set(band.width, band.width * band.aspect, 1)
      // `+ index`, so the NEAR band takes the highest (last-drawn) slot. The sign is
      // the point: three.js draws the LOWER renderOrder first, so `- index` would
      // put the far band in front of the near one — and, at three bands, would
      // run the third band up to the moon's slot and tie with it.
      mesh.renderOrder = BAND_RENDER_ORDER_BASE + index
      mesh.frustumCulled = false
      this.root.add(mesh)
      this.bands.push({ mesh, material, band })
    })
  }


  /**
   * `_buildAsh` — one `Points`, ninety motes, one draw call.
   *
   * `Points` rather than ninety quads, for two reasons that both matter. Ninety
   * additive quads is ninety draw calls to move ninety dots, which is a third of
   * the world's whole budget spent on dust; and `PointsMaterial`'s
   * `sizeAttenuation` gives perspective falloff for free, so the motes shrink
   * with distance exactly as dust does, which a fixed-size quad cannot do.
   *
   * The position buffer is allocated ONCE and rewritten in place every frame.
   * Reallocating would be ninety `Float32Array`s a frame for a scene that has to
   * hold 60 FPS on integrated graphics (pass 17's budget).
   */
  _buildAsh() {
    const positions = new Float32Array(ASH_COUNT * 3)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const material = new THREE.PointsMaterial({
      color: new THREE.Color(PALETTE.skyAsh).multiplyScalar(ASH_PEAK),
      size: ASH_SIZE,
      map: this.discTexture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      // The motes are 2-15 m from the lens and the fog is under 2% opaque at
      // that range, so fogging them would be a rounding error at best. It would
      // not be harmless, though: for an ADDITIVE material three.js mixes toward
      // `fog.color` and then adds it, so a fogged mote adds the whole fog colour
      // to itself. `fog: false` is the difference between a dim mote and a mote
      // carrying a copy of the sky.
      fog: false,
    })
    this.ash = new THREE.Points(geometry, material)
    this.ash.name = 'skyAsh'
    this.ash.renderOrder = ASH_RENDER_ORDER
    this.ash.frustumCulled = false
    this.ashPositions = positions
    this._geometries.push(geometry)
    this.root.add(this.ash)
  }

  /**
   * `update(dt)` — advance the clock and place everything.
   *
   * Called once a frame from `world.js` immediately after `streetView.update`,
   * for the reason `_applyDusk`'s own comment gives about the horizon: the sky
   * has to agree with the fog, and the fog is written by the same frame.
   *
   * The order inside is clock, then the root's position, then the animated
   * values. The root moves BEFORE anything is placed, because every offset below
   * is camera-relative and a mote placed against last frame's camera is a mote a
   * frame in the wrong place — invisible at 0.05 m a frame and very visible at
   * 1.7 m a frame, which is a sprint.
   *
   * @param {number} dt seconds since the last frame
   * @returns {void}
   */
  update(dt) {
    this._time += dt
    const t = this._time
    // The sky rides with the camera in X and Z and is FIXED IN Y. The vertical
    // component is deliberately not followed: the bands' heights and the
    // silhouettes' bases are ground-referenced — a tower stands ON the horizon,
    // it does not hover at eye level — and following Y would put all of them at
    // 1.6 m and put the ash through the road.
    this.root.position.set(this.camera.position.x, 0, this.camera.position.z)

    // The moon, on a fixed bearing so it does not swing with the camera. The
    // bearing is a constant rather than a hash of the seed because a moon that
    // changes side between runs is a bug a player would file: it should be in the
    // same place every night.
    this.moon.position.set(
      Math.cos(MOON_BEARING) * MOON_DISTANCE,
      Math.sin(MOON_ELEVATION) * MOON_DISTANCE,
      Math.sin(MOON_BEARING) * MOON_DISTANCE,
    )
    this.moon.scale.setScalar(MOON_RADIUS * 2)
    this.moon.lookAt(this.root.position)

    for (let index = 0; index < this.bands.length; index += 1) {
      const { mesh, band } = this.bands[index]
      // The drift is a slow ROTATION of the band about the camera rather than a
      // translation: a band that slides sideways eventually slides off the edge
      // of the sky and has to wrap, and a wrap is a discontinuity. A rotation is
      // closed, so the same band returns every 2*pi / |drift| seconds — 873 s at
      // the first band's rate, slow enough that a player never catches the loop,
      // and the intended "very slow" anyway.
      const angle = t * band.drift
      mesh.position.set(
        Math.cos(angle) * band.radius,
        band.height,
        Math.sin(angle) * band.radius,
      )
      mesh.lookAt(this.root.position)
    }

    // PASS 17 — the ash, and the two things this loop was getting wrong on the
    // frame path.
    //
    // 1. `ashDrift` RETURNED a fresh `{x, y, z}` ninety times a frame. It takes
    //    an `into` argument now and writes through it, and `this._ashAt` is the
    //    one object it writes into. Ninety small objects a frame at 60 Hz is
    //    5400 a second for a scene that is entirely fog, and the allocation is
    //    invisible in the heap instrument because V8 collects it herself — which
    //    is exactly why the source contract in `verify.mjs` is the gate and the
    //    heap reading is only the smoke alarm.
    // 2. `needsUpdate = true` was INSIDE the loop, so the flag was written ninety
    //    times to set one thing. It is a boolean assignment, so it cost nothing
    //    measurable, and it was still wrong: the buffer is uploaded once, on the
    //    way out, and a reader counting the uploads would count ninety.
    for (let index = 0; index < ASH_COUNT; index += 1) {
      const at = ashDrift(index, t, this.seed, this._ashAt)
      const i = index * 3
      this.ashPositions[i] = at.x
      this.ashPositions[i + 1] = at.y
      this.ashPositions[i + 2] = at.z
    }
    this.ash.geometry.attributes.position.needsUpdate = true
  }

  /**
   * The moon's `MeshBasicMaterial`, for the gate.
   *
   * A method rather than a field the gate reaches into, so a rename breaks this
   * call rather than silently reading `undefined` and passing.
   *
   * @returns {THREE.MeshBasicMaterial}
   */
  moonMaterial() {
    return this.moon.material
  }

  /**
   * Every band material, near band first — the same order as `HAZE_BANDS`.
   *
   * @returns {THREE.MeshBasicMaterial[]}
   */
  bandMaterials() {
    return this.bands.map((entry) => entry.material)
  }

  /**
   * `ashMaterial()` — the ash's `THREE.PointsMaterial`, for the gate.
   *
   * A method rather than a field the gate reaches into, so a rename breaks this
   * call rather than silently reading `undefined` and passing.
   *
   * @returns {THREE.PointsMaterial}
   */
  ashMaterial() {
    return this.ash.material
  }

  /**
   * `hazeIntensity()` — how much haze is in the air this frame, `[0, 1]`.
   *
   * ITERATION 2, PASS 13. This is the ONE number pass 13's wind layer follows, and
   * the reason it is a method rather than something `world.js` recomputes: the sky
   * owns the bands' clock and the bands' table, so anything that asked the sky a
   * question about its own animation by duplicating the formula would be a second
   * copy of pass 9's numbers in a file that cannot see them.
   *
   * Read on the world's own clock, which `update(dt)` advances BEFORE
   * `_updateAudio` runs, so the wind a frame is ducked by is the wind the frame
   * was *drawn* with rather than the one before it.
   *
   * @returns {number}
   */
  hazeIntensity() {
    return hazeIntensityAt(this._time, this.seed)
  }

  /**
   * `dispose()` — §15's definition of done, the same shape as
   * `creatureView.dispose()`.
   *
   * The root leaves the scene BEFORE `world.js`'s traversal runs, for the reason
   * that same method's comment gives: a geometry disposed twice is a warning, and
   * a texture disposed after the renderer has dropped it is a leak the next
   * mount pays for.
   *
   * `this._materials` is empty by construction — every material here is owned by
   * exactly one mesh and the meshes are under `this.root`, so `root.clear()`
   * drops the references — and it is kept as a list anyway so a future SHARED
   * material has somewhere to be registered rather than being disposed twice by
   * two different owners. `creatureView.js` keeps the same list for the same
   * reason.
   *
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.root.parent?.remove(this.root)
    for (const geometry of this._geometries) geometry.dispose()
    for (const texture of this.textures) texture.dispose()
    for (const material of this._materials) material.dispose()
    this._geometries = []
    this.textures = []
    this._materials = []
    // PASS 17. `horizonGeometryKeys` is GONE, not emptied: the cache it named was
    // the deleted `_horizonGeometry`'s, and there is no geometry left for it to
    // key. The instanced ring's single unit box is in `_geometries` and is
    // disposed by the loop above, and `horizonParts` is build-time data on a
    // disposed view that `root.clear()` has already orphaned.
    this.horizonParts = []
    this.root.clear()
  }
}

export default SkyView
