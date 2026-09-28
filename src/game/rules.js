/**
 * rules.js — the verb, the stamina and the bookkeeping for THE LONG QUIET
 * (v2, slice 05; the finale and the wipe from slice 13).
 *
 * The parts of v2 that are neither the world nor the creature: how a portal is
 * shut down, how breath runs out, what a capture does and does not take away,
 * what the third portal opens, and the single geometric win trigger.
 *
 * Everything here is a pure function of its arguments, in the same style as v1's
 * `loop.js`: primitives in, a new plain object out, never a mutation. The
 * mutable store that React subscribes to is `store.js`'s and lives elsewhere
 * entirely; this module has no idea a store exists.
 *
 * WHY THE PORTAL VERB IS THE INTERESTING PART
 * -------------------------------------------
 * Shutting a portal down is the game's win condition, and it is inherently loud
 * (§6.2: a shutdown is a 25 m sound event, second only to the hammer). So the
 * verb is a two-beat commitment: silent for the first half, loud for the second.
 * A creature arriving in the first half costs nothing to abort; arriving in the
 * second half commits you for roughly another half-second. The player is
 * choosing, every time, which half they are in when it shows up — and that is
 * only true because the noise threshold exists at all.
 *
 * PURE: no DOM, no Three.js, no globals, no clock. `verify.mjs` imports this
 * file directly in node.
 */

import { PORTAL_IDS, SPAWN } from './neighborhood.js'
// Pass 12. The debris ring's orbits are HASHED, not random: pass 11's review found
// that an effect on a clock the renderer and the capture harness cannot both reach
// is an effect nobody can photograph twice, and `Math.random` is the extreme case
// of it. `hash32` is already the repository's answer and this file did not need it
// until now.
import { hash32 } from './hash.js'

// ---------------------------------------------------------------------------
// the portal hold verb (§5.2)
// ---------------------------------------------------------------------------

/** How long a full shutdown takes, seconds, holding E. */
export const PORTAL_SHUT_SECONDS = 1.2

/**
 * Fraction of the hold after which the shutdown becomes audible. The first half
 * is a free commitment; the second half is a promise.
 */
export const PORTAL_NOISE_THRESHOLD = 0.5

/**
 * Sound radius of an active shutdown, metres. Second only to the hammer toll
 * (§6.2) — the win condition is the second-loudest thing in the game.
 */
export const PORTAL_SOUND_RADIUS = 25

/** Progress bleeds off this many times faster than it fills, once you let go. */
export const PORTAL_RELEASE_DECAY = 2

/**
 * portalShutProgress — one tick of the hold.
 *
 * @param {number} progress 0..1
 * @param {number} dt seconds
 * @param {boolean} holding whether E is down
 * @param {boolean} [dead] the portal is already shut
 * @returns {{ progress: number, soundEmitted: boolean, completed: boolean }}
 *   `completed` is true only on the frame the hold crosses 1.0, so a portal can
 *   never be scored twice however long E is held.
 */
export function portalShutProgress(progress, dt, holding, dead = false) {
  if (dead) return { progress: 1, soundEmitted: false, completed: false }
  const step = dt / PORTAL_SHUT_SECONDS
  if (!holding) {
    // aborting is free: progress bleeds away and nothing else happens
    return {
      progress: Math.max(0, progress - step * PORTAL_RELEASE_DECAY),
      soundEmitted: false,
      completed: false,
    }
  }
  const next = Math.min(1, progress + step)
  return {
    progress: next,
    soundEmitted: next >= PORTAL_NOISE_THRESHOLD,
    completed: progress < 1 && next >= 1,
  }
}

/**
 * How many portals are shut.
 *
 * Null-safe, deliberately and for the same reason `isInsideExit` is: both are
 * asked "is the world in its final state" by callers holding a state object they
 * did not build, and a predicate that throws on a missing portal set answers the
 * question by taking the frame down.
 */
export function portalsShut(portals) {
  if (!portals) return 0
  return PORTAL_IDS.reduce((n, id) => (portals[id] ? n + 1 : n), 0)
}

/**
 * FINAL_PORTAL_COUNT — §10.1, as a number rather than an intention.
 *
 * "Shutting down the **third** portal triggers the finale. Nothing else does."
 * The count is written down instead of the sentence because the sentence can
 * only be read, and this is the one trigger in the game whose whole design
 * weight is that it fires exactly once, on exactly one event: the headlights,
 * the enrage, the §14.3 finale ramp and the win itself all hang off it.
 */
export const FINAL_PORTAL_COUNT = PORTAL_IDS.length

/**
 * triggersFinale — §10.1's trigger, as a predicate over the portal set.
 *
 * Deliberately *not* "is the third one shut": the rule is that every portal is
 * shut, so a caller holding a stale or partial set cannot get a different
 * answer by asking about a different portal. Monotone in the count, and
 * therefore monotone in progress — which is the property the world relies on
 * when it reads `state.finale` on a frame that is not the frame it was set.
 */
export function triggersFinale(portals) {
  return portalsShut(portals) >= FINAL_PORTAL_COUNT
}

/** Every portal unlit — the opening state, and the one a full wipe returns to. */
export function openPortals() {
  return Object.fromEntries(PORTAL_IDS.map((id) => [id, false]))
}

/** Every hold at zero, for the same reason. */
export function zeroProgress() {
  return Object.fromEntries(PORTAL_IDS.map((id) => [id, 0]))
}

/** §7.3: a meter that is not being spent is full. One definition, two uses. */
export const FULL_BREATH = 1

/**
 * duskForPortals — §3.7. Dusk tracks PROGRESS, never the loop number, because
 * keying it to the loop would darken the world every time the player died.
 */
export function duskForPortals(portals) {
  return portalsShut(portals) / PORTAL_IDS.length
}

/**
 * applyPortalHold — the hold, in state form. Completing a portal is what opens
 * the finale (§10.1: the third portal and nothing else).
 */
export function applyPortalHold(state, portalId, dt, holding) {
  if (!PORTAL_IDS.includes(portalId)) return state
  // rule: no double completion. A dead portal ignores the verb entirely.
  if (state.portals[portalId]) return state
  const result = portalShutProgress(state.progress[portalId] ?? 0, dt, holding, false)
  const next = { ...state, progress: { ...state.progress, [portalId]: result.progress } }
  if (!result.completed) return next
  const portals = { ...next.portals, [portalId]: true }
  return {
    ...next,
    portals,
    dusk: duskForPortals(portals),
    // §9.1 keeps the finale across a capture, so the flag is latched here rather
    // than recomputed from the portal set on every read: a caller that re-derived
    // it could get `false` from a state whose portals were legitimately wiped out
    // of order, and the headlights would go dark mid-climax.
    finale: next.finale || triggersFinale(portals),
  }
}

