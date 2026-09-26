#!/usr/bin/env node
/**
 * verify-world.mjs — headless INTEGRATION smoke test for the Three.js world.
 *
 * verify.mjs proves the pure modules; this file drives the real `BellLoopGame`
 * state machine with a stubbed DOM + a stubbed renderer, because a script cannot
 * click or look at the canvas.
 *
 * STATE OF THIS FILE
 * ---------------------------------------------------------------------------
 * Slice 14 landed the repair, and the interesting part is that the plan's
 * diagnosis had gone stale. The plan (written at the base commit) says this
 * harness exits 1 with `TypeError: ctx.beginPath is not a function`, thrown from
 * v1's `makeCobbleTexture`. Slice 09's swap rewrote all six procedural textures
 * as one pixel-only `makeSurfaceTexture`, so that particular thrower is gone —
 * and the stub happened to survive it. What the harness was actually failing on
 * was the 12 checks in the v1 live block, 11 of which read `game.maze` /
 * `game.shrines` / `game.door` / `SHRINE_IDS`, all deleted at the swap. `1/12`,
 * exit 1 — the same six-slices-long rot, a different organ.
 *
 * What this slice did, in order:
 *   1. the 2D stub now carries the *whole* drawing surface, so the next person
 *      who writes a path-drawn texture cannot rot the gate the way v1's six did.
 *      It still renders nothing — it is a surface, not an implementation — and a
 *      check at the bottom walks every member so it cannot be quietly halved;
 *   2. the v1 live block is gone, replaced by v2 construction checks, and the 31
 *      checks slices 10-13 parked are live;
 *   3. teardown moved to the bottom. v1 ran `dispose()` one block up from the end
 *      and slice 10 parked a second one; both freed the world out from under the
 *      blocks below, and neither announced it, because `update` has no `disposed`
 *      guard and the checks kept passing against a half-freed street.
 *
 * FOUR OF THE 31 PARKED CHECKS WERE WRONG, NOT THE WORLD
 * ------------------------------------------------------
 * The orchestrator log predicted four slice-10 presentation expectations failing
 * "as written", and it was right about the number and the neighbourhood. Three
 * were bugs in the *checks* and one was a bug in the *game*, and the game bug was
 * sitting underneath all of them:
 *
 *   - **§6.1's sighting stood at zero metres.** `_firstSightingPoint` tested the
 *     view cone against *canonical* node positions in a wrapped world, found
 *     nothing, and fell back to the spawn point itself. A telegraph at distance 0
 *     is not "a sighting at long range", and because `inSightCone` is trivially
 *     true at zero the sighting could then never end — the Act I apparition was on
 *     screen for the whole of Act I, permanently. Fixed in `world.js` by folding
 *     the candidates into the copy the spawn is in before testing them, and by
 *     giving §6.1 the same distance floor §8.3 has. `_updateCreature` had the
 *     identical mistake at runtime for the two *directional* tests, which is why
 *     "gone when you look back" never happened either.
 *   - **the phase-out check's `§9.2` line** asserted `banishCount === 0` in a
 *     suite where the check above it had already advanced the ladder to 1. It was
 *     asserting that the file tidied up after itself. §9.2's claim is comparative,
 *     and now is.
 *   - **the creature view's folded position** compared a `THREE.Vector3` to a
 *     plain object with `deepEqual`, so it could never pass and the diff it
 *     printed said nothing about the fold — which was correct all along.
 *   - **the telegraph's look-back** was driven by four seconds of standing still,
 *     which is not looking back. The check now turns the player around, and §6.1's
 *     second half is tested as the claim it is: a thing that is gone when you look
 *     away, and not gone when you do not.
 *
 * Every parked check otherwise says what slice 10, 11, 12 and 13 wrote, and every
 * one of those edits carries a `SLICE 14` comment saying which way it went.
 *
 * Run: node verify-world.mjs   (exit code 0 = the whole loop works)
 */
import assert from 'node:assert/strict'
// slice 11: the fake audio replays the world's frame through the *real* router, so
// this harness needs the pure half of the audio module. It is a pure module per
// §15.1, which is the property that makes this import possible at all.
import { routeAudio } from './src/game/audio.js'

// ---------------------------------------------------------------------------
// minimal DOM stubs (only what world.js + player.js touch)
// ---------------------------------------------------------------------------

/**
 * The 2D context: a *surface*, not an implementation.
 *
 * v1's stub had five members and every procedural texture drew through
 * `beginPath`/`ellipse`/`fill`, so all six rotted silently and the harness spent
 * five slices reporting `1/12` for a reason nobody could see. Slice 09 rewrote
 * the textures to be pixel-only, which made the stub *sufficient* by accident —
 * and an accidental sufficiency is the exact thing that rots again, because the
 * next person who reaches for a path is reaching for a member that is not here.
 *
 * So: the whole drawing surface, present, and inert. `fill()` records nothing and
 * paints nothing; `createImageData` really allocates, because `streetView`
 * writes every texel through it and a texture that throws on `data[i] = value`
 * is not a stub problem, it is a real one. Nothing here rasterizes, and nothing
 * here is asked to.
 *
 * The split is deliberate and worth keeping: `createImageData`/`getImageData`/
 * `putImageData` are *data*, so they are implemented; everything else is a *call*
 * whose only job is to not be undefined. `measureText` is the one grey area —
 * it returns zeros rather than throwing, because a texture that measures a label
 * is a texture whose layout cannot be checked here, and silently getting 0 is
 * better than a crash that looks like a game bug.
 */
function makeContext2d(canvas) {
  const noop = () => {}
  const state = () => ({})
  return {
    canvas,
    // --- draw state (all readable/writable no-ops: a plain data property) -----
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    lineDashOffset: 0,
    shadowBlur: 0,
    shadowColor: 'rgba(0, 0, 0, 0)',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    direction: 'inherit',
    filter: 'none',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',

    // --- raster: the one part that is real -----------------------------------
    createImageData(width, height) {
      const w = Math.max(1, Math.ceil(Number(width) || 1))
      const h = Math.max(1, Math.ceil(Number(height) || 1))
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
    },
    getImageData(x, y, width, height) {
      return this.createImageData(width, height)
    },
    putImageData() {},

    // --- path construction ---------------------------------------------------
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    bezierCurveTo: noop,
    quadraticCurveTo: noop,
    arc: noop,
    arcTo: noop,
    ellipse: noop,
    rect: noop,
    roundRect: noop,

    // --- path painting -------------------------------------------------------
    fill: noop,
    stroke: noop,
    clip: noop,
    isPointInPath: () => false,
    isPointInStroke: () => false,

    // --- shapes --------------------------------------------------------------
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    drawImage: noop,

    // --- transforms ----------------------------------------------------------
    save: noop,
    restore: noop,
    scale: noop,
    rotate: noop,
    translate: noop,
    transform: noop,
    setTransform: noop,
    resetTransform: noop,

    // --- text ----------------------------------------------------------------
    fillText: noop,
    strokeText: noop,
    measureText: () => ({
      width: 0,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      actualBoundingBoxAscent: 0,
      actualBoundingBoxDescent: 0,
      fontBoundingBoxAscent: 0,
      fontBoundingBoxDescent: 0,
    }),

    // --- gradients, patterns and dashes --------------------------------------
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createConicGradient: () => ({ addColorStop: noop }),
    createPattern: () => state(),
    setLineDash: noop,
    getLineDash: () => [],
  }
}

