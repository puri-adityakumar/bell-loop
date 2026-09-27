/**
 * creature.js — awareness, sight, pathing and the state machine for THE LONG
 * QUIET (v2, slices 06 and 07).
 *
 * WHAT LIVES HERE
 * ---------------
 * §6.1 (the state machine), §6.2 (the awareness meter and the sound table), §6.3
 * (sight), §6.5 (this file), §7.4 (the escalating banish), §8.2 (the chase
 * phase-out), §8.3 (where re-emergence puts the creature) and §11.1–§11.3 (the two
 * difficulty ladders and the balance assertion between them). Pure: no DOM, no
 * Three.js, no clock, no globals — primitives in, a new plain object out, the house
 * style from v1's `loop.js`, a file slice 16 deleted. `verify.mjs` imports this
 * file directly in node, which is the only reason a hunting AI is at all viable in
 * a project nobody can playtest (§16.1).
 *
 * WHAT DOES NOT LIVE HERE
 * -----------------------
 * Slice 08 adds the player's breath; slice 09 gives the rules a store; slice 10
 * builds the view and the capture loop on top of everything here. Nothing in this
 * file knows any of them exist, and every rule they will need is already a pure
 * function they can call: `nextHop` to walk, `reemergeNode` to place, `aggressionAt`
 * to know how fast and how soon, `banishDuration` to know how long it is gone.
 *
 * THE TWO FACTS THE GAME IS BUILT ON
 * -----------------------------------
 *
 * > **Sound acquires. Sight confirms and holds.**
 *
 * A footstep fills the meter ~4.5x faster than the same-strength glimpse does
 * (§6.2), and standing perfectly still emits *nothing*. Together those make
 * "kill your footsteps and let it lose you" a learnable strategy — which is
 * why there is no crouch mechanic — and they make the other half of §6.2 true
 * as well: the thing you do to escape the creature is the loudest thing you
 * can do. Every constant below serves one of those two sentences.
 *
 * The measured consequence, asserted in `verify.mjs` rather than hoped for: a
 * sprint heard at 5 m nets about 0.25/s of meter against 0.12/s of decay, so
 * four seconds of running in the open gets you found. A walk at the same
 * distance never does. The 0.8 release threshold below is the third number that
 * makes those two sentences playable rather than merely true.
 *
 * THE STATE NAMES, AND ONE RECONCILIATION
 * --------------------------------------
 * §6.1's diagram names four states (TELEGRAPH, STALK, CHASE, DORMANT) plus
 * ENRAGED; the pass-8 creature decision in ORCHESTRATOR-LOG.md adds STAGGER and
 * REPOSITION, and both earn their place:
 *
 *   - **STAGGER** is the *contact beat* of a connected swing, not an
 *     alternative to one. §7.4 is explicit that a connected swing is a full
 *     removal and "not a stagger", so STAGGER can only be entered by a swing
 *     that lands inside `BANISH_RANGE`, and it can only leave for DORMANT. The
 *     1.6 s of recoil is the one thing a successful banish buys, and because
 *     STAGGER is not a capture state it is also 1.6 s in which the creature
 *     demonstrably cannot touch you.
 *   - **REPOSITION** is the search behaviour of §6.1 in a single state: the
 *     creature has worked out the street it was heading for and wants a new
 *     one. It asks the pathing layer for an origin (slice 07 supplies it), and
 *     it is the state that gives up — dropping back to a wander — if the meter
 *     falls out of the investigate band.
 *
 * TELEGRAPH is the other half of §8.1 and the reason Act I is shippable: it
 * cannot perceive, cannot be banished and cannot capture. Being physically
 * unable to catch you is what stops the pre-hammer phase being an unwinnable
 * state, so the no-capture rule is a state-machine property rather than a
 * branch somewhere in the world.
 *
 * THE INTEGRATION WINDOW
 * ----------------------
 * Sound arrives as *events*, not as a per-frame dose, because a footstep is a
 * footstep. `SOUND_EVENT_SECONDS` is the window a continuous source (an open
 * shutdown, held past the noise threshold) is integrated over, so the caller
 * emits one event per window rather than one per frame — otherwise "loud" would
 * mean "more dose" instead of "further away", and every constant in the table
 * would be measured in frames instead of metres.
 */

import {
  breathSoundRadius,
  EXHAUSTED_BREATH_SOUND_BONUS,
  PORTAL_SOUND_RADIUS,
} from './rules.js'
// slice 07. The pathing layer is the street graph, and the placement rules pick
// deterministically out of it — so both come from the same two modules the rest
// of v2 is built on rather than from a private copy of either. `neighborhood.js`
// does not import this file, so there is no cycle.
import {
  BLOCK,
  INTERSECTIONS,
  STREET_ADJ,
  WORLD_EXTENT,
  canonicalCoord,
  streetDistanceMap,
  streetNodeToWorld,
  wrap,
} from './neighborhood.js'
// ITERATION 2, PASS 11. `flickerAt` joins `hash32` for the lamp the creature is
// standing under: the strobe is a function of the tick index, so the same tick
// asked for twice — once to build the frame, once to measure it — gives the same
// answer, which is the same property pass 7 needed the vending ballast to have.
import { flickerAt, hash32 } from './hash.js'

// ---------------------------------------------------------------------------
// the states (§6.1)
// ---------------------------------------------------------------------------

/**
 * Every state the creature can be in, in the order §6.1 introduces them.
 *
 * `enraged` is in the list because §6.1's diagram puts it there and §10.2
 * defines it; what it ignores (the banish ladder) is slice 07's business.
 */
export const CREATURE_STATES = Object.freeze([
  'dormant',
  'telegraph',
  'stalk',
  'reposition',
  'chase',
  'stagger',
  'enraged',
])

/**
 * States in which the creature perceives at all. Everywhere else the meter is
 * frozen or zeroed, which is the machine's way of saying "this state cannot
 * learn anything about the player".
 */
export const ACQUIRING_STATES = Object.freeze(['stalk', 'reposition', 'chase', 'enraged'])

/**
 * The only two states that can end the run.
 *
 * Capture is the *end of a chase*, so a creature that does not know where you
 * are cannot catch you — not a wandering `stalk`, not one still choosing where
 * to search in `reposition`, and above all not a `telegraph`. Without that rule
 * a stroll into a hunting creature would be an unearned death, and §8.1's
 * promise that Act I is safe would be a promise about one flag.
 */
export const CAPTURE_STATES = Object.freeze(['chase', 'enraged'])

/**
 * States a swing can land in. TELEGRAPH is absent because §6.1 says in so many
 * words that it cannot be banished: the hammer's whole design is that it is the
 * thing which ends Act I, so a banish available in Act I would be a hole in the
 * two-act structure rather than a feature.
 */
export const BANISHABLE_STATES = Object.freeze(['stalk', 'reposition', 'chase', 'enraged'])

/**
 * PURSUING_STATES — the states in which the creature *closes on the player*.
 *
 * §6.1 splits hunting into STALK, which "ranges around the last-heard point",
 * and CHASE, which "closes", and §10.2's ENRAGED is CHASE with the pressure
 * turned up and the safety valve removed. The distinction matters because it is
 * the difference between a creature that wanders and a creature that is behind
 * you, and because the world's walk is gated on this list: a state that can
 * *catch* the player (`CAPTURE_STATES`) and is absent here is a state the game
 * can end a run in without ever moving, which is exactly the bug this list
 * exists to make impossible. `verify.mjs` asserts the containment.
 *
 * Slice 13 added it. Until then the world walked the creature in STALK only, so
 * the whole of §10.2's premise — a 5.2 m/s thing behind you that only a 6.0 m/s
 * sprint beats — was true only on paper, and the climax was a walk to the car
 * with an omniscient statue behind you.
 */
export const PURSUING_STATES = Object.freeze(['chase', 'enraged'])

/**
 * pursuitTarget — the point the creature is walking toward, in metres.
 *
 * Three cases, in this order, and the first one is the finale:
 *
 *  - **ENRAGED walks at the player.** §10.2's permanent position knowledge is
 *    the whole of the state, so it must not be spent on a stale memory: a
 *    creature that enrages mid-hunt still holds the `lastHeard` point it had at
 *    the time, and walking to that point while knowing where the player actually
 *    is would be a creature that runs away from you at 5.2 m/s.
 *  - **otherwise it walks at its evidence** — the last thing it *heard*, then
 *    the last thing it *saw*, and only then the player. That ordering is §6.2's
 *    meter made geometric: a creature that has heard nothing and seen nothing
 *    wanders in a straight line toward where you are standing, which reads as a
 *    coincidence and is not one.
 *
 * @param {object} creature from `createCreature`
 * @param {{x:number,z:number}} player the player's canonical position
 */
export function pursuitTarget(creature, player) {
  if (!creature) return player ?? null
  if (creature.state === 'enraged' || creature.finale === true) return player ?? null
  return creature.lastHeard ?? creature.lastSeen ?? player ?? null
}

/**
 * TRANSITIONS — the machine, as data.
 *
 * Every row here is asserted by `verify.mjs`, and so is the reverse: no
 * transition the machine can actually make is missing from this table. A row
 * removed here is a rule quietly lost. Slice 07 added the one edge its numbers
 * required — `chase -> dormant`, the §8.2 phase-out — because §7.4's ladder and
 * §8.3's placement are magnitudes rather than states, and a magnitude cannot be
 * read off a transition table.
 */
export const TRANSITIONS = Object.freeze([
  Object.freeze({ from: 'telegraph', to: 'stalk', when: 'the hammer pickup tolls (§7.2)' }),
  Object.freeze({ from: 'telegraph', to: 'dormant', when: 'the sighting ends (§6.1: gone when you look back)' }),
  Object.freeze({ from: 'dormant', to: 'stalk', when: 're-emergence, once the awakening has tolled (§6.1, §7.2, §8.1, §8.3)' }),
  Object.freeze({ from: 'dormant', to: 'enraged', when: 'a banished ENRAGED re-emerges — §10.2 suspends the phase-out, not the banish' }),
  Object.freeze({ from: 'stalk', to: 'chase', when: 'awareness reaches 1.0 (§6.2)' }),
  Object.freeze({ from: 'stalk', to: 'reposition', when: 'the last-heard point is worked out (§6.1)' }),
  Object.freeze({ from: 'stalk', to: 'stagger', when: 'a connected swing (§7.4)' }),
  Object.freeze({ from: 'stalk', to: 'enraged', when: 'the third portal is shut (§6.1, §10.2)' }),
  Object.freeze({ from: 'reposition', to: 'stalk', when: 'the path layer offers a new search origin (slice 07)' }),
  Object.freeze({ from: 'reposition', to: 'chase', when: 'awareness reaches 1.0 while searching (§6.2)' }),
  Object.freeze({ from: 'reposition', to: 'stagger', when: 'a connected swing (§7.4)' }),
  Object.freeze({ from: 'reposition', to: 'enraged', when: 'the third portal is shut (§6.1, §10.2)' }),
  Object.freeze({ from: 'chase', to: 'stalk', when: 'the meter decays back out of a chase (§6.3)' }),
  Object.freeze({ from: 'chase', to: 'dormant', when: 'the chase clock passes CHASE_MAX_SECONDS (§8.2)' }),
  Object.freeze({ from: 'chase', to: 'stagger', when: 'a connected swing (§7.4)' }),
  Object.freeze({ from: 'chase', to: 'enraged', when: 'the third portal is shut (§6.1, §10.2)' }),
  Object.freeze({ from: 'stagger', to: 'dormant', when: 'the recoil ends, so the banish completes (§7.4)' }),
  Object.freeze({ from: 'enraged', to: 'stagger', when: 'a connected swing — the hammer still works in the finale (§10.2)' }),
])

// ---------------------------------------------------------------------------
// the sound table (§6.2)
// ---------------------------------------------------------------------------

/**
 * Sound events and their radii, metres: the §6.2 rows and nothing else. Their
 * ordering is load-bearing — at rest the hammer is loudest, a portal shutdown is
 * second, a sprint is third, a footstep is a whisper, and standing still is
 * silence. The portal radius is imported from `rules.js` rather than typed, so
 * §5.2's verb and §6.2's table cannot drift apart.
 */
export const SOUND_RADII = Object.freeze({
  walk: 9,
  sprint: 22,
  portal: PORTAL_SOUND_RADIUS,
  toll: 30,
})

/**
 * The integration window of one sound event, seconds. See the header: a
 * continuous source emits one event per window, not one per frame.
 */
export const SOUND_EVENT_SECONDS = 0.25

/**
 * How much louder, in fill rate, sound is than sight.
 *
 * §6.2 says "roughly four to five times"; 4.5 is the middle of that band and is
 * asserted to stay inside it. This single ratio is the whole reason the meter is
 * not a boolean: at equal strength a glimpse buys a fifth of what a footstep
 * does, so a creature looking at you across a lit driveway still has to be told
 * where you are before it commits.
 */
export const SOUND_TO_SIGHT_RATIO = 4.5

/**
 * Sight fills the meter at this rate per second at full strength — about 8.3 s
 * of unbroken, point-blank, unoccluded observation to reach a chase. Slow enough
 * that being looked at is not being caught.
 */
export const SIGHT_FILL_PER_SEC = 0.12

/** The sound rate, derived from the ratio so the two can never disagree. */
export const SOUND_FILL_PER_SEC = SOUND_TO_SIGHT_RATIO * SIGHT_FILL_PER_SEC

/**
 * Silence bleeds this much per second. ~3.3 s from the investigate threshold to
 * nothing, ~8 s from a full chase: long enough that sprinting away actually
 * breaks contact, short enough that hiding is not a place you can sit in.
 */
export const AWARENESS_DECAY_PER_SEC = 0.12

/** §6.2: below this the creature is unaware — no tracking, it wanders. */
export const AWARENESS_INVESTIGATE = 0.4

/** §6.2: at this the meter is full and the creature commits. */
export const AWARENESS_CHASE = 1.0

/**
 * …and it only lets go at this. The commit threshold and the release threshold
 * are deliberately different.
 *
 * A single hunt, written as "chase while the meter is at 1.0", lasts exactly one
 * footstep: the frame after a stride the meter decays by `AWARENESS_DECAY_PER_SEC
 * * dt`, which is below 1.0, so the creature drops back to STALK and re-commits
 * on the next stride — a state flicker sixteen times a second, at a tier-3
 * speed, in a game whose whole threat is that it does not stop.
 *
 * 0.8 is not an invented number: it is the ceiling of §6.2's investigate band
 * ("0.4 – 0.8 investigates"). The creature commits at 1.0 and only un-commits
 * once the evidence has decayed back out of a chase, which makes the pair a
 * 0.2-wide hysteresis band. The entry thresholds are still 0.4 and 1.0 — this is
 * the latch on the way out, and it is asserted in `verify.mjs` like everything
 * else here.
 */
export const AWARENESS_CHASE_RELEASE = 0.8

/** The three bands of §6.2, named. */
export const AWARENESS_LEVELS = Object.freeze(['unaware', 'investigate', 'chase'])

/** Clamp anything into `[0, 1]`, whatever the caller did. */
export function clampAwareness(value) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * awarenessLevel — which §6.2 band a meter value is in.
 *
 * `>=` at both thresholds, because both thresholds are *transitions*: the frame
 * that crosses 0.4 is already investigating, and the frame that reaches 1.0 is
 * already chasing.
 */
export function awarenessLevel(value) {
  if (value >= AWARENESS_CHASE) return 'chase'
  if (value >= AWARENESS_INVESTIGATE) return 'investigate'
  return 'unaware'
}

/**
 * soundRadius — the radius of a sound event, exhausted breathing included.
 *
 * §7.3's synthesis is applied through `rules.breathSoundRadius` rather than by
 * adding the +6 here, so exhaustion has exactly one definition in the codebase.
 * `'still'` is not a §6.2 row but the rule that makes the table work: a player
 * who has stopped moving emits nothing at all... unless they are out of breath,
 * in which case their breathing is a 6 m event. That is the intended sting of
 * §7.3 — to go genuinely silent you must stand still *and* recover, so the
 * meter punishes the state you are in when you get caught rather than the act
 * of running.
 *
 * @param {string} kind one of `SOUND_RADII`, or `'still'`
 * @param {{ exhausted?: boolean }} [options]
 * @returns {number} metres; 0 for a silent source or an unknown event
 */
export function soundRadius(kind, options = {}) {
  const exhausted = options.exhausted === true
  if (kind === 'walk' || kind === 'sprint') return breathSoundRadius(SOUND_RADII[kind], exhausted)
  if (kind === 'still') return exhausted ? EXHAUSTED_BREATH_SOUND_BONUS : 0
  return SOUND_RADII[kind] ?? 0
}

/**
 * soundStrength — how loud an event is at `distance`: full at the source, zero
 * at the edge of its radius, and nothing at all past it. One metre of radius is
 * one step of strength, so the table stays in metres all the way down.
 */
export function soundStrength(distance, radius) {
  if (!(radius > 0) || !(distance >= 0)) return 0
  const t = distance / radius
  return t >= 1 ? 0 : 1 - t
}

/**
 * sightStrength — §6.3's "occlusion-aware cone, tested against ... and fog
 * falloff".
 *
 * Two factors: the linear range term, and dusk. Fog makes the far end of the
 * range worth less than the near end, so 17 m of range at tier 1 is not the same
 * as 17 m of range with a clear head. The product decreases monotonically over
 * `[0, 1]` for any `SIGHT_FOG_FALLOFF` below 1 — which is asserted, because a
 * fog curve that made distant targets *more* visible would be a silent,
 * screenshot-invisible bug.
 */
export function sightStrength(distance, range) {
  if (!(distance >= 0) || !(range > 0)) return 0
  const t = Math.min(1, distance / range)
  return (1 - t) * (1 - SIGHT_FOG_FALLOFF * t)
}

/**
 * awarenessStep — one frame of §6.2.
 *
 * The contract, in order of precedence:
 *
 *  1. `immune` wins over everything. Act I passes it (§8.1) and the meter is
 *     pinned to 0: no sound registers, no sight registers, and no decay either.
 *  2. `alwaysKnows` pins it to 1 (§10.2: the enraged creature has permanent
 *     position knowledge).
 *  3. Sound **acquires**: every event inside its radius adds
 *     `SOUND_FILL_PER_SEC * SOUND_EVENT_SECONDS * strength`.
 *  4. Sight **confirms and holds**: being seen adds a trickle of fill and, more
 *     importantly, suspends the decay.
 *  5. Decay applies only on a frame with **no stimulus at all** — the literal
 *     reading of "fills from stimuli and decays when none arrive", and the
 *     reason silence works as a tactic.
 *  6. The result is clamped to `[0, 1]`, so neither one event nor a pile of them
 *     can overshoot a chase.
 *
 * @param {number} awareness current meter, 0..1
 * @param {number} dt seconds
 * @param {object} [frame]
 * @param {object[]} [frame.sounds] events this window: `{ kind, distance, exhausted, position }`
 * @param {boolean} [frame.seen] player inside the cone, unoccluded, in range
 * @param {number} [frame.sightDistance] metres to the player, when seen
 * @param {number} [frame.sightRange] tier detection range (§11.1)
 * @param {boolean} [frame.alwaysKnows] ENRAGED knowledge (§10.2)
 * @param {boolean} [frame.immune] Act I deafness (§8.1)
 * @returns {{ awareness: number, gained: number, decayed: number, heard: object[], seen: boolean, level: string }}
 */
export function awarenessStep(awareness, dt, frame = {}) {
  if (frame.immune === true) {
    return { awareness: 0, gained: 0, decayed: 0, heard: [], seen: false, level: 'unaware' }
  }
  const seen = frame.seen === true
  if (frame.alwaysKnows === true) {
    return { awareness: AWARENESS_CHASE, gained: 0, decayed: 0, heard: [], seen, level: 'chase' }
  }

  const heard = []
  let gained = 0
  for (const event of frame.sounds ?? []) {
    const radius = soundRadius(event.kind, event)
    if (!(radius > 0)) continue
    const distance = typeof event.distance === 'number' ? event.distance : 0
    const strength = soundStrength(distance, radius)
    if (!(strength > 0)) continue
    const step = SOUND_FILL_PER_SEC * SOUND_EVENT_SECONDS * strength
    gained += step
    heard.push({ kind: event.kind, distance, radius, strength, step, position: event.position ?? null })
  }
  if (seen) {
    gained += SIGHT_FILL_PER_SEC * sightStrength(frame.sightDistance ?? 0, frame.sightRange ?? SIGHT_RANGE) * dt
  }

  const stimulated = heard.length > 0 || seen
  const decayed = stimulated ? 0 : Math.min(clampAwareness(awareness), AWARENESS_DECAY_PER_SEC * dt)
  const next = clampAwareness(awareness + gained - decayed)
  return { awareness: next, gained, decayed, heard, seen, level: awarenessLevel(next) }
}

// ---------------------------------------------------------------------------
// sight (§6.3)
// ---------------------------------------------------------------------------

/**
 * Half of the creature's field of view, radians. The pass-8 decision in
 * ORCHESTRATOR-LOG.md puts the cone at ~70°, so 35° either side of the heading.
 */
export const SIGHT_HALF_ANGLE = (Math.PI * 70) / 360

/**
 * How much of the range end dusk eats. 0.6 means a target at the very edge of
 * vision counts for 40% of what it would in a clear head.
 */
export const SIGHT_FOG_FALLOFF = 0.6

/**
 * Default detection range, metres: the tier-0 row of §11.1. The per-tier table
 * itself is slice 07's `aggressionAt`; a caller that knows its tier passes the
 * number in explicitly.
 */
export const SIGHT_RANGE = 14

/**
 * Which footprints are allowed to occlude.
 *
 * §6.3 names house volumes and hedges, §3.5 promises houses "behind hedges or
 * fences, giving ... the sightline system something to occlude against", and
 * §3.6 splits fixtures into a colliding structural half and a non-colliding
 * decorative half. A car and a wheelie bin are not sight blockers at eye height,
 * so they are not in this list — but a caller can override per rect with
 * `occudes: true|false`, because a shed pressed against a gable really does
 * block.
 */
export const OCCLUDER_KINDS = Object.freeze(['house', 'garage', 'shed', 'hedge', 'fence'])

