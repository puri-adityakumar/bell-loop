/**
 * rules.js — the verb, the stamina and the bookkeeping for THE LONG QUIET
 * (v2, slice 05).
 *
 * The parts of v2 that are neither the world nor the creature: how a portal is
 * shut down, how breath runs out, what a capture does and does not take away,
 * and the single geometric win trigger.
 *
 * Everything here is a pure function of its arguments, in the same style as v1's
 * `loop.js`: primitives in, a new plain object out, never a mutation. The
 * mutable store that React subscribes to is built from these in slice 09; this
 * module has no idea a store exists.
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

/** How many portals are shut. */
export function portalsShut(portals) {
  return PORTAL_IDS.reduce((n, id) => (portals[id] ? n + 1 : n), 0)
}

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
  const shut = portalsShut(portals)
  return {
    ...next,
    portals,
    dusk: duskForPortals(portals),
    finale: next.finale || shut >= PORTAL_IDS.length,
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
export const DUSK_FOG = Object.freeze([
  Object.freeze({ portals: 0, density: 0.01 }),
  Object.freeze({ portals: 1, density: 0.0135 }),
  Object.freeze({ portals: 2, density: 0.018 }),
  Object.freeze({ portals: 3, density: 0.026 }),
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

/** The actual win rule: in the exit, and the finale is running. */
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
 * @param {object} objectives from `placeObjectives`
 * @param {object} [options]
 * @param {number} [options.loop] starting capture counter
 */
export function createInitialState(objectives, options = {}) {
  return {
    objectives,
    exitAnchor: objectives.exit,
    loop: options.loop ?? 1,
    portals: Object.fromEntries(PORTAL_IDS.map((id) => [id, false])),
    progress: Object.fromEntries(PORTAL_IDS.map((id) => [id, 0])),
    hammerHeld: false,
    banishCount: 0,
    finale: false,
    dusk: 0,
    breath: 1,
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