/**
 * A canvas: the element, plus the handful of members `world.js` and `player.js`
 * treat as guaranteed.
 *
 * Two things here are load-bearing rather than decorative.
 *
 * `getContext` **memoizes**. A real canvas hands back the same 2D context every
 * time it is asked, and a stub that mints a fresh one is not a smaller lie, it is
 * a different one: `streetView` builds a texture, `THREE.CanvasTexture` may ask
 * for the context again, and with per-call contexts those two are different
 * objects and the check "this texture was drawn on the context I am holding"
 * silently stops meaning anything. It also makes the stub honest about the one
 * method that *is* real: `createImageData` on the memoized context is the buffer
 * the texel loop writes into.
 *
 * `requestPointerLock` **records**. Slice 13 found that `restart()` must re-ask
 * for the lock, because the win card is the one screen the player was never
 * holding it on, and a new run that starts un-walkable reads as broken. A stub
 * that swallowed the call would let that regress silently — the world's own
 * `player.js` already treats the call as best-effort, so nothing else would
 * notice. `lockRequests` is the counter that does.
 */
function makeCanvas(label = 'canvas') {
  const canvas = {
    nodeName: 'CANVAS',
    width: 300,
    height: 150,
    clientWidth: 1280,
    clientHeight: 720,
    style: {},
    dataset: {},
    /** How many times the world asked for pointer lock on this element. */
    lockRequests: 0,
    parentNode: null,
    ownerDocument: null,
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() {
      return null
    },
    focus() {},
    /** Best effort, exactly as `player.js` asks for it. */
    requestPointerLock() {
      canvas.lockRequests += 1
      return undefined
    },
    getBoundingClientRect() {
      return { x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 }
    },
  }
  let context = null
  canvas.getContext = (type) => {
    assert.equal(type, '2d', `headless stub only supports 2d (asked for ${type})`)
    if (!context) context = makeContext2d(canvas)
    return context
  }
  // `three` reads these off a texture's source and treats a missing one as a
  // non-power-of-two texture, which is a different code path than the one the
  // game ships on. Cheap to state, so it is stated.
  canvas.toDataURL = () => `data:image/png;base64,headless-${label}`
  return canvas
}

/**
 * The globals, in the order `three` and the game read them.
 *
 * `matchMedia` is present and returns `matches: false` on purpose. `world.js`
 * guards its call with `typeof window.matchMedia === 'function'`, so with the
 * function absent the constructor takes the "no browser" branch and
 * `reducedMotionSystem` is never exercised at all. The default in a real browser
 * is also `false`, so this stub says the same thing a fresh Chrome says and lets
 * the reduced-motion checks in the slice-12 block test the *game's* toggle rather
 * than accidentally testing the guard.
 *
 * `document.removeEventListener` is here rather than optional-called for the same
 * reason: it is the real API, and `dispose()` reaching for it through `?.` is a
 * statement about teardown order that this harness should be able to see.
 */
globalThis.window = {
  devicePixelRatio: 1,
  innerWidth: 1280,
  innerHeight: 720,
  addEventListener() {},
  removeEventListener() {},
  matchMedia() {
    return { matches: false, media: '', addEventListener() {}, removeEventListener() {} }
  },
}
globalThis.document = {
  pointerLockElement: null,
  hidden: false,
  visibilityState: 'visible',
  exitPointerLock() {},
  addEventListener() {},
  removeEventListener() {},
  createElement(tag) {
    if (tag !== 'canvas') {
      throw new Error(`headless stub only creates canvases (asked for ${tag})`)
    }
    const canvas = makeCanvas()
    canvas.ownerDocument = globalThis.document
    return canvas
  },
}
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}

// `PHASE` and `createStore` are the only two v1 members the v2 world still uses
// (§10.5: the phase machine keeps its meaning). `LOOP_SECONDS`, `SHRINE_IDS` and
// `RESET_TIMELINE` were imported here for the v1 live block, and v2 has no
// countdown, no candles and no bell on a clock — the bells are `creature.js`'s.
const { createInitialState, createStore, PHASE } = await import('./src/game/loop.js')
const { BellLoopGame } = await import('./src/game/world.js')
// The v2 pure modules the checks below read. All four are pure per §15.1 — they
// import no DOM, no `three` and no clock — which is exactly the property that
// lets a world check assert against the *same* rules object the world runs on
// instead of re-deriving a copy of them locally.
const beast = await import('./src/game/creature.js')
const hood = await import('./src/game/neighborhood.js')
// slice 12: the HUD projection, the quantizer the repaint-budget check measures.
const hud = await import('./src/ui/hud.js')
// slice 13: the rules — the fog curve, the exit radius and `checkExitWin` are all
// rules, and a world check that re-derived them would be asserting a copy.
const rules = await import('./src/game/rules.js')

function makeFakeRenderer() {
  return {
    domElement: makeCanvas(),
    shadowMap: { enabled: false, type: null },
    toneMapping: null,
    toneMappingExposure: 1,
    setPixelRatio() {},
    setSize() {},
    render() {},
    dispose() {},
  }
}

/**
 * The recording stand-in for `AudioManager`.
 *
 * Slice 11 changed the *shape* of the world/audio boundary: the world no longer
 * calls voices, it hands the router a frame. So the fake records `update` calls and
 * replays them through the real `routeAudio`, which keeps the world's contract
 * (one call, one frame) and still lets a world check say which sound came out.
 * `bellToll` and `bellSequence` are gone with v1's API; `winChord` is slice 13's.
 */