/**
 * The dusk curve, and the fog it drives (§3.7, §12.1).
 *
 * These numbers are RULES rather than art direction, and that is the whole reason
 * they live here instead of in the renderer: "the fog closes as the run advances"
 * is a promise the design makes to the player in §4 (dusk as a clock — the player
 * always knows how far through the run they are without reading a number), so it
 * has to be a pure function `verify.mjs` can fail on. A density table typed
 * straight into `world.js` would be a number nobody can assert, and §3.7's
 * "never driven by captures" would be a comment instead of a rule.
 *
 * The colours are NOT here. §12.3's palette anchors stay in the view layer
 * (`streetView.js`), because a hex value is an art decision and this file is the
 * rules; the split is deliberate and is the same split §15.2 draws between the
 * two harnesses.
 */
// ITERATION 2, PASS 2 — 0.01 / 0.0135 / 0.018 / 0.026 -> 0.0075 / 0.0105 /
// 0.0135 / 0.0175. Every stop is down, and the reason is the checklist's own
// wording: "fog should be a depth cue, not a wall." The old table put Act I at
// half opacity 83.3 m and the finale at 32.0 m, which sounds generous until it
// is read as a *ratio*: the world lost 61% of its sight between the first step
// and the last, and the 32 m finale put the horizon inside the distance at
// which the player is expected to recognise a shape. §11.3's whole balance rests
// on 20 m of creature detection meaning something, and a fog that is half opaque
// at 32 m means the thing it detects at 20 m is a smudge.
//
// The new table's half-visibility is 111.0 / 79.3 / 61.7 / 47.6 m. The closure
// ratio is 2.33x rather than 2.60x — deliberately still "the finale closes the
// world by half", because §3.7's dusk-as-a-clock is a design promise and this
// pass was never chartered to unmake it. What changed is the *floor*: the
// thinnest fog in the game is now 47.6 m instead of 32.0 m, so the darkest the
// world ever gets still has a road in it.
export const DUSK_FOG = Object.freeze([
  Object.freeze({ portals: 0, density: 0.0075 }),
  Object.freeze({ portals: 1, density: 0.0105 }),
  Object.freeze({ portals: 2, density: 0.0135 }),
  Object.freeze({ portals: 3, density: 0.0175 }),
])

/** Dusk below zero or above one is a caller bug, not a mood; clamp it. */
export function fogDensityForDusk(dusk) {
  const t = Number.isFinite(dusk) ? Math.max(0, Math.min(1, dusk)) : 0
  const last = DUSK_FOG.length - 1
  for (let i = 0; i < last; i += 1) {
    const from = DUSK_FOG[i]
    const to = DUSK_FOG[i + 1]
    if (t <= to.portals / PORTAL_IDS.length) {
      const span = to.portals / PORTAL_IDS.length - from.portals / PORTAL_IDS.length
      const k = span > 0 ? (t - from.portals / PORTAL_IDS.length) / span : 0
      return from.density + (to.density - from.density) * Math.max(0, Math.min(1, k))
    }
  }
  return DUSK_FOG[last].density
}

/**
 * fogVisibility — the distance at which fog is half opaque, metres.
 *
 * `FogExp2` is exp(-(d * density)^2), so half opacity sits at sqrt(ln 2) /
 * density. It is a real distance rather than a feel-good number because §4
 * promises the fog is a clock the player can read, and a clock nobody can convert
 * to metres is a clock that cannot be balanced — the whole of §11.3 rests on the
 * creature's 20 m detection range meaning something relative to how far you can
 * see.
 */
export function fogVisibility(density) {
  if (!Number.isFinite(density) || density <= 0) return Infinity
  return Math.sqrt(Math.LN2) / density
}

// ---------------------------------------------------------------------------
// the portal's descent (iteration 2, pass 12)
//
// WHY THIS SECTION IS HERE AND NOT IN streetView.js
// -------------------------------------------------
// The four things this pass adds are all *decisions*: how close you have to be
// before the arms turn faster, what a rock's orbit is, how long a collapse takes
// and what its envelope looks like, and how dark the lensing overlay is allowed
// to be. `streetView.js` imports Three.js, so `verify.mjs` cannot import it and
// could only ever read its text — which is the pass-1/2/3 arrangement and the
// reason those sections are source contracts. Passes 9/10/11 replaced that
// arrangement for the creature by deciding every number in `creature.js` and
// letting the view apply it, and this is the same move for the portal: the view
// reads these and cannot retune one without failing a gate.
//
// THE REGRESSION THIS PASS IS MOST EXPOSED TO, and it is worth stating before
// any of the numbers: the pass-3 pupil gate reads the luma at the CENTRE of the
// rim's bounding box and requires it to stay at or under 20. Everything added
// below is either kept strictly OUTSIDE the core radius (`PORTAL_DEBRIS_RING`'s
// inner is asserted to be larger than the view's `PORTAL_CORE_RADIUS`), or is a
// MULTIPLICATIVE darkening whose alpha is zero at the centre
// (`portalLensAlpha(0) === 0`), or is applied only while a portal is dying and
// the disc behind it has already been scaled toward nothing. None of the four
// can add a photon to the middle of the hole, and each of those three facts is
// asserted in verify.mjs rather than promised here.
// ---------------------------------------------------------------------------

/**
 * The distance at which the arms turn faster, metres.
 *
 * BEFORE pass 12: nothing. The swirl's rate was two constants in
 * `streetView.js` — [0.21, -0.13] — and the hole turned at the same speed from
 * 70 m as from the hold distance. That is a texture, not a place.
 *
 * AFTER 8. §5.2's verb is a 1.2 s hold and the player must be inside 2.6 m to
 * start one, so 8 m is where the portal stops being scenery and becomes the
 * thing in front of you — about a house plus its front garden, which is roughly
 * how far off a light stops reading as "that one" and starts reading as "a light
 * down there". The ramp is C1 (`u*u*(3-2*u)`) so there is no velocity step as
 * you cross the boundary, and the falloff to 0 is a HARD cut at the radius,
 * because a soft tail would mean the hole still reacts to you across the map.
 */
export const PORTAL_NEAR_METRES = 8

/**
 * How squarely you have to be looking at it, as a dot product.
 *
 * BEFORE nothing — there was no facing term, because there was no reason to
 * distinguish the two ways of standing next to a hole.
 *
 * AFTER 0.5, which is cos 60°. The point of the term is that the swirl should
 * answer *attention*: you turn away and it is just a hole again. Sixty degrees
 * is the half-angle at which a thing is still unambiguously in front of you, and
 * verify.mjs asserts the constant against its own cosine so a retune has to say
 * out loud what angle it bought.
 */
export const PORTAL_NEAR_FACING = 0.5