/** Does this rectangle break a sightline? */
export function isOccluder(rect) {
  if (!rect) return false
  if (typeof rect.occudes === 'boolean') return rect.occudes
  return OCCLUDER_KINDS.includes(rect.kind)
}

/**
 * forwardOf — the heading a yaw points at.
 *
 * Shape-for-shape `PlayerController.forward()` in `player.js` (yaw 0 faces -Z),
 * so the creature and the player agree about what "in front of me" means without
 * the view layer having to convert between them.
 */
export function forwardOf(yaw = 0) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) }
}

/** The yaw that would point `from` at `to`. */
export function yawBetween(from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z))
}

/** Metres between two XZ points. */
export function distanceBetween(a, b) {
  return Math.hypot(b.x - a.x, b.z - a.z)
}

/**
 * segmentHitsRect — does the segment `from -> to` touch an axis-aligned box?
 *
 * The slab method with `t` pre-clamped to `[0, 1]`, so a segment starting inside
 * a hedge counts as blocked. `rect` is `{ x, z, w, d }` centred on `(x, z)` —
 * the footprint shape the fixture pass already emits, so slice 09 can hand
 * `chunkFixtures` straight in.
 */
export function segmentHitsRect(from, to, rect) {
  const hx = Math.max(0, (rect.w ?? 0) / 2)
  const hz = Math.max(0, (rect.d ?? 0) / 2)
  const dx = to.x - from.x
  const dz = to.z - from.z
  let tMin = 0
  let tMax = 1
  const slabs = [
    [from.x, dx, rect.x, hx],
    [from.z, dz, rect.z, hz],
  ]
  for (const [origin, direction, centre, half] of slabs) {
    if (Math.abs(direction) < 1e-9) {
      // parallel to this slab: either it misses outright or it lies inside it
      if (origin < centre - half || origin > centre + half) return false
      continue
    }
    let near = (centre - half - origin) / direction
    let far = (centre + half - origin) / direction
    if (near > far) {
      const swap = near
      near = far
      far = swap
    }
    if (near > tMin) tMin = near
    if (far < tMax) tMax = far
    if (tMin > tMax) return false
  }
  return true
}

/**
 * lineOfSight — pure geometry: is the straight line between the two points
 * clear of every occluder?
 *
 * No range and no cone, because §8.3's re-emergence rule needs this half on its
 * own ("never in line of sight") and §6.3's cone needs it as a term.
 */
export function lineOfSight(from, to, occluders = []) {
  if (!from || !to) return false
  for (const rect of occluders) {
    if (!isOccluder(rect)) continue
    if (segmentHitsRect(from, to, rect)) return false
  }
  return true
}

/**
 * inSightCone — is the target inside the creature's field of view?
 *
 * A target at zero distance is always in the cone: it is standing on the
 * creature, and the cone question is moot.
 */
export function inSightCone(from, to, halfAngle = SIGHT_HALF_ANGLE) {
  if (!from || !to) return false
  const dx = to.x - from.x
  const dz = to.z - from.z
  const length = Math.hypot(dx, dz)
  if (length === 0) return true
  const facing = forwardOf(from.yaw ?? 0)
  const dot = (facing.x * dx + facing.z * dz) / length
  return dot >= Math.cos(halfAngle)
}

/**
 * canSee — the whole of §6.3 in one predicate: in range, inside the cone, and
 * not behind a house or a hedge.
 *
 * @param {{x:number,z:number,yaw?:number}} from the creature
 * @param {{x:number,z:number}} to the player
 * @param {{ range?: number, halfAngle?: number, occluders?: object[] }} [options]
 */
export function canSee(from, to, options = {}) {
  if (!from || !to) return false
  const range = options.range ?? SIGHT_RANGE
  if (range !== Infinity && !(distanceBetween(from, to) <= range)) return false
  if (!inSightCone(from, to, options.halfAngle ?? SIGHT_HALF_ANGLE)) return false
  return lineOfSight(from, to, options.occluders ?? [])
}

// ---------------------------------------------------------------------------
// street-graph pathing (§6.1, §8.3)
// ---------------------------------------------------------------------------

/**
 * PATHING IS BFS OVER 49 NODES, AND NOTHING ELSE
 * ---------------------------------------------
 * The creature does not path through the world the way the player walks it. It
 * paths on the intersection graph `neighborhood.js` already built and already
 * proved connected across the wrap seam in slice 02, and three things make that
 * the whole of the problem:
 *
 *  - **The graph *is* the street.** Every edge is one full `BLOCK` of
 *    carriageway, and slice 04's rule 1 keeps every fixture at least
 *    `STREET_HALF_WIDTH` clear of both centrelines, so a route is walkable by
 *    construction. Pathing therefore needs no obstacle avoidance, no occupancy
 *    grid, and no awareness of what is standing on the corner.
 *  - **49 nodes.** The largest query is an all-pairs table — 2401 shortest walks
 *    over 49 nodes — which is microseconds, so routes are computed on demand and
 *    never cached. There is no module state here for a test to perturb and no
 *    invalidation to get wrong.
 *  - **The torus lies about straight lines.** From `x = 200` to `x = -200` is
 *    48 m the short way round, not 400 m the long way, so a "beeline" in this
 *    world is usually a longer walk than the streets. `wrapDelta` is the single
 *    place the torus is consulted, and it is the whole reason §6.1's CHASE is
 *    a *route*: "direct approach" means the short way along the streets, which
 *    on a 7 x 7 grid is very often behind you.
 *
 * §6.1 gives STALK one instruction — "moves to the player's last-heard position
 * and ranges around it. It does not beeline" — and the same graph does the
 * ranging: the route ends at the node the stimulus was heard from, and
 * REPOSITION picks the *next* street to check rather than the one it has already
 * worked out.
 */

/** Metres of carriageway in one graph edge, and the width the graph assumes. */
export const STREET_EDGE_METRES = BLOCK

/**
 * wrapDelta — the shortest signed difference between two world coordinates on a
 * torus of `extent` metres, so "left" and "right" stay meaningful across the
 * seam. Exported because it is the only definition of proximity in a wrapping
 * world, and the re-emergence rule needs to know that a node 400 m east may be
 * 48 m west.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} [extent] wrap period; the world is 448 m
 * @returns {number} metres in `(-extent / 2, extent / 2]`
 */
export function wrapDelta(a, b, extent = WORLD_EXTENT) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  const half = extent / 2
  let delta = (a - b) % extent
  if (delta > half) delta -= extent
  else if (delta < -half) delta += extent
  return delta
}

/**
 * nearestIntersection — the street node closest to a world point, on the torus.
 *
 * Ties keep the lower node id, so the answer is a function of the point alone
 * and never of iteration order — the determinism property slice 01 established
 * for the generator, extended to the creature's own spatial queries.
 *
 * THE FOLD, AND WHY IT IS HERE
 * ---------------------------
 * The point arrives in *world* coordinates — the player's body never wraps — and
 * the node table is in canonical ones, and those two frames are a half-period
 * apart. Differencing them and folding the result (which is what this used to do)
 * folds the *frame offset* away along with the wrap, and the answer is then
 * silently three blocks out: the balance simulation in `verify-world.mjs` measured
 * `nearestIntersection` disagreeing with the node the player is actually standing
 * at for 8,395 of 8,208 sampled positions, and the creature spent every chase
 * walking toward a corner of the map three blocks from where the player was.
 *
 * So the point is folded into the canonical frame first, by `canonicalCoord`, and
 * only then compared. A caller that already holds a canonical point is unaffected:
 * folding moves it by whole periods, and a torus distance does not notice.
 *
 * @param {{x:number,z:number}|null} point
 * @returns {number} a node id
 */
export function nearestIntersection(point) {
  if (!point) return 0
  const x = Number.isFinite(point.x) ? canonicalCoord(point.x) : 0
  const z = Number.isFinite(point.z) ? canonicalCoord(point.z) : 0
  let best = 0
  let bestDistance = Infinity
  for (let id = 0; id < INTERSECTIONS; id += 1) {
    const node = streetNodeToWorld(id)
    const dx = wrapDelta(x, node.x)
    const dz = wrapDelta(z, node.z)
    const distance = dx * dx + dz * dz
    if (distance < bestDistance) {
      bestDistance = distance
      best = id
    }
  }
  return best
}

/**
 * nodeId — every pathing argument is either a node id or a point in the world.
 *
 * A point is snapped through `nearestIntersection`, which is what lets the world
 * hand the path layer a live player position without maintaining graph
 * membership of its own. A number is floored on the way in, because a fractional
 * id would index past the end of the adjacency table and turn one caller's typo
 * into an `undefined` lookup two frames later.
 *
 * @param {number|{x:number,z:number}} value
 * @returns {number} a node id in `[0, INTERSECTIONS)`
 */
export function nodeId(value) {
  if (typeof value === 'number') return wrap(Math.floor(value), INTERSECTIONS)
  return nearestIntersection(value)
}

/** Rebuild a route from a BFS parent table, target first. */
function walkBack(via, start, target) {
  const route = [target]
  let step = target
  while (step !== start) {
    step = via[step]
    route.unshift(step)
  }
  return route
}

/**
 * streetRoute — the shortest walk of intersections from one node to another.
 *
 * BFS on the 4-neighbour wrapped grid, so it is exactly §3.1's "every block has
 * four street approaches" and nothing more clever. Two properties matter to the
 * caller and are asserted in `verify.mjs`: the route is a connected walk (every
 * consecutive pair is a real edge) and it never revisits a node, so the creature
 * cannot be sent down the same street twice by a route that loops.
 *
 * @returns {number[]} node ids from `from` to `to` inclusive; `[]` if unreachable
 */
export function streetRoute(from, to) {
  const start = nodeId(from)
  const target = nodeId(to)
  if (start === target) return [start]
  const via = new Int32Array(INTERSECTIONS).fill(-1)
  const seen = new Uint8Array(INTERSECTIONS)
  seen[start] = 1
  const queue = [start]
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]
    for (const next of STREET_ADJ[current]) {
      if (seen[next]) continue
      seen[next] = 1
      via[next] = current
      if (next === target) return walkBack(via, start, next)
      queue.push(next)
    }
  }
  return []
}

/** The world positions along a node route, ready for the view layer. */
export function routePositions(route) {
  return (route ?? []).map((id) => streetNodeToWorld(id))
}

/**
 * nextHop — the one node to walk to next, or `null` when already there.
 *
 * This is the entire per-frame contract with the view layer: ask for the next
 * hop, walk it, repeat. And the property the loop's pacing rests on is that
 * each hop closes exactly one step of graph distance, so a creature following
 * `nextHop` toward a moving player always arrives, never oscillates between two
 * nodes, and never circles a block it has already searched.
 */
export function nextHop(from, to) {
  const route = streetRoute(from, to)
  return route.length > 1 ? route[1] : null
}

/** Shortest route length in intersections; 0 when already there, -1 if none. */
export function graphDistance(from, to) {
  const route = streetRoute(from, to)
  if (route.length === 0) return -1
  return route.length - 1
}

/**
 * graphMetres — the same distance in metres walked rather than in graph steps.
 *
 * Exact, not an estimate: every edge is one whole block of carriageway, which is
 * what lets §8.3's "minimum graph distance" be a floor the player can feel in
 * seconds rather than a diagram nobody can picture.
 */
export function graphMetres(from, to) {
  const hops = graphDistance(from, to)
  return hops < 0 ? -1 : hops * STREET_EDGE_METRES
}

/**
 * pickSalt — a deterministic 32-bit salt from a run seed and a counter, so a
 * placement is a function of `(seed, re-emergence count)` and nothing else.
 */
function pickSalt(seed = 0, count = 0) {
  const base = Number.isFinite(seed) ? seed : 0
  const steps = Number.isFinite(count) ? count : 0
  return hash32(base ^ Math.imul(steps, 0x9e3779b1), 0x5b1d, 0x2f1a)
}

/** The lowest-hash candidate — a pick that does not depend on list order. */
function pickByHash(pool, salt) {
  let best = pool[0]
  let bestKey = Infinity
  for (const id of pool) {
    const key = hash32(salt, id, 0)
    if (key < bestKey) {
      bestKey = key
      best = id
    }
  }
  return best
}

/**
 * searchOrigin — the next street REPOSITION checks (§6.1).
 *
 * "The creature has worked out the street it was heading for and wants a new one"
 * is two exclusions, not a search: the street it just walked out of, and the
 * first hop toward the last-heard point, because that is the street it has
 * finished working out. What remains is two or three alternatives, and which one
 * it checks is hashed — the *choice* is arbitrary on purpose, because §6.1's most
 * delicious failure mode is a sound-hunter arriving at the wrong street, and a
 * creature that always picked the same one would be a creature that is wrong in
 * a way the player can learn.
 *
 * @param {object} options
 * @param {number|{x:number,z:number}} options.from where it is standing
 * @param {number|{x:number,z:number}} [options.avoid] the last-heard node
 * @param {number|{x:number,z:number}} [options.previous] the node it arrived from
 * @param {number} [options.seed] run seed
 * @param {number} [options.count] search index, so repeated searches differ
 * @returns {{ id: number, from: number, position: {x:number,z:number}, hopsToTarget: number|null }}
 */
export function searchOrigin(options = {}) {
  const from = nodeId(options.from ?? { x: 0, z: 0 })
  const target = options.avoid == null ? null : nodeId(options.avoid)
  const previous = options.previous == null ? null : nodeId(options.previous)
  const salt = pickSalt(options.seed, options.count)
  const blocked = new Set()
  if (previous != null) blocked.add(previous)
  if (target != null) blocked.add(nextHop(from, target))
  let pool = STREET_ADJ[from].filter((id) => !blocked.has(id))
  if (pool.length === 0) pool = STREET_ADJ[from].filter((id) => id !== previous)
  if (pool.length === 0) pool = STREET_ADJ[from]
  const id = pickByHash(pool, salt)
  return { id, from, position: streetNodeToWorld(id), hopsToTarget: target == null ? null : graphDistance(id, target) }
}

/**
 * REEMERGE_MIN_GRAPH_DISTANCE — §8.3's floor, in graph steps.
 *
 * Two steps is the smallest distance that is *felt*: the closest a node two hops
 * away can lie is `BLOCK * sqrt(2)` = 90.5 m of open air diagonally, and the
 * common case is a straight 128 m walk down a street. That is 4.5x the longest
 * detection range §11.1 ever gives the creature before the finale (20 m) and
 * about 45 s of walking at a sprint, so a re-emergence is never a thing that
 * happens *at* you — it is a thing that happens somewhere, and the tension is in
 * the walk back.
 *
 * One step (64 m) would also clear every detection range, so the honest reading
 * is that this is a margin of safety rather than a balance lever. It is set at
 * two because one would occasionally place the creature on the next street
 * along: technically legal, and in practice a jump scare rather than a
 * re-emergence.
 */
export const REEMERGE_MIN_GRAPH_DISTANCE = 2

/**
 * reemergeNode — where the creature comes back (§6.1, §8.3).
 *
 * §8.3 is two promises: "at a minimum graph distance from the player, never in
 * line of sight." Both are applied as a cascade of filters, strongest first, and
 * the strongest set is always satisfiable:
 *
 *  1. **distance** — at least `REEMERGE_MIN_GRAPH_DISTANCE` from the player's own
 *     node, measured with the same BFS the routing uses;
 *  2. **line of sight** — §8.3's literal rule, tested against the real occluders
 *     (houses, garages, sheds, hedges, fences) rather than against a radius;
 *  3. **facing** — not inside the player's own sight cone.
 *
 * The order matters and the third filter is the load-bearing one. Down a straight
 * suburban street *nothing* occludes a sightline two blocks away, so "never in
 * line of sight" on its own is not universally satisfiable, and a rule that is
 * quietly dropped when it cannot be met is not a rule. The cone filter is
 * strictly stronger from the player's point of view — being in the cone is what
 * being able to look means — and on a wrapping 7 x 7 grid there is always
 * somewhere two blocks away and behind you. The result reports which filter
 * decided it, so a tuning pass that lowers the distance floor can see whether the
 * creature is still hiding or merely being polite.
 *
 * The choice among survivors is hashed from `(seed, reemergenceCount)`, so a
 * placement is reproducible, independent of the order candidates were tested in,
 * and different between successive re-emergences of the same run.
 *
 * @param {object} options
 * @param {{x:number,z:number,yaw?:number}} options.playerPosition the player
 * @param {object[]} [options.occluders] §6.3 occluder rectangles
 * @param {number} [options.seed] run seed
 * @param {number} [options.reemergenceCount] §11.2 pressure axis
 * @param {number} [options.minDistance] override for the distance floor
 * @returns {null | { id: number, position: {x:number,z:number}, hops: number,
 *   origin: number, sighted: boolean, faced: boolean, level: string }}
 */
export function reemergeNode(options = {}) {
  const player = options.playerPosition ?? options.player ?? null
  if (!player) return null
  const occluders = options.occluders ?? []
  // RESOLVED IN SLICE 15 — the canonical-vs-unfolded comparison, closed
  // -------------------------------------------------------------------
  // The `position` this returns is CANONICAL (`streetNodeToWorld`), and so are the
  // `occluders` `world.js` hands in. The `player`, though, is in world coordinates,
  // because the player never wraps and the world does — so the two directional
  // tests below used to compare a canonical point against an unfolded one across
  // §3.3's seam, which is the identical mistake `world.js`'s own sight tests made
  // until slice 14 fixed them there.
  //
  // The balance simulation is what found it, and it found it as a *rule* failure
  // rather than as a suspicious line: it measures §8.3 independently, on every
  // placement the world makes over hundreds of runs, by asking the module's own
  // `canSee` and `inSightCone` the same two questions in the frame the world itself
  // uses. Before the fold below, re-emergence landed inside the player's own view
  // cone and in clear line of sight, often enough to be visible in the report —
  // §8.3's promise, untrue in the one place it is the whole point.
  //
  // The fix is a fold and not a signature change: `canonicalCoord` is a pure
  // function of a world coordinate, so the player's own position goes into the
  // canonical frame here, inside the function that has to be right. `world.js` needs
  // no change, and neither does any caller that was already passing canonical
  // positions — folding a canonical point moves it by whole periods and nothing in
  // the cascade below notices a period. The *distance* filter was never affected,
  // because `nodeId` folds, which is exactly why this survived seven slices and
  // why `verify.mjs` could not see it: every spot it asks about is canonical.
  const folded = {
    x: canonicalCoord(player.x),
    z: canonicalCoord(player.z),
    yaw: player.yaw ?? 0,
  }
  const floor = options.minDistance ?? REEMERGE_MIN_GRAPH_DISTANCE
  const minDistance = Math.max(0, Math.floor(Number.isFinite(floor) ? floor : 0))
  const origin = nodeId(folded)
  const hops = streetDistanceMap(origin)
  const salt = pickSalt(options.seed, options.reemergenceCount)
  const facing = folded

  const far = []
  const hidden = []
  const unobserved = []
  for (let id = 0; id < INTERSECTIONS; id += 1) {
    if (hops[id] < minDistance) continue
    far.push(id)
    const position = streetNodeToWorld(id)
    if (!inSightCone(facing, position)) unobserved.push(id)
    if (lineOfSight(position, folded, occluders)) continue
    hidden.push(id)
  }

  let pool = hidden
  let level = 'sight'
  if (pool.length === 0) {
    pool = unobserved
    level = 'facing'
  }
  if (pool.length === 0) {
    // nothing clears the sight rules: §8.3's distance floor is the promise that
    // is always satisfiable, so it is the one that holds — and the result reports
    // the sight the placement could not avoid rather than hiding it
    pool = far.length > 0 ? far : [origin]
    level = 'distance'
  }
  // §8.3 is a *minimum* graph distance, and slice 15's balance simulation is what
  // turned that word back into a number. The cascade above answers "where may it
  // come back?" and this line answers "how far should it bother?": the nearest hop
  // band inside the pool that survived the cascade, not the whole pool. Picking
  // uniformly out of every node two hops away or further meant a typical
  // re-emergence at the far side of a 7x7 grid — ninety metres and most of a
  // minute of walking — so the hammer was swung roughly once a run, §7.4's ladder
  // moved about two rungs in five minutes, and §11.3's first trend had nothing to
  // measure because the creature was spending the game in transit.
  //
  // The band is hashed, not sorted: a placement still varies with the seed and the
  // re-emergence count, and the §8.3 promise is unchanged — still at least
  // REEMERGE_MIN_GRAPH_DISTANCE away, still out of sight, still out of the cone.
  const nearest = Math.min(...pool.map((id) => hops[id]))
  const band = pool.filter((id) => hops[id] === nearest)
  const id = pickByHash(band, salt)
  const position = streetNodeToWorld(id)
  return {
    id,
    position,
    hops: hops[id],
    origin,
    sighted: lineOfSight(position, folded, occluders),
    faced: inSightCone(facing, position),
    level,
  }
}

// ---------------------------------------------------------------------------
// the two ladders (§7.4, §11.1, §11.2, §11.3)
// ---------------------------------------------------------------------------

/**
 * THE TWO LADDERS ARE OPPOSED ON PURPOSE
 * -------------------------------------
 * §7.4: "Every banish is paid for by the other axis: the creature re-emerges
 * angrier (§11). The two ladders are opposed on purpose. You are buying time, and
 * the price is that the thing returns faster, sooner, and more aware."
 *
 * So the module owns two pure functions and refuses to fold them into one
 * "difficulty" number, because the tension between them *is* the design. The
 * progress axis (§11.1, portals shut) raises speed and detection range. The
 * pressure axis (§11.2, re-emergence count) raises speed and detection range too,
 * and shortens the wait. §7.4's table is the only thing in the game that makes it
 * easier, and it is a table of five numbers with a hard cap.
 *
 * The single most important structural rule: `banishDuration` is keyed on the
 * **run-long** banish counter, which §9.1 persists across a capture, while
 * `aggressionAt` is keyed on the re-emergence count, which §9.1 resets. So dying
 * walks the player back down the pressure axis and nowhere near the progress
 * one — which is exactly what "a capture should cost the player where they were,
 * never what they achieved" means in the only currency the creature has.
 */

/**
 * §7.4's table, seconds, indexed from banish 1. The last row is the cap and it
 * repeats forever: 8, 12, 16, 20, 24, 24, 24, ...
 */