function makeFakeAudio() {
  const calls = []
  const record = (name) => () => {
    calls.push(name)
  }
  const fake = {
    calls,
    /**
     * The last frame the world handed the router.
     *
     * Recording the *call* was enough while the world's contract was "one call
     * per frame", but it hides everything inside the frame — and the frame is
     * where §13's facts live. Slice 14's mutation run found the gap: zeroing
     * `world.creatureAwareness` fed the HUD its meter from a different field, so
     * every HUD check still passed while the audio frame went blind to the
     * creature's proximity breath. A recorder that only remembers *that* it was
     * called cannot see that, so it now remembers what it was called with.
     */
    lastFrame: null,
    ready: true,
    unlock: record('unlock'),
    startAmbient: record('startAmbient'),
    stopAmbient: record('stopAmbient'),
    duckAmbient: record('duckAmbient'),
    update(dt, frame) {
      calls.push('update')
      fake.lastFrame = frame ?? null
      // the routing itself is pure, so the harness can assert on the real decision
      for (const cue of routeAudio(frame ?? {})) calls.push(cue.id)
    },
    stopPortalHums: record('stopPortalHums'),
    winChord: record('winChord'),
    setMuted: record('setMuted'),
  }
  return fake
}

const container = {
  clientWidth: 1280,
  clientHeight: 720,
  appendChild() {},
}

const DT = 1 / 60

/** Advance the simulation by `seconds` of game time. */
function run(game, seconds) {
  const steps = Math.round(seconds / DT)
  for (let i = 0; i < steps; i++) game.update(DT)
}

const checks = []
function check(name, fn) {
  try {
    fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, error: error.message })
  }
}

const store = createStore(createInitialState(1, PHASE.START))
const audio = makeFakeAudio()
const game = new BellLoopGame(container, { store, audio, createRenderer: makeFakeRenderer })
// slice 15 — the balance simulation (§11.3, and the §16.1 mitigation)
// ===========================================================================
//
// WHAT THIS IS
// ------------
// The highest-value single piece of infrastructure in the build, and the only
// reason a tuning pass is possible at all in a project nobody can playtest: a
// headless harness that plays HUNDREDS of complete runs of the real game — real
// `world.js`, real `creature.js`, real `rules.js`, real `player.js` — with a
// scripted player standing in for the one thing a script cannot be, which is a
// person making decisions under pressure.
//
// The scripted player is a *policy*, and there are only three of them, which is
// the whole experiment: `COMPETENT`, `CARELESS` and `RECKLESS`. Everything else —
// where they walk, which verb they press, when they run — is shared, so the only
// variable between the two halves of every claim below is whether the player
// plays well or badly.
//
// WHY IT DRIVES THE REAL WORLD RATHER THAN A MODEL OF IT
// ------------------------------------------------------
// A balance harness that re-implemented the encounter would be asserting a copy
// of the rules, and the bug class this slice exists to catch is exactly a set of
// constants that disagree with each other. So the loop is
// `press keys -> world.update(dt) -> read the world's own state`, against a
// `BellLoopGame` built on the stub renderer this file already has. A 400-second
// run costs about 200 ms of wall clock, which is what makes "hundreds of runs" a
// fact here rather than an ambition.
//
// WHAT IT IS ASSERTED ON
// ----------------------
// §11.3's two trends, numerically; a competent player winning and a careless
// player losing across seeds 1..8 with neither outcome degenerate; §8.1's Act I
// being losing-by-construction impossible; §10.2's finale being escapable only
// by sprinting; and §8.3's re-emergence promise, which is the one this harness
// found broken — the note at `reemergeNode` in `creature.js` is this slice's
// finding, not slice 14's guess.

/** The eight seeds every outcome claim has to survive (§11.3's "across seeds"). */
const SIM_SEEDS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8])

/**
 * SIM_DT — the simulation's frame, seconds.
 *
 * 12 Hz, not 60, and the reason is arithmetic rather than taste: §11.3's claims
 * are averages over minutes of play, so a five-times coarser frame costs a few
 * percent of the answer and buys five times the number of runs. Nothing this
 * harness measures is frame-rate dependent in a way that matters — awareness
 * integrates `dt`, sound events are windowed at `SOUND_EVENT_SECONDS`, and both
 * verbs are edge- and hold-driven rather than per-frame — and the one place
 * frame rate *does* change v2's behaviour (`_animate`'s `dt` clamp) is not on
 * this path at all.
 */
const SIM_DT = 1 / 12

/** `node verify-world.mjs --balance-report` prints every table the checks read. */
const BALANCE_REPORT = process.argv.includes('--balance-report')

/** §11.1's on-field set: the states in which the creature is in the world with you. */
const ON_FIELD = Object.freeze(['stalk', 'reposition', 'chase', 'stagger', 'enraged'])

/** The three policies. `sprint` and `swing` are the whole difference. */
const COMPETENT = Object.freeze({ sprint: true, swing: true, hide: true, hunt: false, skipHammer: false, label: 'competent' })
const CARELESS = Object.freeze({ sprint: false, swing: false, hide: false, hunt: false, skipHammer: false, label: 'careless' })
const RECKLESS = Object.freeze({ sprint: true, swing: false, hide: false, hunt: true, skipHammer: false, label: 'reckless' })

/** §6.2's hiding, as a policy: the three numbers a competent player reads off the HUD. */
const HIDE_RANGE = 34
const HIDE_METER = beast.AWARENESS_CHASE_RELEASE + 0.05
const HIDE_BREATH = 0.45
const HIDE_MAX_SECONDS = 3

/** How close to a locked leg the policy re-plans, metres. */
const LEG_ARRIVAL = 1.5
/** How close to the approach gate the policy gives up on the street graph, metres. */
const GATE_ARRIVAL = 0.9
/** Seconds of net progress below which a player holding forward counts as wedged. */
const WEDGE_WINDOW = 1.5
/** Metres of net progress in that window a walking player covers easily. */
const WEDGE_METRES = 3
/** Radians per turn in the wedge recovery, and how often it turns. */
const SPIN_RADIANS = 0.7
const SPIN_STEP_SECONDS = 0.4
/** Metres of lost ground after which the policy gives up on the approach corridor. */
const CORRIDOR_GIVE_UP = 1.5
/** §7.4's swing is a press, so the policy needs its own cadence between presses. */
const SWING_COOLDOWN = 0.7

/**
 * simWorld — a started, playing world for one seed.
 *
 * The store carries v1's phase machine and nothing else (§10.5); the v2 run state
 * is the world's own, exactly as it is in the browser.
 */
