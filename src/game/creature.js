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
 * style from v1's `loop.js`. `verify.mjs` imports this file directly in node,
 * which is the only reason a hunting AI is at all viable in a project nobody can
 * playtest (§16.1).
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
  streetDistanceMap,
  streetNodeToWorld,
  wrap,
} from './neighborhood.js'
import { hash32 } from './hash.js'

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
  Object.freeze({ from: 'dormant', to: 'stalk', when: 're-emergence, placed by slice 07 (§6.1, §8.3)' }),
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
 * @param {{x:number,z:number}|null} point
 * @returns {number} a node id
 */
export function nearestIntersection(point) {
  if (!point) return 0
  const x = Number.isFinite(point.x) ? point.x : 0
  const z = Number.isFinite(point.z) ? point.z : 0
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
  // KNOWN FRAME QUESTION — slice 14, left for slice 15
  // ------------------------------------------------------
  // The `position` this returns is CANONICAL (`streetNodeToWorld`), and so are
  // the `occluders` `world.js` hands in. The `player`, though, is in world
  // coordinates, because the player never wraps and the world does. So the two
  // directional tests below — `inSightCone` and `lineOfSight` — compare a
  // canonical point against an unfolded one across §3.3's seam, which is the
  // identical mistake `world.js`'s own sight tests made until slice 14 fixed them
  // there.
  //
  // It is left alone on purpose. Fixing it properly is a contract change — this
  // function would want a folded player and folded occluders, and it would return
  // a canonical answer either way — and that ripples through ~20 assertions in
  // `verify.mjs` that were written against the current signature. It is a change
  // to a pure module's API, not a repair, and it belongs in the slice that owns
  // `creature.js`'s tuning. What it costs in the meantime is bounded and named:
  // the placement is still §8.3's distance floor, which is what the design
  // actually promises, and the sight rules are the *secondary* filter that the
  // `level` field already reports when they could not be met.
  const floor = options.minDistance ?? REEMERGE_MIN_GRAPH_DISTANCE
  const minDistance = Math.max(0, Math.floor(Number.isFinite(floor) ? floor : 0))
  const origin = nodeId(player)
  const hops = streetDistanceMap(origin)
  const salt = pickSalt(options.seed, options.reemergenceCount)
  const facing = { x: player.x, z: player.z, yaw: player.yaw ?? 0 }

  const far = []
  const hidden = []
  const unobserved = []
  for (let id = 0; id < INTERSECTIONS; id += 1) {
    if (hops[id] < minDistance) continue
    far.push(id)
    const position = streetNodeToWorld(id)
    if (!inSightCone(facing, position)) unobserved.push(id)
    if (lineOfSight(position, player, occluders)) continue
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
  const id = pickByHash(pool, salt)
  const position = streetNodeToWorld(id)
  return {
    id,
    position,
    hops: hops[id],
    origin,
    sighted: lineOfSight(position, player, occluders),
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
 * A creature that phased out rather than being banished (§8.2) reads the first
 * rung, because §8.2 names no window of its own and the first rung is the one the
 * design calls the baseline. Nothing forces the world to wait it out: §8.3's
 * placement is what makes an early return safe, and it is the placement, not this
 * number, that §8.3 promises.
 *
 * @param {object} creature
 * @returns {number} seconds
 */
export function banishWindow(creature) {
  if (!creature) return BANISH_TABLE[0]
  if (creature.state === 'enraged' || creature.finale === true) return ENRAGED_REEMERGENCE_SECONDS
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
 * 0.25 is a quarter of the gap between two tiers of §11.1 and a tenth of the
 * sprint, so five re-emergences cost you about one tier of speed — the two axes
 * stay legible as separate axes rather than blurring into a single number.
 */
export const AGGRESSION_SPEED_STEP = 0.25

/**
 * AGGRESSION_SIGHT_STEP — metres of detection range per re-emergence. Sight is
 * the scarcer resource in §6.2 than speed is, because a footstep at 9 m is the
 * quietest event in the table and 1.5 m per re-emergence means a sprint is heard
 * one block earlier after four re-emergences than it was in Act II.
 */
export const AGGRESSION_SIGHT_STEP = 1.5

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
  let reemergenceCount = creature.reemergenceCount ?? 0
  let banishCount = creature.banishCount ?? 0
  let hammerToll = creature.hammerToll === true
  let phaseOut = false
  let swing = null

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
    if (frame.reemerge === true) {
      state = 'stalk'
      reemergenceCount += 1
      // §8.3: it comes back at a distance and out of sight, so it comes back
      // knowing nothing. Whatever it had worked out went with the removal.
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
    } else if (frame.searchPosition) {
      state = 'stalk'
      lastHeard = { x: frame.searchPosition.x, z: frame.searchPosition.z }
    } else if (awareness < AWARENESS_INVESTIGATE) {
      state = 'stalk'
      lastHeard = null
    }
  } else if (from === 'stalk') {
    if (awareness >= AWARENESS_CHASE) state = 'chase'
    else if (frame.searchExhausted === true) state = 'reposition'
  } else if (from === 'chase') {
    chaseSeconds += dt
    if (awareness < AWARENESS_CHASE_RELEASE) state = 'stalk'
    else if (chaseSeconds >= CHASE_MAX_SECONDS) {
      // §8.2: the pressure valve. The creature gives the chase up and is gone
      // from the field entirely — same place a completed banish puts it, and for
      // the same reason: the next time it exists it exists somewhere else, at a
      // distance (§8.3), knowing nothing. It earns nothing from this: unlike a
      // connected swing, a chase that ran out of clock does not advance the
      // §7.4 ladder, or the valve would be a reward for being cornered.
      state = 'dormant'
      awareness = 0
      lastHeard = null
      lastSeen = null
      banishPending = false
      phaseOut = true
    }
  }

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
  // §10.2: the finale is a flag on the run, so it may arrive per frame rather
  // than having been carried in at construction. The window it selects is the
  // flat one, and that is the only way the finale touches §7.4.
  const finale = creature.finale === true || frame.finale === true

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
 * them. The two properties are different — `sway` is the gait, `edge` is *where
 * in the frame the thing stands* — and only the ranging states set the second.
 *
 * `dormant` and `dismissing` are not §6.1 states — they are what a *removal* and a
 * *departure* look like, and they are here because §8.2's phase-out and §7.4's
 * banish both have to be visible or they read as a bug.
 */
export const CREATURE_PRESENTATION = Object.freeze({
  /** Off the field entirely (§7.4, §8.2, and every pre-awakening frame). */
  dormant: Object.freeze({
    present: 0, scale: 1, presence: 0, eye: 0, flicker: null,
    lean: 0, sway: 0, scan: 0, edge: 0, recoil: 0, redden: 0, heave: 0,
  }),
  /**
   * The departure, §8.2's phase-out and §7.4's banish fading out. A removal the
   * player cannot see is a removal they read as a stutter, and §8.2 exists so that
   * being cornered is *survivable* — it has to be legible as relief.
   */
  dismissing: Object.freeze({
    present: 1, scale: 1, presence: 0.72, eye: 1.1, flicker: null,
    lean: 0.08, sway: 0, scan: 0, edge: 0, recoil: 0, redden: 0, heave: 0,
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
   */
  telegraph: Object.freeze({
    present: 1, scale: 0.88, presence: 0.3, eye: 0.5,
    flicker: Object.freeze({ rate: 5.4, depth: 0.62, floor: 0.06 }),
    lean: 0, sway: 0.03, scan: 0.12, edge: 0, recoil: 0, redden: 0, heave: 0.35,
  }),
  /**
   * STALK — "moves to the player's last-heard position and ranges around it. It
   * does not beeline" (§6.1).
   *
   * The lean is nearly upright and the sway is the widest of any hunting state,
   * because this is a thing *ranging*, not a thing *coming*. The scan term turns
   * the head independently of the body, which is the second half of the same
   * sentence: a searcher visibly checks a street. The positioning angle itself is
   * `stalkEdgeAngle`, a property of the camera rather than of this row.
   */
  stalk: Object.freeze({
    present: 1, scale: 0.96, presence: 0.62, eye: 0.8, flicker: null,
    lean: 0.06, sway: 0.1, scan: 0.5, edge: 1, recoil: 0, redden: 0, heave: 0.6,
  }),
  /** REPOSITION is STALK with the search origin changing; §6.1's searching beat. */
  reposition: Object.freeze({
    present: 1, scale: 0.96, presence: 0.62, eye: 0.8, flicker: null,
    lean: 0.04, sway: 0.16, scan: 0.72, edge: 1, recoil: 0, redden: 0, heave: 0.7,
  }),
  /**
   * CHASE — the full form. Everything that was withheld arrives at once: the
   * tallest scale, the most solid presence, the hardest forward lean and the
   * fastest heave. A chase that still drifted and still scanned would be
   * indistinguishable from a stalk, and the player is owed an unambiguous read on
   * the one state that can end the run.
   */
  chase: Object.freeze({
    present: 1, scale: 1.04, presence: 1, eye: 1.6, flicker: null,
    lean: 0.26, sway: 0.05, scan: 0, edge: 0, recoil: 0, redden: 0, heave: 1.5,
  }),
  /**
   * STAGGER — §7.4's recoil, and the one beat where the hammer is visibly *doing*
   * something. The flicker is shallow and fast: a bolt of pain, not the slow
   * uncertainty of a telegraph. The displacement itself is not a constant here — it
   * is read off the §7.4 recoil clock by `staggerRecoil`, so the figure is thrown
   * exactly as hard as the window is long.
   */
  stagger: Object.freeze({
    present: 1, scale: 1, presence: 0.85, eye: 1.2,
    flicker: Object.freeze({ rate: 7.7, depth: 0.3, floor: 0.45 }),
    lean: -0.1, sway: 0.3, scan: 0, edge: 0, recoil: 1, redden: 0, heave: 0.2,
  }),
  /**
   * ENRAGED — §10.2, reddened. The only other state with a colour of its own, and
   * the reason the figure is *nearly* black to begin with: a near-black body with
   * a red cast is a different animal from a red one, and the silhouette has to
   * survive both, because the finale is the moment the player is looking at it
   * hardest. `redden` is a 0..1 mix factor; the two hexes it mixes are art, and
   * they live in `creatureView.js`.
   */
  enraged: Object.freeze({
    present: 1, scale: 1.08, presence: 1, eye: 2.1, flicker: null,
    lean: 0.34, sway: 0.04, scan: 0, edge: 0, recoil: 0, redden: 1, heave: 1.9,
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
 * @param {{fov?: number, viewportHeight?: number}} [frame.view] camera numbers
 * @returns {object} `present`, `scale`, `presence`, `eye`, `eyeSize`, `pitch`,
 *   `roll`, `heave`, `scan`, `redden`, `push`, `lift`, `spin`, `state`
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
    pitch: row.lean,
    roll: 0,
    heave: 0,
    scan: row.scan,
    redden: row.redden,
    push: 0,
    lift: 0,
    spin: 0,
  }

  // §6.1's edge-of-vision positioning. The offset is *proportional* to how near the
  // edge of the frame the creature already is, rather than a constant applied to
  // every sighting: a thing standing dead ahead is already being looked at, and
  // presenting it as though it were at the edge of your vision would be a lie the
  // player can see through. The sign comes from the bearing for free.
  //
  // Gated on the `edge` column and not on `sway`, so a chase — which does have a
  // gait, and a small one — is still squared up to the player.
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
  if (pose.presence === 0) pose.present = false
  return pose
}

export default createCreature