export const BANISH_TABLE = Object.freeze([8, 12, 16, 20, 24])

/**
 * The cap, in seconds. §7.4: "The cap is deliberately low at 24 s, because a
 * run-long ladder plus the speed ramp would otherwise walk the game into
 * triviality." It is a *cap* and not just a last table row so that the reason is
 * legible in the code, and `verify.mjs` asserts the table ends on it.
 */
export const BANISH_DURATION_CAP = 24

/**
 * banishDuration — how long banish `banishNumber` of the run keeps the creature
 * off the field (§7.4).
 *
 * Monotonically non-decreasing, never above the cap, and a pure function of one
 * integer. A count that has not happened yet (0, or a negative number) returns
 * the first banish's window, because a caller holding `banishCount: 0` is asking
 * what its *first* swing will buy, not for a free removal.
 *
 * @param {number} banishNumber 1-based, run-long (§9.1 keeps it across a capture)
 * @returns {number} seconds
 */
export function banishDuration(banishNumber) {
  if (!Number.isFinite(banishNumber)) return BANISH_TABLE[0]
  const n = Math.max(1, Math.floor(banishNumber))
  return BANISH_TABLE[Math.min(n, BANISH_TABLE.length) - 1]
}

/**
 * banishWindow — how long *this* creature stays gone, given the state it is in.
 *
 * The finale is the one case the ladder does not apply to: §10.2 makes ENRAGED
 * ignore it, and a banish there is a short flat delay instead. Everything else
 * reads the run-long counter off the creature.
 *
 * A creature that phased out rather than being banished (§8.2) reads the §11.2
 * *re-emergence delay* instead, and that is a change slice 15 made with evidence
 * behind it. It used to read the first rung — "§8.2 names no window of its own" —
 * which quietly deleted half of §11.2: the whole re-emergence curve, the one the
 * pure `balanceTrend` reports as the pressure axis's return rate, was a number
 * nothing in the game ever read. The balance simulation's report printed the return
 * window the *world* was using next to the one the table claimed, and the two
 * disagreed from the first re-emergence onward. A chase that ran out of clock has
 * bought the player nothing, so it waits for the player's banish ladder, which is
 * the player's purchase; the creature's own impatience is the other number, and
 * §11.2 is explicit that it shortens every time it comes back.
 *
 * Nothing forces the world to wait either window out: §8.3's placement is what
 * makes an early return safe, and it is the placement, not this number, that §8.3
 * promises.
 *
 * @param {object} creature
 * @returns {number} seconds
 */
export function banishWindow(creature) {
  if (!creature) return BANISH_TABLE[0]
  if (creature.state === 'enraged' || creature.finale === true) return ENRAGED_REEMERGENCE_SECONDS
  if (creature.removal === 'phase-out') return reemergeDelay(creature.reemergenceCount)
  return banishDuration(creature.banishCount ?? 0)
}

/**
 * reemergeReady — has the removal run out yet?
 *
 * The world owns the clock (it already owns the reset timeline in §9.3); this
 * only owns the *number*, so the banish ladder has exactly one definition and the
 * timer cannot drift from it. The boundary is inclusive: a removal that has run
 * its full duration is over.
 *
 * @param {object} creature
 * @param {number} elapsed seconds since the banish completed
 */
export function reemergeReady(creature, elapsed) {
  if (!Number.isFinite(elapsed)) return false
  return elapsed >= banishWindow(creature)
}

/** Seconds left on the removal, floored at zero. */
export function banishRemainder(creature, elapsed) {
  if (!Number.isFinite(elapsed)) return banishWindow(creature)
  return Math.max(0, banishWindow(creature) - elapsed)
}

/**
 * RAMP_TABLE — §11.1, the progress axis, as data: portals shut -> speed, detection
 * range, behaviour. Row 3 is the finale (§10.2): ENRAGED, ∞ range, no phase-out.
 *
 * The table is data rather than a switch so that `verify.mjs` can assert the
 * design's own rows — a ramp that drifts by 0.2 m/s is invisible in a screenshot
 * and is the single most likely way this game quietly becomes unlosable.
 */
export const RAMP_TABLE = Object.freeze([
  Object.freeze({ portals: 0, speed: 2.2, sight: 14, behaviour: 'stalk only; TELEGRAPH until the hammer is taken' }),
  Object.freeze({ portals: 1, speed: 2.8, sight: 17, behaviour: 'short chases' }),
  Object.freeze({ portals: 2, speed: 3.4, sight: 20, behaviour: 'chained chases' }),
  Object.freeze({ portals: 3, speed: 5.2, sight: Infinity, behaviour: 'ENRAGED; always knows; no phase-out' }),
])

/** The row for a tier (portals shut), clamped into the table. */
export function rampAt(tier) {
  const n = Number.isFinite(tier) ? Math.max(0, Math.floor(tier)) : 0
  return RAMP_TABLE[Math.min(n, RAMP_TABLE.length - 1)]
}

/** The player's two gaits, m/s — `PlayerController`'s defaults in player.js. */
export const PLAYER_WALK_SPEED = 3.6
export const PLAYER_SPRINT_SPEED = 6.0

/**
 * SPEED_CEILING — the fastest the creature may ever move, m/s.
 *
 * It is §11.1's enraged speed, and it is a *ceiling* for §8.6's sake: "The world
 * cannot be exhausted. The map wraps, so no amount of running ends the run." If a
 * tuning pass ever pushed the pressure axis past the sprint, §8.6 stops being
 * true and the game becomes a thing the player can be trapped in — so the ramp is
 * clamped here rather than trusted, and `verify.mjs` asserts the ceiling sits
 * strictly under the player's sprint.
 */
export const SPEED_CEILING = RAMP_TABLE[RAMP_TABLE.length - 1].speed

/**
 * AGGRESSION_SPEED_STEP — m/s added per re-emergence (§11.2: "Each time the
 * creature comes back it is faster").
 *
 * SLICE 15: 0.25 -> 0.45, and the reason is the only number in the game that
 * decides whether Act II is a threat at all. §11.1's tiers top out at 3.4 m/s and
 * the player's walk is 3.6, so a player who keeps walking is *unlosable* by
 * arithmetic — and the balance simulation measured exactly that: across eight full
 * runs of a scripted player, zero captures, zero banishes, sixteen wins. The
 * creature could not reach anyone, so the hammer was never swung, so §7.4's ladder
 * never widened, so §11.3's first trend had nothing to measure.
 *
 * At 0.45 the pressure axis crosses the walk in three or four re-emergences and
 * never crosses the sprint: tier 2 is 4.75 m/s against a 6.0 sprint, tier 0 is 4.0.
 * That is the shape the design wants and could not previously express — the two
 * verbs become *necessary* (§6.2: "the thing you do to escape it is the loudest
 * thing you can do") — and it is still bounded by `SPEED_CEILING`, so §8.6's
 * "the world cannot be exhausted" holds.
 */
export const AGGRESSION_SPEED_STEP = 0.45

/**
 * AGGRESSION_SIGHT_STEP — metres of detection range per re-emergence. Sight is
 * the scarcer resource in §6.2 than speed is, because a footstep at 9 m is the
 * quietest event in the table.
 *
 * SLICE 15: 1.5 -> 2.0. With the speed step raised, the creature closes at all, and
 * a creature that closes from 20 m every time is a different game from one that
 * closes from 14; the simulation's report showed chases starting later and lasting
 * the full §8.2 window, which is a pressure valve opening rather than a threat. Two
 * metres is a quarter of a block per re-emergence, and after four re-emergences a
 * sprint heard at 22 m is acquired from a whole block further out than it was in
 * Act II.
 */
export const AGGRESSION_SIGHT_STEP = 2

/**
 * REEMERGE_DELAY_CEILING — seconds before the first re-emergence, and
 * REEMERGE_DELAY_FLOOR — the asymptote it approaches (§11.2: "its re-emergence
 * delay is shorter").
 *
 * The shape is a ceiling approached over a floor, so the delay is strictly
 * shorter at every re-emergence and never reaches zero. A linear decay to zero
 * would be strictly shorter too, and would put the creature back in the same
 * frame it was banished — which §8.3's placement rule exists precisely to
 * survive, and should not be asked to survive twice.
 */
export const REEMERGE_DELAY_CEILING = 6
export const REEMERGE_DELAY_FLOOR = 0.5

/** How fast the delay closes: delay(n) = floor + (ceiling - floor) / (1 + CURVE n). */
export const REEMERGE_DELAY_CURVE = 0.35

/**
 * ENRAGED_REEMERGENCE_SECONDS — §10.2's flat delay. The finale ignores the ladder
 * entirely, so a banish there buys a fixed 1.5 s and no more. This is the value
 * §16.3 lists as an open question ("Should the finale banish re-emergence be
 * 1.5 s or longer? | Tune against §11.3"), taken at its documented candidate and
 * flagged for the slice 15 tuning pass rather than left undefined.
 */
export const ENRAGED_REEMERGENCE_SECONDS = 1.5

/** The §11.2 re-emergence delay, seconds. Strictly decreasing in the count. */
export function reemergeDelay(reemergenceCount, options = {}) {
  if (options.enraged === true || options.flat === true) return ENRAGED_REEMERGENCE_SECONDS
  const raw = Number.isFinite(reemergenceCount) ? reemergenceCount : 0
  const n = Math.max(0, Math.floor(raw))
  return REEMERGE_DELAY_FLOOR + (REEMERGE_DELAY_CEILING - REEMERGE_DELAY_FLOOR) / (1 + REEMERGE_DELAY_CURVE * n)
}

/**
 * aggressionAt — §11.2, the pressure axis, as one pure function of the
 * re-emergence count.
 *
 * Every field is monotone in the count, and two of the three go the way §11.2
 * says they do: `speed` and `sight` strictly up, `delay` strictly down. Nothing
 * here is capped, deliberately — a cap on the raw ladder would stop it being a
 * ladder, and the ceiling the game actually needs (§8.6's sprint) is applied
 * once, in `creatureSpeed`, where it can be read.
 *
 * `threat` is the scalar §11.3's second trend is stated in: closing speed times
 * return rate, i.e. damage per unit of the player's own time. It is a product of
 * a strictly increasing and a strictly decreasing quantity, so it is strictly
 * increasing — which is what makes "damage per encounter → up" a fact about the
 * two tables rather than an opinion about them.
 *
 * @param {number} reemergenceCount how many times it has come back
 * @returns {{ count: number, speed: number, sight: number, delay: number, threat: number }}
 */
export function aggressionAt(reemergenceCount) {
  const raw = Number.isFinite(reemergenceCount) ? reemergenceCount : 0
  const count = Math.max(0, Math.floor(raw))
  const speed = count * AGGRESSION_SPEED_STEP
  const sight = count * AGGRESSION_SIGHT_STEP
  const delay = reemergeDelay(count)
  return { count, speed, sight, delay, threat: speed / delay }
}

/** Both axes at once: §11.1's tier speed plus §11.2's pressure bonus, capped. */
export function creatureSpeed(tier, reemergenceCount) {
  return Math.min(rampAt(tier).speed + aggressionAt(reemergenceCount).speed, SPEED_CEILING)
}

/** Both axes at once: §11.1's tier range plus §11.2's pressure bonus. */
export function detectionRange(tier, reemergenceCount) {
  const base = rampAt(tier).sight
  if (base === Infinity) return Infinity
  return base + aggressionAt(reemergenceCount).sight
}

// ---------------------------------------------------------------------------
// §11.3, the balance assertion, in pure form
// ---------------------------------------------------------------------------

/**
 * HUNT_SECONDS_PER_ENCOUNTER — how long one encounter puts the creature on the
 * field, and the only number in this section that is not a table row.
 *
 * An encounter is: heard, committed to, chased, and either connected with or
 * lost. Slice 06 measures the first two at roughly seven and a half seconds of
 * unbroken pursuit, and `STAGGER_SECONDS` is the last one and a half, so nine
 * seconds is the whole of it. The one constraint that matters is the bound
 * `verify.mjs` asserts: an encounter must fit *inside* one chase window, or the
 * §8.2 phase-out would end every encounter before the player could answer it.
 */
export const HUNT_SECONDS_PER_ENCOUNTER = 9

/**
 * encounterCycleSeconds — the player's time per encounter: the hunt, then the
 * removal (§7.4). Strictly increasing in the banish number, which is the whole
 * mechanism of §7.4 made arithmetic.
 */
export function encounterCycleSeconds(huntSeconds, banishNumber) {
  const hunt = Number.isFinite(huntSeconds) ? huntSeconds : HUNT_SECONDS_PER_ENCOUNTER
  return hunt + banishDuration(banishNumber)
}

/**
 * onFieldShare — §11.3's first quantity, and the reason the banish ladder is
 * worth anything.
 *
 * "Expected seconds of creature-on-field per encounter → decreasing (because the
 * banish window widens)". The quantity has to be a *share* of the cycle rather
 * than raw on-field seconds, because a longer banish is not on-field time and
 * cannot lower it: the hunt is as long as the hunt is. What the banish lowers is
 * the fraction of the player's own seconds spent with the creature in the world,
 * and that is the number the design is about.
 *
 * Non-increasing rather than strictly decreasing, and the cap is the reason: 24 s
 * to 24 s is the same exposure, twice. The strict decrease lives before the cap.
 */
export function onFieldShare(huntSeconds, banishNumber) {
  const hunt = Number.isFinite(huntSeconds) ? huntSeconds : HUNT_SECONDS_PER_ENCOUNTER
  if (!(hunt > 0)) return 0
  return hunt / encounterCycleSeconds(hunt, banishNumber)
}

/** §11.3's second quantity, read straight off the pressure axis. */
export function threatPerEncounter(reemergenceCount) {
  return aggressionAt(reemergenceCount).threat
}

/**
 * balanceTrend — both §11.3 trends sampled across a run, as data.
 *
 * The canonical run is the worst case for the design's argument: every encounter
 * ends in a connected swing, so encounter `n` is also banish `n`, and the creature
 * has re-emerged `n - 1` times. That makes the two ladders move in opposite
 * directions on the same axis, which is the only way to see the trade at all.
 *
 * Slice 07 asserts the *directions* of both trends here, in node, with no
 * renderer. Slice 15 replaces the arithmetic with a real encounter simulation;
 * this stays, because a trend proved from the tables is cheap to re-check on every
 * commit and the simulation is not.
 *
 * @param {number} [encounters] how far into the run to sample
 */
export function balanceTrend(encounters = 6) {
  const count = Math.max(1, Math.floor(Number.isFinite(encounters) ? encounters : 6))
  const samples = []
  for (let encounter = 1; encounter <= count; encounter += 1) {
    const banishes = encounter
    const reemergences = encounter - 1
    const aggression = aggressionAt(reemergences)
    samples.push({
      encounter,
      banishes,
      reemergences,
      banishSeconds: banishDuration(banishes),
      onField: onFieldShare(HUNT_SECONDS_PER_ENCOUNTER, banishes),
      cycle: encounterCycleSeconds(HUNT_SECONDS_PER_ENCOUNTER, banishes),
      reemergeDelay: aggression.delay,
      threat: aggression.threat,
    })
  }
  return samples
}

// ---------------------------------------------------------------------------
// the state machine (§6.1, §7.4, §8.1)
// ---------------------------------------------------------------------------

/** Contact distance for a capture, metres. */
export const CAPTURE_RADIUS = 1.1

/**
 * A swing that lands inside this is a banish (§7.4). Beyond it the hammer simply
 * misses, and the only consequence is the toll.
 */
export const BANISH_RANGE = 2.6

/**
 * How long a connected swing throws the creature back before it is gone — §7.4's
 * full removal made physical. Also, by §6.1, the one stretch of a chase the
 * creature provably cannot touch you in.
 */
export const STAGGER_SECONDS = 1.6

/**
 * CHASE_MAX_SECONDS — §8.2, "a chase cannot last forever".
 *
 * "A CHASE exceeding CHASE_MAX_SECONDS (~12 s) makes the creature phase out and
 * return to DORMANT elsewhere. This is the single most important rule in the
 * section: it guarantees the player is never permanently cornered, and it is the
 * pressure valve that makes an otherwise-fatal AI shippable."
 *
 * Two things are load-bearing about *how* it fires. It is a clock, not a
 * distance, so a creature that is slower than the player cannot extend it by
 * being unlucky; and it fires at `>=`, not `>`, so the bound is the number
 * rather than the number plus a frame.
 *
 * It does not fire out of ENRAGED, which has no phase-out at all (§11.1's last
 * row, §10.2). The finale is the one part of the game where being cornered is
 * allowed to be lethal, because by then the player is sprinting away from a
 * 5.2 m/s creature with the exit in sight and the answer is the exit.
 *
 * SLICE 15 found the number next to it, and it was not this one. The first balance
 * run played eight full scripted runs against the literal rule — clock only, as
 * §8.2 is written — and the creature never came closer than 51 m in four
 * minutes: sixteen wins, no captures, no banishes. The reason is arithmetic rather
 * than rule-shaped, and it was two tables over. §11.1's tiers top out at 3.4 m/s
 * against a 3.6 m/s walk, and §8.2 puts the creature back 90 m away (§8.3) every
 * twelve seconds, so at the speed the ramp actually granted it could not cross
 * even one street in one window. A chase that cannot reach anybody is not a
 * pressure valve, it is a queue, and the fix belongs in `AGGRESSION_SPEED_STEP`
 * rather than here: the window is the design's and the design's is kept.
 *
 * What the player escapes a real chase with is §6.2's own rule: the meter has to
 * decay, and only silence decays it. Run and it follows; stand still and it loses
 * you. That is the skill the whole design is built on, and it is only reachable
 * once the creature can actually close.
 */
export const CHASE_MAX_SECONDS = 12

/**
 * States the §6.1 finale edge may fire from: every state that is actually
 * hunting. It cannot fire into or out of TELEGRAPH, DORMANT or STAGGER, so the
 * hammer's two-act structure survives the finale.
 */
export const ENRAGE_FROM = Object.freeze(['stalk', 'reposition', 'chase'])

/**
 * createCreature — Act I, exactly as the game starts it.
 *
 * `telegraph` is the opening state rather than `dormant`, because the first
 * sighting exists before you have the hammer and that is §6.1's whole point.
 * Tier lives here rather than arriving per frame so slice 07 can own the
 * aggression ladder without reshaping anything.
 *
 * @param {object} [options]
 * @param {string} [options.state] opening state
 * @param {number} [options.awareness] opening meter
 * @param {number} [options.tier] portals shut (§11.1)
 * @param {number} [options.reemergenceCount] the §11.2 pressure axis
 * @param {number} [options.banishCount] run-long §7.4 ladder position (§9.1 keeps it)
 * @param {boolean} [options.finale] the third portal is down (§10.2)
 * @param {number} [options.chaseSeconds] §8.2's clock, for restoring a chase
 * @param {number} [options.staggerSeconds] §7.4's recoil, for restoring one
 */
export function createCreature(options = {}) {
  return {
    state: options.state ?? 'telegraph',
    awareness: clampAwareness(options.awareness ?? 0),
    tier: options.tier ?? 0,
    reemergenceCount: options.reemergenceCount ?? 0,
    /**
     * §7.4's ladder position, run-long. It lives on the creature because §7.4's
     * window is how long *this* creature is gone, and `banishWindow` reads it
     * with no other argument. `rules.js` keeps a mirror of it for the §9.1
     * persistence table, and `verify.mjs` asserts the two never disagree.
     */
    banishCount: options.banishCount ?? 0,
    finale: options.finale === true,
    /** §6.1: STALK commits to the last-heard position and ranges around it. */
    lastHeard: null,
    lastSeen: null,
    /** §6.1 TELEGRAPH ---(hammer pickup toll)---> STALK. */
    hammerToll: false,
    /** Counts only while chasing, and is compared to CHASE_MAX_SECONDS (§8.2). */
    chaseSeconds: Math.max(0, options.chaseSeconds ?? 0),
    staggerSeconds: Math.max(0, options.staggerSeconds ?? 0),
    banishPending: false,
    /**
     * §7.2: the awakening has tolled, so this thing is a hunter and not an
     * apparition. It is a *state* rather than a frame on purpose — §8.1's promise
     * that Act I cannot kill you has to be a property of the machine, and a
     * one-frame flag is not a property a test can hold on to.
     */
    awakened: options.awakened === true,
    /** The closest it has got this chase, for §8.2's "is it still winning" test. */
    chaseClosest: options.chaseClosest ?? Infinity,
    /**
     * How it left the field: §7.4's `banish` (the player paid for it) or §8.2's
     * `phase-out` (it gave up). `banishWindow` reads it, so the two removal windows
     * cannot be confused — which is how §11.2's return curve got wired to the world
     * in slice 15 without touching the banish ladder the player bought.
     */
    removal: options.removal ?? null,
  }
}

/**
 * canCapture — can this state, at this distance, end the run?
 *
 * The §8.1 guarantee in one function, and the reason it takes a *state* and not
 * a flag: TELEGRAPH is absent from `CAPTURE_STATES`, so Act I cannot kill you
 * however close it gets, however loud you are, and however many frames the game
 * runs. STAGGER is absent too, which is the 1.6 s of relief a connected banish
 * buys.
 *
 * @param {object|string} creature a creature state or the state name
 * @param {number} distance metres to the player
 * @param {number} [radius] override for `CAPTURE_RADIUS`
 */
export function canCapture(creature, distance, radius = CAPTURE_RADIUS) {
  const state = typeof creature === 'string' ? creature : creature?.state
  if (!CAPTURE_STATES.includes(state)) return false
  if (!Number.isFinite(distance)) return false
  return distance <= radius
}

/**
 * resolveSwing — what one LMB does to the creature standing `distance` away.
 *
 * The outcomes are exhaustive because there is no fourth: a miss (too far), a
 * banish (inside `BANISH_RANGE`, §7.4), or immunity in Act I (§6.1: TELEGRAPH
 * cannot be banished at all). `flat` marks the §10.2 case, where the ladder is
 * ignored and re-emergence is a short flat delay — `ENRAGED_REEMERGENCE_SECONDS`
 * rather than a row of §7.4's table.
 *
 * @returns {{ result: 'immune'|'miss'|'banish', distance: number, flat: boolean }}
 */