/**
 * How much faster the arms turn when you are standing at the hole, as a
 * multiplier on each layer's own rate.
 *
 * BEFORE 1, implicitly: one rate, no variation.
 *
 * AFTER 1.6, and the number is CONSTRAINED FROM ABOVE by the pass-3 gate rather
 * than chosen for feel. Pass 3 wrote `|rate| < 0.35` into a check that reads
 * `PORTAL_SWIRL_RATES` out of this file's own source, and that check is about the
 * hole a player is LOOKING AT — which after this pass is the hole they are
 * standing in front of. `0.21 * SPIN < 0.35` puts the ceiling on `SPIN` at 1.667,
 * and 1.6 leaves 4% of headroom against it.
 *
 * BEFORE 1.6 IT WAS 2.2, chosen for the look of the difference rather than against
 * the gate, and it put the near field at 0.462 rad/s — a full turn every 13.6 s and
 * a flat violation of a rule this repository has held since pass 3. The pass-3
 * check did not catch it because it reads the idle TABLE and the near field is a
 * multiplier applied in `update`, which is the same reason it would not have
 * caught a turbine either. The new check in this pass's section asserts the
 * ceiling against `rate * PORTAL_NEAR_SPIN` and not against the table, which is
 * the shape of check that would have.
 *
 * 0.21 * 1.6 is 0.336 rad/s: one revolution in 18.7 s, against the idle 30 s. The
 * whole point is that the difference between "a light down there" and "I am at the
 * door" is legible in about three seconds of standing still, and 1.6x buys that.
 * Much above 1.667 and the two readings merge into machinery; at or below 1.3 you
 * cannot tell you have arrived.
 */
export const PORTAL_NEAR_SPIN = 1.6

// ---------------------------------------------------------------------------
// the debris ring
// ---------------------------------------------------------------------------

/**
 * How many rocks orbit the rim, and the hard cap on the number.
 *
 * BEFORE none. The hole had a lip, a disc and two spiral layers and nothing else
 * in it, which is what §4's portal-cyan comment means by a light with nothing in
 * it.
 *
 * AFTER 14 built, capped at 20. The brief asked for "max ~20" and the cap is
 * written as a separate constant rather than left as the literal 14, because the
 * number a future pass is tempted to raise is the one that has to be defended.
 * Fourteen is chosen against the geometry rather than by taste: at the 0.78-0.96
 * m ring the 1.44 m disc subtends about 400 px at the §16.5.5 stand-off, so 14
 * rocks of 18-40 mm are each 5-11 px — under `EYE_MAX_SPAN`'s 14 px ceiling,
 * which is the whole safety argument for the effect and is recomputed per rock
 * in verify.mjs. Fourteen also reads as a *ring*: the eye completes a circle at
 * around seven objects, and past about twenty a belt of debris stops being a
 * belt and becomes noise.
 */
export const PORTAL_DEBRIS_COUNT = 14

/**
 * The cap, as a number distinct from the count.
 *
 * The count is a TUNING decision and this is a CONTRACT, and the only way a
 * reviewer can tell them apart is if they are different constants. A pass that
 * wants a denser ring moves `PORTAL_DEBRIS_COUNT`; it is allowed to move it up
 * to 20 and then has to re-answer the eye-span argument, which verify.mjs
 * recomputes from the geometry rather than restating.
 */
export const PORTAL_DEBRIS_MAX = 20

/**
 * The ring's radii, metres, inner and outer.
 *
 * The INNER one is the load-bearing number in this pass and it is constrained
 * from below by the pupil gate, not by taste. The pass-3 measure reads the luma
 * at the centre of the rim's bounding box, and a rock crossing that point would
 * be a 5-11 px speck sitting exactly where the gate says there must be nothing
 * but the hole's own near-black. So the inner radius must be strictly greater
 * than the core radius, and verify.mjs asserts that against `PORTAL_CORE_RADIUS`
 * read out of the view's own source — the two modules cannot both own the
 * number, so the check compares them rather than trusting either.
 *
 * 0.78 m is 8% outside the 0.72 m disc: enough that a rock at its innermost
 * orbit is never inside the hole, and tight enough that the ring still reads as
 * belonging to the lip rather than as a separate halo. The outer 0.96 m is
 * chosen against the shed, whose doorway is 1.1 m of clear width — so the ring
 * IS cropped by the doorway, at the same two edges the disc is, which is the
 * consistency `PORTAL_DEBRIS_FLATTEN`'s docblock argues for.
 *
 * **AND THE NEAREST APPROACH IS `radius * FLATTEN`, NOT `radius`, WHICH IS THE
 * WHOLE OF THE PUPIL ARGUMENT AND WAS NOT STATED HERE.** A squash makes the orbit's
 * minor axis shorter than its major one, and a short minor axis is what reaches the
 * centre. The paragraph above reasons entirely about the major axis, which is why
 * `verify.mjs` was green over a ring that sat 0.48 m from the centre of a 0.72 m
 * hole. The gate now sweeps every pose over a full revolution and takes the
 * minimum, which is the only way to see it, and the value it is run against is
 * this pair times `PORTAL_DEBRIS_FLATTEN`.
 */
export const PORTAL_DEBRIS_RING = Object.freeze([0.78, 0.96])

/**
 * How much the ring is squashed vertically, as a fraction of its radius.
 *
 * **BEFORE 0.62. AFTER 1 — i.e. the ring is a CIRCLE, and the squash was a
 * geometric error rather than a taste call.**
 *
 * 0.62 was chosen so that a 1.9 m ring would be cropped by the shed's 1.1 m
 * doorway, on the reasoning that "a perfect circle in a doorway is cropped on both
 * sides, and the crop is what the eye reads". The crop is real. What was not
 * checked is WHERE the crop happens, and a squashed ellipse centred on a circle
 * that is LARGER than it is inside that circle at the top and the bottom: the
 * orbit's minimum distance from the gate's centre is `radius * FLATTEN`, not
 * `radius`, so at 0.78 m and 0.62 the nearest a rock ever came to the centre was
 * 0.48 m on a 0.72 m hole — a third of the way into the pupil, in the one place
 * the whole feature was written not to go.
 *
 * The world check found it on the first run, by reading the built instance
 * matrices and comparing each rock's distance from the gate's centre with the
 * hole's own radius. The pure test in `verify.mjs` did NOT, because it compared
 * `rock.radius` with `PORTAL_CORE` and `rock.radius` is the orbit's MAJOR axis —
 * so the test was true and the feature was broken, which is the exact shape of
 * failure pass 11's review called "a gate that reads a number the feature does not
 * produce". Both are fixed: the value, and the test, which now sweeps the
 * semi-axes rather than the parameter.
 *
 * WHY A CIRCLE IS RIGHT ANYWAY, and it is the same sentence the old value was
 * written with, minus the part that was wrong. The crop is already the disc's:
 * pass 3 established that the 1.44 m hole MUST be cropped by a 1.1 m doorway, and
 * built a gate on the claim. A concentric ring is cropped by exactly the same two
 * edges, which is consistency rather than a new problem. And the pass-3 failure
 * this constant was reaching for — the portal reading as a HALO — was a
 * continuous, bright, 2.8 cm torus. Fourteen DARK flakes of 18-40 mm are not that,
 * and conflating the two is what produced 0.62.
 *
 * The value is still a named export and still travels on the orbit rather than on
 * the mesh, because at 1.0 the two are the same thing and the next person to
 * retune this will not know that unless the seam is still there to be found.
 */