function simWorld(seed) {
  const store = createStore(createInitialState(1, PHASE.START))
  const world = new BellLoopGame(container, {
    store,
    audio: makeFakeAudio(),
    createRenderer: makeFakeRenderer,
    seed,
  })
  world.start()
  return world
}

function holdKey(player, code) {
  if (!player.keys.has(code)) player.pressKey(code)
}

function dropKey(player, code) {
  if (player.keys.has(code)) player.releaseKey(code)
}

/**
 * nearestCopy — the image of a canonical point that is closest to the player.
 *
 * NOT `streetView.worldOf`, and the difference is the wrap seam and nothing else.
 * `worldOf` answers "which copy of this would be drawn around the player", which
 * is the copy whose *tile* contains the player; that is the right question for a
 * thing the world is about to draw and the wrong one for a route. The canonical
 * window holds seven intersections, and the eighth — the one `STREET_ADJ` calls
 * adjacent across the seam — is 384 m away inside that window and 64 m away in the
 * next copy, so a route folded with `worldOf` sends the player on a six-block
 * detour to the block next door, every single time it crosses the seam.
 *
 * The fold has to happen in the *canonical* frame, which is why the origin is read
 * here rather than folded away: `wrapDelta` differences world coordinates against
 * canonical ones, and those two frames are a whole half-period apart, so folding
 * before subtracting puts the answer 32 m out. The fold itself is
 * `wrapDelta`'s idea — the nearest image of a point on a torus is the point plus
 * the difference rounded to a whole period — done with `Math.round` so that a
 * player standing exactly half a period from a node picks the *same* image every
 * frame. `wrapDelta` leaves the tie to the caller, and a policy that re-picks a tie
 * every frame steers alternately at two points 450 m apart and stands still, which
 * is a spectacular thing to watch in a harness that is supposed to be measuring
 * something else.
 */
function nearestCopy(world, canonical) {
  const origin = world.streetView.origin
  const here = world.player.pos
  const localX = here.x - origin.x
  const localZ = here.z - origin.z
  return {
    x: origin.x + canonical.x + hood.WORLD_EXTENT * Math.round((localX - canonical.x) / hood.WORLD_EXTENT),
    z: origin.z + canonical.z + hood.WORLD_EXTENT * Math.round((localZ - canonical.z) / hood.WORLD_EXTENT),
  }
}

/** The objective the run is on: the hammer, then the three portals, then the car. */
function currentGoal(world, plan) {
  if (!world.state.hammerHeld && !plan.skipHammer) {
    return { kind: 'hammer', anchor: world.objectives.hammer }
  }
  for (let i = 0; i < hood.PORTAL_IDS.length; i += 1) {
    if (world.state.portals[hood.PORTAL_IDS[i]] !== true) {
      return { kind: 'portal', anchor: world.objectives.portals[i] }
    }
  }
  return { kind: 'exit', anchor: world.objectives.exit }
}

/**
 * lotGate — the patch of street directly outside an anchor's approach corridor.
 *
 * A beeline from a street to a lot centre is a beeline through a house, and the
 * three-stage approach this feeds is the fix: along the street to here, then up
 * §3.6's corridor (which is kept clear by rule 3, and is only `APPROACH_WIDTH`
 * wide, so it has to be walked rather than approximated), and the anchor is at the
 * far end of it.
 *
 * So the gate is the *street* end of the corridor's axis, one `SETBACK` plus half a
 * lot depth beyond the lot's centre, and the branch is `lotApproach`'s own so the
 * axis cannot drift from it.
 */
function lotGate(anchor) {
  const lot = anchor.lot
  if (lot.w >= lot.d) {
    return { x: lot.x, z: lot.z + (lot.side === 'N' ? -1 : 1) * (hood.SETBACK + lot.d / 2) }
  }
  return { x: lot.x + (lot.side === 'W' ? -1 : 1) * (hood.SETBACK + lot.w / 2), z: lot.z }
}

/**
 * drive — one frame of a scripted player.
 *
 * It only ever touches the two input doors `player.js` exposes (`pressKey` and
 * the yaw), so every rule that answers is the rule the browser runs: the breath
 * lockout, the collision resolve, the footstep cadence, §5.2's hold and §7.4's
 * swing edge.
 */