export function resolveSwing(state, distance) {
  if (!BANISHABLE_STATES.includes(state)) return { result: 'immune', distance, flat: false }
  if (!Number.isFinite(distance) || distance > BANISH_RANGE) return { result: 'miss', distance, flat: false }
  return { result: 'banish', distance, flat: state === 'enraged' }
}

/**
 * creatureStep — one frame of §6.1, for every state.
 *
 * The frame is data, never an object with behaviour, so the world owns the clock
 * and this module owns the rules. The order below is the order the design tells
 * them in:
 *
 *  1. the meter, unless this state cannot perceive at all (§6.1, §8.1);
 *  2. this state's own exit condition, including the §8.2 chase phase-out;
 *  3. the §6.1 finale edge, if the third portal is down;
 *  4. the hammer, if a swing was thrown (§7.4) — a banish advances the ladder;
 *  5. the capture test, and only ever from a state that is closing on you.
 *
 * @param {object} creature from `createCreature`
 * @param {number} dt seconds
 * @param {object} [frame]
 * @param {object[]} [frame.sounds] sound events this window (§6.2)
 * @param {boolean} [frame.seen] player visible to the creature right now
 * @param {number} [frame.sightDistance] metres to the player, when seen
 * @param {number} [frame.sightRange] tier detection range (§11.1)
 * @param {{x:number,z:number}} [frame.playerPosition] recorded on `lastSeen`
 * @param {number} [frame.distance] metres to the player, for capture and swings
 * @param {boolean} [frame.hammerPickup] the awakening toll (§7.2)
 * @param {boolean} [frame.swing] LMB this frame (§7.4)
 * @param {boolean} [frame.finale] the third portal is shut (§6.1, §10.2)
 * @param {boolean} [frame.sighting] a TELEGRAPH apparition is on screen
 * @param {boolean} [frame.reemerge] the removal ran out and it is coming back (§8.3)
 * @param {boolean} [frame.searchExhausted] the path layer worked out the last-heard street
 * @param {{x:number,z:number}} [frame.searchPosition] a new search origin
 */
export function creatureStep(creature, dt, frame = {}) {
  const from = creature.state
  let state = from
  let awareness = creature.awareness
  let seen = from === 'telegraph' ? false : frame.seen === true
  let heard = []
  let lastHeard = creature.lastHeard
  let lastSeen = creature.lastSeen
  let chaseSeconds = creature.chaseSeconds ?? 0
  let staggerSeconds = creature.staggerSeconds ?? 0
  let banishPending = creature.banishPending === true
  let removal = creature.removal ?? null
  let awakened = creature.awakened === true
  let chaseClosest = creature.chaseClosest ?? Infinity
  let reemergenceCount = creature.reemergenceCount ?? 0
  let banishCount = creature.banishCount ?? 0
  let hammerToll = creature.hammerToll === true
  let phaseOut = false
  let swing = null
  // §10.2: the finale is a flag on the run, so it may arrive per frame rather than
  // having been carried in at construction — and it is read *here*, above the
  // state machine, because the re-emergence edge below has to be able to ask
  // whether it is in the finale. A per-frame flag that only the frame that sets it
  // can see is not a flag; it is an event, and §10.2's "banish still works" does
  // not survive being an event.
  const finale = creature.finale === true || frame.finale === true

  // 1. the meter. TELEGRAPH and DORMANT cannot perceive at all, STAGGER is
  //    reeling and holds what it had, and only the hunting states integrate.
  if (ACQUIRING_STATES.includes(from)) {
    const step = awarenessStep(awareness, dt, {
      sounds: frame.sounds,
      seen,
      sightDistance: frame.sightDistance,
      sightRange: frame.sightRange,
      alwaysKnows: from === 'enraged',
    })
    awareness = step.awareness
    heard = step.heard
    for (const event of heard) {
      if (event.position) lastHeard = { x: event.position.x, z: event.position.z }
    }
    if (seen && frame.playerPosition) lastSeen = { x: frame.playerPosition.x, z: frame.playerPosition.z }
  } else if (from === 'telegraph' || from === 'dormant') {
    awareness = 0
    seen = false
  }

  // 2. this state's own exit condition.
  if (from === 'telegraph') {
    // §7.2: the pickup toll is the awakening, and it is the only thing that is.
    if (frame.hammerPickup === true) {
      state = 'stalk'
      hammerToll = true
    } else if (frame.sighting === false) {
      state = 'dormant'
    }
  } else if (from === 'dormant') {
    // §8.1, and the re-emergence edge is where it was broken: a creature that has
    // been dismissed as an apparition comes back as a *stalker*, and a stalker hunts,
    // and a hunter captures. The balance simulation's Act I scenario found it in
    // thirty seconds — the reckless player, who runs at the thing, was caught
    // before the hammer in three seeds out of eight, sixteen times in one of them,
    // in a phase the design says cannot kill you. The awakening is a state, not a
    // frame: §7.2's toll is the one thing that turns a sighting into a hunt, and
    // until it has tolled there is nothing to come back *as*.
    //
    // And it comes back as what it *was*. `enraged` for the finale, because §10.2's
    // "no phase-out" is a property of the creature and not of the single state the
    // valve happened to be implemented in. The world offers `reemerge: true` exactly
    // once, on the frame the banish window closes, and never again — so a banished
    // ENRAGED went DORMANT, never came back, and the simulation's finale was a
    // creature that sat in the dark for a minute and a half and let the player walk
    // to the car. §10.2's "banish still works ... the hammer must stay relevant" is
    // worth nothing at all if the swing ends the pursuit for good.
    if (frame.reemerge === true && (awakened || finale)) {
      // §11.2 counts it either way — it came back, so it is one step further up
      // the pressure axis — and §8.3 holds in both branches: it comes back at a
      // distance and out of sight, so it comes back knowing nothing, and whatever it
      // had worked out went with the removal.
      reemergenceCount += 1
      if (finale) {
        // §10.2 outranks the awakening: in the finale the thing is ENRAGED whether
        // or not it was ever an apparition, and a banish buys the flat delay and
        // nothing else — the ladder, the phase-out and the search are all suspended.
        state = 'enraged'
        awareness = AWARENESS_CHASE
      } else {
        state = 'stalk'
      }
      lastHeard = null
      lastSeen = null
    }
  } else if (from === 'stagger') {
    staggerSeconds = Math.max(0, staggerSeconds - dt)
    if (staggerSeconds === 0) {
      // the banish completes: it is off the field, and whatever it knew goes
      // with it (§7.4 — a removal, not a stagger, so the meter is moot). The
      // positions go too: a creature that walks back into the world already
      // holding the player's last known position is a wallhack, and §7.4's
      // "full removal" is the only description of the event that permits one.
      state = 'dormant'
      awareness = 0
      lastHeard = null
      lastSeen = null
      banishPending = false
    }
  } else if (from === 'reposition') {
    if (awareness >= AWARENESS_CHASE) {
      state = 'chase'
      chaseClosest = Infinity
    } else if (frame.searchPosition) {
      state = 'stalk'
      lastHeard = { x: frame.searchPosition.x, z: frame.searchPosition.z }
    } else if (awareness < AWARENESS_INVESTIGATE) {
      state = 'stalk'
      lastHeard = null
    }
  } else if (from === 'stalk') {
    if (awareness >= AWARENESS_CHASE) {
      state = 'chase'
      chaseClosest = Infinity
    } else if (frame.searchExhausted === true) state = 'reposition'
  } else if (from === 'chase') {
    chaseSeconds += dt
    const gap = frame.distance ?? Infinity
    if (gap < chaseClosest) chaseClosest = gap
    if (awareness < AWARENESS_CHASE_RELEASE) state = 'stalk'
    else if (chaseSeconds >= CHASE_MAX_SECONDS) {
      // §8.2: the pressure valve. The creature gives the chase up and is gone
      // from the field entirely — same place a completed banish puts it, and for
      // the same reason: the next time it exists it exists somewhere else, at a
      // distance (§8.3), knowing nothing. It earns nothing from this: unlike a
      // connected swing, a chase that ran out of clock does not advance the
      // §7.4 ladder, or the valve would be a reward for being cornered.
      //
      // There is deliberately nothing else in here. §8.3 already hands the
      // creature a fresh position, and adding a distance or a "losing ground"
      // clause to the valve — slice 15 tried both — gives §8.2 a fourth release
      // on top of the §6.3 meter decay and the §7.4 removal, and the first one
      // to arrive wins the chase before the player has done the thing the design
      // says releases it: standing still and letting the meter bleed. Silence is
      // the skill. A valve that fires because the player got twenty metres of road
      // between them is not a skill, it is a refund.
      state = 'dormant'
      awareness = 0
      lastHeard = null
      lastSeen = null
      banishPending = false
      phaseOut = true
      removal = 'phase-out'
    }
  }

  // 2b. §7.2's awakening, wherever the creature happens to be. The pickup tolls the
  //     bell and the bell is what wakes it, and the sighting it may or may not still
  //     be showing is not part of that: an Act I apparition is dismissed the moment
  //     the player looks away, so a creature that only woke from `telegraph` was
  //     asleep for the whole of Act II whenever the player had glanced sideways while
  //     picking the hammer up. The balance simulation found it as an Act II with no
  //     encounters in it at all, which is the emptiest possible reading of §8.1.
  if (frame.hammerPickup === true) awakened = true

  // 3. the finale edge of §6.1. The promotion carries §10.2's permanent position
  //    knowledge with it on this frame, not on the next one: without the second
  //    line the creature is ENRAGED for one frame with whatever meter it had.
  if (frame.finale === true && ENRAGE_FROM.includes(state)) {
    state = 'enraged'
    awareness = AWARENESS_CHASE
  }

  // 4. the hammer (§7.4). A connected swing is a *full removal*, and the run-long
  //    ladder advances on it — the one place `banishCount` moves, because §7.4's
  //    window is the banish counter read as a duration.
  if (frame.swing === true) {
    swing = resolveSwing(state, frame.distance)
    if (swing.result === 'banish') {
      state = 'stagger'
      staggerSeconds = STAGGER_SECONDS
      banishPending = true
      banishCount += 1
      removal = 'banish'
    }
  }

  // 5. the capture test. It runs after the swing, so a hammer that connects on the
  //    frame it would have caught you saves you — 1.6 s of it, and §6.1's promise
  //    that STAGGER cannot touch you is a property of the state list, not of luck.
  const captured = canCapture({ state }, frame.distance)
  // the chase clock runs only while chasing, and the phase-out frame reports the
  // value it reached rather than the zero it is about to become
  const chaseElapsed = from === 'chase' ? chaseSeconds : 0
  if (state !== 'chase') chaseSeconds = 0
  return {
    creature: {
      ...creature,
      state,
      awareness,
      tier: creature.tier ?? 0,
      reemergenceCount,
      banishCount,
      finale,
      hammerToll,
      lastHeard,
      lastSeen,
      chaseSeconds,
      staggerSeconds,
      banishPending,
      removal,
      chaseClosest,
      awakened,
    },
    from,
    to: state,
    changed: state !== from,
    awareness,
    level: awarenessLevel(awareness),
    heard,
    seen,
    swing,
    captured,
    /** §8.2: this frame ended a chase on the clock rather than on the meter. */
    phaseOut,
    /** The chase clock as it stood when this frame's decision was taken. */
    chaseSeconds: chaseElapsed,
    /**
     * How long the creature is now off the field, §7.4 for a banish and §10.2's
     * flat delay for the finale; 0 when it is not being removed at all. The world
     * runs the clock (`reemergeReady`), this is the number it runs it against.
     */
    banishSeconds:
      state === 'dormant' || state === 'stagger' ? banishWindow({ state, banishCount, finale }) : 0,
  }
}


// ---------------------------------------------------------------------------
// presentation (§6.1, §12.1) — what each state LOOKS like
// ---------------------------------------------------------------------------
//
// WHY THE POLICY IS HERE AND THE GEOMETRY IS NOT
// -----------------------------------------------
// The design splits the world into a pure half and a Three.js half (§15.1) and
// `verify.mjs` may only import the first — the V2-PLAN's own ground rule, and the
// reason an entire hunting AI is provable in node. A per-state *presentation*
// rule is exactly the kind of thing that needs proving ("CHASE is the full form",
// "the eyes still read at §8.3's minimum distance") and exactly the kind of thing
// that decays into art direction when nothing can see it. So the split inside the
// slice follows the same line: the numbers are pure and live here, the meshes are
// not and live in `creatureView.js`, which reads this table and does nothing else
// but apply it.