export const PORTAL_DEBRIS_FLATTEN = 1

/**
 * The rocks' angular rates, rad/s, slowest and fastest.
 *
 * BEFORE n/a. AFTER 0.09-0.28, and both ends are set by comparisons rather than by
 * feel. The slow end is one revolution in 70 s — slower than the swirl's own 30 s,
 * so the debris is the QUIET layer and the brief's "subtle" is a number here
 * rather than an adjective.
 *
 * THE FAST END IS UNDER THE FASTEST THE SWIRL EVER TURNS, which is
 * `PORTAL_SWIRL_RATES[0] * PORTAL_NEAR_SPIN` and not the idle 0.21. BEFORE this
 * pass corrected it the range was 0.11-0.34, and 0.34 is FASTER than the swirl at
 * 0.21 and faster than its own near-field 0.336 — so the claim the docblock made,
 * "even the liveliest rock turns slower than the thing it orbits", was false in
 * the direction that matters, and a belt of rocks outrunning the spiral it is
 * supposed to belong to reads as the wrong effect entirely. 0.28 leaves 17% of
 * headroom under the near-field ceiling.
 *
 * The sign is drawn separately from the magnitude (see `portalDebrisRing`), so the
 * ring is genuinely two-directional: a belt where every rock turns the same way is
 * a clock face.
 */
export const PORTAL_DEBRIS_RATES = Object.freeze([0.09, 0.28])

/**
 * Rock radius, metres, smallest and largest.
 *
 * BEFORE n/a. AFTER 0.018-0.040. The top end is set by the eye-span argument in
 * `PORTAL_DEBRIS_COUNT`: 40 mm at 4.5 m is about 9 px on the long axis, inside
 * `EYE_MAX_SPAN`'s 14. The bottom end is 18 mm, about 4 px at the same distance
 * and under a pixel per side on the 480-wide responsive capture, so on a small
 * viewport the ring thins out rather than becoming a dotted line of single
 * pixels. A rock that small and that dark is also why this effect needs no
 * additive trick: it never becomes an eye-finder candidate at any size, because
 * it is never bright.
 */
export const PORTAL_DEBRIS_SIZE = Object.freeze([0.018, 0.04])

/**
 * The rock material's colour, and the whole safety argument in one hex.
 *
 * BEFORE n/a. AFTER 0x2b2f33. It has to be a `MeshStandardMaterial` and not a
 * `_glow`, because the brief asks for rocks that "catch the rim light" and an
 * unlit material cannot catch anything — the portal's own PointLight IS the rim's
 * light and a lit material is the only thing that receives it. It also has to be
 * DARK: 0x2b2f33 is 47.4 Rec. 709 luma, 32% of `EYE_MIN`'s 150, so even fully lit
 * by a 26 m cyan point light it stays an order of magnitude below the eye
 * finder's floor. verify.mjs measures the lit worst case from the light's own
 * intensity and falloff rather than restating 47, and holds it under half of
 * `EYE_MIN`.
 */
export const PORTAL_DEBRIS_COLOUR = 0x2b2f33

// ---------------------------------------------------------------------------
// the lensing overlay, and the collapse
// ---------------------------------------------------------------------------

/**
 * The lensing overlay's radius as a multiple of the core radius, and the darkest
 * it is allowed to get there.
 *
 * BEFORE n/a. The brief asks for "a dark radial gradient overlay just larger than
 * the disc that deepens the background near the rim (no real refraction)", which
 * is the right cheap approximation and is safe to do at all *because* it is
 * MULTIPLICATIVE: a normal-blended dark quad can only ever subtract, so it
 * cannot brighten the pupil, and its alpha is a function of radius alone, so the
 * centre — the pixel the pass-3 gate measures — is provably untouched.
 *
 * 1.34 is "just larger than the disc": 0.72 m of hole and 0.965 m of overlay, so
 * the darkening is a 24 cm annulus of BACKGROUND around the lip rather than a
 * disc laid over it. `crest` 1.11 is a third of the way out — far enough from the
 * lip that the lip itself is undimmed, close enough that the falloff has most of
 * the annulus in front of it. The 0.34 is a ceiling AND the value the profile
 * actually reaches, and the profile is exactly zero at the lip and at the outer
 * edge, so only a narrow band of background is darkened at all.
 */
export const PORTAL_LENS = Object.freeze({ outer: 1.34, peak: 0.34, crest: 1.11 })

/**
 * The collapse: how long it takes, how fast the arms are going by the end, and
 * when the flash is.
 *
 * BEFORE n/a — §5.3 put a portal out in one frame, which is right for a boolean
 * and wrong for a thing a player is standing 2.2 m from holding a key down for
 * the fifth time. The port goes dark instantly and stays dark for ever (that is
 * the rule and it has not moved); what pass 12 adds is the 0.8 s *aftermath*,
 * during which the aperture closes.
 *
 * 0.8 s is the brief's "~0.8 s" and it is also the number the balance simulation
 * cannot feel: `PORTAL_SHUT_SECONDS` is 1.2 and the collapse starts after the
 * hold completes, so the collapse is strictly AFTER every gameplay-visible event
 * it could disturb. verify-world.mjs asserts that directly, by running the
 * three-portal sequence and requiring the state to be identical with and without
 * the collapse running.
 *
 * The spin multiplier of 7 is the one number here with a reason. By the end the
 * arms turn at 7x their live rate — 1.47 rad/s — which is FASTER than the swirl's
 * own 0.35 ceiling, and that is deliberate: the ceiling exists to keep a LIVE
 * hole from reading as machinery, and a hole reading as machinery for 0.8 s on
 * its way out is the entire point. The gate on it is therefore not "under 0.35"
 * but "applied to a group whose scale has already left the frame", which
 * verify-world.mjs asserts structurally rather than numerically.
 *
 * The flash sits at 0.16 s — a fifth of the way in. Early enough to be the first
 * thing you see, late enough that it is not simultaneous with the shut itself: a
 * flash on the same frame as the light going out is a single event, and this is
 * meant to read as a CONSEQUENCE of one.
 */