function drive(world, plan, control) {
  const player = world.player
  const creature = world.creature
  const goal = currentGoal(world, plan)
  const anchor = nearestCopy(world, goal.anchor.position)
  const gap = Math.hypot(beast.wrapDelta(player.pos.x, anchor.x), beast.wrapDelta(player.pos.z, anchor.z))
  const drawn = world.streetView.worldOf(world.creaturePosition)
  const creatureGap = Math.hypot(beast.wrapDelta(player.pos.x, drawn.x), beast.wrapDelta(player.pos.z, drawn.z))
  const hunted = creature.state === 'chase' || creature.state === 'enraged'

  // §6.2's escape, and the whole reason a competent player is competent: a chase is
  // only lost by *silence*. The meter decays when nothing arrives, footsteps are the
  // loudest thing available, and standing still is the only way to stop making them —
  // so a player who is being chased stops, lets the meter fall out of the chase band,
  // and walks away from a creature that is now following a position they left two
  // seconds ago. Sprinting does the opposite: it opens the gap and tells the creature
  // exactly where the gap went, and the sprint costs the breath that hiding needs,
  // because §7.3 makes an exhausted player emit a 6 m event while standing still.
  //
  // So the competent policy spends breath to make room, recovers, and only then goes
  // quiet — and a careless one does none of it, which is the entire difference the
  // balance assertions below measure.
  let hiding = false
  if (plan.hide && hunted && creatureGap < HIDE_RANGE && player.breath > HIDE_BREATH) {
    if (creature.awareness >= HIDE_METER) {
      control.hiding = true
      hiding = true
    } else control.hiding = false
  } else control.hiding = false
  if (control.hiding && control.hideSince === null) control.hideSince = control.clock
  if (!control.hiding) control.hideSince = null
  // and never hide for longer than it takes to lose the meter
  if (control.hideSince !== null && control.clock - control.hideSince > HIDE_MAX_SECONDS) {
    control.hideSince = null
    hiding = false
  }

  // RECKLESS walks *at* the creature, because the Act I question is "can the worst
  // possible player be caught before the hammer", and the worst possible player is
  // the one who runs at the thing
  //
  // Hiding navigates nothing at all, and that is not a shortcut: `walkTo` watches
  // for a player who is stuck, and a player who is *deliberately* standing still
  // looks exactly like one. Steering during a hide is also nonsense — you do not
  // walk to the portal while you are listening to whether the thing behind you has
  // stopped moving.
  if (hiding) control.key = null
  else if (plan.hunt && creatureGap < 90) {
    player.yaw = beast.yawBetween(player.pos, drawn)
    control.key = null
  } else {
    // two stages, because a beeline from a street to a lot centre is a beeline
    // through a house: the streets to the gate outside the approach corridor, and
    // then the corridor itself, which rule 3 keeps clear and which is only three
    // metres wide.
    //
    // The second stage LATCHES. Without it the policy stands on the 3.5 m boundary
    // between the two and walks north for one frame and south for the next, which
    // looks exactly like a player who cannot reach the thing they came for and
    // costs the run: a real player who steps into the corridor keeps going.
    if (control.stage !== goal.anchor.id) {
      control.stage = goal.anchor.id
      control.inCorridor = false
      control.bestGap = Infinity
    }
    const gate = nearestCopy(world, lotGate(goal.anchor))
    const atGate = Math.hypot(beast.wrapDelta(player.pos.x, gate.x), beast.wrapDelta(player.pos.z, gate.z)) < GATE_ARRIVAL
    if (gap < control.bestGap) control.bestGap = gap
    if (gap <= 1.4 || atGate) control.inCorridor = true
    // ...and the corridor is given up on the moment it stops working, because a
    // player who walks into a blocked corridor and keeps walking into it is a policy
    // that costs the run an objective, and the way in is not the only way in
    if (control.inCorridor && gap > control.bestGap + CORRIDOR_GIVE_UP) {
      control.inCorridor = false
      control.key = null
    }
    if (control.inCorridor) {
      player.yaw = beast.yawBetween(player.pos, anchor)
      control.key = null
    } else {
      control.bestGap = Infinity
      walkTo(world, control, lotGate(goal.anchor), goal.anchor.id)
    }
  }
  if (hiding) dropKey(player, 'KeyW')
  else holdKey(player, 'KeyW')

  // §5.2's hold, in reach only: a hold on nothing is a hold that bleeds off
  const reach = goal.kind === 'portal' ? 2.0 : goal.kind === 'hammer' ? 1.1 : 0.9
  if (gap <= reach) holdKey(player, 'KeyE')
  else dropKey(player, 'KeyE')

  // the sprint: to open a gap, in bursts, and never while hiding
  const panicky = ON_FIELD.includes(creature.state) && creatureGap < 15
  if (plan.sprint && !hiding && player.breath > 0.15 && (hunted || panicky)) holdKey(player, 'ShiftLeft')
  else dropKey(player, 'ShiftLeft')

  // §7.4's swing: a press, inside BANISH_RANGE, only against a state that can be
  // banished, and no faster than a hammer can be swung
  if (
    plan.swing &&
    world.state.hammerHeld &&
    creatureGap < beast.BANISH_RANGE - 0.3 &&
    beast.BANISHABLE_STATES.includes(creature.state) &&
    control.clock - control.lastSwing >= SWING_COOLDOWN
  ) {
    control.lastSwing = control.clock
    dropKey(player, 'Mouse0')
    player.pressKey('Mouse0')
  } else dropKey(player, 'Mouse0')
}

/** A blank tally: one number per §11.3 quantity, and the frames that made them. */
function makeTally() {
  return {
    clock: 0,
    loop: 1,
    onField: false,
    current: null,
    encounters: [],
    lastStart: null,
    lastX: 0,
    lastZ: 0,
    captures: 0,
    reemergences: [],
    states: new Set(),
    finaleSeconds: 0,
    actOneSeconds: 0,
    hammerAt: null,
    onFieldSeconds: 0,
  }
}

/**
 * watchReemergence — measure §8.3's promise every time the world places the thing.
 *
 * `reemergeNode` *reports* whether the placement it chose was inside the player's
 * cone or in line of sight; this asks the same two questions independently, in
 * the frame the world itself uses, with the module's own predicates. A module
 * that misreports its own answer is exactly the failure this harness exists to
 * find, and the only way to see it is to ask the question twice from outside.
 */
function watchReemergence(world, tally) {
  const place = world._reemerge.bind(world)
  world._reemerge = (player, occluders) => {
    place(player, occluders)
    // the player's canonical copy, derived the way the world derives it everywhere
    const canonical = {
      x: player.x - world.streetView.origin.x,
      z: player.z - world.streetView.origin.z,
      yaw: player.yaw ?? 0,
    }
    const spot = world.creaturePosition
    tally.reemergences.push({
      hops: hood.streetDistanceMap(beast.nodeId(canonical))[beast.nodeId(spot)],
      // §8.3: "never in line of sight", at any range §11.1 ever offers
      sighted: beast.canSee(canonical, { ...spot, yaw: 0 }, { range: Infinity, occluders }),
      faced: beast.inSightCone(canonical, spot),
      metres: Math.hypot(beast.wrapDelta(canonical.x, spot.x), beast.wrapDelta(canonical.z, spot.z)),
    })
  }
}

function openEncounter(tally, world) {
  const encounter = {
    n: tally.encounters.length + 1,
    tier: world.creature.tier,
    reemergence: world.creature.reemergenceCount,
    banish: world.state.banishCount,
    start: tally.clock,
    onField: 0,
    cycle: tally.lastStart === null ? 0 : tally.clock - tally.lastStart,
    pursuitMetres: 0,
    pursuitSeconds: 0,
    captured: false,
    banished: false,
    finale: world.state.finale === true,
  }
  tally.encounters.push(encounter)
  tally.lastStart = tally.clock
  tally.current = encounter
}

function closeEncounter(tally, world) {
  const encounter = tally.current
  if (!encounter) return
  encounter.onField = tally.clock - encounter.start
  encounter.pursuit = encounter.pursuitSeconds > 0 ? encounter.pursuitMetres / encounter.pursuitSeconds : 0
  encounter.banished = world.state.banishCount > encounter.banish
  encounter.share = encounter.cycle > 0 ? encounter.onField / encounter.cycle : 1
  tally.current = null
}