/** Clamp to [0, 1], treating a non-number as the low end rather than a NaN hole. */
function clampUnit(value) {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * CREATURE_SHAPE — the silhouette, in metres, and the only geometry numbers
 * anywhere in the project. `creatureView.js` builds from this and nothing else,
 * so "procedural geometry only" is checkable: there is no second copy of a height
 * to drift.
 *
 * The proportions are the art direction and they are load-bearing twice over.
 *
 * **It is thin.** A 2.80 m figure on a 0.40 m shoulder is 7:1 — twice as thin as
 * a person, because a person-shaped thing at 90 m in fog is a smudge and the
 * entire point of §6.1's apparition is that you notice it. Thin is legible; bulky
 * is not.
 *
 * **It clears the frontage.** The height is set against the two things it will
 * always be seen against, both from `streetView.js`: the hedges and fences are
 * 1.1–1.3 m and the house walls are 5.2 m. At 2.80 m the figure is a little over
 * twice the frontage, and that is the whole legibility argument — the street
 * corridor is empty vertical space between a 1.3 m hedge and a 7.1 m roofline, and
 * a dark thin thing standing in it is the only shape in the frame that is neither
 * ground nor sky. It does not need to clear the roofs. Nothing human-proportioned
 * does, and trying would turn a horror silhouette into a landmark.
 */
export const CREATURE_SHAPE = Object.freeze({
  /** Crown height, and the aspect-ratio numerator (§12.1's silhouette). */
  height: 2.8,
  /** Shoulder span — the aspect-ratio denominator, and the "thin" in the brief. */
  shoulder: 0.4,
  /** Hip span, where the legs hang from. */
  hip: 0.24,
  /** Floor to hip, and hip to shoulder; the two add to the shoulder line. */
  legLength: 1.24,
  torsoLength: 1.08,
  /** Shoulder joint height, `legLength + torsoLength`. */
  armRoot: 2.32,
  armLength: 1.36,
  // ITERATION 2, PASS 10 — LIMB ARTICULATION. BEFORE: `armLength` was one number
  // and one number bought one rigid stick, so the arm swung from the shoulder as a
  // single segment and the whole limb *slid* rather than articulated. The split is
  // the shoulder-to-elbow bone and the elbow-to-claw bone, and it is a SPLIT rather
  // than two new numbers so that the claw still hangs at exactly `armLength`: the
  // tip of the arm is where it was, which is the one measurement of this rig the
  // §12.1 silhouette check can make from `CREATURE_SHAPE` alone, and a pass that
  // moved it would have to re-justify 7:1.
  //
  // 0.74 / 0.62 is a 54/46 split, which is the proportion a human arm breaks at and
  // the proportion that makes an elbow read as an elbow: equal bones read as a
  // hinge, a long upper bone reads as a wing. `verify.mjs` asserts the sum rather
  // than either number, so a retune of the split cannot quietly lengthen the arm.
  armUpper: 0.74,
  armFore: 0.62,
  neckLength: 0.14,
  headRadius: 0.15,
  headCentre: 2.65,
  /** The eyes sit a little above the head's centre, which is what reads as a face. */
  eyeHeight: 2.68,
  eyeSpread: 0.08,
  eyeRadius: 0.035,
})

/**
 * CREATURE_PRESENTATION — §6.1's five states as numbers.
 *
 * One row per state, and the rows are chosen so that the *difference* between two
 * states is legible at a glance, because that is the entire job of a silhouette
 * you can only see for a second at a time in fog. The brief's five names map onto
 * the columns like this:
 *
 * | State | The tell | Columns that carry it |
 * | --- | --- | --- |
 * | `telegraph` | a far-appearance flicker | `flicker`, and the lowest `presence` |
 * | `stalk` | edge-of-vision positioning | `edge`, plus `sway` and `scan` |
 * | `chase` | the full form | the highest `scale`/`presence` with a hard `lean` |
 * | `stagger` | a recoil reaction | `recoil`, read off the §7.4 recoil clock |
 * | `enraged` | reddened | `redden` |
 *
 * `edge` is a named column rather than a test on `sway`, and the reason is a bug
 * this table already had once: gating the §6.1 edge-of-vision angle on "does this
 * state sway at all" also caught `chase`, which sways 0.05, and a chase presented
 * 42° off the bearing to the player is a chase that appears not to be coming at
 * them. The two properties are different — `sway` is the idle drift, `edge` is
 * *where in the frame the thing stands* — and only the ranging states set the
 * second.
 *
 * `sway` AND `stride` — PASS 10, and one of them is a repair.
 *
 * BEFORE this pass `sway` was documented right here as "the gait" and was read by
 * NOTHING: the view hard-coded one swing amplitude (0.5 on the legs, 0.7 on the
 * arms) and applied it to every state, so a stalking thing and a hunting thing had
 * identical limbs and a telegraph's arms flailed at chase amplitude. `verify.mjs`
 * asserted the column was ordered and the column never reached the screen, which
 * is the pass-9 review's finding in its purest form: a number that is logged is
 * not a gate.
 *
 * AFTER, the two columns are two different motions and both are read:
 *
 *  - `sway` is the **idle** sway — the weight shifting across the feet, the slow
 *    drift of a standing figure — in units of `IDLE_SWAY_RADIANS`. It is largest
 *    for the ranging states, which is the same sentence the old comment was making
 *    with the wrong word, and it is near zero for a chase, which is squared up to
 *    the player and closing.
 *  - `stride` is the **gait** — how hard the limbs are driven, 0 (dormant) to 1.08
 *    (enraged). It is the per-state drive that the amplitude is scaled BY, so the
 *    ordering is a claim about the frame: a chase's shoulder swing is 0.84 rad and
 *    a telegraph's is 0.035, a factor of 24, where before it was exactly 1.0.
 *
 * The `edge` bug story above is unchanged and is exactly why `edge` stayed its own
 * column through this pass rather than being folded into either of them.
 *
 * `dormant` and `dismissing` are not §6.1 states — they are what a *removal* and a
 * *departure* look like, and they are here because §8.2's phase-out and §7.4's
 * banish both have to be visible or they read as a bug.
 */
export const CREATURE_PRESENTATION = Object.freeze({
  /** Off the field entirely (§7.4, §8.2, and every pre-awakening frame). */
  // `stride: 0` and `sway: 0`: a thing that is not there does not breathe and does
  // not walk. BEFORE this pass `dormant`'s row was read by nothing, so it did not
  // matter; now both columns reach the screen, and a non-zero value here would
  // animate a figure nobody can see.
  dormant: Object.freeze({
    present: 0, scale: 1, presence: 0, eye: 0, flicker: null,
    lean: 0, sway: 0, stride: 0, scan: 0, edge: 0, recoil: 0, redden: 0, heave: 0,
  }),
  /**
   * The departure, §8.2's phase-out and §7.4's banish fading out. A removal the
   * player cannot see is a removal they read as a stutter, and §8.2 exists so that
   * being cornered is *survivable* — it has to be legible as relief.
   *
   * `stride: 0` is a decision and not an omission. A departing figure whose legs
   * kept striding would be walking away while it dissolved, and a figure that stops
   * dead is a figure being switched off; `presence` is already falling across
   * `FADE_SECONDS.dismiss`, so the motion has nothing left to support. BEFORE: the
   * row inherited the gait that every other row had, because the gait had one
   * amplitude for every state.
   */
  dismissing: Object.freeze({
    present: 1, scale: 1, presence: 0.72, eye: 1.1, flicker: null,
    lean: 0.08, sway: 0, stride: 0, scan: 0, edge: 0, recoil: 0, redden: 0, heave: 0,
  }),
  /**
   * TELEGRAPH — "appears at long range and is gone when you look back" (§6.1).
   *
   * Dim and flickering, and *slightly smaller than life*. The flicker is the whole
   * tell: at 90 m (§8.3's minimum, which is also the closest a telegraph ever gets,
   * because `world.js`'s `_firstSightingPoint` reuses the same distance floor) a
   * solid dark shape is either invisible or an obvious blob, and the design wants
   * the player to be unsure whether they saw it at all. A thing that is there,
   * then is not, then is, is the apparition. It is also the only state that does
   * not lean: it has not arrived, so it does not read as moving towards anything.
   *
   * `sway: 0.03 -> 0.35` and a NEW `stride: 0.12`. The apparition is a rumour at
   * ninety metres, so both its motions are scaled to the point where a player
   * would swear they saw the shape shift and could not say which part of it
   * moved. BEFORE: it walked at full gait amplitude, because the gait had exactly
   * one amplitude and it was applied to every state.
   */
  telegraph: Object.freeze({
    present: 1, scale: 0.88, presence: 0.3, eye: 0.5,
    flicker: Object.freeze({ rate: 5.4, depth: 0.62, floor: 0.06 }),
    lean: 0, sway: 0.35, stride: 0.12, scan: 0.12, edge: 0, recoil: 0, redden: 0, heave: 0.35,
  }),
  /**
   * STALK — "moves to the player's last-heard position and ranges around it. It
   * does not beeline" (§6.1).
   *
   * The lean is nearly upright and the idle sway is the widest of any hunting
   * state, because this is a thing *ranging*, not a thing *coming*. The scan term
   * turns the head independently of the body, which is the second half of the same
   * sentence: a searcher visibly checks a street. The positioning angle itself is
   * `stalkEdgeAngle`, a property of the camera rather than of this row.
   *
   * `sway: 0.1 -> 1` — a full idle sway, i.e. `IDLE_SWAY_RADIANS` of drift — and a
   * NEW `stride: 0.55`: a ranging thing walks, at a little over half a chase's
   * drive.
   */
  stalk: Object.freeze({
    present: 1, scale: 0.96, presence: 0.62, eye: 0.8, flicker: null,
    lean: 0.06, sway: 1, stride: 0.55, scan: 0.5, edge: 1, recoil: 0, redden: 0, heave: 0.6,
  }),
  /** REPOSITION is STALK with the search origin changing; §6.1's searching beat. */
  reposition: Object.freeze({
    present: 1, scale: 0.96, presence: 0.62, eye: 0.8, flicker: null,
    lean: 0.04, sway: 1.15, stride: 0.68, scan: 0.72, edge: 1, recoil: 0, redden: 0, heave: 0.7,
  }),
  /**
   * CHASE — the full form. Everything that was withheld arrives at once: the
   * tallest scale, the most solid presence, the hardest forward lean and the
   * fastest heave. A chase that still drifted and still scanned would be
   * indistinguishable from a stalk, and the player is owed an unambiguous read on
   * the one state that can end the run.
   *
   * `sway: 0.05 -> 0.4` and a NEW `stride: 1`. The idle sway is nearly OFF for a
   * chase, and that is the readable half: this is the one state that is squared up
   * to you and closing, and a thing that drifts while it closes is a thing that is
   * not sure it has you. The stride is the whole of the pass's third claim — the
   * arms swing 0.84 rad at the shoulder with the elbow a further 1.05 rad behind
   * them, and the same three numbers on a telegraph produce 0.035.
   */
  chase: Object.freeze({
    present: 1, scale: 1.04, presence: 1, eye: 1.6, flicker: null,
    lean: 0.26, sway: 0.4, stride: 1, scan: 0, edge: 0, recoil: 0, redden: 0, heave: 1.5,
  }),
  /**
   * STAGGER — §7.4's recoil, and the one beat where the hammer is visibly *doing*
   * something. The flicker is shallow and fast: a bolt of pain, not the slow
   * uncertainty of a telegraph. The displacement itself is not a constant here — it
   * is read off the §7.4 recoil clock by `staggerRecoil`, so the figure is thrown
   * exactly as hard as the window is long.
   *
   * `stride: 0.4` is deliberately not 0. §7.4's window is 1.6 s and the figure is
   * being thrown backwards through it; a limb that locks while the body is still
   * moving reads as a mannequin on a swing. It is the only state whose limbs move
   * for a reason other than walking, and the drive is a floor under the recoil pose
   * rather than a replacement for it.
   */
  stagger: Object.freeze({
    present: 1, scale: 1, presence: 0.85, eye: 1.2,
    flicker: Object.freeze({ rate: 7.7, depth: 0.3, floor: 0.45 }),
    lean: -0.1, sway: 0.8, stride: 0.4, scan: 0, edge: 0, recoil: 1, redden: 0, heave: 0.2,
  }),
  /**
   * ENRAGED — §10.2, reddened. The only other state with a colour of its own, and
   * the reason the figure is *nearly* black to begin with: a near-black body with
   * a red cast is a different animal from a red one, and the silhouette has to
   * survive both, because the finale is the moment the player is looking at it
   * hardest. `redden` is a 0..1 mix factor; the two hexes it mixes are art, and
   * they live in `creatureView.js`.
   *
   * `stride: 1.08` is the only value above 1 in the table and it is what §10.2's
   * 5.2 m/s asks for: the same rig, driven 8% harder, at the tier where the
   * creature is faster than a walking player. `sway: 0.04 -> 0.3` keeps the finale
   * from drifting while it runs you down, which is the same rule as CHASE's.
   */
  enraged: Object.freeze({
    present: 1, scale: 1.08, presence: 1, eye: 2.1, flicker: null,
    lean: 0.34, sway: 0.3, stride: 1.08, scan: 0, edge: 0, recoil: 0, redden: 1, heave: 1.9,
  }),
})

/** Every key of the table above, in §6.1's own order, for iteration and checks. */
export const PRESENTATION_STATES = Object.freeze(Object.keys(CREATURE_PRESENTATION))

/**
 * presentationFor — a state name to its row.
 *
 * An unknown state is a caller bug, and it is answered with `dormant` rather than
 * `undefined`: a creature that is not on the field is the safe reading of a name
 * this build has never heard of, and a thrown `TypeError` sixty times a second in
 * the render loop is the worst possible way to find that out.
 *
 * @param {string} state
 */
export function presentationFor(state) {
  return CREATURE_PRESENTATION[state] ?? CREATURE_PRESENTATION.dormant
}

/**
 * FADE_SECONDS — the two presentation windows a removal needs.
 *
 * They are presentation, not rules: §8.2's chase phase-out and §7.4's banish
 * window are both decided in `creatureStep`, and the world runs their clocks.
 * What this module owns is the number of seconds it takes the *figure* to go and
 * to come, which nothing else depends on and which a benchmark capture will show.
 * The dismissal is deliberately the same length as §9.3's cross-fade rather than
 * longer, so the creature has finished leaving before the screen starts going
 * down — and both are short enough that the player sees the relief, not a wait.
 */
export const FADE_SECONDS = Object.freeze({ dismiss: 1.1, reemerge: 0.9 })

/** Fade *out*: 1 at the start of a departure, 0 once it is gone. */
export function fadeOut(elapsed, total = FADE_SECONDS.dismiss) {
  if (!Number.isFinite(elapsed) || !Number.isFinite(total) || total <= 0) return 0
  return clampUnit(1 - elapsed / total)
}

/** Fade *in*: 0 the moment a re-emergence is placed, 1 once it has arrived. */
export function fadeIn(elapsed, total = FADE_SECONDS.reemerge) {
  if (!Number.isFinite(elapsed)) return 1
  return clampUnit(elapsed / total)
}

/**
 * EYE_PIXEL_FLOOR — the eyes' minimum apparent size, in pixels.
 *
 * This is the number that makes "emissive eyes" and "reads at distance in fog" one
 * requirement instead of two, and it is the reason the eyes are quads rather than
 * spheres. At §8.3's minimum re-emergence distance — 90.5 m of open air
 * diagonally, the closest a banished thing can possibly come back — a 7 cm sphere
 * subtends about *half a pixel*. The problem is not that the eyes are too dark;
 * they are not there at all. Geometry has no floor on its apparent size, so the
 * only fix is to stop scaling them down and hold a screen-space size instead: from
 * six metres out the eye is anatomically sized, and from ninety it is a pair of
 * points of light on a shape you can only guess at, which is the correct horror
 * at that range and the only version of it that renders.
 */
export const EYE_PIXEL_FLOOR = 7

/**
 * eyeWorldSize — the world size an eye needs to hold `EYE_PIXEL_FLOOR` pixels.
 *
 * The exact solid-angle relation, with the camera's real numbers passed in rather
 * than read off a Three.js object, so it stays a pure function and the behaviour
 * at §8.3's distance is a number the gate can assert instead of a screenshot a
 * human has to squint at.
 *
 * @param {number} distance metres to the camera
 * @param {{ base?: number, pixels?: number, viewportHeight?: number,
 *           fov?: number }} [options] `fov` is the camera's *vertical* field
 */
export function eyeWorldSize(distance, options = {}) {
  const base = Number.isFinite(options.base) ? options.base : CREATURE_SHAPE.eyeRadius * 2.6
  const pixels = Number.isFinite(options.pixels) ? options.pixels : EYE_PIXEL_FLOOR
  const height = Number.isFinite(options.viewportHeight) ? options.viewportHeight : 720
  const fov = Number.isFinite(options.fov) ? options.fov : 72
  if (!Number.isFinite(distance) || distance <= 0 || height <= 0 || pixels <= 0) return base
  const visible = (2 * distance * Math.tan((fov * Math.PI) / 360) * pixels) / height
  return Math.max(base, visible)
}

/**
 * STALK_EDGE_FRACTION — where in the frame a stalking creature is presented.
 *
 * A fraction of the camera's *horizontal* half-field rather than an angle, because
 * the angle depends on the aspect ratio and the aspect ratio belongs to the window
 * the player happens to have open. At the 16:9 the gate's captures are taken at,
 * that is 0.8 x 52.2° = 41.8° off the bearing to the player, and the one number
 * buys two properties at once:
 *
 *  - it is **inside** the frame, so the player does see it. §6.1's STALK is a
 *    state the player is meant to be able to notice, and a presentation that put
 *    it off-screen would be a state nobody ever learns to read;
 *  - it is **outside** `SIGHT_HALF_ANGLE` (35°), so the thing standing at the
 *    edge of your vision cannot see you. §6.1's stalk is a sound-hunter that
 *    does not beeline, and this is the same promise drawn in the one place the
 *    player can actually see it.
 *
 * `verify.mjs` asserts both halves against a restated camera, so a change to the
 * fov or to `SIGHT_HALF_ANGLE` that quietly breaks either one is caught there.
 */
export const STALK_EDGE_FRACTION = 0.8

/**
 * stalkEdgeAngle — the off-bearing angle a STALK is presented at.
 *
 * @param {number} viewHalfFov the camera's horizontal half-field, radians
 */
export function stalkEdgeAngle(viewHalfFov) {
  const fov = Number.isFinite(viewHalfFov) && viewHalfFov > 0 ? viewHalfFov : Math.PI / 4
  return fov * STALK_EDGE_FRACTION
}

/**
 * stalkEdgeAspectFloor — the narrowest window the §6.1 edge promise holds in.
 *
 * This is a real limit of the design rather than a rounding detail, and it was
 * found by the gate rather than by playing. The edge has to be *inside* the frame
 * (or §6.1's STALK is a state the player never learns to read) and *outside*
 * `SIGHT_HALF_ANGLE` (or the thing at the edge of your vision can see you). With a
 * 72° vertical field those two are only simultaneously satisfiable above an aspect
 * of about 1.32:1, and a square window leaves barely one degree between the 35°
 * cone and the 36° frame edge.
 *
 * The gate does not paper over that. It asserts both properties at every aspect
 * above this floor, asserts the floor is above 1 — so the promise can never be
 * *claimed* for a square window — and asserts that 4:3, the narrowest aspect any
 * real window ships at, is inside the floor. A portrait phone therefore shows the
 * figure nearer the frame edge than the fraction asks for, which is the right way
 * round: §6.1's promise is that the player can see it, and "it can see you" is
 * enforced by §6.3's sight test rather than by where the renderer chose to stand.
 *
 * @param {number} viewFov the camera's vertical field, degrees
 */
export function stalkEdgeAspectFloor(viewFov = 72) {
  const half = (Number.isFinite(viewFov) && viewFov > 0 ? viewFov : 72) / 2
  const needed = SIGHT_HALF_ANGLE / STALK_EDGE_FRACTION
  if (needed >= half) return Infinity
  return Math.tan(needed) / Math.tan((half * Math.PI) / 180)
}

/**
 * RECOIL — §7.4's recoil, as displacement rather than as a flag.
 *
 * A hammer blow throws something *backwards*, which is why `creaturePose` applies
 * these with the opposite sign to every other pitch in the table, and the spin is
 * there because a thing that is struck hard turns: without it the recoil reads as
 * the creature being deleted from behind rather than hit.
 *
 * `shape` is a decay exponent, and it is deliberately > 1. `staggerRecoil` returns
 * `remaining ^ shape`, and a struck body *decelerates into a stop* rather than
 * falling off a cliff — so the curve is convex, not concave. A tenth of the way
 * through the window three quarters of the throw is still to come; by the halfway
 * point it has already recovered three quarters; the last tenth is a settle worth
 * nothing. An exponent below 1 gives the opposite shape, which is a shove into a
 * wall, and 1 is a linear slide, which is a fade rather than a hit.
 */
export const RECOIL = Object.freeze({ push: 1.35, lift: 0.22, spin: 0.9, shape: 2 })

/**
 * staggerRecoil — how far into its recoil the creature is, 0..1.
 *
 * Read off the §7.4 clock the state machine already keeps (`staggerSeconds` counts
 * down from `STAGGER_SECONDS`) rather than off a second timer the view would have
 * to start and keep in step on its own. That is the whole reason the recoil is
 * tied to the banish: the window *is* the animation, so a hammer thrown with a
 * long window throws further, with no second source of truth left to disagree.
 *
 * The curve is `RECOIL.shape`, a convex decay, because a body that has been hit
 * decelerates into a stop. See `RECOIL` for why the exponent is above one.
 *
 * Gated on the state as well as the clock, and not on the clock alone: a creature
 * that is not staggering has no recoil however much time is left on a counter it
 * does not own. In the game the two can never disagree — `creatureStep` sets both
 * in the same frame, and the world asks for the pose after that frame — but a
 * function that answers "how hard is it being hit right now" should not answer
 * that question about a creature which is not.
 */
export function staggerRecoil(creature) {
  const total = STAGGER_SECONDS
  const left = creature?.staggerSeconds
  if (creature?.state !== 'stagger') return 0
  if (!Number.isFinite(left) || total <= 0) return 0
  return Math.pow(clampUnit(left / total), RECOIL.shape)
}

/**
 * apparitionFlicker — the TELEGRAPH's beat, in [0, 1].
 *
 * Two incommensurable sines rather than one, because a single sine is a pulse and
 * a pulse is a machine: a player who has watched two apparitions has learned its
 * period and can time their attention against it. The exponent does the real work
 * — it holds the value near zero and lets it spike, so the apparition is absent
 * far more often than it is present and each appearance is an event.
 *
 * Pure in `time`: the world owns the clock and passes it, which is what keeps
 * §6.5 true of this file too.
 *
 * @param {number} time seconds, the world's own animation clock
 * @param {number} [offset] per-creature phase, so two sightings do not blink in
 *   lockstep
 */
export function apparitionFlicker(time, offset = 0) {
  if (!Number.isFinite(time)) return 0
  const a = Math.sin(time * 5.4 + offset)
  const b = Math.sin(time * 13.7 + offset * 1.7)
  return Math.pow(clampUnit(0.5 + 0.5 * (a * 0.62 + b * 0.38)), 2.2)
}

// ---------------------------------------------------------------------------
// ITERATION 2, PASS 10 — CREATURE FIDELITY I
//
// The figure is the only thing in the game a player looks at on purpose, and nine
// passes of world-building had left it doing four things: standing, bobbing, sliding
// its limbs and glowing. This block is the four things it was not doing, and all
// four are HERE, in the pure half, because `creatureView.js` is a renderer: a
// number decided in the view is a number the gate cannot see. That is the pass-9
// review's finding, and it is why `stride` and `sway` had to be read here rather
// than invented there.
//
//  1. `idleBreath`   — a slow, deterministic breath and shoulder sway, so a thing
//                      standing ninety metres away in fog is alive, not a cut-out.
//  2. `limbGait`     — a stride amplitude PER STATE and an elbow that lags the
//                      shoulder, which is the difference between a limb that
//                      articulates and a limb that slides.
//  3. `dripStep`     — the viscous trail: decals at footfalls, a hard cap on how
//                      many are alive, and the oldest fading first.
//  4. `eyeFlare`     — the eyes flaring on the frame the creature first spots you,
//                      and settling afterwards.
//
// EVERY MOTION HERE IS A FUNCTION OF `(time, offset)` OR OF A COUNT OF METRES. No
// `Math.random`, no `Date.now`, no `performance.now`, no frame counter, and no
// state that survives a call — which is what D10 asks for and what makes §16.5's
// fourteen captures reproducible twice each.
// ---------------------------------------------------------------------------

/**
 * IDLE_BREATH_SECONDS — seconds per breath, 4.2.
 *
 * BEFORE: none. A standing figure was perfectly still between its bobs.
 *
 * 4.2 s is 14 breaths a minute, which is roughly what a 2.8 m figure that is not
 * trying to look like a person breathes. It is also the number that makes the
 * motion a *breath* rather than a sway: at 1.2 s the same curve is a tremble, and
 * at 9 s a player stops noticing it inside the first chase, which is where this
 * motion has to survive longest.
 */
export const IDLE_BREATH_SECONDS = 4.2

/**
 * IDLE_BREATH_RATIO — the second partial's rate, as a multiple of the first.
 *
 * Two sines again, for `apparitionFlicker`'s reason: one sine is a pulse and a
 * pulse is a machine. 0.41 is close enough to 5/12 that the two beat against each
 * other over ~10 s and far enough from any round ratio that the composite never
 * quite repeats inside a chase. It is deliberately NOT 2 or 3 — those would put a
 * clean sub-harmonic in the breath and give the figure a visible double-bounce.
 */
export const IDLE_BREATH_RATIO = 0.41

/**
 * IDLE_BREATH_DEPTH — the peak scale change, as a fraction.
 *
 * BEFORE: none. AFTER: ±0.016, so a 2.80 m figure rises and falls 4.5 cm at the
 * crown. That is the number the brief's "subtle" is: below about 0.008 the whole
 * rig shimmers like a bad shadow map and a reviewer blames the renderer; above
 * about 0.03 the figure visibly pulses and reads as a cut-out on a turntable
 * rather than as a body.
 */
export const IDLE_BREATH_DEPTH = 0.016

/**
 * IDLE_SWAY_SECONDS / IDLE_SWAY_RADIANS — the shoulder sway.
 *
 * BEFORE: none, and the `sway` column it now drives was read by nothing. AFTER:
 * ±0.03 rad (1.7°) at a full `sway` of 1, on a 5.9 s period that shares no factor
 * with the breath.
 *
 * Why 1.7°: the shoulder line is 0.40 m wide, so a yaw of 0.03 rad moves the far end
 * of that bar by 6 mm. It has to be that small — a shoulder sway you can name is a
 * shoulder twitch — and it has to run on a *different* period from the breath, or
 * the two lock into one loop and the figure reads as rocking rather than breathing.
 */
export const IDLE_SWAY_SECONDS = 5.9
export const IDLE_SWAY_RADIANS = 0.03

/**
 * idleBreath — the idle micro-motion, as two signed numbers.
 *
 * `breath` is a SCALE DELTA, not a scale: the caller adds it to 1. It is bounded by
 * construction (`IDLE_BREATH_DEPTH` is the amplitude of a weighted sum of two unit
 * sines), so a pose can never hand the view a negative figure.
 *
 * `sway` is in RADIANS and has already been multiplied by the state's `sway`
 * column, so `sway: 0` in a row means no idle drift at all and the view has nothing
 * to apply. Multiplying here rather than in the view is the point: a per-state depth
 * and a per-state angle are the same fact, and the view is not allowed to own it.
 *
 * Pure in `time` and `offset` exactly as `apparitionFlicker` is, so a capture that
 * steps the world to a known clock gets the same breath twice.
 *
 * @param {number} time seconds, the world's own animation clock
 * @param {number} [offset] per-creature phase
 * @param {number} [sway] the state's `sway` column, 0..1.2
 * @returns {{breath: number, sway: number}} both signed; `breath` is a scale delta
 */
export function idleBreath(time, offset = 0, sway = 1) {
  if (!Number.isFinite(time)) return { breath: 0, sway: 0 }
  const rate = (2 * Math.PI) / IDLE_BREATH_SECONDS
  const a = Math.sin(time * rate + offset)
  const b = Math.sin(time * rate * IDLE_BREATH_RATIO + offset * 1.7)
  const depth = Number.isFinite(sway) ? Math.max(0, sway) : 0
  return {
    breath: (a * 0.7 + b * 0.3) * IDLE_BREATH_DEPTH,
    sway: Math.sin(time * ((2 * Math.PI) / IDLE_SWAY_SECONDS) + offset * 0.6) * IDLE_SWAY_RADIANS * depth,
  }
}

/**
 * STRIDE_ARC — the rate multiplier the gait phase runs at.
 *
 * BEFORE: the rate was `26` and the amplitude `0.5`, both hard-coded in
 * `creatureView.js` and neither reachable from a check. AFTER: the rate is here and
 * `stridePhase` below applies it, so "how fast does a chase walk" is a number a
 * test can read and a retune can move without opening a file a test cannot import.
 *
 * 26 against a `heave` of 1.5 is 2.87 rad/s at the peak of the bob, a 0.46 Hz
 * stride — a slow, deliberate walk. That is UNCHANGED from before this pass on
 * purpose: the brief asks for better articulation, not a sprint, and this figure's
 * pace is a design decision (a thing that lopes) rather than a fidelity one.
 */
export const STRIDE_ARC = 26

/** The phase offset the state name contributes, so two creatures are not in step. */
const STRIDE_STATE_OFFSET = 0.7

/**
 * LEG_SWING — the leg amplitude at a full `stride` of 1, radians.
 *
 * BEFORE: the literal `0.5` in `creatureView.js`, applied to every state. AFTER:
 * the same 0.5, at a full stride, scaled by the row. A chase still swings its legs
 * exactly as far as it did; a telegraph now swings them 0.06 rad, which is the
 * whole of "the apparition is barely there".
 */
export const LEG_SWING = 0.5

/**
 * ARM_SWING_BASE / ARM_SWING_GAIN — the shoulder amplitude, `drive x (base + gain x
 * drive)`.
 *
 * BEFORE: the literal `0.7`, applied to every state, so the arms of a thing at
 * ninety metres swung exactly as hard as the arms of the thing about to catch you.
 * AFTER: 0.84 rad (48°) at a full stride, and 0.035 rad (2°) at a telegraph's 0.12.
 *
 * The quadratic shape is why it is two numbers and not one. A linear
 * `drive x amplitude` would give a 0.12-stride telegraph 12% of a chase, which is
 * 0.10 rad — visible on a figure whose entire job is to be unsure of. The quadratic
 * costs 0.035 rad instead, and the extra it spends at the top is that an enraged
 * stride drives 8% past a chase's rather than landing on the same number.
 */
export const ARM_SWING_BASE = 0.22
export const ARM_SWING_GAIN = 0.62

/**
 * ARM_ELBOW_REST / ELBOW_FLEX — the elbow's bend in radians, and how much of it is
 * gait.
 *
 * BEFORE: there was no elbow. The arm was one cylinder on one pivot, so the whole
 * limb rotated rigidly from the shoulder — which is what the brief calls sliding,
 * and it is worse than it sounds: a rigid swinging stick keeps its own silhouette at
 * every angle, so the eye reads one object oscillating rather than two segments
 * working.
 *
 * The bend is never zero, and that is the other half of the fix. `ARM_ELBOW_REST`
 * 0.35 rad is the hang of a long-armed thing at rest; an elbow that straightened
 * once per stride would be a mechanism, and a mechanism is a machine.
 */
export const ARM_ELBOW_REST = 0.35
export const ELBOW_FLEX = 0.7

/**
 * ELBOW_LAG — how far behind the shoulder the elbow peaks, in radians of gait.
 *
 * THIS is the claim the pass is actually making about the arms, and it is a
 * *phase* relationship rather than an amplitude, which is why it can be asserted:
 * sweep a stride, find each peak, and the elbow's has to come later.
 *
 * BEFORE: nothing to lag. AFTER: 0.66 rad, a fifth of a stride cycle — about 0.23 s
 * at a chase's 2.87 rad/s. Long enough to read as a forearm trailing an upper arm,
 * short enough that the limb does not look broken. A lag of 0 is a rigid stick with
 * a decorative joint; a lag of pi puts the elbow's peak opposite the shoulder's,
 * which is a bird's wing and reads as broken rather than as fast.
 */
export const ELBOW_LAG = 0.66

/**
 * stridePhase — the gait phase in radians, derived from the pose and never from a
 * clock of the view's own.
 *
 * Moved here from `creatureView.js` for the reason `apparitionFlicker` lives in
 * this file: a rig that keeps its own phase accumulator is a rig that drifts away
 * from the pose it is drawing. `heave` carries the bob and therefore the rate, so
 * the phase speeds up and slows down with it; the state name contributes a constant
 * offset so two creatures in one scene are never in step.
 *
 * BEFORE: `pose.heave * 26 + pose.state.length * 0.7`, in the view. AFTER: the same
 * arithmetic with `STRIDE_ARC` and `STRIDE_STATE_OFFSET`, here, where a test can
 * read it.
 *
 * @param {number} heave the pose's `heave`, the bob amplitude and the gait rate
 * @param {string} state the state name
 * @returns {number} radians
 */
export function stridePhase(heave, state) {
  const rate = Number.isFinite(heave) ? heave : 0
  const name = typeof state === 'string' ? state : ''
  return rate * STRIDE_ARC + name.length * STRIDE_STATE_OFFSET
}

/**
 * limbGait — the three joint angles for one stride, radians.
 *
 * `leg` and `swing` are the counter-phase pair the view has always applied, now
 * scaled by the state's `stride`. `elbow` is the new one, and it is NEGATIVE
 * because a bend forward is a negative rotation about +X for a limb hanging down
 * local -Y — the sign is stated here so the view never has to reason about it.
 *
 * The elbow's curve is `-(rest + flex x drive) x (0.5 + 0.5 sin(phase - lag))`: a
 * full bend-and-straighten through the stride, peaking `ELBOW_LAG` after the
 * shoulder reaches forward. `verify.mjs` measures that delay off the function rather
 * than restating the constant.
 *
 * @param {number} phase radians, from `stridePhase`
 * @param {number} [drive] the state's `stride` column
 * @returns {{leg: number, swing: number, elbow: number}}
 */
export function limbGait(phase, drive = 0) {
  if (!Number.isFinite(phase)) return { leg: 0, swing: 0, elbow: 0 }
  const d = Number.isFinite(drive) ? Math.max(0, drive) : 0
  const wave = Math.sin(phase)
  const bend = ARM_ELBOW_REST + ELBOW_FLEX * d
  return {
    leg: wave * LEG_SWING * d,
    // A negative rotation about +X swings the limb FORWARD, so the arm is furthest
    // forward where `sin(phase)` is 1, and the elbow's curve below is phased against
    // that. It was the other way round in the first version — `0.5 - 0.5 sin(...)` —
    // which put the deepest bend at the top of the BACK swing, and the check below
    // found it by measuring the two peaks instead of restating the lag.
    swing: -wave * d * (ARM_SWING_BASE + ARM_SWING_GAIN * d),
    elbow: -bend * (0.5 + 0.5 * Math.sin(phase - ELBOW_LAG)),
  }
}

/**
 * isSpot — did the creature just SEE the player, on this transition?
 *
 * BEFORE: nothing in the codebase asked this question. The presentation had a
 * `telegraph` state for the Act I apparition and a jump to full chase, and the
 * player's eye was given nothing at all in between: awareness filled from 0 to 1
 * over about eight seconds of §6.2's rate, and the only sign was the vignette
 * tightening as the HUD quantized.
 *
 * AFTER: one function, and it is deliberately narrow. It fires on the §6.2 edge
 * `-> chase` and on nothing else, which excludes three transitions that a looser
 * test would have caught:
 *
 *  - `chase -> chase`, which is every frame of a chase. A test that asked "is it
 *    chasing" would re-arm the flare sixty times a second and the eye would sit
 *    permanently bright.
 *  - `stalk -> enraged`, §10.2's finale edge. The finale is not a spotting: the
 *    creature is given permanent position knowledge by the third portal, so it has
 *    nothing to discover, and a flare here would claim a surprise the design has
 *    already spent. That is also why this names the state rather than testing
 *    `CAPTURE_STATES`, which is `['chase', 'enraged']` and would have fired on
 *    both.
 *  - anything out of `telegraph`, which cannot see at all. Act I is a rumour.
 *
 * @param {{from?: string, to?: string}} [step] a `creatureStep` result
 * @returns {boolean}
 */
export function isSpot(step) {
  if (!step || typeof step.to !== 'string') return false
  return step.to === 'chase' && step.from !== 'chase'
}

/**
 * EYE_FLARE_SECONDS — how long the flare lasts, 0.9 s.
 *
 * BEFORE: none. AFTER: 0.9 s from the spotting frame.
 *
 * 0.9 s is about a third of §6.2's eight-second fill, which is the relationship
 * that matters: the flare is the *punctuation* on a meter the player has been
 * watching for eight seconds, so it has to be short enough that the next one
 * registers as a new event. At 2 s two chases in a §8.2 cycle overlap into one
 * long bright eye and the second one stops being a surprise.
 */
export const EYE_FLARE_SECONDS = 0.9

/**
 * EYE_FLARE_GAIN — the peak ADDED brightness of the eye, as a multiplier.
 *
 * BEFORE: none; the eye's own `pose.eye` was the whole of its brightness and is
 * clamped to 1 by `clampUnit` in `creaturePose`. AFTER: up to 3.2x that at the peak,
 * falling to 1x at the end of the window.
 *
 * Why the gain is a *colour* multiplier and not an opacity: `eyeMaterial` is
 * `AdditiveBlending` with `fog: false` and its opacity is already spent on
 * `pose.eye`, which the flicker also scales (`stagger` multiplies both by the same
 * `g`). Pushing opacity above 1 would work and would also be unreadable — the
 * flicker could no longer dim a flaring eye without a second term. Scaling the
 * colour keeps the two independent: the eye can flare AND flicker.
 *
 * Why 2.2 and not 1.2: the eye is unfogged additive over a body that is near-black,
 * so a 1.2x gain is a change nobody would notice at 30 m, and this is a telegraph
 * that has to survive the same fog everything else does. 3.2x at the peak is still
 * a small quad — `EYE_MAX_SPAN` in `tools/png-luma.mjs` rejects anything past 14 px
 * precisely so a lamp head cannot pass as an eye, and a flare that GREW the quad
 * would be eating the creature gate's own margin. So the gain is brightness only.
 */
export const EYE_FLARE_GAIN = 2.2

/**
 * EYE_FLARE_GROWTH — the quad's peak size multiplier, 1.2.
 *
 * A real eye that flares dilates as well as brightens, and 20% is the smallest
 * swell that reads at all. The ceiling is the gate's, not this file's: the eye is
 * held at `EYE_PIXEL_FLOOR` 7 px by `eyeWorldSize`, so the worst case this can
 * produce is 8.4 px against `EYE_MAX_SPAN` 14 — and the check that says so is in
 * `verify.mjs`, because "a flare must not grow the eye past the eye-finder's own
 * ceiling" is a claim about a number in another repository file.
 */
export const EYE_FLARE_GROWTH = 1.2

/**
 * eyeFlare — the flare envelope, `0` outside the window and `1` on the frame the
 * creature spots you.
 *
 * BEFORE: nothing read a sighting. AFTER: a squared fall from the peak, which is
 * the shape the brief asks for ("briefly flare bright ... then settle to their
 * normal glow") and the cheapest of the three candidates:
 *
 *  - a linear fall is a triangle, and a triangle has a visible corner at the end
 *    where the derivative jumps;
 *  - an exponential never reaches zero, so "settle to normal" has no frame at
 *    which it HAS settled and the gate would have to test an epsilon;
 *  - `1 - u` squared reaches exactly zero at `EYE_FLARE_SECONDS` and is
 *    continuous, so `eyeFlare(w) === 0` is a fact about the function.
 *
 * A sighting is a frame, not a moment, so the value on that frame is the PEAK and
 * there is no attack: a telegraph that ramps up over 200 ms is a telegraph the
 * player can miss, and this one fires on the same frame as the state change.
 *
 * @param {number} seconds since the spotting frame; `null`/negative before it
 * @returns {number} 0..1
 */
export function eyeFlare(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= EYE_FLARE_SECONDS) return 0
  const u = 1 - seconds / EYE_FLARE_SECONDS
  return u * u
}