export const PORTAL_COLLAPSE = Object.freeze({
  seconds: 0.8,
  spin: 7,
  flash: 0.16,
  flashWidth: 0.09,
  flashGain: 3.2,
})

/**
 * portalNearness — how much the hole is answering you, 0..1.
 *
 * Two gates and a ramp, in this order, and the ORDER is the claim: you must be
 * CLOSE, you must be FACING it, and only then does distance buy you anything.
 * Checking facing first would mean a player 20 m away staring at the portal got
 * a partial response; checking distance first would mean walking past one
 * backwards spun it up.
 *
 * Null-safe on both arguments, for the reason `portalsShut` is: this is called
 * from a render loop with values that come off a camera and a projection, and a
 * predicate that throws on `NaN` takes the frame down instead of answering the
 * question. A non-finite input is treated as "not near", which is the safe
 * direction — the hole goes back to being a hole.
 *
 * @param {number} distance metres from the viewer to the gate
 * @param {number} facing dot of the view direction with the gate's own normal
 * @returns {number} 0 (a hole) to 1 (standing at it, looking at it)
 */
export function portalNearness(distance, facing) {
  if (!Number.isFinite(distance) || !Number.isFinite(facing)) return 0
  if (distance < 0 || facing < PORTAL_NEAR_FACING) return 0
  if (distance >= PORTAL_NEAR_METRES) return 0
  const u = 1 - distance / PORTAL_NEAR_METRES
  return u * u * (3 - 2 * u)
}

/**
 * portalSwirlRate — a layer's angular rate, given how near the viewer is.
 *
 * A single multiplier rather than a second table, because the layer's own rate
 * carries its SIGN and the pass-3 gate asserts that the two layers turn opposite
 * ways. A separate near-field table would have to carry the sign too, and would
 * be a second place for the two layers to disagree.
 *
 * @param {number} rate the layer's own rate, rad/s, signed
 * @param {number} nearness 0..1 from `portalNearness`
 * @returns {number} rad/s
 */
export function portalSwirlRate(rate, nearness) {
  if (!Number.isFinite(rate) || !Number.isFinite(nearness)) return 0
  const near = Math.max(0, Math.min(1, nearness))
  return rate * (1 + (PORTAL_NEAR_SPIN - 1) * near)
}

/**
 * portalDebrisRing — the fourteen rocks, as plain data.
 *
 * Deterministic in the run seed and the portal's own index, and a pure function
 * of both because pass 11's review finding 4 is the reason: an orbit that cannot
 * be re-taken is a frame nobody can photograph twice. `hash32` is imported rather
 * than `Math.random` for the reason pass 7 moved its seeds off the call site — a
 * seed typed at the call site is a seed two people will change differently.
 *
 * The shape of each rock is four numbers: a radius in the ring, a signed rate, a
 * phase, and a size. Nothing else, deliberately — no per-rock bob, no tilt, no
 * colour. Every extra degree of freedom is a number somebody has to justify, and
 * a ring of identical dark flakes turning at different rates on different orbits
 * already reads as debris without any of them.
 *
 * @param {number} seed the run seed
 * @param {number} index which portal, 0..2
 * @returns {ReadonlyArray<{radius: number, rate: number, phase: number, size: number}>}
 */
export function portalDebrisRing(seed, index) {
  const [inner, outer] = PORTAL_DEBRIS_RING
  const [slow, fast] = PORTAL_DEBRIS_RATES
  const [small, large] = PORTAL_DEBRIS_SIZE
  const rings = []
  for (let i = 0; i < PORTAL_DEBRIS_COUNT; i += 1) {
    // The SALT is the rock's own index and the COORDINATE is the portal's, which is
    // the same shape pass 7's `flickerLot` uses: two draws that cannot alias,
    // because a rock at (seed+salt, portal*31+i) and one at (seed+salt',
    // portal'*31+i') share a hash only when both of their numbers do.
    const pick = (salt) => (hash32(seed + salt * 2654435761, index * 31 + i, salt * 7 + 3) >>> 8) / 0x00ffffff
    // The SIGN is a SEPARATE draw from the magnitude, on purpose. One draw for
    // both would correlate them — the rock that drew low for its rate would also
    // be the one that goes the other way — and the ring would carry a visible
    // bias in which way it turns at which radius.
    rings.push({
      radius: inner + (outer - inner) * pick(1),
      rate: (slow + (fast - slow) * pick(2)) * (pick(3) < 0.5 ? -1 : 1),
      phase: pick(4) * Math.PI * 2,
      size: small + (large - small) * pick(5),
    })
  }
  return rings
}

/**
 * portalDebrisPose — where one rock is at a given time, in the gate's own frame.
 *
 * A function of TIME and not of a frame count, for the reason the swirl is:
 * `update(dt)` is handed a delta, so a pose written from an accumulator is a
 * different picture on every machine. This is why `verify-world.mjs` can drive
 * the world to the same `t` twice and require the matrices back bit-identical.
 *
 * The squash is on the ORBIT and not on the mesh (see `PORTAL_DEBRIS_FLATTEN`),
 * and it is 1 today, so the flake is a REGULAR TETRAHEDRON and the two are the
 * same shape — which is exactly why the seam is kept. A squashed tetra is a
 * different solid, and a retune that put the squash on the mesh instead of here
 * would be a change nobody could see in a number.
 *
 * The flake's own spin about its axis is `angle * 3` — an arbitrary-looking
 * factor rather than a second clock, so a rock is never tidily aligned with its
 * own orbit and never quite still.
 *
 * @param {{radius: number, rate: number, phase: number, size: number}} rock
 * @param {number} time seconds on the view's own clock
 * @returns {{x: number, y: number, angle: number, size: number}}
 */
/**
 * portalDebrisPose — one flake's position and spin at `time`, in the ring's plane.
 *
 * PASS 17. The `into` argument is new and optional, and it exists for the same
 * reason `ashDrift`'s is: this is called fourteen times a frame per live portal
 * (forty-two a frame in a full Act I) and a function that can only return a value
 * will allocate one every time. The module is PURE and stays pure — this writes
 * into a caller's object rather than mutating any of its own — and every existing
 * caller that wants a value rather than a destination is unaffected, because the
 * fresh-object path is still there when `into` is omitted.
 *
 * @param {object} rock one flake's own `{phase, rate, radius, size}`
 * @param {number} time seconds on the view's clock; negative clamps to zero
 * @param {{x: number, y: number, angle: number, size: number}} [into] written
 *   instead of allocating a fresh object
 * @returns {{x: number, y: number, angle: number, size: number}}
 */