/** One frame of measurement, taken after the world's own update. */
function tallyFrame(tally, world, dt) {
  const state = world.creature.state
  tally.states.add(state)
  const present = ON_FIELD.includes(state)
  if (present) {
    if (!tally.onField) openEncounter(tally, world)
    tally.onFieldSeconds += dt
    if (beast.PURSUING_STATES.includes(state)) {
      // §11.3's threat, measured rather than read off a table: the speed at which
      // the thing that can end the run is actually closing, in metres a second
      const moved = Math.hypot(
        beast.wrapDelta(tally.lastX, world.creaturePosition.x),
        beast.wrapDelta(tally.lastZ, world.creaturePosition.z),
      )
      if (tally.current) {
        tally.current.pursuitMetres += moved
        tally.current.pursuitSeconds += dt
      }
    }
  } else if (tally.onField) closeEncounter(tally, world)
  tally.onField = present
  tally.lastX = world.creaturePosition.x
  tally.lastZ = world.creaturePosition.z
  tally.clock += dt
  if (world.state.finale) tally.finaleSeconds += dt
  if (!world.state.hammerHeld) tally.actOneSeconds += dt
  if (world.state.hammerHeld && tally.hammerAt === null) tally.hammerAt = tally.clock
  if (world.state.loop !== tally.loop) {
    tally.loop = world.state.loop
    tally.captures += 1
    if (tally.current) tally.current.captured = true
    closeEncounter(tally, world)
    tally.onField = false
  }
}



/**
 * walkTo — steer along the street graph to `aim`, one locked leg at a time.
 *
 * Two failure modes, both found by watching runs that were supposed to be
 * measured and turned out to be measuring a player wedged against a hedge, which
 * is worth writing down because neither is visible in the numbers:
 *
 *  - **re-planning every frame** makes `nearestIntersection` flip to the node
 *    behind the player halfway along an edge, and the route then sends them back.
 *  - **re-planning too early** cuts the corner: a leg replaced 30 m out is walked
 *    diagonally, and the diagonal leaves the 6 m half-width of the carriageway and
 *    takes the player through a front garden. `LEG_ARRIVAL` is 1.5 m for that
 *    reason — small enough that the cut stays on the road, large enough that a
 *    0.5 m frame at a sprint cannot step over it.
 *
 * And one safety net, because a policy bug must never quietly poison a run. It is
 * measured as NET displacement over a second and a half rather than as speed,
 * because the failure is not standing still — it is sliding back and forth inside a
 * hedge line, which reads as a player moving at 2 m/s and covers no ground at all.
 * A wedged player walks a spiral until something gives.
 */
function walkTo(world, control, aim, key) {
  const player = world.player
  const here = player.pos
  const net = Math.hypot(beast.wrapDelta(control.netX, here.x), beast.wrapDelta(control.netZ, here.z))
  if (control.clock - control.netAt >= WEDGE_WINDOW) {
    control.netX = here.x
    control.netZ = here.z
    control.netAt = control.clock
    control.stuck = net < WEDGE_METRES ? control.stuck + 1 : 0
    if (control.stuck > 0) {
      control.leg = null
      control.key = null
      control.wedged = true
      control.spinAt = control.clock
    }
  }
  if (control.wedged) {
    // A wedged player walks in a widening spiral until something gives. The obvious
    // alternatives are worse: steering at the nearest intersection walks into the
    // house the player is already inside, and giving up costs the run a whole
    // objective. The spin is deterministic — a fixed step per frame off the same base
    // heading — so a wedged run is still replayable, which §15.3's scripted-run rule
    // requires of anything that reads a run's outcome.
    // The turn is a STEP, not a rate: spinning the heading every frame walks the
    // player in a 30 cm circle and never leaves the pocket, which is the one thing a
    // recovery must not do. Every `SPIN_STEP_SECONDS` it turns 40°, so the player
    // walks a staircase out of whatever it is in.
    if (control.clock - control.spinAt >= SPIN_STEP_SECONDS) {
      control.spinAt = control.clock
      control.spin += SPIN_RADIANS
    }
    const nearest = beast.nearestIntersection(here)
    player.yaw = beast.yawBetween(here, nearestCopy(world, hood.streetNodeToWorld(nearest))) + control.spin
    if (net > WEDGE_METRES) {
      control.wedged = false
      control.spin = 0
    }
    return
  }
  control.spin = 0
  if (control.key !== key) {
    control.key = key
    control.leg = null
  }
  if (control.leg !== null) {
    const leg = nearestCopy(world, hood.streetNodeToWorld(control.leg))
    if (Math.hypot(beast.wrapDelta(here.x, leg.x), beast.wrapDelta(here.z, leg.z)) < LEG_ARRIVAL) {
      control.leg = null
    }
  }
  if (control.leg === null) {
    // the aim arrives canonical (it is a block centre or an anchor) and `nodeId`
    // reads the frame the player is in, so it crosses over before it is snapped
    const route = beast.streetRoute(beast.nodeId(here), beast.nodeId(nearestCopy(world, aim)))
    control.leg = route.length > 1 ? route[1] : null
  }
  player.yaw = beast.yawBetween(
    here,
    control.leg === null ? nearestCopy(world, aim) : nearestCopy(world, hood.streetNodeToWorld(control.leg)),
  )
}


/**
 * playRun — play one run to a conclusion, or to the clock.
 *
 * `setup` gets the world before the first frame, which is how the encounter grid
 * and the finale are posed; `until` ends the run early, which is how the Act I
 * question is bounded. Everything else is the same loop every run takes.
 */
function playRun(seed, plan, options = {}) {
  const world = simWorld(seed)
  const tally = makeTally()
  // the watcher goes on before the setup, so a placement the *setup* makes — the
  // encounter grid's opening §8.3 placement — is measured like every other one
  watchReemergence(world, tally)
  if (options.setup) options.setup(world)
  const control = { clock: 0, lastSwing: -99, key: null, leg: null, stuck: 0, wedged: false, markX: 0, markZ: 0, stage: null, inCorridor: false, bestGap: Infinity, hiding: false, hideSince: null, spin: 0, spinAt: 0, netX: 0, netZ: 0, netAt: 0 }
  const steps = Math.ceil((options.maxSeconds ?? 900) / SIM_DT)
  let won = false
  for (let i = 0; i < steps; i += 1) {
    const phase = world.store.get().phase
    if (phase === PHASE.WON) {
      won = true
      break
    }
    if (phase === PHASE.PLAYING) drive(world, plan, control)
    else {
      // §9.3 plays itself out behind the black; hands off rather than walking
      for (const code of ['KeyW', 'KeyE', 'ShiftLeft', 'Mouse0']) dropKey(world.player, code)
    }
    control.clock = tally.clock
    world.update(SIM_DT)
    tallyFrame(tally, world, SIM_DT)
    if (options.until && options.until(world, tally)) break
  }
  closeEncounter(tally, world)
  const result = {
    seed,
    plan: plan.label,
    won,
    seconds: tally.clock,
    captures: tally.captures,
    hammerAt: tally.hammerAt,
    hammerHeld: world.state.hammerHeld,
    portalsShut: rules.portalsShut(world.state.portals),
    banishes: world.state.banishCount,
    finaleSeconds: tally.finaleSeconds,
    actOneSeconds: tally.actOneSeconds,
    onFieldSeconds: tally.onFieldSeconds,
    encounters: tally.encounters,
    reemergences: tally.reemergences,
    states: [...tally.states],
  }
  if (BALANCE_REPORT) {
    const captured = tally.captures
    console.log(
      `    ${plan.label.padEnd(9)} seed ${seed}  ${won ? 'WON ' : 'lost'}  ` +
        `captures ${captured}  portals ${result.portalsShut}  banishes ${result.banishes}  ` +
        `encounters ${tally.encounters.length}  on-field ${tally.onFieldSeconds.toFixed(1)}s / ` +
        `${tally.clock.toFixed(1)}s`,
    )
  }
  world.dispose()
  return result
}