/**
 * DRIP_STRIDE_METRES — metres of ground between one footfall's decal and the next.
 *
 * BEFORE: nothing. The creature left no trace of any kind: it walked, and where it
 * had been was indistinguishable from where it had not.
 *
 * 0.9 m is a stride, and the decision it encodes is that the trail is keyed to
 * DISTANCE rather than to the drawn gait — because a trail's density is a fact
 * about how far a thing walked, and tying it to `STRIDE_ARC` would have made the
 * marks' spacing depend on the bob's amplitude, which is 1.5 in a chase and 0.6 in
 * a stalk. At 0.9 m a creature closing at §10.2's 5.2 m/s lays 5.8 marks a second
 * and one at tier 0's 2.2 lays 2.4, which is the difference between a smear and a
 * dotted line, and both read.
 *
 * The arithmetic is frame-rate independent by construction, and that is the whole
 * reason it is a count of metres rather than an accumulator of per-frame steps: at
 * 5.2 m/s a 60 Hz frame moves 8.7 cm, so an accumulator that added `walked` and
 * tested a threshold would place the same marks at 30 fps and at 144 fps and only
 * agree with the 60 fps number by luck. The remainder is CARRIED, never dropped.
 */
export const DRIP_STRIDE_METRES = 0.9

/**
 * TRAIL_MAX — decals alive at once.
 *
 * BEFORE: none, so there was no ceiling to have. AFTER: 16, and the ceiling is
 * load-bearing rather than decorative, which is the only interesting thing about a
 * cap: at 5.8 marks a second and `DRIP_LIFE` 3.2 s the finale wants 18.6 marks and
 * gets 16, so the two oldest are evicted mid-chase. `verify.mjs` drives the
 * reducer to `TRAIL_MAX + 8` and requires that it is still `TRAIL_MAX`.
 *
 * 16 is also the draw-call budget's answer: the whole trail is ONE mesh with
 * `TRAIL_MAX` quads in it (see `creatureView.js`), so a bigger cap would cost
 * vertices and a smaller one would cost the trail. Below about 10 a tier-0 chase
 * runs out of marks and the creature appears to stop leaving a trail at exactly the
 * moment it is walking towards you.
 */
export const TRAIL_MAX = 16

/**
 * DRIP_SPREAD — seconds for a mark to reach full strength, 0.12.
 *
 * A mark that appears at full opacity is a decal that switches on; one that fades
 * in over 0.12 s reads as something landing and spreading, which is the whole
 * difference between "a sprite appeared" and "something dripped here". It is short
 * enough to be invisible as a delay — at 0.4 s a player would watch the trail grow
 * behind the creature.
 */
export const DRIP_SPREAD = 0.12

/**
 * DRIP_LIFE — seconds a mark is visible, 3.2.
 *
 * 3.2 s at a tier-0 chase is 7.7 marks of tail; at the finale's 5.2 m/s it is 18.6,
 * which is the number `TRAIL_MAX` is set against. The floor is a legible trail
 * rather than a permanent stain: this world resets its maze every bell and the
 * creature re-emerges 90 m away, so a trail that never dried would accumulate
 * into a map of everywhere the thing has ever been and stop being information.
 */
export const DRIP_LIFE = 3.2

/**
 * DRIP_RADIUS / DRIP_ASPECT / DRIP_LIFT — the mark itself, in metres.
 *
 * 0.15 m across is a foot's worth of road, and it is rejected as the creature's eye
 * TWICE OVER, which is the whole reason the size is what it is. At §16.5.8's 9 m a
 * mark spans about 16 px, past `tools/png-luma.mjs`'s own `EYE_MAX_SPAN` 14 — so even
 * a bright one could not pass — and at luma 12 it is nowhere near that module's
 * `EYE_MIN` 150 floor, so a dark one is never even considered. The checks that say so
 * are in `verify.mjs`, because the claim is about a number in another repository file.
 *
 * `DRIP_ASPECT` 0.62 squashes it into an ellipse, for `streetView.js`'s puddle
 * reason: a circle of anything is a painted dot, and a puddle pass that had
 * learned this is the precedent being followed. `DRIP_LIFT` 0.03 m is ABOVE pass
 * 8's water: `PUDDLE_HALO_LIFT` is 0.01 and the water surface sits
 * `PUDDLE_LIFT_GAP` 0.004 above that, so a mark drawn at the halo's height is
 * invisible on a third of the road. No `polygonOffset`, for the same reason the
 * puddles use none: this is a plane at a fixed lift and a z-fight would need them
 * to be coplanar, which is the one thing they are not.
 */
export const DRIP_RADIUS = 0.15
export const DRIP_ASPECT = 0.62
export const DRIP_LIFT = 0.03

/**
 * DRIP_OPACITY — the peak alpha of a mark, 0.55.
 *
 * It is a BLEND and can never reach 1: an opaque mark is a hole cut in the road,
 * and a hole cut in the road is a shadow, which this world already has a family of.
 * 0.55 over asphalt under a sodium pool is the difference between a stain and a
 * shadow, and the number is asserted in both directions — too low and the trail is
 * only visible where a lamp happens to be.
 */
export const DRIP_OPACITY = 0.55

/**
 * DRIP_COLOUR — the mark's colour, as a hex.
 *
 * BEFORE: nothing. AFTER: `0x0b0c10`, which is a shade cooler and a shade darker
 * than `PALETTE.puddle` (0x0d0e11) and darker than `PALETTE.wetSheen`. A mark that
 * is wet rather than shadowed is *slightly* lighter than the water it sits in, and
 * this is a wet thing: it is asserted against both in `verify.mjs` so a later pass
 * cannot repaint the trail as a shadow and leave the "viscous" claim unbacked.
 */
export const DRIP_COLOUR = 0x0b0c10

/** The region of the mix that owns each mark's shape, so a seed replay is identical. */
const DRIP_SALT = 0x44524950

/**
 * dripAlpha — a mark's strength at a given age, 0..1.
 *
 * Two segments and a reason for each: `DRIP_SPREAD` to come up (it landed) and the
 * rest of `DRIP_LIFE` to go down, quadratically (it is drying). A linear tail would
 * be visible as a mark being switched off; this one has no corner in it.
 *
 * This is where "oldest fades first" is TRUE rather than claimed: alpha is a pure
 * function of age, so among a set of marks the oldest is always the faintest and is
 * always the next to go, and `verify.mjs` asserts the monotonicity rather than the
 * ordering of a particular frame.
 *
 * @param {number} age seconds since the mark was laid
 * @returns {number} 0..1
 */
export function dripAlpha(age) {
  if (!Number.isFinite(age) || age < 0) return 0
  if (age >= DRIP_LIFE) return 0
  if (age < DRIP_SPREAD) return age / DRIP_SPREAD
  const u = (age - DRIP_SPREAD) / (DRIP_LIFE - DRIP_SPREAD)
  return (1 - u) * (1 - u)
}

/** An empty trail: fresh arrays, so a caller cannot reach in and edit one it was given. */
export function createDripTrail() {
  return { marks: [], walked: 0, dropped: 0, suppressed: 0, spare: 0 }
}

/**
 * dripStep — one frame of the viscous trail, as a pure reducer.
 *
 * The trail is the only state in this pass, and it is a REDUCER rather than a class
 * for the reason §6.5 wants of this file: `dripStep(trail, frame)` returns a new
 * trail and touches nothing, so `verify.mjs` can run a thousand frames of walking in
 * a loop and compare the result against a hundred frames of the same walk taken in
 * one go. A class with a `this.marks.push` could only be tested by watching it.
 *
 * The rules, in the order they are applied:
 *
 *  1. **Nothing is laid while the creature is not there.** `present: false` is the
 *     §7.4 banish and the Act I telegraph, and a telegraph that drips on the road it
 *     has not walked to is the bug this rule exists to prevent.
 *  2. **Nothing is laid for standing still.** The carrier is `walked`, a count of
 *     METRES, so a creature that is present and motionless accumulates nothing. This
 *     is why the drip is not keyed to the drawn stride: the drawn stride advances
 *     for a standing creature, and a version keyed to it would drip in place forever.
 *  3. **`clear: false` suppresses the drop** and counts it. That is the §16.5.5 pupil
 *     stand-off: a mark laid inside `PORTAL_FURNITURE_CLEAR` of a portal is a dark
 *     decal on the road between the gate and the camera that photographs it, and the
 *     pass-3 gate measures the luma of the HOLE in that frame. `suppressed` is
 *     published so a check can require the rule to have fired, which is the
 *     `dressingRejected` discipline pass 6 established for the same reason.
 *  4. **The cap evicts the OLDEST**, which `dripAlpha` has already made the
 *     faintest. The survivor list is oldest-first, always, so "oldest fades first"
 *     and "oldest goes first" are the same statement and cannot be got wrong in a way
 *     the ordering hides.
 *
 * @param {object} trail from `createDripTrail`
 * @param {object} [frame]
 * @param {number} [frame.walked] metres the creature covered this frame
 * @param {number} [frame.dx] this frame's x delta, for the foot that planted
 * @param {number} [frame.dz] this frame's z delta
 * @param {number} [frame.x] the drawn x to lay the mark at
 * @param {number} [frame.z] the drawn z
 * @param {number} [frame.time] the world's clock, for the mark's age
 * @param {boolean} [frame.present] is the figure on screen
 * @param {boolean} [frame.clear] is this spot outside the portal stand-off
 * @param {number} [frame.seed] the run's seed
 * @returns {{trail: object, dropped: object|null}} the new trail and the new mark
 */
export function dripStep(trail, frame = {}) {
  const before = trail && Array.isArray(trail.marks) ? trail : createDripTrail()
  const walked = Number.isFinite(frame.walked) ? Math.max(0, frame.walked) : 0
  const walkedTotal = before.walked + walked
  if (frame.present !== true || walked <= 0) {
    return { trail: { ...before, walked: walkedTotal }, dropped: null }
  }
  // The remainder is CARRIED, not floored: a 0.4 m frame lays nothing, a 0.5 m
  // frame lays nothing, and the eighth of them lays one. See `DRIP_STRIDE_METRES`.
  const spare = before.spare + walked
  if (spare < DRIP_STRIDE_METRES) {
    return { trail: { ...before, walked: walkedTotal, spare }, dropped: null }
  }
  const laid = Math.floor(spare / DRIP_STRIDE_METRES)
  const remaining = spare - laid * DRIP_STRIDE_METRES

  const time = Number.isFinite(frame.time) ? frame.time : 0
  const seed = Number.isFinite(frame.seed) ? frame.seed : 0
  const clear = frame.clear !== false
  const dx = Number.isFinite(frame.dx) ? frame.dx : 0
  const dz = Number.isFinite(frame.dz) ? frame.dz : 0
  // The foot that planted the mark is the one on the outside of the turn, so the
  // marks alternate sides by PARITY rather than by a coin: the same walk lays the
  // same marks in the same order, which is the determinism the brief asks for.
  const travel = Math.hypot(dx, dz)
  const lateral = travel > 1e-6 ? CREATURE_SHAPE.hip / 2 + 0.06 : 0
  const px = travel > 1e-6 ? -dz / travel : 1
  const pz = travel > 1e-6 ? dx / travel : 0
  const x = Number.isFinite(frame.x) ? frame.x : 0
  const z = Number.isFinite(frame.z) ? frame.z : 0

  const marks = before.marks.slice()
  let droppedCount = before.dropped
  let suppressed = before.suppressed
  let dropped = null
  for (let n = 0; n < laid; n += 1) {
    if (!clear) {
      suppressed += 1
      continue
    }
    const salt = hash32(seed, droppedCount, DRIP_SALT)
    const side = droppedCount % 2 === 0 ? 1 : -1
    droppedCount += 1
    dropped = {
      x: x + px * lateral * side,
      z: z + pz * lateral * side,
      born: time,
      radius: DRIP_RADIUS * (0.78 + 0.44 * ((salt & 0xffff) / 0xffff)),
      spin: (((salt >>> 16) & 0xffff) / 0xffff) * Math.PI,
    }
    marks.push(dropped)
  }
  // THE CAP. Slice from the front: `marks[0]` is the oldest, and `dripAlpha` has
  // already made it the faintest, so evicting the head IS "oldest fades first" and
  // there is no ordering in which the cap could keep a faint mark and drop a dark one.
  const alive = marks.length > TRAIL_MAX ? marks.slice(marks.length - TRAIL_MAX) : marks
  return {
    trail: { marks: alive, walked: walkedTotal, dropped: droppedCount, suppressed, spare: remaining },
    dropped,
  }
}