export function portalDebrisPose(rock, time, into) {
  // NEGATIVE TIME IS CLAMPED TO ZERO, and this is not a formality. `t` on the
  // view's clock only ever rises, so a negative value cannot occur here — but the
  // function's two siblings in this file (`portalCollapse`, and the `t` a caller
  // hands it as `now - something`) both clamp, and a ring that could be posed at a
  // negative time while the collapse beside it could not is two different answers
  // to the same question. A rock in the future sits at its phase, which is a
  // position the ring already occupies and therefore one nobody could have told
  // apart from a rock whose clock had run backwards.
  const t = Number.isFinite(time) ? Math.max(0, time) : 0
  const angle = rock.phase + rock.rate * t
  const pose = into ?? { x: 0, y: 0, angle: 0, size: 0 }
  pose.x = Math.cos(angle) * rock.radius
  pose.y = Math.sin(angle) * rock.radius * PORTAL_DEBRIS_FLATTEN
  pose.angle = angle * 3
  pose.size = rock.size
  return pose
}

/**
 * portalCollapse — the 0.8 s aftermath of a shutdown, as a pure envelope.
 *
 * Four numbers, all functions of `elapsed` seconds and nothing else, and that is
 * what makes the animation re-takeable: a capture that steps the world to
 * `elapsed = 0.4` gets the same frame on any machine, and `verify-world.mjs`
 * asserts exactly that by driving the same elapsed twice and comparing the
 * resulting transforms to the bit.
 *
 * The SHAPE, and why each piece is here:
 *
 *  - `scale` is `1 - u^4`, which hangs at full size and then goes. The derivative
 *    at `u = 0` is exactly zero, so there is no velocity step as the collapse
 *    starts; the aperture is still 99.8% open at the flash's own centre, 94% at the
 *    halfway mark, and 59% at three quarters, and then it is gone in the last
 *    fifth of a second. An ease-out closes fast immediately and reads as a pop; a
 *    linear one reads as a zoom. The quartic holds because the interesting thing —
 *    the flash — happens inside the held part, and a collapse that starts closing
 *    at t=0 has nothing to interrupt.
 *
 *    THE `1 - u^4` IS NOT A TYPO, and neither was the two versions that preceded
 *    it. The first wrote `u * u * u`, which had the aperture GROWING to full size
 *    over the 0.8 s and then snapping shut at the very end — the exact inverse of
 *    the easing its comment claimed, and invisible to any gate that only checked
 *    `scale <= 1` and `scale === 0 at u === 1`. The second wrote `(1 - u) ** 3`,
 *    which is a correct ease but not the ease that was wanted: a cubic of the
 *    remaining size starts closing at -3 per unit, so it is 29% closed by the end
 *    of the "held" first third and a full 49% closed at the flash. The flash was
 *    then lighting a hole that was halfway to nothing. `1 - u^4` is the shape the
 *    paragraph above has always described, and the gate in this pass's section is
 *    what found that the two earlier shapes were not it.
 *  - `flash` is a symmetric bell centred on `PORTAL_COLLAPSE.flash`, peaking at
 *    `flashGain` and reaching exactly 0 one `flashWidth` to either side. It is
 *    SYMMETRIC on purpose: a one-sided flash is a switch, and a switch is a
 *    strobe, and §14.3's reduced-motion rule exists because a switch is exactly
 *    what that rule is about. The `(1 - bell^2)^2` shape is a smoothstep of the
 *    squared offset — C1 at both edges, so there is no velocity step at the
 *    moment the flash appears or dies.
 *  - `spin` ramps `1 -> PORTAL_COLLAPSE.spin` on `u^2`, so the acceleration
 *    itself accelerates, and the arms are still at their live rate on frame 0.
 *  - `scale` reaching 0 IS the end of the animation. There is no separate "done"
 *    flag, because a separate flag is a second thing to get out of step with the
 *    first; `scale === 0` is the one condition, and the view's own `scale.set`
 *    makes the mesh vanish with it.
 *
 * @param {number} elapsed seconds since the shutdown, clamped at 0
 * @returns {{scale: number, flash: number, spin: number, u: number}}
 */
export function portalCollapse(elapsed) {
  const t = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0
  const u = Math.min(1, t / PORTAL_COLLAPSE.seconds)
  const bell = (t - PORTAL_COLLAPSE.flash) / PORTAL_COLLAPSE.flashWidth
  return {
    scale: 1 - u ** 4,
    flash: Math.abs(bell) < 1 ? PORTAL_COLLAPSE.flashGain * (1 - bell * bell) ** 2 : 0,
    spin: 1 + (PORTAL_COLLAPSE.spin - 1) * u * u,
    u,
  }
}

/**
 * portalLensAlpha — the lensing overlay's alpha at a radius, 0..peak.
 *
 * A function of the radius ALONE, and that is the safety property rather than a
 * convenience. The pass-3 pupil gate measures the luma at the centre of the rim,
 * and this returns exactly 0 there and at every radius inside 0.55 of the core —
 * so the hole's own dark ground is not darkened by one level, and the swirl band
 * that same gate reads (0.30-0.62 of the radius) is likewise untouched. The
 * profile is a tent on [0.55, 1.34] with a smooth join, so there is no ring of
 * discontinuity for the eye to find at either edge.
 *
 * The tent is asymmetric about its peak because the peak is at the RIM, which in
 * this parameterisation is u = (1 - 0.55) / 0.79 = 0.570 — nearer the inner edge
 * than the outer one, so the falloff has more room to be soft on the side that
 * faces open background. `Math.sin(pi*u)` is zero at BOTH ends and 1 in the
 * middle, which is what makes the join C1 without a second easing term.
 *
 * @param {number} ratio the radius as a fraction of the core radius
 * @returns {number} 0..PORTAL_LENS.peak
 */
/**
 * portalLensAlpha — the lensing overlay's alpha at a radius, 0..peak.
 *
 * A function of the radius ALONE, and that is the safety property rather than a
 * convenience. It returns exactly 0 for every radius at or inside the DISC — and
 * "the disc" is the load-bearing boundary, because the disc is everything the
 * pass-3 gate reads: the pupil at the centre, and both swirl layers, which sit at
 * 0.4 m and 0.66 m on a 0.72 m hole, i.e. at 0.556 and 0.917 of the radius. So the
 * hole's own dark ground is not darkened by one level and neither is the swirl.
 *
 * WHY THE EDGE IS AT 1.0 AND NOT NEARER IN, and this was the first version's bug.
 * The original profile ran from ratio 0.55, on the reasoning that 0.55 was "well
 * inside the hole". It is — and the outer swirl layer is at 0.917, so that
 * profile put up to 0.28 of alpha on the outer third of the swirl band, which is
 * a visible dark crescent on the one element the pass-3 swirl gate exists to
 * measure. The fix is not a smaller number, it is moving the whole ramp outside
 * the disc: the darkening is then *only ever* on background, which is what the
 * brief asked for in the first place, and the safety argument stops depending on
 * where the swirl layers happen to be.
 *
 * The profile on [1.0, 1.34] is a smoothstep tent peaking at 1.11, so it is
 * exactly 0 at the lip, exactly 0 at the overlay's own edge, exactly `peak` in
 * between, and C1 at all three. A tent with a sharp apex is a ring; a tent with
 * a sharp foot is a decal.
 *
 * @param {number} ratio the radius as a fraction of the core radius
 * @returns {number} 0..PORTAL_LENS.peak
 */
