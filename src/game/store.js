/**
 * store.js — the phase machine (§10.5) and the store React subscribes to.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * These two things lived in v1's `loop.js`, and slice 16 deleted that file with the
 * rest of v1. They still have to live somewhere, and the two obvious candidates
 * are both wrong in instructive ways:
 *
 *   - **`world.js`** owns the phase machine per §15.1, but it imports Three.js and
 *     the DOM, so putting `PHASE` there would make the one piece of §10.5 that
 *     the pure gate asserts (four phases, finale is *not* a fifth) unassertable.
 *   - **`src/ui/hud.js`** is where the plan suggested folding `PHASE`, and it is
 *     the wrong way round: `hud.js` is a *projection* — a total function from a
 *     state object to finished paint values with a closed field list. A store is a
 *     mutable object with subscribers and a lifetime. Letting the projection own
 *     the thing it projects inverts the dependency and puts a subscription list
 *     inside the one module whose whole argument is that it holds no state.
 *
 * So: a small pure module with the two survivors, and nothing else. It is pure per
 * §15.1 — no DOM, no Three.js, no clock, no globals — which is what keeps
 * `verify.mjs` able to import it, and it is the only module in `src/game/` that
 * exports no rule at all.
 *
 * WHAT `PHASE` STILL MEANS
 * ------------------------
 * §10.5 is explicit: start / playing / reset / won, unchanged from v1, and the
 * finale is a `finale: true` flag on the run state rather than a fifth phase. The
 * names and the strings are v1's, deliberately, for the same reason §14's win test
 * is the same shape as v1's chamber test: the benchmark compares runs, and a phase
 * table that meant something different would make them incomparable.
 */
export const PHASE = Object.freeze({
  START: 'start', // start overlay up, world built but frozen
  PLAYING: 'playing', // player walks, the creature hunts
  RESET: 'reset', // §9.3's capture cross-fade; the world holds still behind it
  WON: 'won', // §10.4: "THE NEIGHBORHOOD WENT QUIET." behind a frozen world
})

/**
 * Plain mutable store. `set` merges a patch and notifies subscribers; React
 * subscribes once and copies out only the values it renders.
 *
 * The one behaviour every caller depends on is the first line of `set`: a patch
 * whose values are all `===` the current ones notifies nobody. `world.js`'s HUD
 * mirror leans on it to stay inside a repaint budget (it quantizes before it
 * writes for exactly this reason), and a store that re-rendered on an unchanged
 * patch would put that budget back to sixty repaints a second.
 */
export function createStore(initialState = {}) {
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
    /** Atomic read-modify-write, for callers holding a reducer rather than a patch. */
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
 * createStartStore — the store every entry point starts from.
 *
 * `App.jsx` builds one before the world exists and the headless world harness
 * builds one per world, and both want the same thing: a store that says "the title
 * screen is up, the world is behind black, and this is loop 1". Three fields, and
 * the third is here for a reason — `hudSnapshot` is total, so a missing `loop`
 * would not crash, it would paint an empty counter on the one screen where the HUD
 * is visible behind the overlay.
 */
export function createStartStore() {
  return createStore({ phase: PHASE.START, loop: 1, fade: 1 })
}

export default createStore