// ---------------------------------------------------------------------------
// ITERATION 2, PASS 11 — THE PRESENCE THAT IS NOT THE BODY
//
// Pass 10 gave the creature three things that are all ON or IN the figure: a
// breath, two elbowed arms, a viscous trail, a flare. This pass is about the four
// that are AROUND it, and the whole design argument is one sentence. A 2.80 m
// figure at ninety metres in sodium fog is a smudge, and the only things a design
// can give a player instead of a better smudge are the things the figure DOES to
// the air, to the light and to the ground around it.
//
// FOUR EFFECTS, AND THE SPLIT IS BY WHAT EACH ONE NEEDS TO BE TRUE:
//
//  1. `hazeAmount` / `hazeLayers` — a column of `HAZE_LAYERS` additive quads
//     within `HAZE_RADIUS`, so the creature has an edge that is not its
//     silhouette. A FUNCTION of (distance, time): a falloff curve and a table of
//     six numbers.
//  2. `lampDread` — the nearest sodium lamp strobes while the creature is standing
//     under it, out of `hash.js`'s own `flickerAt` and a per-lamp seed. It is
//     `flickerAt` rather than a fourth sine for the reason §12.2 gives for the
//     vending machine's bad tube: a hashed dropout is an EVENT, and two sines and
//     an avalanche are incommensurate.
//  3. `lampPulse` — the eye flare's OWN envelope, on the lamp rather than on the
//     eye, so one clock and one curve drive two effects on the same frame. That is
//     the sync claim, and it is only checkable if it is literally the same number.
//  4. `puffStep` — dust at the footfalls, on `dripStep`'s reducer discipline.
//
// All four are pure, seeded, and take either `(distance, time, options)` or a frame
// object. None of them reads a clock, allocates a closure, or can produce a NaN
// from one: the same total-function contract `creaturePose` keeps, for the same
// reason — a render loop that throws is a browser that stops.
// ---------------------------------------------------------------------------

// --- 1. THE HEAT HAZE --------------------------------------------------------

/**
 * HAZE_RADIUS — the creature's shimmer reaches this far, and no further. 30 m.
 *
 * BEFORE: nothing. The figure had exactly one edge, the one its geometry made.
 * AFTER: a second edge, and it is only an edge inside 30 m.
 *
 * The brief asked for "within ~30 m" and this is the number it asked for, but the
 * reason it is 30 rather than 90 is the reason the whole effect exists. §6.1's
 * apparition has to be noticed at ninety metres, and a shimmer at ninety metres is
 * not a shimmer: at that range the fog's own luma gradient between the road and the
 * sky is larger than anything a 0.006-alpha quad could add, so the effect would be
 * invisible in the one frame it was built for. 30 m is also 0.46 of the apparition's
 * own range, which is what keeps the Act I telegraph — the one figure that MUST stay
 * a rumour — with no shimmer at all by construction rather than by a test.
 *
 * The other half of the number is `EYE_PIXEL_FLOOR`: the eye is held at 7 px at any
 * range, which is a promise that the eye is legible everywhere. The haze has no such
 * promise and must not acquire one, because a shimmer that is 7 px at 90 m is a
 * second signal in the frame and §4 already has three.
 */
export const HAZE_RADIUS = 30

/**
 * HAZE_FADE_METRES — the last 12 m of the radius are a smoothstep, not a cut.
 *
 * BEFORE: n/a. AFTER 12.
 *
 * A hard edge at `HAZE_RADIUS` is a circle of shimmer that switches on, and the eye
 * finds a circle that switches on long before it finds a shimmer. The smoothstep
 * (`u * u * (3 - 2u)`, below) is chosen over a linear ramp for the reason `eyeFlare`
 * uses a squared fall: it is C1 at BOTH ends, so neither the arrival at 18 m nor the
 * disappearance at 30 m has a corner in its derivative for the eye to find. The inner
 * bound is therefore 18 m, and 18 m is `SPEED_CEILING` 5.2 x 3.5 s — inside three and
 * a half seconds of the finale's closing run, which is the window the effect has to
 * cover and no more.
 */
export const HAZE_FADE_METRES = 12

/**
 * HAZE_LAYERS — six bands in the column. The brief's "4-6", and the upper end.
 *
 * BEFORE: none. AFTER 6, which is 90 vertices and 48 triangles for the whole effect.
 *
 * Six rather than four because the column has to read as RISING and not as a box:
 * four bands of 0.76 m are four stripes, and six of 0.51 m are close enough together
 * that the eye integrates them into one soft column while the top and bottom of the
 * stack are still visibly doing different work. The cost is the reason there is no
 * cylinder and no noise texture: a scrolling texture is one more sampler and a
 * second UV set on a material the rest of the creature shares, and this is 48
 * triangles of CPU-written vertices.
 */
export const HAZE_LAYERS = 6

/**
 * HAZE_BASE_Y / HAZE_SPAN — the column in metres, floor up.
 *
 * BEFORE: n/a. AFTER 0.10 and 3.05.
 *
 * `HAZE_SPAN` overshoots the crown (`CREATURE_SHAPE.height` 2.80) by 0.25 m on
 * purpose: a shimmer that stops exactly at the top of the head is a hat, and the
 * top band has to be above the thing it is shimmering around. `HAZE_BASE_Y` 0.10 m
 * keeps the bottom band off the road plane, for the same reason pass 10's
 * `DRIP_LIFT` does and with the same number's reasoning — pass 8's water is the
 * lowest surface on the ground and a coplanar band would z-fight it.
 */
export const HAZE_BASE_Y = 0.1
export const HAZE_SPAN = 3.05

/**
 * HAZE_HALF_WIDTH — how far the shimmer stands off the figure's axis, 0.62 m.
 *
 * BEFORE: n/a. AFTER 0.62.
 *
 * §12.1's shoulder span is 0.40 m, so a band of alpha is centred 0.62 m out — 0.42 m
 * clear of the silhouette at the shoulder and 0.50 m clear at the hip (0.24). The
 * band cannot touch the body, and that is the constraint, because this effect is
 * additive and the creature gate measures a body against its LOCAL SURROUND: a
 * shimmer painted over the figure raises the body's own luma and moves the one
 * measurement in the repository with 0.013 of headroom. The two bright bands sit
 * either side of the figure and the middle of every band is transparent, which is
 * also what heat shimmer actually looks like — the distortion is at the edges of a
 * hot column, not in the middle of it.
 */
export const HAZE_HALF_WIDTH = 0.62

/**
 * HAZE_PEAK — the alpha at the crest of ONE band, before the bands sum. 0.006.
 *
 * BEFORE: n/a. AFTER 0.006, and the number is small because additive luma near
 * black is not a linear quantity.
 *
 * `HAZE_COLOUR` below is a pale grey whose linear luma is 0.218, so one band at
 * 0.006 adds 0.0013 linear light, and the surface the shimmer sits on in
 * `creature-stalking.png` measures about 19 of 255 — 0.0065 linear. A pixel is inside
 * at most `HAZE_OVERLAP` 2 bands, which is 0.0026 linear, and re-encoding that gives
 * about +5 levels of sRGB on that surround: a readable shimmer. Ten levels would be a
 * grey pillar and fifty a light, and `verify.mjs` measures the real worst pixel in the
 * renderer's own colour space and requires it inside [2, 12] levels, because a ceiling
 * alone is satisfied by a shimmer too faint to see.
 */
export const HAZE_PEAK = 0.006

/**
 * HAZE_BAND_HEIGHT / HAZE_BAND_FILL / HAZE_OVERLAP — the column's own grid, and how
 * many bands are lit at ONE PIXEL.
 *
 * BEFORE: n/a. AFTER 0.508 m, 0.62 and 2.
 *
 * A band is `HAZE_BAND_FILL` 0.62 of the pitch in half-height, so it is 1.24 of the
 * pitch tall and a point on the column is inside `ceil(1.24) = 2` of them. It is a
 * ceiling rather than a mean because that is what the luma budget needs: a pixel is
 * lit by at most two bands, so two is the worst case a gate may measure, and using the
 * 1.24 mean would understate the brightest pixel in the frame by 40%.
 *
 * The three are constants rather than arithmetic inside the loop for the reason
 * `TRAIL_MAX` is a constant rather than a computed capacity: the view's grid is a
 * fixed thing, and the number the luma budget is computed from has to be the same
 * number the view was built with. `verify.mjs` re-derives the coverage by walking the
 * bands' actual extents and asserts it equals this, so a retune of `HAZE_BAND_FILL`
 * that pushed the coverage to three would fail the budget rather than quietly making
 * it wrong.
 */
export const HAZE_BAND_HEIGHT = HAZE_SPAN / HAZE_LAYERS
export const HAZE_BAND_FILL = 0.62
export const HAZE_OVERLAP = Math.ceil(2 * HAZE_BAND_FILL)

/**
 * HAZE_DRIFT_HZ / HAZE_DRIFT_METRES — the ripple: 0.8 Hz, 0.2 m.
 *
 * BEFORE: n/a. AFTER 0.8 and 0.2.
 *
 * 0.8 Hz is a 1.25 s period, and the period is the claim: a shimmer that moves faster
 * than about 1.5 Hz reads as a wobble on the lens rather than as hot air, and one
 * slower than about 0.3 Hz is a column of fog with a slow lean in it. 0.2 m of travel
 * is a third of `HAZE_HALF_WIDTH`, so the band never leaves the figure's silhouette
 * — the effect is distortion around a shape, and a shimmer that wanders off and
 * reveals the edge it was hiding is worse than no shimmer at all.
 *
 * It is driven off `time` and the view's own hashed `offset` and never off an
 * accumulator, for the reason `vendingFlicker` is: a capture that steps to a given
 * time has to get the same shimmer, and `verify-world.mjs` can then drive the world
 * to the same time twice and require the buffer back bit-identical.
 */
export const HAZE_DRIFT_HZ = 0.8
export const HAZE_DRIFT_METRES = 0.2

/**
 * HAZE_COLOUR — the shimmer's tint, as a hex.
 *
 * BEFORE: n/a. AFTER 0x7b818a, a pale cool grey.
 *
 * Pale and desaturated on purpose, and both halves of that are decisions. PALE
 * because a shimmer is refracted streetlight: it has to read as light rather than as
 * a grey stain, and at a fixed alpha a pale colour gets there where a dark one would
 * have to be brighter than its own fog. COOL because the sodium family is the only
 * warm thing in this world and §12.2's rule is that the families never mix — a warm
 * shimmer would put a second orange in a frame whose orange all belongs to lamps,
 * and the lamp is about to start flickering because of the creature standing in it.
 *
 * It is asserted against `PALETTE.sodium`'s channel order in `verify.mjs` for the
 * same reason the trail's `DRIP_COLOUR` is: a later pass that repaints the shimmer
 * warm would break the family rule invisibly.
 */
export const HAZE_COLOUR = 0x7b818a

/**
 * `nearness` — the shared smoothstep both pass-11 radii are built on, 0..1.
 *
 * BEFORE: n/a. AFTER one function, used twice.
 *
 * A smoothstep over the last `fade` metres of `radius`: exactly 1 inside, exactly 0
 * at the edge, and C1 at both ends so nothing in the frame has a corner in its
 * derivative. The haze and the lamp dread both need "how near is near", and two
 * copies of that curve is how a shimmer at 30 m and a strobe at 12 m drift apart
 * until one of them is retuned and nobody notices the other moved.
 *
 * BEFORE this function existed, the lamp reused `hazeAmount`, which was wrong in a
 * way only arithmetic catches: `hazeAmount` is a NEAR-ness (1 close, 0 far) and it
 * was being used as a far-ness, so every lamp read a weight of zero at zero metres
 * and the strobe was a function that always returned 1. The parameters are the reason
 * the two effects cannot share one curve outright — the radii are 30 and 12 — so they
 * share the SHAPE and pass their own numbers.
 *
 * @param {number} distance metres
 * @param {number} radius the effect's own reach
 * @param {number} fade the ramp at the edge
 * @returns {number} 0..1, 1 near and 0 far
 */
export function nearness(distance, radius, fade) {
  const d = Number.isFinite(distance) ? Math.max(0, distance) : 0
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0
  const f = Number.isFinite(fade) && fade > 0 ? Math.min(fade, r) : r
  if (r <= 0) return 0
  if (d >= r) return 0
  if (d <= r - f) return 1
  const u = (r - d) / f
  return u * u * (3 - 2 * u)
}

/**
 * hazeAmount — how much shimmer is on at a distance. 0..1.
 *
 * The whole of the distance half of the effect, and it is `1` well inside the radius
 * and a smoothstep to `0` at it (see `HAZE_FADE_METRES`). A creature at zero
 * distance gets the full column, one at 40 m gets nothing at all, and a NaN gets
 * nothing at all rather than throwing.
 *
 * @param {number} distance metres to the camera
 * @returns {number} 0..1
 */
export function hazeAmount(distance) {
  return nearness(distance, HAZE_RADIUS, HAZE_FADE_METRES)
}

/**
 * `hazeLayers` — the column, one descriptor per band, all of it a function of the
 * four numbers the caller already has.
 *
 * The shape of the return is `{y, halfWidth, halfHeight, alpha, warp}`, and each of
 * the five is a number the view can multiply into a fixed grid without deciding
 * anything: the grid's row and column layout is geometry (like `SEGMENTS.limb`),
 * while every distance, alpha and offset is decided here.
 *
 * WHY FOUR INPUTS AND NOT A CREATURE
 * ----------------------------------
 * `time`, `offset`, `amount` and `scale`, and nothing else. The world already passes
 * `time` and `offset` to `creaturePose` on the same frame, so the view can hand the
 * same two numbers back here and the two draws cannot disagree about which instant
 * they are on — a shimmer running on a different clock from the figure it is
 * shimmering around is a bug that no screenshot can see and no replay can reproduce.
 *
 * @param {object} [options]
 * @param {number} [options.time] the world's clock, seconds
 * @param {number} [options.offset] `CreatureView`'s hashed flicker phase
 * @param {number} [options.amount] `hazeAmount` x the pose's presence, 0..1
 * @param {number} [options.scale] the pose's own figure scale
 * @returns {{y:number, halfWidth:number, halfHeight:number, alpha:number, warp:number}[]}
 */
export function hazeLayers(options = {}) {
  const time = Number.isFinite(options.time) ? options.time : 0
  const offset = Number.isFinite(options.offset) ? options.offset : 0
  const amount = Number.isFinite(options.amount) ? Math.max(0, Math.min(1, options.amount)) : 0
  const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 1
  const band = HAZE_BAND_HEIGHT
  const wave = time * HAZE_DRIFT_HZ * Math.PI * 2
  const layers = []
  for (let index = 0; index < HAZE_LAYERS; index += 1) {
    // The band's own share of the rise, so the stack starts at the floor and ends
    // `HAZE_SPAN` above it without a cumulative sum that would let a retune of
    // `HAZE_BASE_Y` move the whole column twice.
    const u = (index + 0.5) / HAZE_LAYERS
    // Two sines on unrelated phases per band: the travel steps 1.7 rad per band so no
    // two bands are ever in step, and the alpha's own sine runs at half the rate of
    // the travel, so a band brightens as it leans rather than translating at a
    // constant brightness — which is what makes it read as air rather than as a
    // sliding rectangle.
    const travel = Math.sin(wave + offset + index * 1.7)
    const breathe = 0.5 + 0.5 * Math.sin(wave * 0.5 + offset * 0.7 + index * 2.3)
    // The vertical taper: full strength in the middle of the column and a third of it
    // at the top and bottom bands, so the stack has ends that fade rather than a top
    // edge that stops.
    const taper = 0.35 + 0.65 * Math.sin(Math.PI * u)
    layers.push({
      y: HAZE_BASE_Y + band * (index + 0.5),
      // Hot air spreads as it rises, so the column is a cone and not a box: 0.72 of
      // the base width at the floor and 1.28 at the top.
      halfWidth: HAZE_HALF_WIDTH * (0.72 + 0.56 * u) * scale,
      halfHeight: band * HAZE_BAND_FILL * scale,
      alpha: HAZE_PEAK * amount * taper * (0.55 + 0.45 * breathe),
      warp: HAZE_DRIFT_METRES * travel,
    })
  }
  return layers
}

// --- 2 & 3. THE LAMP UNDER THE CREATURE --------------------------------------

/**
 * LAMP_DREAD_RADIUS — how close the creature has to be to a lamp to affect it. 12 m.
 *
 * BEFORE: nothing. The sodium family ran on `update()`'s three sines and on the one
 * failing vending ballast, and the creature had no relationship with either.
 * AFTER 12 m, and the creature's presence is one of the inputs to a lamp's level.
 *
 * 12 m is `LAMP_POOL_DIAMETER` 18 m's inner two thirds and roughly a fifth of a lamp
 * spacing, and it is chosen so the effect is LOCAL: a lamp 12 m away is a lamp the
 * player is looking past, and one at 30 m is a lamp the player is looking AT. A
 * creature that dims every lamp on the street is not a presence in a place, it is a
 * global dimmer, and the brief's words were "the nearest lamp".
 */
export const LAMP_DREAD_RADIUS = 12

/**
 * LAMP_DREAD_FADE — the 6 m in which the creature's influence ramps off.
 *
 * BEFORE: n/a. AFTER 6, on the same smoothstep as `HAZE_FADE_METRES`.
 *
 * Without it the lamp would switch from clean to strobing as the creature crossed an
 * invisible circle, and an invisible circle is the most artificial thing a game can
 * draw. 6 m is half the radius, so the lamp is at half strength at 9 m — inside the
 * pool it lights, which is the only place the player can see the change happen.
 */
export const LAMP_DREAD_FADE = 6

/**
 * LAMP_DREAD_HZ / LAMP_DREAD_FLOOR / LAMP_DREAD_DEPTH / LAMP_DREAD_ONE_IN — the
 * strobe's own numbers, handed straight to `flickerAt`.
 *
 * BEFORE: n/a. AFTER 11 Hz, 0.30, 0.46, one in three.
 *
 * Every one of them is a different choice from the vending machine's
 * (`VENDING_FLICKER_HZ` 8, floor 0.30, depth 0.42, one in 8), and the differences are
 * the design:
 *
 *  - **11 Hz against 8.** Two bad ballasts in one world should not share a period,
 *    and at 11 Hz the strobe is a flicker rather than a pulse.
 *  - **one in three against one in eight.** A lamp that drops to its floor on a third
 *    of its ticks is strobing, which is the word the brief used. A lamp that drops on
 *    an eighth is a fitting with a bad ballast, which is what the vending machine
 *    already is, and two of those on one street is a fault report.
 *  - **floor 0.30, the same as the vending machine's.** This one is deliberately the
 *    SAME number, and the reason is that both are about the same thing: a light that
 *    goes fully out is a DEAD light, and a dead lamp is street furniture. What is
 *    happening under this one is that something is standing in it, and something
 *    standing in a pool does not switch it off — it draws what it can.
 *  - **depth 0.46 against 0.42**, so the wobble between dropouts is deeper as well as
 *    the dropouts themselves: a strobe that is only ever at 1 or at the floor is a
 *    square wave, and a player can learn a square wave.
 */
export const LAMP_DREAD_HZ = 11
export const LAMP_DREAD_FLOOR = 0.3
export const LAMP_DREAD_DEPTH = 0.46
export const LAMP_DREAD_ONE_IN = 3

/** The region of the mix that owns the DROPOUT pattern; 'LDDR' in ASCII. */
const LAMP_DREAD_SALT = 0x4c444452

/** The region that owns each lamp's own seed; 'LDSE', one step along. */
const LAMP_DREAD_SEED_SALT = 0x4c444453

/**
 * `lampDreadSeed` — one lamp's own seed, derived from the run's seed and its index.
 *
 * BEFORE: n/a. AFTER: `hash32(seed, index, LAMP_DREAD_SEED_SALT)`.
 *
 * The index is the lamp's slot in the four-light pool (`LAMP_LIGHTS` in `world.js`),
 * not its position, and that is deliberate: the pool re-aims as the player walks, so
 * "slot 0" is a different physical lamp on every corner of the grid, and keying the
 * seed to a lamp's coordinates would mean a seed that changed as the player moved —
 * a lamp that strobed one way on the way up the street and another on the way back.
 * The index is stable, and the pass-7 `dressingLog` discipline is the same one: a
 * per-caller seed typed at the call site is a seed two people will change differently.
 *
 * @param {number} seed the run's seed
 * @param {number} index the lamp's slot in the light pool
 * @returns {number} an unsigned 32-bit integer
 */
export function lampDreadSeed(seed, index) {
  return hash32(
    Number.isFinite(seed) ? seed : 0,
    Number.isFinite(index) ? index : 0,
    LAMP_DREAD_SEED_SALT,
  )
}

/**
 * `lampDread` — the multiplier on one lamp while the creature is near it.
 *
 * Returns exactly `1` when the creature is outside `LAMP_DREAD_RADIUS`, and inside
 * it a blend between `1` and `flickerAt`'s stepped level, weighted by proximity. Two
 * properties are load-bearing and both are asserted:
 *
 *  - **the lamp RECOVERS.** The weight falls to zero at the radius, so a creature
 *    that walks on leaves the lamp clean behind it, and "the lamp recovers after it
 *    leaves" is a fact about the function rather than about a frame someone watched.
 *  - **the same tick twice gives the same answer.** `flickerAt` is a function of
 *    `floor(t * hz)`, so a lamp asked for a tick once to build and once to measure
 *    cannot disagree — which is what makes a strobe testable at all.
 *
 * The proximity weight is `nearness(d, LAMP_DREAD_RADIUS, LAMP_DREAD_FADE)`, the
 * same curve the shimmer uses on its own radius, and the reuse is not a coincidence to
 * be admired but a decision: one smoothstep in the file, so a retune of one is a
 * retune of both and there is no second "how near is near" to fall out of step.
 *
 * @param {number} distance metres from the creature to the lamp
 * @param {number} time seconds on the world's own clock
 * @param {{seed?: number, salt?: number}} [options]
 * @returns {number} a multiplier in `[LAMP_DREAD_FLOOR, 1]`
 */
export function lampDread(distance, time, options = {}) {
  const weight = nearness(distance, LAMP_DREAD_RADIUS, LAMP_DREAD_FADE)
  if (weight <= 0) return 1
  const seed = Number.isFinite(options.seed) ? options.seed : 0
  const salt = Number.isFinite(options.salt) ? options.salt : LAMP_DREAD_SALT
  const t = Number.isFinite(time) ? time : 0
  const level = flickerAt(seed, Math.floor(t * LAMP_DREAD_HZ), salt, {
    phaseSalt: (salt ^ 0x9e3779b9) >>> 0,
    floor: LAMP_DREAD_FLOOR,
    depth: LAMP_DREAD_DEPTH,
    oneIn: LAMP_DREAD_ONE_IN,
  })
  // `1 - weight * (1 - level)`: under the lamp `weight` is 1 and the lamp IS the
  // strobe; at the edge of the radius it is clean.
  return 1 - weight * (1 - level)
}