export function portalLensAlpha(ratio) {
  const r = Number.isFinite(ratio) ? ratio : 0
  if (r <= 1 || r >= PORTAL_LENS.outer) return 0
  const u = r < PORTAL_LENS.crest ? (r - 1) / (PORTAL_LENS.crest - 1) : 1 - (r - PORTAL_LENS.crest) / (PORTAL_LENS.outer - PORTAL_LENS.crest)
  return u * u * (3 - 2 * u) * PORTAL_LENS.peak
}

// ---------------------------------------------------------------------------
// breath (§7.3)
// ---------------------------------------------------------------------------

/** Full breath is 1. Sprinting from full runs this many seconds. */
export const BREATH_DRAIN_PER_SEC = 0.28

/** Seconds to refill from empty. */
export const BREATH_RECOVER_PER_SEC = 0.18

/**
 * Hysteresis. Sprint lockout does not lift the instant breath leaves zero — it
 * lifts at this level, so you cannot sprint-bobbing along the bottom of the
 * meter. Reads fine in code, feels awful in play.
 */
export const BREATH_RECOVERY_THRESHOLD = 0.35

/** Exhausted breathing is this much louder than the gait alone (§7.3). */
export const EXHAUSTED_BREATH_SOUND_BONUS = 6

/**
 * breathStep — one tick of the stamina model.
 *
 * The rule the design actually wanted is not "sprinting costs stamina", it is
 * **exhaustion makes you louder**: the meter is never shown, and being out of
 * breath raises your sound radius. That punishes the state you are in when you
 * get caught rather than the act of running, so panicking is still available
 * and merely expensive.
 *
 * @param {number} breath 0..1
 * @param {boolean} exhausted lockout flag
 * @param {boolean} sprinting whether the sprint key is down
 * @param {number} dt seconds
 * @returns {{ breath: number, exhausted: boolean }}
 */
export function breathStep(breath, exhausted, sprinting, dt) {
  const delta = sprinting && !exhausted ? -BREATH_DRAIN_PER_SEC : BREATH_RECOVER_PER_SEC
  const next = Math.max(0, Math.min(1, breath + delta * dt))
  if (exhausted) return { breath: next, exhausted: next < BREATH_RECOVERY_THRESHOLD }
  return { breath: next, exhausted: next <= 0 }
}

/** The sound radius for a gait, louder when out of breath. */
export function breathSoundRadius(baseRadius, exhausted) {
  return exhausted ? baseRadius + EXHAUSTED_BREATH_SOUND_BONUS : baseRadius
}

// ---------------------------------------------------------------------------
// the win trigger (§10.4) — deliberately a mirror of v1's isInsideChamber
// ---------------------------------------------------------------------------

/**
 * EXIT_WIN_RADIUS — §10.4's `isInsideExit(playerPosition, exitCenter, radius)`.
 *
 * 1.15 m, and the same number v1's `DOOR_WIN_RADIUS` has, which is asserted
 * rather than merely intended. The radius is also why `streetView.js` parks the
 * car *beside* its anchor: the player has a 0.36 m collision radius of their
 * own, so a body centred on the anchor would push them out of their own win.
 */
export const EXIT_WIN_RADIUS = 1.15

/**
 * isInsideExit — have you walked into the exit car?
 *
 * Shape-for-shape the same as v1's `isInsideChamber`, deliberately: it keeps
 * the verification pattern transferable and makes the benchmark's "keep the win
 * condition comparable between runs" literally true rather than aspirational.
 * Note it is pure GEOMETRY — the rule that you must have reached the finale is
 * `checkExitWin` below, not this.
 */
export function isInsideExit(position, exitCenter, radius = EXIT_WIN_RADIUS) {
  if (!position || !exitCenter) return false
  return Math.hypot(position.x - exitCenter.x, position.z - exitCenter.z) <= radius
}

/**
 * checkExitWin — the actual win rule: in the exit, and the finale is running.
 *
 * Both halves, in one function, because §10.4's win is the conjunction and a
 * world that checked them separately would eventually check them in the wrong
 * order. The finale half is the one that is easy to lose: the car is *there*
 * from Act I (§10.3 — dark, unremarkable, easy to walk past), so a player can
 * stand in the win trigger for a whole run and win nothing.
 */
export function checkExitWin(state, position) {
  if (!state.finale) return false
  return isInsideExit(position, state.exitAnchor.position, EXIT_WIN_RADIUS)
}


// ---------------------------------------------------------------------------
// state + the capture table (§9.1)
// ---------------------------------------------------------------------------

/**
 * CAPTURE_TABLE — the whole of §9.1, as data.
 *
 * This exists so the rule is asserted rather than described: `verify.mjs` walks
 * every row, sets it to a non-default value, captures, and checks it survived
 * or reset. A new row here is a new obligation in the gate, and a row quietly
 * removed is a rule quietly lost.
 *
 * `keep` — the player earned it, a capture never takes it back.
 * `increment` — the capture counter itself.
 * `reset` — the cost of dying: where you were, and what was hunting you.
 */
export const CAPTURE_TABLE = Object.freeze([
  { field: 'portals', mutation: 'keep', note: 'shuttered portals are permanent' },
  { field: 'hammerHeld', mutation: 'keep', note: 'the hammer is not dropped' },
  { field: 'banishCount', mutation: 'keep', note: 'the banish ladder is run-long' },
  { field: 'finale', mutation: 'keep', note: 'the exit stays open once triggered' },
  { field: 'dusk', mutation: 'keep', note: 'dusk tracks portals, never the loop (§3.7)' },
  { field: 'loop', mutation: 'increment', note: 'the capture counter' },
  { field: 'player', mutation: 'reset', note: 'position returns to spawn' },
  { field: 'prompt', mutation: 'reset', note: 'no prompt survives a reset' },
  { field: 'creature', mutation: 'reset', note: 'back to STALK, or TELEGRAPH in Act I' },
  { field: 'sounds', mutation: 'reset', note: 'sound events do not persist' },
])

/** Read a dotted path out of a state object. */
export function readField(state, field) {
  return field.split('.').reduce((value, part) => (value == null ? value : value[part]), state)
}

/** Write a dotted path into a state object, immutably. */
export function writeField(state, field, value) {
  const parts = field.split('.')
  if (parts.length === 1) return { ...state, [field]: value }
  const [head, ...rest] = parts
  return { ...state, [head]: writeField({ ...state[head] }, rest.join('.'), value) }
}

