/**
 * creature.js — awareness, sight and the state machine for THE LONG QUIET
 * (v2, slice 06).
 *
 * WHAT LIVES HERE
 * ---------------
 * §6.1 (the state machine), §6.2 (the awareness meter and the sound table) and
 * §6.3 (sight). Pure: no DOM, no Three.js, no clock, no globals — primitives in,
 * a new plain object out, the house style from v1's `loop.js`. `verify.mjs`
 * imports this file directly in node, which is the only reason a hunting AI is
 * viable at all in a project nobody can playtest (§16.1).
 *
 * WHAT DOES NOT LIVE HERE YET
 * ---------------------------
 * Slice 07 adds pathing and the two ladders: `banishDuration`, `aggressionAt`,
 * where re-emergence puts the creature, and the `CHASE_MAX_SECONDS` phase-out.
 * The hooks for all four are already in the shape below, because a state machine
 * whose exits depend on modules that do not exist yet is a machine that cannot
 * be tested. This slice owns the **edges**; slice 07 owns the **numbers**.
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
 * TRANSITIONS — the machine, as data.
 *
 * Slice 07 adds `chase -> dormant` (the `CHASE_MAX_SECONDS` phase-out) plus the
 * dormant and reposition duration edges. Every row here is asserted by
 * `verify.mjs`, and so is the reverse: no transition the machine can actually
 * make is missing from this table. A row removed here is a rule quietly lost.
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
 */
export function createCreature(options = {}) {
  return {
    state: options.state ?? 'telegraph',
    awareness: clampAwareness(options.awareness ?? 0),
    tier: options.tier ?? 0,
    reemergenceCount: options.reemergenceCount ?? 0,
    /** §6.1: STALK commits to the last-heard position and ranges around it. */
    lastHeard: null,
    lastSeen: null,
    /** §6.1 TELEGRAPH ---(hammer pickup toll)---> STALK. */
    hammerToll: false,
    /** Counts only while chasing; slice 07 compares it to CHASE_MAX_SECONDS. */
    chaseSeconds: 0,
    staggerSeconds: 0,
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
 * ignored and re-emergence is a short flat delay; the ladder's numbers are slice
 * 07's, so the flag is all slice 06 owes it.
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
 *  2. this state's own exit condition;
 *  3. the §6.1 finale edge, if the third portal is down;
 *  4. the hammer, if a swing was thrown (§7.4);
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
 * @param {boolean} [frame.reemerge] slice 07's re-emergence timer fired
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
  let hammerToll = creature.hammerToll === true
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
    }
  } else if (from === 'stagger') {
    staggerSeconds = Math.max(0, staggerSeconds - dt)
    if (staggerSeconds === 0) {
      // the banish completes: it is off the field, and whatever it knew goes
      // with it (§7.4 — a removal, not a stagger, so the meter is moot)
      state = 'dormant'
      awareness = 0
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
  }

  // 3. the finale edge of §6.1. The promotion carries §10.2's permanent position
  //    knowledge with it on this frame, not on the next one: without the second
  //    line the creature is ENRAGED for one frame with whatever meter it had.
  if (frame.finale === true && ENRAGE_FROM.includes(state)) {
    state = 'enraged'
    awareness = AWARENESS_CHASE
  }

  // 4. the hammer (§7.4).
  if (frame.swing === true) {
    swing = resolveSwing(state, frame.distance)
    if (swing.result === 'banish') {
      state = 'stagger'
      staggerSeconds = STAGGER_SECONDS
      banishPending = true
    }
  }

  // 5. the capture test.
  const captured = canCapture({ state }, frame.distance)
  if (state !== 'chase') chaseSeconds = 0

  return {
    creature: {
      ...creature,
      state,
      awareness,
      tier: creature.tier ?? 0,
      reemergenceCount,
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
  }
}

export default createCreature