/**
 * LAMP_PULSE_GAIN — the peak the lamp's glow gains on the eye flare, as a
 * multiplier. 0.45.
 *
 * BEFORE: n/a. AFTER 0.45, i.e. up to 1.45x on the frame the creature spots you.
 *
 * The brief asks for a "single deterministic pulse" and this is why it is a GAIN on
 * the existing level and not an additive constant: an additive pulse would be a
 * brightness the lamp could not reach under a strobe, and two terms fighting over one
 * channel is how a lamp ends up brighter in the dark than in the light. A multiplier
 * is a term that composes with `lampDread` in either order.
 *
 * 0.45 is under half, and the ceiling is the creature's own eye: `EYE_FLARE_GAIN` is
 * 2.2 and the eye is a 7 px unfogged additive quad, so the lamp's 45% arrives as a
 * swell across a whole pool of road while the eye arrives as a point. The lamp is the
 * echo and the eye is the event, and the order of those two is the whole of the
 * composition.
 */
export const LAMP_PULSE_GAIN = 0.45

/**
 * `lampPulse` — the flare's envelope, on the lamp instead of on the eye.
 *
 * `lampPulse(flare) === 1 + LAMP_PULSE_GAIN * clampUnit(flare)`, and that identity IS
 * the audio-visual sync claim. The brief asks for the eye's flare and the lamp's
 * glow to land together; a second curve with a second length and a second peak would
 * be two events that happen to be near each other, and a machine-checked sync has to
 * be one number read twice. `verify.mjs` asserts the identity over the whole window
 * rather than restating the arithmetic.
 *
 * @param {number} flare `pose.eyeFlare`, 0..1
 * @returns {number} 1..(1 + LAMP_PULSE_GAIN)
 */
export function lampPulse(flare) {
  const f = Number.isFinite(flare) ? Math.max(0, Math.min(1, flare)) : 0
  return 1 + LAMP_PULSE_GAIN * f
}

// --- 4. THE FOOTFALL DUST ----------------------------------------------------

/**
 * FOOTFALL_STRIDE_METRES — metres of ground between one footfall's puff and the
 * next. 0.45.
 *
 * BEFORE: nothing. The creature moved through dust without disturbing any.
 * AFTER 0.45, which is EXACTLY HALF `DRIP_STRIDE_METRES` 0.9, and the halving is
 * the claim: two feet, and one puff under each of them per stride. A puff laid on the
 * same 0.9 m cadence as the trail would be one puff per two footfalls, which is a
 * thing that shuffles rather than a thing that walks.
 *
 * The frame-rate argument is `DRIP_STRIDE_METRES`' and it is not repeated: the
 * carrier is metres, the remainder is carried rather than floored, and the same walk
 * in 60 frames and in 600 frames lays the same puffs in the same places.
 */
export const FOOTFALL_STRIDE_METRES = 0.45

/**
 * PUFF_MAX — puffs alive at once. 10.
 *
 * BEFORE: none, so there was no ceiling to have. AFTER 10, and the cap is
 * load-bearing rather than decorative, which is the only interesting thing about a
 * cap: at §10.2's finale speed 5.2 m/s and `PUFF_LIFE` 0.95 s the creature wants 11
 * puffs alive and gets 10, so the oldest is evicted mid-run. Below about 6 a tier-0
 * chase (2.2 m/s, 4.6 puffs wanted) would be near the cap on every step and the dust
 * would pop.
 *
 * Ten is also the draw-call budget's answer, on the same argument as `TRAIL_MAX` 16:
 * the whole field is ONE mesh of ten quads with a per-quad vertex alpha, so the cap
 * costs vertices and nothing else.
 */
export const PUFF_MAX = 10

/**
 * PUFF_LIFE / PUFF_FADE — how long a puff is up, and how long it takes to arrive.
 *
 * BEFORE: n/a. AFTER 0.95 s and 0.22 s.
 *
 * 0.95 s is long enough to read as a puff of dust hanging in the light and short
 * enough that a chase does not leave a permanent cloud behind it — a trail of hanging
 * dust is a map of everywhere the thing has been, and this world resets its maze every
 * bell, so the information stops being information. It is also the number `PUFF_MAX` is
 * set against (5.2 m/s x 0.95 s / 0.45 m = 11 wanted).
 *
 * 0.22 s to reach full strength, which is `DRIP_SPREAD`'s argument in the other
 * direction: a mark that appears instantly is a decal switching on, and a puff that
 * appears instantly is a sprite switching on. Both are a quarter of a stride at tier 0
 * and both are short enough to be invisible as a delay.
 */
export const PUFF_LIFE = 0.95
export const PUFF_FADE = 0.22

/**
 * PUFF_RADIUS / PUFF_SPREAD — the puff's own size, 0.24 m growing to 0.39 m.
 *
 * BEFORE: n/a. AFTER 0.24, 0.62.
 *
 * 0.24 m is a foot's worth of dust, and it is bounded by the same rejection the trail
 * is: at the 7.8 m the chase view puts the creature's feet, a 0.48 m puff spans about
 * 30 px of a 720-tall frame, which is past `tools/png-luma.mjs`'s own `EYE_MAX_SPAN`
 * 14, so the eye-finder cannot take one for the creature's eye even before the luma
 * floor rejects it. That is asserted arithmetically in `verify.mjs` and against the
 * built material in `verify-world.mjs`.
 *
 * `PUFF_SPREAD` 0.62 is how much it grows over its life, and a puff that does not grow
 * is a decal that shrinks; a puff that grows by 62% and fades over 0.95 s reads as
 * dust losing its density.
 */
export const PUFF_RADIUS = 0.24
export const PUFF_SPREAD = 0.62

/**
 * PUFF_RISE / PUFF_LIFT — how far up it goes, and how high off the road it starts.
 *
 * BEFORE: n/a. AFTER 0.40 m and 0.06 m.
 *
 * Dust rises because it is dust and not because it is a sprite, and 0.4 m over 0.95 s
 * is slow enough to watch happening. `PUFF_LIFT` 0.06 m is `DRIP_LIFT`'s argument: the
 * puff hangs in the AIR above the road rather than lying on it, so it needs no
 * polygon offset and cannot z-fight pass 8's water, and the 0.06 is a billboard's
 * centre height rather than a plane.
 */
export const PUFF_RISE = 0.4
export const PUFF_LIFT = 0.06

/**
 * PUFF_OPACITY / PUFF_COLOUR — the puff's own brightness, 0.3 of a warm grey.
 *
 * BEFORE: n/a. AFTER 0.3, `0x6f6754`.
 *
 * It is a BLEND and can never reach 1: an opaque puff is a hole cut in the road, and
 * this file already has a family of holes (the trail) and a gate that measures one of
 * them. The composite is what matters and it is checked as a composite: 0.3 of a
 * 0.139-linear-luma grey over the darkest asphalt in the design lands around luma 58
 * of 255, which is unmistakably a puff and nowhere near `EYE_MIN` 150. The colour is
 * warm because it is ROAD dust under SODIUM light, and cooler than the sodium itself,
 * because a puff that is the same colour as the lamp it is standing in is a lamp.
 */
export const PUFF_OPACITY = 0.3
export const PUFF_COLOUR = 0x6f6754

/** The region of the mix that owns each puff's shape, so a replay is identical. */
const PUFF_SALT = 0x50554646

/**
 * `puffAlpha` — a puff's strength at a given age, 0..1.
 *
 * `PUFF_FADE` up and a squared tail down, which is `dripAlpha`'s two segments with
 * the names changed: a linear tail is visible as a puff being switched off, and this
 * has no corner in it. Alpha is a pure function of the age, so among a set of puffs
 * the oldest is always the faintest and always the next to go.
 *
 * @param {number} age seconds since the footfall
 * @returns {number} 0..1
 */
export function puffAlpha(age) {
  if (!Number.isFinite(age) || age < 0) return 0
  if (age >= PUFF_LIFE) return 0
  if (age < PUFF_FADE) return age / PUFF_FADE
  const u = (age - PUFF_FADE) / (PUFF_LIFE - PUFF_FADE)
  return (1 - u) * (1 - u)
}

/**
 * `puffRadius` — a puff's radius at a given age, metres. 0.24 -> 0.39.
 *
 * Growth is linear in `age` and therefore exactly `PUFF_SPREAD` at `PUFF_LIFE`, which
 * is what makes the constant above a boundary rather than a shape: a check can ask
 * for the radius at the end of the life and get the documented number back.
 *
 * @param {number} age seconds since the footfall
 * @returns {number} metres, `0` once the puff is gone
 */
export function puffRadius(age) {
  if (!Number.isFinite(age) || age < 0 || age >= PUFF_LIFE) return 0
  return PUFF_RADIUS * (1 + PUFF_SPREAD * (age / PUFF_LIFE))
}

/**
 * `puffLift` — a puff's height off the road at a given age, metres.
 *
 * @param {number} age seconds since the footfall
 * @returns {number} metres
 */
export function puffLift(age) {
  if (!Number.isFinite(age) || age < 0 || age >= PUFF_LIFE) return 0
  return PUFF_LIFT + PUFF_RISE * (age / PUFF_LIFE)
}

/** An empty field: fresh arrays, so a caller cannot reach in and edit one it was given. */
export function createPuffField() {
  return { puffs: [], laid: 0, suppressed: 0, spare: 0 }
}

/**
 * `puffStep` — one frame of footfall dust, as a pure reducer.
 *
 * `dripStep` is the model and the shape is the same, deliberately, because the two
 * are the same kind of thing: a decal field keyed to metres walked, with a cap, a
 * seeded per-mark shape, and a stand-off. The rules:
 *
 *  1. **Nothing while the creature is not there.** `present: false` is §7.4's banish
 *     and the Act I telegraph, and a telegraph that dusts the road it has not walked
 *     to is the same bug `dripStep` was written to prevent.
 *  2. **Nothing for standing still.** The carrier is `walked`, so a present and
 *     motionless creature accumulates nothing and breathes no dust.
 *  3. **`clear: false` suppresses the puff and counts it.** This is the §16.5.5 pupil
 *     stand-off, and it matters MORE here than it does for the trail: a trail mark is
 *     a dark decal and a puff is a bright one, and the pass-3 gate measures the luma of
 *     the HOLE in `portal-located.png`. A puff standing in that hole would fill it.
 *     `suppressed` is published so a check can require the rule to have fired.
 *  4. **The cap evicts the OLDEST**, which `puffAlpha` has already made the faintest,
 *     and the survivor list is oldest-first so the two statements cannot disagree.
 *
 * @param {object} field from `createPuffField`
 * @param {object} [frame]
 * @param {number} [frame.walked] metres covered this frame
 * @param {number} [frame.dx] this frame's x delta, for the foot that planted it
 * @param {number} [frame.dz] this frame's z delta
 * @param {number} [frame.x] the drawn x to lay it at
 * @param {number} [frame.z] the drawn z
 * @param {number} [frame.time] the world's clock, for the puff's age
 * @param {boolean} [frame.present] is the figure on screen
 * @param {boolean} [frame.clear] is this spot outside the portal stand-off
 * @param {number} [frame.seed] the run's seed
 * @returns {{field: object, laid: object|null}} the new field and the new puff
 */
export function puffStep(field, frame = {}) {
  const before = field && Array.isArray(field.puffs) ? field : createPuffField()
  const walked = Number.isFinite(frame.walked) ? Math.max(0, frame.walked) : 0
  if (frame.present !== true || walked <= 0) {
    return { field: before, laid: null }
  }
  // The remainder is CARRIED, not floored — see `DRIP_STRIDE_METRES`, and the
  // frame-rate-independence check in `verify.mjs` is the one that holds this honest.
  const spare = before.spare + walked
  if (spare < FOOTFALL_STRIDE_METRES) {
    return { field: { ...before, spare }, laid: null }
  }
  const count = Math.floor(spare / FOOTFALL_STRIDE_METRES)
  const remaining = spare - count * FOOTFALL_STRIDE_METRES

  const time = Number.isFinite(frame.time) ? frame.time : 0
  const seed = Number.isFinite(frame.seed) ? frame.seed : 0
  const clear = frame.clear !== false
  const dx = Number.isFinite(frame.dx) ? frame.dx : 0
  const dz = Number.isFinite(frame.dz) ? frame.dz : 0
  // Which foot planted it: the one on the outside of the turn, alternating by PARITY
  // rather than by a coin, so the same walk lays the same puffs in the same order.
  // The offset is wider than the trail's (`CREATURE_SHAPE.hip / 2 + 0.06`) because
  // dust comes off a stride rather than off a drip line.
  const travel = Math.hypot(dx, dz)
  const lateral = travel > 1e-6 ? CREATURE_SHAPE.hip / 2 + 0.1 : 0
  const px = travel > 1e-6 ? -dz / travel : 1
  const pz = travel > 1e-6 ? dx / travel : 0
  const x = Number.isFinite(frame.x) ? frame.x : 0
  const z = Number.isFinite(frame.z) ? frame.z : 0

  const puffs = before.puffs.slice()
  let laid = before.laid
  let suppressed = before.suppressed
  let newest = null
  for (let n = 0; n < count; n += 1) {
    if (!clear) {
      suppressed += 1
      continue
    }
    const salt = hash32(seed, laid, PUFF_SALT)
    const side = laid % 2 === 0 ? 1 : -1
    laid += 1
    newest = {
      x: x + px * lateral * side,
      z: z + pz * lateral * side,
      born: time,
      // ±22% on the radius and a half-turn of spin, from two different regions of the
      // same mix — a row of identical circles at a dead run of pixels is a row of dots,
      // and the eye finds the repeat in three.
      radius: PUFF_RADIUS * (0.78 + 0.44 * ((salt & 0xffff) / 0xffff)),
      spin: (((salt >>> 16) & 0xffff) / 0xffff) * Math.PI,
    }
    puffs.push(newest)
  }
  const alive = puffs.length > PUFF_MAX ? puffs.slice(puffs.length - PUFF_MAX) : puffs
  return { field: { puffs: alive, laid, suppressed, spare: remaining }, laid: newest }
}

/**
 * creaturePose — every number the view needs for one frame, and nothing else.
 *
 * This is the whole contract between the two halves of the slice. It is a total
 * function of `(creature, frame)`: no clock of its own, no randomness, no
 * Three.js, and nothing in the flicker that a replay could not reproduce. A
 * missing creature, a state this build has never heard of, a NaN distance and a
 * NaN time all have defined answers, because the alternative is a render loop that
 * throws and a browser that stops — and a horror game must not be one bad frame
 * away from a dead tab.
 *
 * @param {object|null} creature from `createCreature`
 * @param {object} [frame]
 * @param {number} [frame.time] seconds, the world's animation clock
 * @param {number} [frame.distance] metres to the camera
 * @param {number} [frame.elapsed] seconds into the current presentation
 * @param {number} [frame.dismiss] a departure is still drawing, 0..1
 * @param {number} [frame.sinceReemerge] seconds since the §8.3 placement
 * @param {number} [frame.offset] flicker phase
 * @param {number} [frame.chaseSeconds] §8.2's chase clock, for the closing beat
 * @param {number} [frame.bearing] radians from the camera to the creature, signed
 *   — the view measures it, because the camera is the only thing that knows which
 *   way "left" is
 * @param {number} [frame.viewHalfFov] the camera's horizontal half-field, radians
 * @param {number} [frame.sinceSpot] seconds since the creature first spotted the
 *   player, for §10's eye flare; `null`/absent before it has
 * @param {{fov?: number, viewportHeight?: number}} [frame.view] camera numbers
 * @returns {object} `present`, `scale`, `presence`, `eye`, `eyeSize`, `eyeFlare`,
 *   `haze` (pass 11: the shimmer's strength, 0..1), `pitch`, `roll`, `heave`,
 *   `scan`, `redden`, `push`, `lift`, `spin`, `breath`, `sway`, `legSwing`,
 *   `armSwing`, `armElbow`, `stride`, `state`
 */
export function creaturePose(creature, frame = {}) {
  const state = typeof creature?.state === 'string' ? creature.state : 'dormant'
  const time = Number.isFinite(frame.time) ? frame.time : 0
  const distance = Number.isFinite(frame.distance) ? Math.max(0, frame.distance) : 0
  const offset = Number.isFinite(frame.offset) ? frame.offset : 0
  const dismissing = Number.isFinite(frame.dismiss) ? frame.dismiss : 0

  // A departure outranks the state it departed from. A creature banished on this
  // frame is already `dormant`, and `dormant` draws nothing, so §7.4's removal
  // would be invisible and §8.2's relief would read as a stutter in the frame
  // rate. What the world hands over as `dismiss` is the only thing that can keep
  // the last of it on screen while it goes.
  const row = presentationFor(dismissing > 0 ? 'dismissing' : state)

  const pose = {
    state,
    present: row.present > 0 && (dismissing > 0 || state !== 'dormant'),
    scale: row.scale,
    presence: row.presence,
    eye: row.eye,
    eyeSize: eyeWorldSize(distance, {
      fov: frame.view?.fov,
      viewportHeight: frame.view?.viewportHeight,
    }),
    eyeFlare: eyeFlare(frame.sinceSpot),
    pitch: row.lean,
    roll: 0,
    heave: 0,
    scan: row.scan,
    redden: row.redden,
    push: 0,
    lift: 0,
    spin: 0,
    // PASS 10. The five below are the whole of the fidelity pass on the pose: two
    // idle numbers and three joint angles, all of them read off `row` and `time`
    // here so the view applies them without deciding anything. They are seeded by
    // nothing but `offset`, which is `CreatureView`'s own hashed phase, so two
    // creatures in one scene breathe out of step and one creature in two runs
    // breathes identically.
    breath: 0,
    sway: 0,
    stride: row.stride,
    legSwing: 0,
    armSwing: 0,
    armElbow: 0,
    // PASS 11 — the heat haze's own strength, 0..1. It is a DISTANCE and a
    // PRESENCE and nothing else, and the distance half is `hazeAmount`, which is
    // exactly 0 at `HAZE_RADIUS` and so leaves §6.1's ninety-metre apparition with no
    // shimmer by construction. The presence half is applied at the END of this
    // function rather than here, because it has to be the FINAL presence: the
    // re-emergence fade, the banish fade and §8.2's last-of-a-chase fade all live
    // below, and a shimmer that outlived the figure it was shimmering around would be
    // a column of hot air standing in an empty street.
    haze: 0,
  }

  // §6.1's edge-of-vision positioning. The offset is *proportional* to how near the
  // edge of the frame the creature already is, rather than a constant applied to
  // every sighting: a thing standing dead ahead is already being looked at, and
  // presenting it as though it were at the edge of your vision would be a lie the
  // player can see through. The sign comes from the bearing for free.
  //
  // Gated on the `edge` column and not on `sway` or `stride`, so a chase — which
  // has the HARDEST gait in the table (pass 10's `stride: 1`) and only 0.4 of an
  // idle sway — is still squared up to the player. This is the bug the table's own
  // note records: gating `edge` on "does this state move" caught `chase` before.
  if (row.edge > 0 && Number.isFinite(frame.bearing) && Number.isFinite(frame.viewHalfFov) && frame.viewHalfFov > 0) {
    const off = Math.max(-1, Math.min(1, frame.bearing / frame.viewHalfFov))
    pose.roll = stalkEdgeAngle(frame.viewHalfFov) * off
  }

  if (row.flicker) {
    const { rate, depth, floor } = row.flicker
    const beat = 1 - depth + depth * apparitionFlicker(time * (rate / 5.4), offset)
    const g = clampUnit(floor + (1 - floor) * beat)
    pose.presence *= g
    pose.eye *= g
  }

  if (row.recoil > 0) {
    const k = staggerRecoil(creature)
    pose.push = RECOIL.push * k
    pose.lift = RECOIL.lift * k
    pose.spin = RECOIL.spin * k
    pose.pitch = row.lean - k * 0.7
    pose.heave = k * 0.5
  }

  if (row.heave > 0) {
    // the gait: a slow breath when it is still looking, a hard one at a sprint
    pose.heave += Math.sin(time * row.heave * 2.1 + offset) * 0.035 * row.heave
  }

  // PASS 10 — THE MICRO-MOTION, and it is applied AFTER the heave for a reason
  // that is not tidiness. `heave` is the bob the whole rig rides on and it is what
  // sets `stridePhase`'s rate, so the joint angles below are derived from the bob
  // this frame has already been given. Applying them before would mean deriving
  // them from `row.heave` — a different number from the one the bob actually used,
  // and the limbs would drift against the body by exactly the recoil's and fade's
  // contributions.
  const gait = limbGait(stridePhase(pose.heave, state), row.stride)
  pose.legSwing = gait.leg
  pose.armSwing = gait.swing
  pose.armElbow = gait.elbow
  const idle = idleBreath(time, offset, row.sway)
  pose.breath = idle.breath
  pose.sway = idle.sway

  if (dismissing > 0) pose.presence *= fadeOut(frame.elapsed ?? 0, FADE_SECONDS.dismiss)

  // §8.3's placement is instant, so the arrival has to be *drawn* rather than
  // snapped: a creature that pops into being two blocks away is a teleport, and a
  // teleport is how a horror game tells you its own rules are not real
  if (state === 'stalk' && Number.isFinite(frame.sinceReemerge)) {
    pose.presence *= fadeIn(frame.sinceReemerge, FADE_SECONDS.reemerge)
  }

  if (state === 'chase' && Number.isFinite(frame.chaseSeconds) && frame.chaseSeconds > 0) {
    // §8.2: the last of a chase, the figure is already half gone. Not a warning
    // and not a mechanic — the state machine owns the phase-out — but the player
    // deserves to feel the valve open a beat before it does.
    pose.presence *= 1 - 0.25 * clampUnit(frame.chaseSeconds / CHASE_MAX_SECONDS)
  }

  pose.presence = clampUnit(pose.presence)
  pose.eye = clampUnit(pose.eye)
  // PASS 11. The shimmer rides the FINAL presence, and it is zero for a figure that
  // is not there — `hazeAmount(0)` is 1, so the only thing standing between a banished
  // creature's shimmer and a column of hot air over an empty road is this line.
  pose.haze = pose.present ? clampUnit(hazeAmount(distance) * pose.presence) : 0
  if (pose.presence === 0) pose.present = false
  return pose
}

export default createCreature