/**
 * createInitialState — a fresh run, with the player's position at spawn.
 *
 * The shape here and the shape `wipeRun` returns are the same shape, on purpose:
 * the whole of §10.4's "BEGIN AGAIN returns to loop 1 with portals, hammer and
 * counters wiped" is the claim that the second is indistinguishable from the
 * first, and the only way to *prove* that is to build both from one list of
 * fields. `verify.mjs` compares them with `deepEqual`.
 *
 * @param {object} objectives from `placeObjectives`
 * @param {object} [options]
 * @param {number} [options.loop] starting capture counter
 */
export function createInitialState(objectives, options = {}) {
  return {
    objectives,
    exitAnchor: objectives.exit,
    loop: options.loop ?? 1,
    portals: openPortals(),
    progress: zeroProgress(),
    hammerHeld: false,
    banishCount: 0,
    finale: false,
    dusk: 0,
    breath: FULL_BREATH,
    exhausted: false,
    player: { x: SPAWN.position.x, z: SPAWN.position.z },
    prompt: null,
    // the creature side is owned by creature.js from slice 06; it lives here so
    // that the whole of §9.1 is provable in one pure module
    creature: { state: 'telegraph', reemergenceCount: 0, awareness: 0 },
    sounds: [],
  }
}

/**
 * The two fields `createInitialState` owns that are *not* run state.
 *
 * They are the anchors: where the objectives and the exit are, which is
 * geometry rather than progress (§3.4), and which is why a capture keeps them
 * (§9.1) and why a full wipe may too. `verify.mjs` walks every key of a fresh
 * state and fails on one that neither table mentions and this list does not
 * cover — a field added to the state and to neither table is a rule nobody
 * decided.
 */
export const WIPE_EXEMPT_FIELDS = Object.freeze(['objectives', 'exitAnchor'])

/**
 * WIPE_TABLE — §10.4's full wipe, as data.
 *
 * The mirror image of `CAPTURE_TABLE`, and the contrast is the design's own
 * sentence: a capture should cost the player *where they were*, never *what they
 * achieved*; BEGIN AGAIN is the one place the achieved column goes too, because
 * the player asked for a new run rather than another attempt at this one. There
 * is no `keep` row here. That absence is the rule, and `verify.mjs` asserts it.
 *
 * @see CAPTURE_TABLE for the row shape
 */
export const WIPE_TABLE = Object.freeze([
  Object.freeze({ field: 'portals', mutation: 'open', note: 'all three go back to unlit' }),
  Object.freeze({ field: 'progress', mutation: 'zeroProgress', note: 'no half-finished hold survives' }),
  Object.freeze({ field: 'hammerHeld', mutation: 'clear', note: 'the hammer is back in its clearing' }),
  Object.freeze({ field: 'banishCount', mutation: 'zero', note: 'the run-long ladder starts over' }),
  Object.freeze({ field: 'finale', mutation: 'clear', note: 'the exit goes dark again' }),
  Object.freeze({ field: 'dusk', mutation: 'zero', note: 'and with it the fog (§3.7)' }),
  Object.freeze({ field: 'breath', mutation: 'refill', note: 'a new run starts rested' }),
  Object.freeze({ field: 'exhausted', mutation: 'clear', note: 'and not winded' }),
  Object.freeze({ field: 'loop', mutation: 'setLoop', note: 'back to loop 1' }),
  Object.freeze({ field: 'player', mutation: 'spawn', note: 'and the player to spawn' }),
  Object.freeze({ field: 'prompt', mutation: 'null', note: 'no prompt survives a wipe' }),
  Object.freeze({
    field: 'creature',
    mutation: 'wipeCreature',
    note: 'Act I sighting, no re-emergences, no awareness',
  }),
  Object.freeze({ field: 'sounds', mutation: 'empty', note: 'nothing queued for a frame that never came' }),
])

/**
 * wipeRun — BEGIN AGAIN, the full wipe of §10.4.
 *
 * The one place in the game where nothing is kept, and the reason it is a table
 * rather than a constructor call is that "nothing is kept" is the kind of claim
 * that decays: a new field added to the state is kept by default, silently, and
 * the only defence is a list the gate walks. A row added here is a new
 * obligation; a field added to the state and to neither table fails the gate.
 *
 * @param {object} state the run to wipe
 * @param {object} [options]
 * @param {number} [options.loop] the loop to return to, 1 by default
 */
export function wipeRun(state, options = {}) {
  let next = state
  for (const row of WIPE_TABLE) {
    switch (row.mutation) {
      case 'open':
        next = writeField(next, row.field, openPortals())
        break
      case 'zeroProgress':
        next = writeField(next, row.field, zeroProgress())
        break
      case 'clear':
        next = writeField(next, row.field, false)
        break
      case 'zero':
        next = writeField(next, row.field, 0)
        break
      case 'refill':
        next = writeField(next, row.field, FULL_BREATH)
        break
      case 'setLoop':
        next = writeField(next, row.field, options.loop ?? 1)
        break
      case 'spawn':
        next = writeField(next, row.field, { x: SPAWN.position.x, z: SPAWN.position.z })
        break
      case 'null':
        next = writeField(next, row.field, null)
        break
      case 'wipeCreature':
        next = writeField(next, row.field, { state: 'telegraph', reemergenceCount: 0, awareness: 0 })
        break
      case 'empty':
        next = writeField(next, row.field, [])
        break
      default:
        // a typo in the table must not quietly wipe nothing: a wipe that keeps
        // everything is the one failure this function exists to make impossible
        throw new Error(`wipeRun: unknown mutation '${row.mutation}' on ${row.field}`)
    }
  }
  return next
}

/**
 * applyCapture — you were caught.
 *
 * The right-hand column of §9.1 is deliberately short: a capture should cost
 * the player where they were, never what they achieved.
 */
export function applyCapture(state) {
  let next = state
  for (const row of CAPTURE_TABLE) {
    if (row.mutation === 'keep') continue
    if (row.mutation === 'increment') {
      next = writeField(next, row.field, readField(next, row.field) + 1)
      continue
    }
    if (row.field === 'player') {
      next = writeField(next, row.field, { x: SPAWN.position.x, z: SPAWN.position.z })
      continue
    }
    if (row.field === 'prompt') {
      next = writeField(next, row.field, null)
      continue
    }
    if (row.field === 'creature') {
      next = writeField(next, row.field, {
        state: next.hammerHeld ? 'stalk' : 'telegraph',
        reemergenceCount: 0,
        awareness: 0,
      })
      continue
    }
    if (row.field === 'sounds') {
      next = writeField(next, row.field, [])
      continue
    }
  }
  return next
}

export default createInitialState