/** `placePortals` — §10.1's trigger applied the way the game applies it. */
function placePortals(world, count) {
  const shut = Math.max(0, Math.min(count, hood.PORTAL_IDS.length))
  const portals = { ...world.state.portals }
  for (let i = 0; i < shut; i += 1) {
    const id = hood.PORTAL_IDS[i]
    portals[id] = true
    world.streetView.setPortalShut(id, true)
  }
  world.state = {
    ...world.state,
    portals,
    dusk: rules.duskForPortals(portals),
    finale: rules.triggersFinale(portals),
  }
  if (shut > 0) {
    world._onPortalShut(hood.PORTAL_IDS[shut - 1])
    world._applyDusk(world.state.dusk)
  }
  return world
}

/**
 * the encounter grid — §11.3's own experiment, one cell at a time.
 *
 * "Creature at tier N, player sprinting or walking, hammer held or not", which is
 * the sentence §11.3 writes, taken literally: every combination of the progress
 * axis, the gait, the hammer and the pressure axis, across all eight seeds. Each
 * cell is a short window rather than a whole run, because the question here is
 * what one encounter does to one player, not what a run adds up to.
 */
function encounterGrid() {
  const cells = []
  for (const seed of SIM_SEEDS) {
    for (let tier = 0; tier < 3; tier += 1) {
      for (const hammer of [false, true]) {
        for (const sprint of [false, true]) {
          for (const reemergence of [0, 2]) {
            // a player without the hammer is a player who never went for it, and
            // a policy that knows that is the only way to hold the axis still
            const base = sprint ? COMPETENT : CARELESS
            const plan = { ...base, skipHammer: !hammer, label: `${base.label}${hammer ? '+hammer' : '-hammer'}` }
            cells.push(
              playRun(seed, plan, {
                maxSeconds: 45,
                setup: (world) => {
                  placePortals(world, tier)
                  world.state = { ...world.state, hammerHeld: hammer }
                  if (hammer) world.streetView.setHammerTaken(true)
                  world.creature = beast.createCreature({
                    state: 'stalk',
                    tier,
                    reemergenceCount: reemergence,
                    banishCount: tier,
                    awareness: 0,
                  })
                  // §8.3 places the first one, through the world's own door
                  world._reemerge(
                    { x: world.player.pos.x, z: world.player.pos.z, yaw: world.player.yaw },
                    world.streetView.canonicalOccluders(),
                  )
                },
              }),
            )
          }
        }
      }
    }
  }
  return cells
}

/**
 * the full runs — one per seed per policy, from the title card to a win or a
 * capture that costs the player nothing but the walk.
 */
function fullRuns() {
  const runs = []
  for (const seed of SIM_SEEDS) {
    for (const plan of [COMPETENT, CARELESS]) runs.push(playRun(seed, plan, { maxSeconds: 900 }))
  }
  return runs
}

/**
 * Act I, played by the worst player the harness can express: sprinting at the
 * thing, into its face, for the whole of the pre-hammer phase.
 */
function actOneRuns() {
  return SIM_SEEDS.map((seed) => playRun(seed, RECKLESS, {
    maxSeconds: 420,
    until: (world) => world.state.hammerHeld,
  }))
}

/**
 * the finale, posed at its worst: §10.3's headlights have just come on, the
 * creature is thirty metres behind, and the player has no hammer — so the only
 * question §10.2 asks is the one about the gap between 5.2 and 6.0.
 */
function finaleRuns() {
  const runs = []
  for (const seed of SIM_SEEDS) {
    for (const sprint of [false, true]) {
      const base = sprint ? COMPETENT : CARELESS
      runs.push(
        playRun(seed, { ...base, skipHammer: true, label: `${base.label}-finale` }, {
          maxSeconds: 300,
          setup: (world) => {
            placePortals(world, hood.PORTAL_IDS.length)
            // the third portal is where the run actually ends, so the finale
            // starts there: the worst case for the walk to the car
            const anchor = world.objectives.portals[hood.PORTAL_IDS.length - 1].position
            const start = world.streetView.worldOf(anchor)
            world.player.teleport(start.x, start.z, beast.yawBetween(start, world.streetView.worldOf(world.objectives.exit.position)))
            world.creature = beast.createCreature({ state: 'stalk', tier: 3, awareness: 0.4, finale: true })
            const canonical = {
              x: world.player.pos.x - world.streetView.origin.x,
              z: world.player.pos.z - world.streetView.origin.z,
            }
            world.creaturePosition = { x: canonical.x - 28, z: canonical.z + 12 }
          },
        }),
      )
    }
  }
  return runs
}

/** Mean of a list, or NaN when the list is empty. */
function mean(values) {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : NaN
}

/** Every number this section asserts on, computed once and shared by the checks. */
let SIMULATION = null

function simulation() {
  if (SIMULATION) return SIMULATION
  const started = Date.now()
  SIMULATION = {
    grid: encounterGrid(),
    runs: fullRuns(),
    actOne: actOneRuns(),
    finale: finaleRuns(),
  }
  SIMULATION.milliseconds = Date.now() - started
  SIMULATION.plays = SIMULATION.grid.length + SIMULATION.runs.length + SIMULATION.actOne.length + SIMULATION.finale.length
  if (BALANCE_REPORT) reportBalance(SIMULATION)
  return SIMULATION
}

/** Act II encounters only: the finale is one long pursuit, not a series of them. */
function actTwoEncounters(runs) {
  return runs.flatMap((run) => run.encounters.filter((encounter) => !encounter.finale))
}

