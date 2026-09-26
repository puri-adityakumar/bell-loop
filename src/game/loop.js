/**
 * loop.js — the rules of the 60-second loop, plus the mutable store React
 * subscribes to.
 *
 * Everything in the first half of this file is PURE (no DOM, no Three.js) so
 * `verify.mjs` can import it in node. The second half is the tiny store: game
 * state lives in a plain mutable object, never in React state, and React only
 * re-renders the handful of values it actually paints.
 */
import { SHRINE_IDS } from './maze.js'

/** The bell rings every 60 seconds. */
export const LOOP_SECONDS = 60

export const PHASE = Object.freeze({
  START: 'start', // start overlay up, world built but frozen
  PLAYING: 'playing', // player walks, timer runs
  RESET: 'reset', // bell tolling, walls swap, fade at full black
  WON: 'won', // §10.4: "THE NEIGHBORHOOD WENT QUIET." (v1's line is gone from src/)
})

/**
 * Bell-reset timeline in seconds, measured from the moment the bell rings.
 * `swap` is where the maze layout actually changes (behind full black).
 */
export const RESET_TIMELINE = Object.freeze({
  fadeOut: 0.6, // black creeps in, old walls sink into the floor
  hold: 0.45, // fully black — the maze swaps here
  rise: 1.0, // new walls rise, staggered by distance from the entrance
  fadeIn: 0.9, // black lifts, player can move again
  total: 2.35,
  tolls: 3, // 3 bell tolls, spaced 0.7s
  tollSpacing: 0.7,
})

/** Moment inside the reset when the layout changes. */
export const RESET_SWAP_AT = RESET_TIMELINE.fadeOut + RESET_TIMELINE.hold

// ---------------------------------------------------------------------------
// pure state + rules
// ---------------------------------------------------------------------------

/**
 * @param {number} loopNumber
 * @param {string} phase
 */
export function createInitialState(loopNumber = 1, phase = PHASE.PLAYING) {
  return {
    phase,
    loop: loopNumber,
    timeLeft: LOOP_SECONDS,
    candles: { A: false, B: false, C: false },
    doorOpen: false,
    fade: phase === PHASE.START ? 1 : 0,
    prompt: null, // 'light' while an unlit shrine is in reach
    fps: 0, // loop 14: hidden perf counter (toggled with F)
    showFps: false,
  }
}

export function candlesLit(candles) {
  return SHRINE_IDS.reduce((n, id) => (candles[id] ? n + 1 : n), 0)
}

export function allCandlesLit(candles) {
  return candlesLit(candles) === SHRINE_IDS.length
}

/**
 * THE WIN RULE: light all three shrines and the chamber door stands open from
 * the NEXT loop onward (and every loop after that — the shrines stay lit).
 */
export function shouldDoorOpenAtLoopStart(candles) {
  return allCandlesLit(candles)
}

/** Light one shrine. Immutable; already-lit shrines are left untouched. */
export function applyLightCandle(state, shrineId) {
  if (!SHRINE_IDS.includes(shrineId)) return state
  if (state.candles[shrineId]) return state
  return { ...state, candles: { ...state.candles, [shrineId]: true } }
}

/** Countdown. Never goes below zero; the world watches for the 0 crossing. */
export function advanceTimer(timeLeft, dt) {
  return Math.max(0, timeLeft - dt)
}

/**
 * How close to the chamber centre counts as "walked through the door".
 * Smaller than half a cell (1.5m) so it can only trigger from inside the
 * chamber, i.e. after you have physically crossed the doorway.
 */
export const DOOR_WIN_RADIUS = 1.15

/** The win trigger, as a pure function of two positions. */
export function isInsideChamber(position, chamberCenter, radius = DOOR_WIN_RADIUS) {
  if (!position || !chamberCenter) return false
  return Math.hypot(position.x - chamberCenter.x, position.z - chamberCenter.z) <= radius
}

/**
 * Begin loop `nextLoop`: fresh timer, phase back to playing, door decided by
 * the shrines that are already lit. `phase` is a parameter because the maze
 * swap happens *behind full black* — the world stays in RESET for a moment.
 */
export function beginLoop(state, nextLoop, phase = PHASE.PLAYING) {
  return {
    ...state,
    loop: nextLoop,
    timeLeft: LOOP_SECONDS,
    phase,
    doorOpen: shouldDoorOpenAtLoopStart(state.candles),
    prompt: null,
  }
}

/** Full wipe for "BEGIN AGAIN" (shrines go dark, loop back to 1). */
export function restartState(loopNumber = 1) {
  return createInitialState(loopNumber, PHASE.PLAYING)
}

// ---------------------------------------------------------------------------
// reset timeline (pure curves, used by world.js and asserted by verify.mjs)
// ---------------------------------------------------------------------------

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3
}

/** 0 = clear view, 1 = full black, over the bell-reset window. */
export function resetFade(elapsed) {
  const T = RESET_TIMELINE
  if (elapsed <= 0) return 0
  if (elapsed < T.fadeOut) return easeInOut(elapsed / T.fadeOut)
  if (elapsed < RESET_SWAP_AT) return 1
  const t = (elapsed - RESET_SWAP_AT) / T.fadeIn
  if (t >= 1) return 0
  return 1 - easeInOut(t)
}

/** Progress of one wall rising out of the floor after the swap (0..1). */
export function wallRiseProgress(elapsed, delay = 0, rise = RESET_TIMELINE.rise) {
  const t = (elapsed - RESET_SWAP_AT - delay) / rise
  if (t <= 0) return 0
  if (t >= 1) return 1
  return easeOutCubic(t)
}

/** Per-wall stagger delay: walls near the entrance rise first, like a ripple. */
export function wallRiseDelay(distanceFromEntrance, maxDistance, maxDelay = 0.5) {
  if (!(maxDistance > 0)) return 0
  const k = Math.min(1, Math.max(0, distanceFromEntrance / maxDistance))
  return k * maxDelay
}

// ---------------------------------------------------------------------------
// the store (deliberately NOT React state)
// ---------------------------------------------------------------------------

/**
 * Plain mutable store. `set` merges a patch and notifies subscribers; React
 * subscribes once and copies out only the values it renders.
 */
export function createStore(initialState = createInitialState()) {
  let state = initialState
  const listeners = new Set()
  return {
    get() {
      return state
    },
    set(patch) {
      let changed = false
      for (const key of Object.keys(patch)) {
        if (state[key] !== patch[key]) {
          changed = true
          break
        }
      }
      if (!changed) return state
      state = { ...state, ...patch }
      for (const listener of listeners) listener(state)
      return state
    },
    /** Atomic read-modify-write for the reducers above. */
    update(fn) {
      const next = fn(state)
      if (next && next !== state) {
        state = next
        for (const listener of listeners) listener(state)
      }
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listenerCount() {
      return listeners.size
    },
  }
}

/**
 * v1's HUD projection used to live here, at the bottom of the store, and slice 12
 * moved it to `src/ui/hud.js`.
 *
 * The reason is scope, not tidiness. Everything this projection paints is §14's
 * vocabulary — sigils, a hold ring, awareness and breath tells, a pause — and
 * keeping it here would have meant a v1 module that still imported `maze.js` for
 * its shrine ids and still knew about a countdown, describing a game that has
 * neither. It is now the closed field list of a module about §14, and this file
 * is left holding what is still genuinely v1 until slice 16 deletes it.
 */

export default createStore