function reportBalance(sim) {
  const line = (text) => console.log(text)
  line('')
  line(`  balance simulation — ${sim.plays} runs in ${sim.milliseconds} ms`)
  line('')
  line('  full runs')
  for (const run of sim.runs) {
    line(
      `    ${run.plan.padEnd(9)} seed ${run.seed}  ${run.won ? 'WON ' : 'lost'}  captures ${run.captures}  ` +
        `portals ${run.portalsShut}  banishes ${run.banishes}  hammer ${run.hammerAt === null ? 'never' : `${run.hammerAt.toFixed(0)}s`}  ` +
        `encounters ${run.encounters.length}  on-field ${(run.onFieldSeconds / run.seconds * 100).toFixed(0)}%  ` +
        `finale ${run.finaleSeconds.toFixed(0)}s  ${run.seconds.toFixed(0)}s`,
    )
  }
  line('')
  line('  §11.3 by encounter index (competent runs, Act II only)')
  const perIndex = new Map()
  for (const run of sim.runs) {
    if (run.plan !== 'competent') continue
    for (const encounter of actTwoEncounters([run])) {
      const bucket = perIndex.get(encounter.n) ?? { n: encounter.n, onField: [], cycle: [], share: [], pursuit: [], captured: 0, banished: 0, count: 0 }
      bucket.count += 1
      bucket.onField.push(encounter.onField)
      bucket.cycle.push(encounter.cycle)
      bucket.share.push(encounter.share)
      bucket.pursuit.push(encounter.pursuit)
      bucket.captured += encounter.captured ? 1 : 0
      bucket.banished += encounter.banished ? 1 : 0
      perIndex.set(encounter.n, bucket)
    }
  }
  for (const bucket of [...perIndex.values()].sort((a, b) => a.n - b.n)) {
    line(
      `    #${bucket.n}  n=${String(bucket.count).padStart(2)}  on-field ${mean(bucket.onField).toFixed(1)}s  ` +
        `cycle ${mean(bucket.cycle).toFixed(1)}s  share ${mean(bucket.share).toFixed(3)}  ` +
        `pursuit ${mean(bucket.pursuit).toFixed(2)} m/s  banished ${bucket.banished}/${bucket.count}  captured ${bucket.captured}/${bucket.count}`,
    )
  }
  line('')
  line('  §11.3 by tier (competent runs, Act II only)')
  const perTier = new Map()
  for (const run of sim.runs) {
    for (const encounter of actTwoEncounters([run])) {
      const bucket = perTier.get(encounter.tier) ?? { tier: encounter.tier, share: [], pursuit: [], captured: 0, count: 0, banish: [] }
      bucket.count += 1
      bucket.share.push(encounter.share)
      bucket.pursuit.push(encounter.pursuit)
      bucket.banish.push(encounter.banish)
      bucket.captured += encounter.captured ? 1 : 0
      perTier.set(encounter.tier, bucket)
    }
  }
  for (const bucket of [...perTier.values()].sort((a, b) => a.tier - b.tier)) {
    line(
      `    tier ${bucket.tier}  n=${String(bucket.count).padStart(2)}  share ${mean(bucket.share).toFixed(3)}  ` +
        `pursuit ${mean(bucket.pursuit).toFixed(2)} m/s  banish #${mean(bucket.banish).toFixed(1)}  captured ${bucket.captured}/${bucket.count}`,
    )
  }
  line('')
  line('  encounter grid (tier x gait x hammer x pressure, 45 s each)')
  const perCell = new Map()
  for (const cell of sim.grid) {
    const key = `${cell.portalsShut}|${cell.hammerHeld}|${cell.plan.startsWith('competent')}`
    const bucket = perCell.get(key) ?? { key, plays: 0, captures: 0, wins: 0, onField: [], banishes: 0, encounters: 0 }
    bucket.plays += 1
    bucket.captures += cell.captures
    bucket.wins += cell.won ? 1 : 0
    bucket.banishes += cell.banishes
    bucket.encounters += cell.encounters.length
    bucket.onField.push(cell.onFieldSeconds / cell.seconds)
    perCell.set(key, bucket)
  }
  for (const bucket of [...perCell.values()].sort()) {
    line(
      `    tier ${bucket.key}  plays ${bucket.plays}  captured ${bucket.captures}  won ${bucket.wins}  ` +
        `banishes ${bucket.banishes}  encounters ${bucket.encounters}  on-field ${(mean(bucket.onField) * 100).toFixed(0)}%`,
    )
  }
  line('')
  line('  Act I, played by the recklessly sprinting player')
  for (const run of sim.actOne) {
    line(`    seed ${run.seed}  hammer at ${run.hammerAt === null ? 'NEVER' : `${run.hammerAt.toFixed(0)}s`}  captures ${run.captures}  states ${run.states.join(',')}`)
  }
  line('')
  line('  the finale (§10.2): 30 m behind, no hammer, car up to four blocks away')
  for (const run of sim.finale) {
    line(`    ${run.plan.padEnd(15)} seed ${run.seed}  ${run.won ? 'WON ' : 'lost'}  captures ${run.captures}  finale ${run.finaleSeconds.toFixed(0)}s / ${run.seconds.toFixed(0)}s`)
  }
  line('')
  const reemergences = sim.runs.flatMap((run) => run.reemergences)
  const faced = reemergences.filter((spot) => spot.faced).length
  const sighted = reemergences.filter((spot) => spot.sighted).length
  const near = reemergences.filter((spot) => spot.hops < beast.REEMERGE_MIN_GRAPH_DISTANCE).length
  line(`  §8.3 over ${reemergences.length} re-emergences: ${faced} in the player's cone, ${sighted} in line of sight, ${near} under the hop floor`)
  line('')
}

for (const seed of [2, 4, 7]) {
  const w = simWorld(seed)
  const tally = makeTally()
  watchReemergence(w, tally)
  const control = { clock: 0, lastSwing: -99, key: null, leg: null, stuck: 0, wedged: false, markX: 0, markZ: 0, stage: null, inCorridor: false, bestGap: Infinity, hiding: false, hideSince: null, spin: 0, spinAt: 0, netX: 0, netZ: 0, netAt: 0 }
  for (let i = 0; i < 12 * 420; i += 1) {
    drive(w, RECKLESS, control)
    control.clock = tally.clock
    w.update(SIM_DT)
    tallyFrame(tally, w, SIM_DT)
    if (w.state.hammerHeld) break
  }
  console.log('seed', seed, 'hammer at', tally.hammerAt === null ? 'NEVER' : tally.hammerAt.toFixed(0), 'captures', tally.captures, 'states', [...tally.states].join(","))
}
